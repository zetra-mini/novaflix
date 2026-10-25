/**
 * AdminManager - Sistema de Gestão do Painel Administrativo, Resiliência e SAC
 * Controla:
 * - Autenticação JWT e Gestão de Usuários Administradores
 * - Anti-queda de Domínios (Failover de Domínio Principal e Espelhos)
 * - Gestão e Health-Check de Listas IPTV (Primária e Backups)
 * - Central de Mensagens e Feedback com Notificação Telegram
 * - Rate Limiting e Controle de CORS
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const STORE_FILE = process.env.VERCEL
  ? path.join('/tmp', 'admin_store.json')
  : path.join(__dirname, 'data', 'admin_store.json');

class AdminManager {
  constructor() {
    this.jwtSecret = process.env.ADMIN_JWT_SECRET || 'novaflix_jwt_secret_key_2026_super_safe_token';
    this.ipRateLimits = new Map(); // ip -> Array<timestamp>
    this.activeSessions = new Map(); // sessionId -> session details
    this.knownUsers = new Map(); // uuid -> user details
    this.ipGeoCache = new Map(); // ip -> { city, region, country, isp }
    this.sessionMessages = new Map(); // sessionId -> Array<msg>
    this.broadcastMessages = []; // Array<msg>
    this.deliveredBroadcasts = new Map(); // sessionId -> Set of delivered ids
    this.messageSecret = crypto.createHash('sha256').update('novaflix-secret-key-2026').digest();
    this.systemLogs = []; // Buffer circular de logs em tempo real
    this.maxLogs = 1000;
    this.store = null;
    this.initStore();

    // Aliases para compatibilidade total entre controladores modulares e legado
    this.verifyToken = this.verifyJwt.bind(this);
    this.generateToken = this.generateJwt.bind(this);
    this.savePlaylistConfig = this.updatePlaylistConfig.bind(this);
    this.setMainDomain = (domain) => this.updateDomainConfig({ mainDomain: domain });

    this.logEvent('INFO', 'SISTEMA', 'Painel Administrativo e Motor de Monitoramento inicializados com sucesso.');
  }

  // Gera hash PBKDF2 com Salt
  hashPassword(password, salt = null) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, s, 10000, 64, 'sha512').toString('hex');
    return { hash, salt: s };
  }

  verifyPassword(password, storedHash, salt) {
    const { hash } = this.hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  }

  // Geração e Verificação de JWT nativo (Zero dependências externas)
  generateJwt(payload, expiresInMs = 24 * 60 * 60 * 1000) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const fullPayload = Buffer.from(JSON.stringify({
      ...payload,
      exp: Date.now() + expiresInMs,
      iat: Date.now()
    })).toString('base64url');

    const signature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${header}.${fullPayload}`)
      .digest('base64url');

    return `${header}.${fullPayload}.${signature}`;
  }

  verifyJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    if (signature !== expectedSignature) return null;

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (decoded.exp && Date.now() > decoded.exp) return null; // Expirado
      return decoded;
    } catch (e) {
      return null;
    }
  }

  // Inicializa armazenamento persistente
  initStore() {
    try {
      if (process.env.VERCEL && !fs.existsSync(STORE_FILE)) {
        const seedFile = path.join(__dirname, 'data', 'admin_store.json');
        if (fs.existsSync(seedFile)) {
          fs.copyFileSync(seedFile, STORE_FILE);
        }
      }

      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        this.store = JSON.parse(raw);
        if (!this.store.paymentGateway) {
          this.store.paymentGateway = { apiKey: '' };
        }
        if (!this.store.userOverrides) {
          this.store.userOverrides = {};
        }
      }
    } catch (e) {
      console.warn('[Admin] Aviso ao carregar admin_store.json:', e.message);
    }

    if (!this.store) {
      const defaultSalt = 'a1b2c3d4e5f67890';
      const defaultHash = this.hashPassword('admin123', defaultSalt).hash;

      this.store = {
        users: [
          {
            id: 'usr_admin',
            username: 'admin',
            passwordHash: defaultHash,
            salt: defaultSalt,
            role: 'superadmin',
            name: 'Administrador Principal',
            createdAt: new Date().toISOString()
          }
        ],
        config: {
          mainDomain: 'http://localhost:3000',
          mirrorDomains: [
            'http://127.0.0.1:3000',
            'http://backup.player.tv'
          ],
          playlists: {
            primary: 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=ts',
            backup1: 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8',
            backup2: '',
            live_list_url: 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=ts',
            vod_list_url: 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8'
          },
          activePlaylist: 'primary',
          updatedAt: new Date().toISOString()
        },
        settings: {
          streamMode: 'proxy', // 'proxy' (Proxy VPS Seguro com Range & CORS) | 'direct' (Decodificação Direta na Ponta / CDN)
          syncInterval: '24h', // 'manual' | '24h' | '12h' | '30m'
          telegram: {
            enabled: false,
            botToken: '',
            chatId: ''
          },
          rateLimit: {
            maxRequests: 5,
            windowMinutes: 10
          },
          corsAllowedDomains: '*'
        },
        feedbacks: [],
        healthChecks: {
          lastChecked: null,
          mainDomain: { status: 'online', statusCode: 200, latency: 12 },
          primary: { status: 'unknown', statusCode: null, latency: null },
          backup1: { status: 'unknown', statusCode: null, latency: null },
          backup2: { status: 'unknown', statusCode: null, latency: null }
        }
      };
      this.saveStore();
      console.log('[Admin] Store administrativa criada com sucesso com usuário admin padrão!');
    }
  }

  saveStore() {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2), 'utf8');
    } catch (e) {
      console.error('[Admin] Falha ao salvar admin_store.json:', e.message);
    }
  }

  // =========================================================================
  // GESTÃO DE USUÁRIOS
  // =========================================================================
  authenticate(username, password) {
    if (!username || !password) return null;
    const cleanUser = String(username).trim().toLowerCase();
    const user = this.store.users.find(u => u.username.toLowerCase() === cleanUser);
    if (!user) return null;

    const valid = this.verifyPassword(password, user.passwordHash, user.salt);
    if (!valid) return null;

    const token = this.generateJwt({
      userId: user.id,
      username: user.username,
      role: user.role
    });

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name || user.username
      }
    };
  }

  getUsers() {
    return this.store.users.map(u => ({
      id: u.id,
      username: u.username,
      name: u.name || u.username,
      role: u.role,
      createdAt: u.createdAt
    }));
  }

  addUser({ username, password, name = '', role = 'admin' }) {
    const clean = String(username).trim();
    if (clean.length < 3) throw new Error('Nome de usuário deve ter pelo menos 3 caracteres.');
    if (!password || password.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.');

    const exists = this.store.users.some(u => u.username.toLowerCase() === clean.toLowerCase());
    if (exists) throw new Error(`O usuário "${clean}" já existe no sistema.`);

    const { hash, salt } = this.hashPassword(password);
    const newUser = {
      id: 'usr_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      username: clean,
      name: name || clean,
      passwordHash: hash,
      salt: salt,
      role: role === 'superadmin' ? 'superadmin' : 'admin',
      createdAt: new Date().toISOString()
    };

    this.store.users.push(newUser);
    this.saveStore();
    return {
      id: newUser.id,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
      createdAt: newUser.createdAt
    };
  }

  updateUserPassword(userId, newPassword) {
    if (!newPassword || newPassword.length < 6) {
      throw new Error('A nova senha deve ter no mínimo 6 caracteres.');
    }
    const user = this.store.users.find(u => u.id === userId);
    if (!user) throw new Error('Usuário não encontrado.');

    const { hash, salt } = this.hashPassword(newPassword);
    user.passwordHash = hash;
    user.salt = salt;
    this.saveStore();
    return true;
  }

  updateProfile(userId, { username, newPassword, name }) {
    const user = this.store.users.find(u => u.id === userId);
    if (!user) throw new Error('Usuário não encontrado.');

    if (username) {
      const cleanUser = String(username).trim();
      if (cleanUser.length < 3) throw new Error('O usuário deve ter ao menos 3 caracteres.');
      const conflict = this.store.users.some(u => u.id !== userId && u.username.toLowerCase() === cleanUser.toLowerCase());
      if (conflict) throw new Error(`O nome de usuário "${cleanUser}" já está em uso.`);
      user.username = cleanUser;
    }

    if (name !== undefined) {
      user.name = String(name).trim();
    }

    if (newPassword && newPassword.trim().length > 0) {
      if (newPassword.trim().length < 6) throw new Error('A senha deve ter no mínimo 6 caracteres.');
      const { hash, salt } = this.hashPassword(newPassword.trim());
      user.passwordHash = hash;
      user.salt = salt;
    }

    this.saveStore();
    return {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      role: user.role
    };
  }

  deleteUser(userId) {
    if (this.store.users.length <= 1) {
      throw new Error('Não é possível excluir o único administrador do sistema.');
    }
    const idx = this.store.users.findIndex(u => u.id === userId);
    if (idx === -1) throw new Error('Usuário não encontrado.');
    this.store.users.splice(idx, 1);
    this.saveStore();
    return true;
  }

  // =========================================================================
  // GESTÃO DE DOMÍNIOS & ANTI-QUEDA
  // =========================================================================
  async detectPublicIp() {
    const providers = [
      'https://api.ipify.org?format=json',
      'https://icanhazip.com',
      'https://ifconfig.me/ip'
    ];

    for (const pUrl of providers) {
      try {
        const ip = await new Promise((resolve, reject) => {
          const req = https.get(pUrl, { timeout: 2500 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Status ' + res.statusCode));
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              try {
                if (body.trim().startsWith('{')) {
                  const j = JSON.parse(body);
                  resolve((j.ip || j.ip_address || '').trim());
                } else {
                  resolve(body.trim());
                }
              } catch (e) {
                resolve(body.trim());
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !ip.startsWith('127.')) {
          return ip;
        }
      } catch (e) {}
    }

    try {
      const os = require('os');
      const interfaces = os.networkInterfaces();
      for (const name in interfaces) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            return iface.address;
          }
        }
      }
    } catch (e) {}

    return null;
  }

  async autoConfigureVpsIp(port = 3000) {
    const current = this.store?.config?.mainDomain || '';
    if (!current || current.includes('localhost') || current.includes('127.0.0.1')) {
      const ip = await this.detectPublicIp();
      if (ip) {
        const isStandardPort = (port === 80 || port === '80' || port === 443 || port === '443');
        const newUrl = isStandardPort ? `http://${ip}` : `http://${ip}:${port}`;
        this.store.config.mainDomain = newUrl;
        this.saveStore();
        this.syncServerConfigFile();
        this.logEvent('INFO', 'DOMINIOS', `IP da VPS detectado e configurado automaticamente como domínio principal: ${newUrl}`);
        return newUrl;
      }
    }
    return current;
  }

  getDomainConfig() {
    return {
      mainDomain: this.store.config.mainDomain,
      mirrorDomains: this.store.config.mirrorDomains || [],
      updatedAt: this.store.config.updatedAt
    };
  }

  syncServerConfigFile() {
    try {
      const targetDomain = this.store?.config?.mainDomain || '';
      // Se for localhost ou 127.0.0.1, deixa vazio no arquivo de configuração dos clientes
      // para que celulares e outros computadores usem descoberta dinâmica ou IP público
      const isLocalhost = targetDomain.includes('localhost') || targetDomain.includes('127.0.0.1');
      const safeUrl = isLocalhost ? '' : targetDomain;

      const configData = {
        serverUrl: safeUrl,
        serverIp: safeUrl,
        updatedAt: this.store?.config?.updatedAt || new Date().toISOString(),
        description: "Configuração gerada pelo Painel ADM NovaFlix para compilações nativas (Android/Windows/PWA)."
      };
      const jsonStr = JSON.stringify(configData, null, 2);

      const targetPaths = [
        path.join(__dirname, 'public', 'server_config.json'),
        path.join(__dirname, 'data', 'server_config.json'),
        path.join(__dirname, 'android', 'app', 'src', 'main', 'assets', 'public', 'server_config.json')
      ];

      targetPaths.forEach(p => {
        try {
          const dir = path.dirname(p);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(p, jsonStr, 'utf8');
        } catch (e) {
          console.warn(`[SERVER-CONFIG] Não foi possível atualizar ${p}:`, e.message);
        }
      });
      return true;
    } catch (err) {
      console.error('[SERVER-CONFIG] Erro ao sincronizar server_config.json:', err.message);
      return false;
    }
  }

  updateDomainConfig({ mainDomain, mirrorDomains }) {
    if (mainDomain) {
      this.store.config.mainDomain = String(mainDomain).trim().replace(/\/+$/, '');
    }
    if (Array.isArray(mirrorDomains)) {
      this.store.config.mirrorDomains = mirrorDomains
        .map(d => String(d).trim().replace(/\/+$/, ''))
        .filter(d => d.length > 0);
    }
    this.store.config.updatedAt = new Date().toISOString();
    this.saveStore();
    this.syncServerConfigFile();
    return this.getDomainConfig();
  }

  // =========================================================================
  // GESTÃO DE LISTAS IPTV (FAILOVER)
  // =========================================================================
  getPlaylistConfig() {
    if (!this.store) this.initStore();
    if (!this.store.config) this.store.config = {};
    if (!this.store.config.playlists) {
      this.store.config.playlists = {
        primary: '',
        backup1: '',
        backup2: '',
        live_list_url: '',
        vod_list_url: ''
      };
    }
    if (!this.store.healthChecks) {
      this.store.healthChecks = {
        primary: { status: 'unknown', statusCode: null, latency: null },
        backup1: { status: 'unknown', statusCode: null, latency: null },
        backup2: { status: 'unknown', statusCode: null, latency: null }
      };
    }
    return {
      playlists: this.store.config.playlists,
      activePlaylist: this.store.config.activePlaylist || 'primary',
      healthChecks: this.store.healthChecks
    };
  }

  updatePlaylistConfig({ primary, backup1, backup2, activePlaylist, live_list_url, vod_list_url }) {
    if (!this.store) this.initStore();
    if (!this.store.config) this.store.config = {};
    if (!this.store.config.playlists) {
      this.store.config.playlists = {
        primary: '',
        backup1: '',
        backup2: '',
        live_list_url: '',
        vod_list_url: ''
      };
    }
    if (primary !== undefined) this.store.config.playlists.primary = String(primary).trim();
    if (backup1 !== undefined) this.store.config.playlists.backup1 = String(backup1).trim();
    if (backup2 !== undefined) this.store.config.playlists.backup2 = String(backup2).trim();
    if (live_list_url !== undefined) this.store.config.playlists.live_list_url = String(live_list_url).trim();
    if (vod_list_url !== undefined) this.store.config.playlists.vod_list_url = String(vod_list_url).trim();
    if (activePlaylist && ['primary', 'backup1', 'backup2'].includes(activePlaylist)) {
      this.store.config.activePlaylist = activePlaylist;
    }
    this.store.config.updatedAt = new Date().toISOString();
    this.saveStore();
    return this.getPlaylistConfig();
  }

  // =========================================================================
  // CONFIGURAÇÃO PÚBLICA (/api/config)
  // =========================================================================
  getPublicConfig() {
    return {
      mainDomain: this.store.config.mainDomain,
      mirrorDomains: this.store.config.mirrorDomains,
      playlists: {
        primary: this.store.config.playlists.primary,
        backup1: this.store.config.playlists.backup1,
        backup2: this.store.config.playlists.backup2
      },
      activePlaylist: this.store.config.activePlaylist,
      updatedAt: this.store.config.updatedAt
    };
  }

  // =========================================================================
  // HEALTH CHECK (INTEGRIDADE & LATÊNCIA)
  // =========================================================================
  async pingUrl(targetUrl, timeoutMs = 20000) {
    if (!targetUrl || !targetUrl.startsWith('http')) {
      return { status: 'empty', statusCode: null, latency: null };
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      try {
        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
          method: 'GET',
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
            'Accept': '*/*'
          },
          timeout: timeoutMs
        };

        const req = client.request(options, (res) => {
          const latency = Date.now() - startTime;
          const sc = res.statusCode;
          req.destroy();

          const isOk = (sc >= 200 && sc < 400);
          resolve({
            status: isOk ? 'online' : 'error',
            statusCode: sc,
            latency
          });
        });

        req.on('error', (err) => {
          resolve({
            status: 'offline',
            statusCode: null,
            latency: Date.now() - startTime,
            error: err.message
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            status: 'offline',
            statusCode: 504,
            latency: timeoutMs,
            error: 'Timeout'
          });
        });

        req.end();
      } catch (err) {
        resolve({
          status: 'offline',
          statusCode: null,
          latency: null,
          error: err.message
        });
      }
    });
  }

  async runHealthChecks() {
    const mainDom = this.store.config.mainDomain;
    const p1 = this.store.config.playlists.primary;
    const b1 = this.store.config.playlists.backup1;
    const b2 = this.store.config.playlists.backup2;

    const [mainRes, p1Res, b1Res, b2Res] = await Promise.all([
      this.pingUrl(mainDom),
      this.pingUrl(p1),
      this.pingUrl(b1),
      this.pingUrl(b2)
    ]);

    this.store.healthChecks = {
      lastChecked: new Date().toISOString(),
      mainDomain: mainRes,
      primary: p1Res,
      backup1: b1Res,
      backup2: b2Res
    };

    this.saveStore();
    return this.store.healthChecks;
  }

  // =========================================================================
  // CENTRAL DE FEEDBACK (MENSAGENS & SAC)
  // =========================================================================
  checkRateLimit(ip) {
    const limitConf = this.store.settings.rateLimit || { maxRequests: 5, windowMinutes: 10 };
    const maxReq = limitConf.maxRequests || 5;
    const windowMs = (limitConf.windowMinutes || 10) * 60 * 1000;
    const now = Date.now();

    const history = this.ipRateLimits.get(ip) || [];
    const validHistory = history.filter(ts => (now - ts) < windowMs);

    if (validHistory.length >= maxReq) {
      return false; // Bloqueado
    }

    validHistory.push(now);
    this.ipRateLimits.set(ip, validHistory);
    return true; // Permitido
  }

  async addFeedback({ tipo, mensagem, ip = '' }) {
    const cleanTipo = ['reclamacao', 'sugestao', 'observacao'].includes(String(tipo).toLowerCase())
      ? String(tipo).toLowerCase()
      : 'observacao';

    const cleanMsg = String(mensagem || '').trim();
    if (!cleanMsg) {
      throw new Error('A mensagem não pode estar vazia.');
    }

    const item = {
      id: 'fb_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toISOString(),
      tipo: cleanTipo,
      mensagem: cleanMsg,
      ip: ip ? ip.replace(/:+ffff:/g, '') : 'Desconhecido',
      status: 'unread'
    };

    this.store.feedbacks.unshift(item);
    if (this.store.feedbacks.length > 500) {
      this.store.feedbacks = this.store.feedbacks.slice(0, 500);
    }
    this.saveStore();

    // Dispara alerta no Telegram se configurado
    this.dispatchTelegramNotification(item).catch(err => {
      console.warn('[Admin/Telegram] Erro ao enviar notificação:', err.message);
    });

    return item;
  }

  getFeedbacks({ page = 1, limit = 50, tipo = '', status = '', search = '' } = {}) {
    let list = this.store.feedbacks || [];

    if (tipo) {
      list = list.filter(f => f.tipo === tipo);
    }
    if (status) {
      list = list.filter(f => f.status === status);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(f => f.mensagem.toLowerCase().includes(q) || f.ip.includes(q));
    }

    const total = list.length;
    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      items: paginated
    };
  }

  updateFeedbackStatus(feedbackId, newStatus) {
    const fb = this.store.feedbacks.find(f => f.id === feedbackId);
    if (!fb) throw new Error('Feedback não encontrado.');
    fb.status = newStatus;
    this.saveStore();
    return fb;
  }

  deleteFeedback(feedbackId) {
    const idx = this.store.feedbacks.findIndex(f => f.id === feedbackId);
    if (idx === -1) throw new Error('Feedback não encontrado.');
    this.store.feedbacks.splice(idx, 1);
    this.saveStore();
    return true;
  }

  getFeedbackMetrics() {
    const feedbacks = this.store.feedbacks || [];
    const todayStr = new Date().toISOString().slice(0, 10);

    let reclamacoesHoje = 0;
    let sugestoesHoje = 0;
    let observacoesHoje = 0;
    let unreadCount = 0;

    for (const f of feedbacks) {
      if (f.status === 'unread') unreadCount++;
      const fDay = (f.timestamp || '').slice(0, 10);
      if (fDay === todayStr) {
        if (f.tipo === 'reclamacao') reclamacoesHoje++;
        else if (f.tipo === 'sugestao') sugestoesHoje++;
        else if (f.tipo === 'observacao') observacoesHoje++;
      }
    }

    return {
      total: feedbacks.length,
      unreadCount,
      reclamacoesHoje,
      sugestoesHoje,
      observacoesHoje
    };
  }

  // =========================================================================
  // INTEGRAÇÃO TELEGRAM (WEBHOOK / BOT API)
  // =========================================================================
  async dispatchTelegramNotification(feedback) {
    const tg = this.store.settings.telegram;
    if (!tg || !tg.enabled || !tg.botToken || !tg.chatId) {
      return;
    }

    const emojiMap = {
      reclamacao: '🔴 *RECLAMAÇÃO*',
      sugestao: '🔵 *SUGESTÃO*',
      observacao: '🟡 *OBSERVAÇÃO*'
    };

    const label = emojiMap[feedback.tipo] || '⚪ *FEEDBACK*';
    const text = `${label} recebido no Player!\n\n` +
      `📅 *Data:* ${new Date(feedback.timestamp).toLocaleString('pt-BR')}\n` +
      `🌐 *IP:* \`${feedback.ip}\`\n\n` +
      `💬 *Mensagem:*\n${feedback.mensagem}\n\n` +
      `🔗 Acesse o Painel ADM: ${this.store.config.mainDomain}/admin`;

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        chat_id: tg.chatId,
        text: text,
        parse_mode: 'Markdown'
      });

      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${encodeURIComponent(tg.botToken)}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 8000
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            reject(new Error(`Telegram API HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram Timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // =========================================================================
  // CONFIGURAÇÕES TÉCNICAS (TELEGRAM, RATE LIMIT, CORS)
  // =========================================================================
  getSettings() {
    if (!this.store.settings) this.store.settings = {};
    if (!this.store.settings.streamMode) this.store.settings.streamMode = 'proxy';
    if (!this.store.settings.syncInterval) this.store.settings.syncInterval = '24h';
    return this.store.settings;
  }

  getStreamMode() {
    return (this.store && this.store.settings && this.store.settings.streamMode) || 'proxy';
  }

  getSyncInterval() {
    return (this.store && this.store.settings && this.store.settings.syncInterval) || '24h';
  }

  updateSettings({ telegram, rateLimit, corsAllowedDomains, streamMode, syncInterval }) {
    if (!this.store.settings) this.store.settings = {};

    if (streamMode && ['direct', 'proxy'].includes(streamMode)) {
      this.store.settings.streamMode = streamMode;
    }

    if (syncInterval && ['manual', '24h', '12h', '30m'].includes(syncInterval)) {
      this.store.settings.syncInterval = syncInterval;
    }

    if (telegram) {
      this.store.settings.telegram = {
        enabled: Boolean(telegram.enabled),
        botToken: String(telegram.botToken || '').trim(),
        chatId: String(telegram.chatId || '').trim()
      };
    }

    if (rateLimit) {
      this.store.settings.rateLimit = {
        maxRequests: Math.max(1, parseInt(rateLimit.maxRequests || 5, 10)),
        windowMinutes: Math.max(1, parseInt(rateLimit.windowMinutes || 10, 10))
      };
    }

    if (corsAllowedDomains !== undefined) {
      this.store.settings.corsAllowedDomains = String(corsAllowedDomains || '*').trim();
    }

    this.saveStore();
    return this.store.settings;
  }

  // =========================================================================
  // MONITORAMENTO DE ACESSOS, GEOLOCALIZAÇÃO POR IP & MENSAGENS CRIPTOGRAFADAS
  // =========================================================================
  async lookupIpLocation(ip) {
    if (!ip) return { city: 'Desconhecida', region: '', country: 'Brasil', isp: '' };
    const cleanIp = String(ip).replace('::ffff:', '').trim();
    if (cleanIp === '127.0.0.1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.') || cleanIp.includes('Localhost')) {
      return { city: 'Rede Local', region: 'Localhost', country: 'Brasil', isp: 'Desenvolvimento' };
    }
    if (this.ipGeoCache.has(cleanIp)) {
      return this.ipGeoCache.get(cleanIp);
    }

    try {
      const loc = await new Promise((resolve) => {
        const req = http.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,regionName,city,isp`, { timeout: 3500 }, (res) => {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => {
            try {
              const data = JSON.parse(raw);
              if (data && data.status === 'success') {
                resolve({
                  city: data.city || 'Desconhecida',
                  region: data.regionName || '',
                  country: data.country || 'Brasil',
                  isp: data.isp || ''
                });
                return;
              }
            } catch (e) {}
            resolve({ city: 'Brasil', region: '', country: 'Brasil', isp: '' });
          });
        });
        req.on('error', () => resolve({ city: 'Brasil', region: '', country: 'Brasil', isp: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ city: 'Brasil', region: '', country: 'Brasil', isp: '' }); });
      });

      this.ipGeoCache.set(cleanIp, loc);
      return loc;
    } catch (e) {
      return { city: 'Brasil', region: '', country: 'Brasil', isp: '' };
    }
  }

  // Criptografa objeto com AES-256-CBC com fallback para conexões HTTP (insecure context)
  encryptPayload(payloadObj) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.messageSecret, iv);
    const jsonStr = JSON.stringify(payloadObj);
    let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
      iv: iv.toString('hex'),
      payload: encrypted,
      plain: payloadObj // Garante compatibilidade e execução em conexões HTTP por IP da VPS
    };
  }

  // Envia mensagem criptografada (para um usuário específico ou para todos)
  sendEncryptedMessage({ targetSessionId, title = 'Aviso da Administração', text, type = 'info' }) {
    if (!text || !text.trim()) throw new Error('O texto da mensagem é obrigatório.');
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const messageData = {
      id: msgId,
      title: title || 'Aviso da Administração',
      text: text.trim(),
      type: type || 'info',
      timestamp: new Date().toISOString()
    };
    const encrypted = this.encryptPayload(messageData);
    encrypted.id = msgId;

    if (targetSessionId === 'ALL') {
      this.broadcastMessages.push(encrypted);
      this.logEvent('INFO', 'MENSAGENS', `Mensagem transmitida para TODOS os usuários: "${text.substring(0, 35)}..."`);
      return { success: true, count: this.activeSessions.size, broadcast: true };
    } else {
      const queue = this.sessionMessages.get(targetSessionId) || [];
      queue.push(encrypted);
      this.sessionMessages.set(targetSessionId, queue);

      // Também registra pelo UUID e IP caso o cliente tenha renovado sessionId ao recarregar a página
      const targetSession = this.activeSessions.get(targetSessionId);
      if (targetSession) {
        if (targetSession.uuid) {
          const uQueue = this.sessionMessages.get('uuid_' + targetSession.uuid) || [];
          uQueue.push(encrypted);
          this.sessionMessages.set('uuid_' + targetSession.uuid, uQueue);
        }
        if (targetSession.ip) {
          const ipQueue = this.sessionMessages.get('ip_' + targetSession.ip) || [];
          ipQueue.push(encrypted);
          this.sessionMessages.set('ip_' + targetSession.ip, ipQueue);
        }
      }

      this.logEvent('INFO', 'MENSAGENS', `Mensagem enviada para sessão ${targetSessionId}: "${text.substring(0, 35)}..."`);
      return { success: true, targetSessionId, broadcast: false };
    }
  }

  // Dispara comando remoto criptografado para dispositivo do usuário (Reprodução Imediata ou Pop-up com Ação)
  sendRemoteCommand({ targetSessionId, commandType = 'force_play', contentType = 'catalog', item = null, url = null, title = '', message = '', buttonText = 'Assistir Agora', linkType = 'auto', openMode = 'redirect' }) {
    if (contentType === 'url' && !url) {
      throw new Error('A URL de destino é obrigatória para o comando.');
    }
    if (contentType === 'catalog' && !item) {
      throw new Error('O conteúdo do catálogo é obrigatório para o comando.');
    }

    const cmdId = 'cmd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const commandPayload = {
      id: cmdId,
      isRemoteCommand: true,
      commandType: commandType || 'force_play', // 'force_play' | 'interactive_popup'
      contentType: contentType || 'catalog',   // 'catalog' | 'url'
      item: item || null,
      url: url || null,
      title: title || (commandType === 'force_play' ? 'Abertura Remota' : 'Recomendação Especial'),
      text: message || (commandType === 'force_play' ? 'Abertura forçada pela administração.' : 'O administrador liberou este conteúdo exclusivo para você!'),
      buttonText: buttonText || 'Acessar Link',
      linkType: linkType || 'auto',             // 'auto' | 'video' | 'web'
      openMode: openMode || 'redirect',         // 'redirect' | 'new_tab'
      timestamp: new Date().toISOString()
    };

    const encrypted = this.encryptPayload(commandPayload);
    encrypted.id = cmdId;
    encrypted.isRemoteCommand = true;

    const itemName = item ? (item.name || item.title || 'Conteúdo do Catálogo') : url;
    const isBroadcast = !targetSessionId || targetSessionId === 'ALL' || targetSessionId === 'all';
    if (isBroadcast) {
      this.broadcastMessages.push(encrypted);
      this.logEvent('INFO', 'COMANDO_REMOTO', `Comando "${commandType}" (${contentType}: ${itemName}) transmitido para TODOS os usuários.`);
      return { success: true, count: this.activeSessions.size, broadcast: true, commandId: cmdId };
    } else {
      const queue = this.sessionMessages.get(targetSessionId) || [];
      queue.push(encrypted);
      this.sessionMessages.set(targetSessionId, queue);

      // Também registra pelo UUID e IP caso o dispositivo mobile tenha mudado de sessionId ao recarregar a página
      const targetSession = this.activeSessions.get(targetSessionId);
      if (targetSession) {
        if (targetSession.uuid) {
          const uQueue = this.sessionMessages.get('uuid_' + targetSession.uuid) || [];
          uQueue.push(encrypted);
          this.sessionMessages.set('uuid_' + targetSession.uuid, uQueue);
        }
        if (targetSession.ip) {
          const ipQueue = this.sessionMessages.get('ip_' + targetSession.ip) || [];
          ipQueue.push(encrypted);
          this.sessionMessages.set('ip_' + targetSession.ip, ipQueue);
        }
      }

      this.logEvent('INFO', 'COMANDO_REMOTO', `Comando "${commandType}" (${contentType}: ${itemName}) enviado para sessão ${targetSessionId}.`);
      return { success: true, targetSessionId, broadcast: false, commandId: cmdId };
    }
  }

  // Retorna mensagens pendentes para a sessão e remove da fila
  getPendingMessagesForSession(sessionId, uuid = null, ip = null) {
    const list = [];
    const seenIds = new Set();

    const addFromKey = (k) => {
      if (!k) return;
      const msgs = this.sessionMessages.get(k);
      if (msgs && msgs.length) {
        for (const m of msgs) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            list.push(m);
          }
        }
        this.sessionMessages.delete(k);
      }
    };

    addFromKey(sessionId);
    if (uuid) addFromKey('uuid_' + uuid);
    if (ip) addFromKey('ip_' + ip);

    let delivered = this.deliveredBroadcasts.get(sessionId);
    if (!delivered) {
      delivered = new Set();
      this.deliveredBroadcasts.set(sessionId, delivered);
    }
    for (const bMsg of this.broadcastMessages) {
      if (!delivered.has(bMsg.id)) {
        delivered.add(bMsg.id);
        if (!seenIds.has(bMsg.id)) {
          seenIds.add(bMsg.id);
          list.push(bMsg);
        }
      }
    }
    return list;
  }

  recordHeartbeat({ sessionId, uuid, ip, userAgent, currentTitle, itemType, durationSeconds, profile, donationStats }) {
    if (!sessionId) return { success: false, messages: [] };
    const now = Date.now();
    const effectiveUuid = (uuid && String(uuid).trim()) || (profile && profile.uuid ? String(profile.uuid).trim() : sessionId);
    
    // Detecta tipo de dispositivo amigável
    let device = 'Desktop (Web)';
    const ua = (userAgent || '').toLowerCase();
    if (ua.includes('smart-tv') || ua.includes('tizen') || ua.includes('web0s') || ua.includes('applecoremedia')) {
      device = 'Smart TV';
    } else if (ua.includes('android')) {
      device = ua.includes('mobile') ? 'Celular Android' : 'Android TV / Box';
    } else if (ua.includes('iphone')) {
      device = 'Apple iPhone';
    } else if (ua.includes('ipad')) {
      device = 'Apple iPad';
    } else if (ua.includes('windows')) {
      device = 'Windows PC';
    } else if (ua.includes('macintosh') || ua.includes('mac os')) {
      device = 'Mac OS';
    } else if (ua.includes('linux')) {
      device = 'Linux';
    }

    let cleanIp = String(ip || '').trim();
    if (cleanIp === '::1' || cleanIp === '1') {
      cleanIp = '127.0.0.1 (Localhost)';
    } else if (cleanIp.startsWith('::ffff:')) {
      cleanIp = cleanIp.replace('::ffff:', '');
    }

    const userProfile = {
      name: (profile && profile.name) ? String(profile.name).trim() : 'Visitante',
      gender: (profile && profile.gender) ? String(profile.gender).trim() : 'Não informado',
      age: (profile && profile.age !== undefined && profile.age !== null) ? parseInt(profile.age, 10) : null,
      city: (profile && profile.city) ? String(profile.city).trim() : '',
      avatar: (profile && profile.avatar) ? String(profile.avatar).trim() : 'user',
      isAdultConfirmed: (profile && (profile.isAdultConfirmed === true || profile.isAdultConfirmed === 'true')) || false,
      adultConfirmedAt: (profile && profile.adultConfirmedAt) ? profile.adultConfirmedAt : null,
      uuid: effectiveUuid
    };

    const donationsCount = (donationStats && typeof donationStats.donationsCount === 'number')
      ? donationStats.donationsCount
      : ((profile && typeof profile.donationsCount === 'number') ? profile.donationsCount : 0);

    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      existing.uuid = effectiveUuid;
      existing.donationsCount = donationsCount;
      existing.lastHeartbeat = now;
      existing.currentTitle = currentTitle || existing.currentTitle || 'Navegando no Catálogo';
      existing.itemType = itemType || existing.itemType || 'browsing';
      existing.ip = cleanIp;
      existing.userAgent = userAgent || existing.userAgent;
      existing.device = device;
      existing.durationSeconds = Math.round((now - existing.connectedAt) / 1000);
      if (profile) {
        existing.profile = {
          ...existing.profile,
          ...userProfile,
          isAdultConfirmed: userProfile.isAdultConfirmed || (existing.profile && existing.profile.isAdultConfirmed) || false,
          adultConfirmedAt: userProfile.adultConfirmedAt || (existing.profile && existing.profile.adultConfirmedAt) || null
        };
      }
    } else {
      const sessObj = {
        id: sessionId,
        uuid: effectiveUuid,
        donationsCount: donationsCount,
        ip: cleanIp,
        device: device,
        userAgent: userAgent || '',
        currentTitle: currentTitle || 'Navegando no Catálogo',
        itemType: itemType || 'browsing',
        connectedAt: now,
        lastHeartbeat: now,
        durationSeconds: 0,
        profile: userProfile,
        location: { city: 'Buscando...', region: '', country: 'Brasil', isp: '' }
      };
      this.activeSessions.set(sessionId, sessObj);

      // Busca geolocalização por IP em segundo plano
      this.lookupIpLocation(cleanIp).then(loc => {
        if (this.activeSessions.has(sessionId)) {
          this.activeSessions.get(sessionId).location = loc;
        }
      });
    }

    // Registra na base de usuários conhecidos
    this.knownUsers.set(effectiveUuid, {
      uuid: effectiveUuid,
      name: userProfile.name,
      gender: userProfile.gender,
      age: userProfile.age,
      city: userProfile.city || cleanIp,
      device: device,
      lastIp: cleanIp,
      lastSeen: new Date(now).toISOString(),
      donationsCount: donationsCount,
      isOnline: true
    });

    // Prune sessões antigas (> 75s sem heartbeat)
    for (const [sId, sess] of this.activeSessions.entries()) {
      if (now - sess.lastHeartbeat > 75000) {
        this.activeSessions.delete(sId);
        this.deliveredBroadcasts.delete(sId);
        this.sessionMessages.delete(sId);
      }
    }

    // Retorna mensagens pendentes para o cliente (busca por sessionId, UUID e IP)
    const pending = this.getPendingMessagesForSession(sessionId, effectiveUuid, cleanIp);

    // Consulta e sincroniza overrides e gateway para o cliente
    const overrides = this.getUserOverrides(effectiveUuid);
    if (donationStats && donationStats.forceDonationAcknowledged && overrides && overrides.forceDonation) {
      this.setUserOverride(effectiveUuid, { forceDonation: false });
    }
    const hasGateway = Boolean(this.store.paymentGateway && this.store.paymentGateway.apiKey && this.store.paymentGateway.apiKey.trim().length > 0);

    return {
      success: true,
      timestamp: now,
      messages: pending,
      gatewayActive: hasGateway,
      userOverrides: overrides || null
    };
  }

  getActiveSessions() {
    const now = Date.now();
    const list = [];
    for (const [sId, sess] of this.activeSessions.entries()) {
      if (now - sess.lastHeartbeat <= 75000) {
        const uId = sess.uuid || sId;
        list.push({
          id: sess.id,
          uuid: uId,
          ip: sess.ip,
          device: sess.device,
          currentTitle: sess.currentTitle,
          itemType: sess.itemType,
          connectedAt: new Date(sess.connectedAt).toISOString(),
          durationSeconds: Math.round((now - sess.connectedAt) / 1000),
          lastSeenSeconds: Math.round((now - sess.lastHeartbeat) / 1000),
          donationsCount: sess.donationsCount || 0,
          profile: sess.profile || { name: 'Visitante', gender: 'Não informado', age: null, city: '', avatar: 'user' },
          location: sess.location || { city: 'Rede Local', region: '', country: 'Brasil', isp: '' },
          userOverrides: this.getUserOverrides(uId)
        });
      } else {
        this.activeSessions.delete(sId);
        this.deliveredBroadcasts.delete(sId);
        this.sessionMessages.delete(sId);
      }
    }
    list.sort((a, b) => b.durationSeconds - a.durationSeconds);
    return list;
  }

  terminateSession(sessionId) {
    this.deliveredBroadcasts.delete(sessionId);
    this.sessionMessages.delete(sessionId);
    return this.activeSessions.delete(sessionId);
  }

  /**
   * Terminal de Logs do Sistema em Tempo Real
   */
  logEvent(level, category, message, meta = {}) {
    const logItem = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      timestamp: new Date().toISOString(),
      level: (level || 'INFO').toUpperCase(), // INFO, STREAM, WARN, ERROR, AUTH, SISTEMA
      category: (category || 'SISTEMA').toUpperCase(), // STREAMING, SEGURANÇA, LISTAS, METADADOS, SISTEMA, FEEDBACK
      message: String(message || ''),
      ip: meta.ip || meta.clientIp || '127.0.0.1',
      details: meta.details || meta.userAgent || meta.target || ''
    };

    if (!Array.isArray(this.systemLogs)) {
      this.systemLogs = [];
    }

    this.systemLogs.unshift(logItem);
    if (this.systemLogs.length > (this.maxLogs || 1000)) {
      this.systemLogs.pop();
    }
    return logItem;
  }

  getLogs({ limit = 150, level = 'ALL', category = 'ALL', search = '' } = {}) {
    if (!Array.isArray(this.systemLogs)) {
      this.systemLogs = [];
    }

    let filtered = this.systemLogs;

    if (level && level !== 'ALL') {
      const l = level.toUpperCase();
      filtered = filtered.filter(item => item.level === l);
    }

    if (category && category !== 'ALL') {
      const c = category.toUpperCase();
      filtered = filtered.filter(item => item.category === c);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(item => 
        (item.message && item.message.toLowerCase().includes(q)) ||
        (item.ip && item.ip.toLowerCase().includes(q)) ||
        (item.category && item.category.toLowerCase().includes(q)) ||
        (item.details && item.details.toLowerCase().includes(q))
      );
    }

    const totalStreams = this.systemLogs.filter(l => l.level === 'STREAM').length;
    const totalErrors = this.systemLogs.filter(l => l.level === 'ERROR').length;
    const totalWarnings = this.systemLogs.filter(l => l.level === 'WARN').length;
    const totalAuth = this.systemLogs.filter(l => l.level === 'AUTH').length;

    return {
      total: this.systemLogs.length,
      filteredCount: filtered.length,
      logs: filtered.slice(0, parseInt(limit, 10) || 150),
      metrics: {
        totalEvents: this.systemLogs.length,
        totalStreams,
        totalErrors,
        totalWarnings,
        totalAuth
      }
    };
  }

  clearLogs() {
    this.systemLogs = [];
    this.logEvent('INFO', 'SISTEMA', 'Terminal de logs limpo pelo administrador.');
    return true;
  }

  // =========================================================================
  // CONFIGURAÇÕES DE PAGAMENTO (GATEWAY DE DOAÇÃO)
  // =========================================================================
  getPaymentGatewayConfig() {
    if (!this.store.paymentGateway) {
      this.store.paymentGateway = { apiKey: '' };
    }
    const key = String(this.store.paymentGateway.apiKey || '').trim();
    return {
      apiKey: key,
      isActive: Boolean(key.length > 0),
      updatedAt: this.store.paymentGateway.updatedAt || null
    };
  }

  updatePaymentGatewayConfig({ apiKey }) {
    if (!this.store.paymentGateway) {
      this.store.paymentGateway = { apiKey: '' };
    }
    const cleanKey = String(apiKey || '').trim();
    this.store.paymentGateway.apiKey = cleanKey;
    this.store.paymentGateway.updatedAt = new Date().toISOString();
    this.saveStore();

    const isActive = Boolean(cleanKey.length > 0);
    this.logEvent('INFO', 'CONFIG_PAGAMENTO', `Gateway de pagamento atualizado. Motor de doação: ${isActive ? 'ATIVADO' : 'DESLIGADO (Modo 100% Gratuito)'}`);
    return this.getPaymentGatewayConfig();
  }

  // =========================================================================
  // GESTÃO INDIVIDUAL DE USUÁRIOS VIA UUID (CONTROLE & OVERRIDES)
  // =========================================================================
  getUserOverrides(uuid) {
    if (!uuid) return null;
    if (!this.store.userOverrides) this.store.userOverrides = {};
    return this.store.userOverrides[uuid] || null;
  }

  setUserOverride(uuid, data = {}) {
    if (!uuid) throw new Error('UUID do dispositivo é obrigatório.');
    if (!this.store.userOverrides) this.store.userOverrides = {};

    const existing = this.store.userOverrides[uuid] || {};
    let customInitial = existing.customInitialValues || null;
    if (data.customInitialValues !== undefined) {
      if (Array.isArray(data.customInitialValues)) {
        customInitial = data.customInitialValues.map(Number).filter(n => !isNaN(n) && n > 0);
      } else if (typeof data.customInitialValues === 'string') {
        const parsed = data.customInitialValues.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
        customInitial = parsed.length > 0 ? parsed : null;
      } else if (data.customInitialValues === null) {
        customInitial = null;
      }
    }

    let customRecurring = existing.customRecurringValues || null;
    if (data.customRecurringValues !== undefined) {
      if (Array.isArray(data.customRecurringValues)) {
        customRecurring = data.customRecurringValues.map(Number).filter(n => !isNaN(n) && n > 0);
      } else if (typeof data.customRecurringValues === 'string') {
        const parsed = data.customRecurringValues.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
        customRecurring = parsed.length > 0 ? parsed : null;
      } else if (data.customRecurringValues === null) {
        customRecurring = null;
      }
    }

    const updated = {
      ...existing,
      uuid: String(uuid).trim(),
      name: data.name !== undefined ? String(data.name).trim() : (existing.name || ''),
      abolishDonation: data.abolishDonation !== undefined ? Boolean(data.abolishDonation) : Boolean(existing.abolishDonation),
      forceDonation: data.forceDonation !== undefined ? Boolean(data.forceDonation) : Boolean(existing.forceDonation),
      customInitialValues: customInitial,
      customRecurringValues: customRecurring,
      updatedAt: new Date().toISOString()
    };

    this.store.userOverrides[uuid] = updated;
    this.saveStore();
    this.logEvent('INFO', 'USUARIOS', `Sobreposições atualizadas para o UUID "${uuid}" (${updated.name || 'Anônimo'})`);
    return updated;
  }

  getUsersControlList() {
    const list = [];
    const seenUuids = new Set();
    const now = Date.now();

    // 1. Usuários de sessões ativas
    for (const [sId, sess] of this.activeSessions.entries()) {
      const uId = sess.uuid || sId;
      if (!seenUuids.has(uId)) {
        seenUuids.add(uId);
        const override = this.getUserOverrides(uId);
        list.push({
          uuid: uId,
          name: (sess.profile && sess.profile.name) ? sess.profile.name : 'Visitante',
          gender: (sess.profile && sess.profile.gender) ? sess.profile.gender : 'Não informado',
          age: (sess.profile && sess.profile.age) ? sess.profile.age : null,
          device: sess.device,
          ip: sess.ip,
          location: sess.location,
          lastSeen: new Date(sess.lastHeartbeat).toISOString(),
          isOnline: (now - sess.lastHeartbeat <= 75000),
          donationsCount: sess.donationsCount || 0,
          currentTitle: sess.currentTitle,
          overrides: override || { abolishDonation: false, forceDonation: false, customInitialValues: null, customRecurringValues: null }
        });
      }
    }

    // 2. Usuários conhecidos offline
    for (const [uId, uData] of this.knownUsers.entries()) {
      if (!seenUuids.has(uId)) {
        seenUuids.add(uId);
        const override = this.getUserOverrides(uId);
        list.push({
          uuid: uId,
          name: uData.name || (override && override.name) || 'Usuário Registrado',
          gender: uData.gender || 'Não informado',
          age: uData.age || null,
          device: uData.device || 'Desconhecido',
          ip: uData.lastIp || '',
          location: { city: uData.city || 'Desconhecida', country: 'Brasil' },
          lastSeen: uData.lastSeen || new Date().toISOString(),
          isOnline: false,
          donationsCount: uData.donationsCount || 0,
          currentTitle: 'Offline',
          overrides: override || { abolishDonation: false, forceDonation: false, customInitialValues: null, customRecurringValues: null }
        });
      }
    }

    // 3. Overrides salvos sem sessão ativa no momento
    if (this.store.userOverrides) {
      for (const [uId, override] of Object.entries(this.store.userOverrides)) {
        if (!seenUuids.has(uId)) {
          seenUuids.add(uId);
          list.push({
            uuid: uId,
            name: override.name || 'Usuário Configurado',
            gender: 'Não informado',
            age: null,
            device: 'Dispositivo Registrado',
            ip: '',
            location: { city: 'Desconhecida', country: 'Brasil' },
            lastSeen: override.updatedAt || new Date().toISOString(),
            isOnline: false,
            donationsCount: 0,
            currentTitle: 'Offline',
            overrides: override
          });
        }
      }
    }

    list.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return new Date(b.lastSeen) - new Date(a.lastSeen);
    });

    return list;
  }
}

module.exports = new AdminManager();
