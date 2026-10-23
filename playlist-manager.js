const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const epgManager = require('./epg-manager');

// Chave secreta de 32 bytes para criptografia AES-256
const SECRET_KEY = crypto.createHash('sha256').update('netflix-iptv-super-secret-key-2026').digest();
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'data');
const PLAYLIST_FILE = path.join(DATA_DIR, 'playlist.m3u');
const CACHE_FILE = path.join(DATA_DIR, 'catalog_cache.json');
const SEED_CACHE_FILE = path.join(__dirname, 'data', 'catalog_cache.json');
const GZ_CACHE_FILE = path.join(__dirname, 'data', 'catalog_cache.json.gz');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

class PlaylistManager {
  constructor() {
    this.playlistUrl = process.env.PLAYLIST_URL || 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8';
    this.channels = [];
    this.movies = [];
    this.series = []; // Séries únicas (Cards)
    this.seriesById = new Map(); // Mapa de Séries por ID com todas as temporadas e episódios
    this.totalEpisodesCount = 0;
    this.groupsMap = new Map();
    this.heroItem = null;
    this.prebuilt = null;
    this.isReady = false;
    this.isDownloading = false;
    this.catalogVersion = 1;
    this.lastUpdated = null;
    this.autoUpdateTimer = null;
  }

  setPlaylistUrl(url) {
    if (url && typeof url === 'string') {
      this.playlistUrl = url.trim();
    }
  }

  /**
   * Criptografa uma URL de stream (AES-256-CBC)
   */
  encryptUrl(targetUrl) {
    if (!targetUrl) return '';
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
      let encrypted = cipher.update(targetUrl, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return iv.toString('hex') + ':' + encrypted;
    } catch (e) {
      console.error('Erro na criptografia da URL:', e);
      return '';
    }
  }

  /**
   * Descriptografa um token recebido do player
   */
  decryptUrl(token) {
    if (!token) return null;
    try {
      let cleanToken = String(token);
      try { cleanToken = decodeURIComponent(cleanToken); } catch(e) {}
      cleanToken = cleanToken.replace(/\.(mp4|m3u8|ts|mkv)$/i, '');
      const parts = cleanToken.split(':');
      if (parts.length !== 2) return null;
      const iv = Buffer.from(parts[0], 'hex');
      const encryptedText = parts[1];
      const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      console.error('Falha ao descriptografar token:', e.message);
      return null;
    }
  }

  /**
   * Helper para identificação de grupos e conteúdos adultos (+18)
   */
  isAdultGroup(group) {
    if (!group) return false;
    const g = String(group).toLowerCase();
    return /\b(adult|adulto|adultos|porn|porno|pornô|erotic|erótica|erótico|sexy|sensual|playboy|venus|for man|penthouse|hustler|redlight|brazzers|privé|prive)\b/i.test(g) ||
           /\bxxx\b/i.test(g) ||
           g.includes('+18') || g.includes('18+') || g.includes('🔞');
  }

  isAdultItem(item) {
    if (!item) return false;
    if (item.isAdult === true) return true;
    if (this.isAdultGroup(item.group)) return true;
    const n = String(item.name || item.rawTitle || '').toLowerCase();
    if (/xxx\s*[:\-]\s*(reativado|state of the union|triplo x)/i.test(n)) {
      return false;
    }
    if (/horrores\s+xxx|black\s+sails.*xxx|velas\s+negras.*xxx/i.test(n)) {
      return false;
    }
    return /^(xxx\b|xxx\.|\+18|18\+)/i.test(n.trim()) ||
           /\b(porn|porno|pornô|pornstar|pornoxplotaci[oó]n|erotic|erótica|erótico|penthouse|hustler|redlight|brazzers|brasileirinhas|teste de fudelidade|sexy hot)\b/i.test(n) ||
           n.includes('+18') || n.includes('18+') || n.includes('🔞');
  }

  /**
   * Helper para identificação de grupos e conteúdos infantis / Kids / Menor de Idade
   */
  isKidsGroup(group) {
    if (!group) return false;
    if (this.isAdultGroup(group)) return false;
    const g = String(group).toLowerCase();
    if (/\b(terror|crime|crimes|guerra|assassin|massacre|xxx|adulto|adultos)\b/i.test(g)) return false;
    return /infantil|animação|animacao|desenho|desenhos|\bkids\b|gloob|\bnick\b|nickelodeon|cartoon/i.test(g);
  }

  isKidsItem(item) {
    if (!item) return false;
    if (this.isAdultItem(item)) return false;
    const g = String(item.group || '').toLowerCase();
    const n = String(item.name || item.title || item.rawTitle || '').toLowerCase();
    if (/\b(terror|crime|crimes|guerra|assassin|massacre|xxx|adulto|adultos|\+18|18\+)\b/i.test(g) ||
        /\b(terror|massacre|assassin|erotic|sexy|\+18|18\+)\b/i.test(n)) {
      return false;
    }
    // 1. Pertence a grupo 100% infantil/animação
    if (this.isKidsGroup(item.group)) return true;

    // 2. Canais infantis específicos (mesmo que estejam em grupos mistos como MAX e Disney+)
    if (item.itemType === 'live') {
      return /disney\s*(channel|jr|junior|xd)|cartoon|gloob|discovery\s*kids|nick|nickelodeon|baby\s*tv|tooncast|tooncami|desenho|animax|tv\s*ra\s*tim\s*bum/i.test(n);
    }

    // 3. Filmes ou Séries com temáticas/personagens reconhecidamente infantis
    return /infantil|animação|animacao|desenho|kids|disney|pixar|dreamworks|minions|shrek|patrulha canina|peppa|bob esponja|miraculous|bluey|turma da mônica|monica|galinha pintadinha|masha|ben 10|cartoon|looney|tom e jerry|scooby|toy story|carros|frozen|moana|divertida mente|encanto|rei leão|mulan|tarzan|nemo|dory|madagascar|kung fu panda|como treinar o seu dragão|hotel transilvânia|aladdin|bela e a fera|monstros s\.a|valente|zootopia|pocahontas|hercules|pinóquio|bambi|dumbo|ursinho pooh|chaves|tartarugas ninja/i.test(n);
  }

  /**
   * Identifica a Classificação Indicativa Oficial (L, 10, 12, 14, 16, 18)
   */
  getContentRating(item) {
    if (!item) return 'L';
    const name = String(item.name || item.rawTitle || item.title || '').trim();
    const group = String(item.group || '').toLowerCase();

    // 1. Verificação explícita na nomenclatura oficial (ex: "(L)", "(10)", "(12)", "(14)", "(16)", "(18)", "+18", "+16")
    const match = name.match(/\((\s*(?:L|10|12|14|16|18)\s*)\)/i) || 
                  name.match(/\[(\s*(?:L|10|12|14|16|18)\s*)\]/i) ||
                  name.match(/\+(\s*(?:10|12|14|16|18)\s*)/i);
    if (match) {
      const tag = match[1].trim().toUpperCase();
      if (['L', '10', '12', '14', '16', '18'].includes(tag)) return tag;
    }

    // 2. Conteúdos Adultos (+18)
    if (this.isAdultItem(item) || this.isAdultGroup(group)) {
      return '18';
    }

    // 3. Infantil / Desenhos / Bebê / Família / Animação (L ou 10)
    if (this.isKidsItem(item) || this.isKidsGroup(group) || /infantil|kids|desenho|baby|gloob|cartoon|disney|fam[ií]lia|anima[cç][aã]o/i.test(group)) {
      return 'L';
    }

    // 4. Conteúdos Terror / Horror / Sangue / Violência Explícita (+16)
    if (/terror|horror|sangue|massacre|gore|slasher/i.test(group) || /terror|horror|massacre/i.test(name)) {
      return '16';
    }

    // 5. Ação Intensa, Suspense, Crime, Investigação, Guerra (+14)
    if (/crime|policial|investig|guerra|suspense|tiro|mafia/i.test(group) || /crime|guerra|assass/i.test(name) || /\b(a[cç][aã]o|action|adrenalina)\b/i.test(group)) {
      return '14';
    }

    // 6. Ficção, Comédia, Aventura, Fantasia, Animes (+12 ou 10)
    if (/anime|fic[cç][aã]o|fantasia|drama/i.test(group)) {
      return '12';
    }
    if (/aventura|com[eé]dia/i.test(group)) {
      return '10';
    }

    if (item.itemType === 'live') return 'L';
    return '12';
  }

  /**
   * Extração segura de atributos e título de linha #EXTINF (suporta vírgulas em aspas)
   */
  parseExtinf(line) {
    let inQuotes = false;
    let splitIndex = -1;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) return null;

    for (let i = colonIndex + 1; i < line.length; i++) {
      const char = line[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) {
        splitIndex = i;
        break;
      }
    }

    if (splitIndex === -1) return null;
    const rawAttrs = line.substring(colonIndex + 1, splitIndex);
    const title = line.substring(splitIndex + 1).trim();

    const attrs = {};
    const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(rawAttrs)) !== null) {
      attrs[match[1].toLowerCase()] = match[2];
    }

    return { attrs, title };
  }

  /**
   * Analisador de Título de Episódio de Série:
   * Extrai o nome limpo da Série, número da Temporada, Episódio e Título do Episódio
   */
  parseSeriesTitle(rawTitle) {
    let seriesName = rawTitle;
    let season = 1;
    let episode = 1;
    let episodeTitle = '';

    const seMatch = rawTitle.match(/[\s\-_]+[SsTt](\d{1,3})[\s\.\-_]*[Ee](\d{1,3})(?:[\s\-_]+(.*))?$/i);
    if (seMatch) {
      season = parseInt(seMatch[1], 10);
      episode = parseInt(seMatch[2], 10);
      episodeTitle = (seMatch[3] || '').trim();

      const beforeSE = rawTitle.substring(0, seMatch.index).trim();
      const sMatch = beforeSE.match(/^(.*?)(?:[\s\-_]+[SsTt](\d{1,3}))(?:\s+(.*))?$/);
      if (sMatch) {
        seriesName = sMatch[1].trim();
      } else {
        seriesName = beforeSE.replace(/[\-_]+$/, '').trim();
      }
    } else {
      const altMatch = rawTitle.match(/^(.*?)(?:[\s\-_]+[SsTt](\d{1,3}))[\s\-_]+(?:E|EP|Episódio|Capítulo)[\s\-_]*(\d+)(?:[\s\-_]+(.*))?$/i);
      if (altMatch) {
        seriesName = altMatch[1].trim();
        season = parseInt(altMatch[2], 10);
        episode = parseInt(altMatch[3], 10);
        episodeTitle = (altMatch[4] || '').trim();
      } else {
        const simpleS = rawTitle.match(/^(.*?)(?:[\s\-_]+[SsTt](\d{1,3}))(?:\s+(.*))?$/);
        if (simpleS) {
          seriesName = simpleS[1].trim();
          season = parseInt(simpleS[2], 10);
        }
      }
    }

    seriesName = seriesName
      .replace(/\s+-\s+$/, '')
      .replace(/\s+\[L\]$/, '')
      .replace(/\s+\[D\]$/, '')
      .replace(/\s+LEG$/, '')
      .replace(/\s+DUB$/, '')
      .trim();

    if (!episodeTitle) {
      episodeTitle = `Episódio ${episode}`;
    }

    return { seriesName, season, episode, episodeTitle };
  }

  async init() {
    // Carrega metadados oficiais de séries e VODs imediatamente (síncrono)
    epgManager.loadSeriesMetadata();
    epgManager.loadVodCache();

    // Inicializa download/atualização do EPG em segundo plano
    epgManager.init().catch(err => console.warn('[Manager] Aviso ao iniciar EPG:', err.message));

    // 1. Tenta carregar cache pré-compilado instantâneo (< 50ms)
    let cacheLoaded = false;
    let cached = null;

    if (fs.existsSync(CACHE_FILE)) {
      try {
        console.log('[Manager] Carregando cache pré-compilado instantâneo...');
        cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      } catch (e) {}
    } else if (fs.existsSync(SEED_CACHE_FILE)) {
      try {
        console.log('[Manager] Carregando cache pré-compilado da pasta data...');
        cached = JSON.parse(fs.readFileSync(SEED_CACHE_FILE, 'utf-8'));
      } catch (e) {}
    } else if (fs.existsSync(GZ_CACHE_FILE)) {
      try {
        console.log('[Manager] Descomprimindo catálogo pré-indexado (catalog_cache.json.gz)...');
        const zlib = require('zlib');
        const gzBuffer = fs.readFileSync(GZ_CACHE_FILE);
        const decompressed = zlib.gunzipSync(gzBuffer);
        cached = JSON.parse(decompressed.toString('utf-8'));
        try { fs.writeFileSync(CACHE_FILE, decompressed); } catch (wErr) {}
      } catch (e) {
        console.error('[Manager] Erro ao descompactar catalog_cache.json.gz:', e.message);
      }
    }

    if (cached && cached.version === 3 && cached.seriesById) {
      this.prebuilt = cached;
      this.heroItem = cached.heroItem;
      this.channels = [];
      this.movies = cached.movies || [];
      this.series = cached.series || [];
      this.totalEpisodesCount = cached.totalEpisodesCount || 0;
      this.seriesById = new Map(Object.entries(cached.seriesById).map(([k, v]) => [Number(k), v]));
      this.catalogVersion = cached.catalogVersion || Date.now();
      this.lastUpdated = cached.lastUpdated || new Date().toISOString();
      this.isReady = true;
      cacheLoaded = true;
      this.enrichSeriesWithMetadata();
      for (const m of this.movies) {
        if (!m.cover && m.logo) m.cover = m.logo;
        if (!m.backdrop && m.logo) m.backdrop = m.logo;
      }
      console.log(`[Manager] Catálogo pronto do cache! 0 canais, ${this.movies.length} filmes, ${this.series.length} séries únicas (${this.totalEpisodesCount} episódios).`);
    }

    if (!cacheLoaded) {
      if (fs.existsSync(PLAYLIST_FILE) && fs.statSync(PLAYLIST_FILE).size > 1000000) {
        console.log('[Manager] Arquivo de playlist local encontrado. Carregando e agrupando catálogo...');
        await this.parseLocalFile(PLAYLIST_FILE);
      } else {
        console.log('[Manager] Baixando playlist completa do servidor remoto...');
        await this.backgroundSync(true);
      }
    }

    // Inicia o motor de atualização automática periódica em segundo plano
    this.scheduleAutoUpdate();
  }

  /**
   * Obtém a lista de fontes configuradas no painel ADM em ordem de prioridade (Failover)
   */
  getConfiguredPlaylistTargets() {
    try {
      const adminManager = require('./admin-manager');
      const conf = adminManager.getPlaylistConfig();
      if (conf && conf.playlists) {
        const active = conf.activePlaylist || 'primary';
        const targets = [];
        const labelMap = {
          primary: 'Lista Primária',
          backup1: 'Lista Backup 1',
          backup2: 'Lista Backup 2'
        };

        if (conf.playlists[active]) {
          targets.push({ key: active, label: labelMap[active] || active, url: conf.playlists[active] });
        }
        ['primary', 'backup1', 'backup2'].forEach(k => {
          if (k !== active && conf.playlists[k]) {
            targets.push({ key: k, label: labelMap[k] || k, url: conf.playlists[k] });
          }
        });
        const valid = targets.filter(t => t.url && t.url.trim().startsWith('http'));
        if (valid.length) return valid;
      }
    } catch (e) {}

    return [{ key: 'primary', label: 'Lista Primária', url: this.playlistUrl }];
  }

  /**
   * Helper para baixar uma URL específica para arquivo local com suporte a redirect e timeout
   */
  _fetchUrlToFile(targetUrl, destinationPath, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(destinationPath);
      const isHttps = targetUrl.startsWith('https');
      const client = isHttps ? https : http;

      const req = client.get(targetUrl, {
        headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*' },
        timeout: timeoutMs
      }, (res) => {
        // Redirecionamento HTTP
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          fileStream.close();
          try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
          return this._fetchUrlToFile(res.headers.location, destinationPath, timeoutMs).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          fileStream.close();
          try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve());
        });
      });

      req.on('error', err => {
        fileStream.close();
        try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        fileStream.close();
        try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
        reject(new Error(`Timeout de leitura (${timeoutMs / 1000}s)`));
      });
    });
  }

  /**
   * Baixa a playlist com Failover Automático entre as listas cadastradas no ADM
   */
  async downloadPlaylistFile(destinationPath) {
    const targets = this.getConfiguredPlaylistTargets();
    let lastError = null;
    let adminManager = null;
    try { adminManager = require('./admin-manager'); } catch (e) {}

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        console.log(`[AutoSync] Tentando sincronizar playlist via ${target.label} (${target.url.substring(0, 50)}...)...`);
        await this._fetchUrlToFile(target.url, destinationPath, 300000);

        if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).size > 1000000) {
          console.log(`[AutoSync] Sucesso no download via ${target.label}!`);
          if (adminManager && typeof adminManager.logEvent === 'function') {
            adminManager.logEvent('INFO', 'LISTAS', `Download da playlist concluído com sucesso via ${target.label}`);
          }
          return target;
        } else {
          throw new Error('Arquivo baixado é muito pequeno ou vazio.');
        }
      } catch (err) {
        lastError = err;
        console.warn(`[AutoSync] Falha na lista ${target.label}: ${err.message}.`);
        if (adminManager && typeof adminManager.logEvent === 'function') {
          adminManager.logEvent('WARN', 'LISTAS', `Falha temporária ao baixar lista ${target.label} (${err.message}).`);
        }
      }
    }

    // Se já possuímos catálogo em memória, mantemos o acervo ativo sem interromper usuários
    if (this.channels.length > 0 || this.movies.length > 0) {
      console.warn('[AutoSync] Provedores remotos demoraram a responder no download. O catálogo existente permanece 100% ativo em memória sem quedas.');
      if (adminManager && typeof adminManager.logEvent === 'function') {
        adminManager.logEvent('INFO', 'LISTAS', 'Sincronização adiada: Provedor lento/ocupado. O catálogo atual em memória permanece 100% ativo.');
      }
      return null;
    }

    throw lastError || new Error('Nenhuma das listas IPTV configuradas pôde ser baixada com sucesso.');
  }

  downloadPlaylist() {
    return this.backgroundSync(true);
  }

  /**
   * Sincronização automática em segundo plano:
   * Baixa a lista remota, compara se houve alterações reais,
   * reindexa os conteúdos e atualiza atomicamente o catálogo em memória e em cache.
   */
  async backgroundSync(force = false) {
    if (this.isDownloading) {
      console.log('[AutoSync] Uma sincronização já está em andamento. Aguardando...');
      return { success: false, reason: 'already_syncing' };
    }

    // PROTEÇÃO CRÍTICA PARA VPS DE 1GB:
    // Se algum usuário estiver assistindo vídeo agora, NÃO baixa arquivo de 63MB para não congelar o streaming!
    if (!force && typeof this.hasActiveStreams === 'function' && this.hasActiveStreams()) {
      console.log('[AutoSync] Há reproduções ativas de vídeo no momento. Sincronização em segundo plano adiada para não interromper os usuários.');
      return { success: false, reason: 'active_streams_deferred' };
    }

    this.isDownloading = true;
    const tempFile = path.join(DATA_DIR, 'playlist.tmp.m3u');

    try {
      console.log('[AutoSync] Verificando novos conteúdos no servidor remoto IPTV...');
      const targetDownloaded = await this.downloadPlaylistFile(tempFile);

      if (!targetDownloaded || !fs.existsSync(tempFile) || fs.statSync(tempFile).size < 1000000) {
        this.isDownloading = false;
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
        return { success: true, updated: false, reason: 'kept_existing_catalog' };
      }

      const tempSize = fs.statSync(tempFile).size;
      const curSize = fs.existsSync(PLAYLIST_FILE) ? fs.statSync(PLAYLIST_FILE).size : 0;

      // Se não for forçado e a diferença de tamanho for mínima (< 512 bytes), considera inalterado
      // evitando ler 63MB duas vezes na memória RAM da VPS de 1GB
      if (!force && curSize > 0 && Math.abs(tempSize - curSize) < 512) {
        console.log('[AutoSync] O catálogo já está 100% atualizado com o provedor (tamanho inalterado).');
        try { fs.unlinkSync(tempFile); } catch (e) {}
        this.isDownloading = false;
        return { success: true, updated: false };
      }

      console.log(`[AutoSync] Nova versão da lista detectada (${(tempSize / 1024 / 1024).toFixed(2)} MB)! Reindexando catálogo em segundo plano...`);

      // Faz o parse do arquivo novo
      await this.parseLocalFile(tempFile);

      // Substitui o playlist.m3u pelo novo arquivo atualizado
      try {
        if (fs.existsSync(PLAYLIST_FILE)) fs.unlinkSync(PLAYLIST_FILE);
      } catch (e) {}
      fs.renameSync(tempFile, PLAYLIST_FILE);

      this.catalogVersion = Date.now();
      this.lastUpdated = new Date().toISOString();

      console.log(`[AutoSync] Catálogo atualizado com sucesso! Novos totais: ${this.channels.length} canais, ${this.movies.length} filmes, ${this.series.length} séries únicas (${this.totalEpisodesCount} episódios agrupados).`);

      // Atualiza também EPG se expirado
      if (typeof epgManager.updateIfExpired === 'function') {
        epgManager.updateIfExpired().catch(console.warn);
      }

      this.isDownloading = false;
      return {
        success: true,
        updated: true,
        catalogVersion: this.catalogVersion,
        lastUpdated: this.lastUpdated,
        totalChannels: this.channels.length,
        totalMovies: this.movies.length,
        totalSeries: this.series.length,
        totalEpisodes: this.totalEpisodesCount
      };

    } catch (err) {
      this.isDownloading = false;
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
      console.error('[AutoSync] Falha na sincronização automática:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Agendador automático para manter o acervo de filmes, séries e canais sempre atualizado
   * com proteção anti-sobrecarga de rede na VPS de 1GB
   */
  scheduleAutoUpdate() {
    if (this.autoUpdateTimer) {
      clearInterval(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }

    let intervalSetting = '24h';
    try {
      const adminManager = require('./admin-manager');
      intervalSetting = adminManager.getSyncInterval() || '24h';
    } catch (e) {}

    if (intervalSetting === 'manual') {
      console.log('[AutoSync] Sincronização automática periódica desativada (Modo Manual no ADM).');
      return;
    }

    let intervalMs = 24 * 60 * 60 * 1000; // Padrão: 24 horas
    if (intervalSetting === '12h') intervalMs = 12 * 60 * 60 * 1000;
    else if (intervalSetting === '30m') intervalMs = 30 * 60 * 1000;

    console.log(`[AutoSync] Agendador automático configurado para intervalo de ${intervalSetting} (${Math.round(intervalMs / 3600000)}h).`);
    this.autoUpdateTimer = setInterval(() => {
      console.log(`[AutoSync] Verificação periódica programada iniciada (${intervalSetting})...`);
      this.backgroundSync(false).catch(err => console.warn('[AutoSync] Aviso:', err.message));
    }, intervalMs);

    // Se o catálogo estiver completamente vazio (primeira inicialização sem cache local),
    // baixa os dados em segundo plano após 15 segundos. Se já houver catálogo, NÃO baixa no boot!
    if (!this.channels.length && !this.movies.length && !this.series.length) {
      setTimeout(() => {
        console.log('[AutoSync] Catálogo vazio na inicialização. Disparando carga inicial de conteúdos...');
        this.backgroundSync(false).catch(err => console.warn('[AutoSync] Aviso:', err.message));
      }, 15000);
    }
  }

  /**
   * Lê o arquivo linha a linha via stream para performance máxima:
   * Agrupa episódios em Séries Únicas (Shows) com capas do EPG e seleção de temporadas
   */
  async parseLocalFile(filePath = PLAYLIST_FILE) {
    console.log('[Parser] Analisando e organizando catálogo estrito (Filmes x Séries Únicas x Canais)...');
    
    this.channels = [];
    this.movies = [];
    this.series = [];
    this.seriesById = new Map();
    this.groupsMap = new Map();
    this.totalEpisodesCount = 0;

    const seriesByGroupMap = new Map();
    let seriesCounter = 1;
    let idCounter = 1;

    const fileStream = fs.createReadStream(filePath || PLAYLIST_FILE);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentItem = null;

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        const parsed = this.parseExtinf(line);
        if (parsed) {
          currentItem = {
            id: idCounter++,
            tvgId: parsed.attrs['tvg-id'] || '',
            rawTitle: parsed.title,
            logo: parsed.attrs['tvg-logo'] || '',
            group: parsed.attrs['group-title'] || 'Outros'
          };
        }
      } else if (currentItem && !line.startsWith('#')) {
        const rawUrl = line;
        const grpUpper = currentItem.group.toUpperCase();
        const lowerUrl = rawUrl.toLowerCase();

        // 1. REJEIÇÃO TOTAL DE CANAIS AO VIVO
        const isLive = grpUpper.startsWith('CANAIS') || 
                       grpUpper.startsWith('CANAL') || 
                       grpUpper.includes('24 HORAS') || 
                       grpUpper.includes('RÁDIOS') || 
                       grpUpper.includes('RADIOS') ||
                       grpUpper.includes('AO VIVO') ||
                       lowerUrl.includes('/live/') || 
                       lowerUrl.endsWith('.ts');
        if (isLive) {
          currentItem = null;
          continue;
        }

        // 2. DETECÇÃO ROBUSTA DE SÉRIES vs FILMES
        // Detecta padrões de episódios no título (ex: S01E02, T01 EP05, Temporada 1, etc.)
        const hasSeriesPattern = /[\s\-_]+[SsTt](\d{1,3})[\s\.\-_]*[Ee](\d{1,3})/i.test(currentItem.rawTitle) ||
                                 /^(.*?)(?:[\s\-_]+[SsTt](\d{1,3}))[\s\-_]+(?:E|EP|Episódio|Capítulo)[\s\-_]*(\d+)/i.test(currentItem.rawTitle) ||
                                 /\b(temporada\s*\d+|epis[oó]dio\s*\d+|cap[ií]tulo\s*\d+)\b/i.test(currentItem.rawTitle);

        let itemType = 'movie';
        const isAdultGroupItem = this.isAdultGroup(currentItem.group);
        if (!isAdultGroupItem && (grpUpper.startsWith('SÉRIES') || grpUpper.startsWith('SERIES') || grpUpper.includes('NOVELA') || grpUpper.includes('ANIME') || grpUpper.includes('DORAMA') || lowerUrl.includes('/series/') || hasSeriesPattern)) {
          itemType = 'series';
        } else if (lowerUrl.includes('/series/')) {
          itemType = 'series';
        } else {
          itemType = 'movie';
        }

        // 3. CONTEÚDOS ADULTOS (+18 / XXX): Mantém TODOS os Filmes Adultos e Séries/Coleções Adultas disponíveis
        const isAdult = isAdultGroupItem || this.isAdultItem({ name: currentItem.rawTitle, group: currentItem.group });

        // 4. Identificação do formato de mídia
        let mediaType = 'mp4';
        let ext = '.mp4';
        if (lowerUrl.includes('.m3u8')) {
          mediaType = 'hls';
          ext = '.m3u8';
        } else {
          mediaType = 'mp4';
          ext = '.mp4';
        }

        // === PROCESSAMENTO DE SÉRIES (AGRUPAMENTO POR TÍTULO E TEMPORADA) ===
        if (itemType === 'series') {
          this.totalEpisodesCount++;
          const { seriesName, season, episode, episodeTitle } = this.parseSeriesTitle(currentItem.rawTitle);
          const groupKey = currentItem.group;
          const seriesKey = `${seriesName.toLowerCase()}___${groupKey.toLowerCase()}`;

          if (!seriesByGroupMap.has(seriesKey)) {
            const newSeries = {
              id: seriesCounter++,
              name: seriesName,
              logo: currentItem.logo,
              group: currentItem.group,
              itemType: 'series',
              isAdult: Boolean(isAdultGroupItem),
              totalSeasons: 0,
              totalEpisodes: 0,
              seasons: {}
            };
            seriesByGroupMap.set(seriesKey, newSeries);
            this.seriesById.set(newSeries.id, newSeries);
          }

          const seriesObj = seriesByGroupMap.get(seriesKey);
          if (!seriesObj.logo && currentItem.logo) {
            seriesObj.logo = currentItem.logo;
          }

          if (!seriesObj.seasons[season]) {
            seriesObj.seasons[season] = [];
          }

          seriesObj.seasons[season].push({
            id: currentItem.id,
            episode,
            season,
            name: episodeTitle,
            logo: currentItem.logo || seriesObj.logo,
            mediaType: mediaType,
            rawUrl: rawUrl
          });

          seriesObj.totalEpisodes++;

        } else {
          // === FILMES VOD (GERAIS + TODOS OS FILMES ADULTOS +18) ===
          const encToken = this.encryptUrl(rawUrl);
          const clientItem = {
            id: currentItem.id,
            tvgId: currentItem.tvgId,
            name: currentItem.rawTitle,
            logo: currentItem.logo,
            cover: currentItem.logo,
            backdrop: currentItem.logo,
            group: currentItem.group,
            itemType: 'movie',
            mediaType: mediaType,
            isAdult: Boolean(isAdult),
            rating: isAdult ? '18' : this.getContentRating({ name: currentItem.rawTitle, group: currentItem.group, isAdult: false, itemType: 'movie' }),
            streamUrl: `/api/stream/${encodeURIComponent(encToken)}${ext}`
          };

          this.movies.push(clientItem);

          // Se for conteúdo adulto multi-cena (ex: "(Cena 1)", "(Cena 2)") ou episódio dentro de XXX - Adultos,
          // agrupa TAMBÉM como Série/Coleção Adulta (+18) para que o usuário e o ADM possam navegar por Cenas/Episódios!
          if (isAdult) {
            const cenaMatch = currentItem.rawTitle.match(/^(.*?)\s*\(\s*cena\s*(\d+)\s*\)(.*)$/i);
            if (cenaMatch || hasSeriesPattern) {
              let adultSeriesName = '';
              let adultSeason = 1;
              let adultEp = 1;
              let adultEpTitle = '';

              if (cenaMatch) {
                adultSeriesName = cenaMatch[1].trim();
                adultSeason = 1;
                adultEp = parseInt(cenaMatch[2], 10) || 1;
                const extra = (cenaMatch[3] || '').trim();
                adultEpTitle = extra ? `Cena ${adultEp} ${extra}` : `Cena ${adultEp}`;
              } else {
                const parsedS = this.parseSeriesTitle(currentItem.rawTitle);
                adultSeriesName = parsedS.seriesName;
                adultSeason = parsedS.season || 1;
                adultEp = parsedS.episode || 1;
                adultEpTitle = parsedS.episodeTitle || `Episódio ${adultEp}`;
              }

              const adultGroupKey = 'Séries | Adultos (+18)';
              const adultSeriesKey = `${adultSeriesName.toLowerCase()}___adult_series`;
              if (!seriesByGroupMap.has(adultSeriesKey)) {
                const newAdultSeries = {
                  id: seriesCounter++,
                  name: adultSeriesName,
                  logo: currentItem.logo,
                  group: adultGroupKey,
                  itemType: 'series',
                  isAdult: true,
                  totalSeasons: 0,
                  totalEpisodes: 0,
                  seasons: {}
                };
                seriesByGroupMap.set(adultSeriesKey, newAdultSeries);
                this.seriesById.set(newAdultSeries.id, newAdultSeries);
              }

              const adultSeriesObj = seriesByGroupMap.get(adultSeriesKey);
              if (!adultSeriesObj.logo && currentItem.logo) {
                adultSeriesObj.logo = currentItem.logo;
              }
              if (!adultSeriesObj.seasons[adultSeason]) {
                adultSeriesObj.seasons[adultSeason] = [];
              }
              adultSeriesObj.seasons[adultSeason].push({
                id: currentItem.id,
                episode: adultEp,
                season: adultSeason,
                name: adultEpTitle,
                logo: currentItem.logo || adultSeriesObj.logo,
                mediaType: mediaType,
                rawUrl: rawUrl
              });
              adultSeriesObj.totalEpisodes++;
            }
          }
        }

        currentItem = null;
      }
    }

    // Finaliza ordenação e cards das Séries Únicas (Gerais + Séries Adultas +18)
    this.series = [];
    const seriesByIdObj = {};

    for (const [sId, seriesObj] of this.seriesById.entries()) {
      // Se for uma série adulta gerada por "(Cena 1)" mas que só possui 1 única cena, mantém apenas como filme
      if (seriesObj.group === 'Séries | Adultos (+18)' && seriesObj.totalEpisodes < 2) {
        this.seriesById.delete(sId);
        continue;
      }

      const seasonKeys = Object.keys(seriesObj.seasons).map(Number).sort((a,b)=>a-b);
      seriesObj.totalSeasons = seasonKeys.length;

      // Ordena episódios de cada temporada
      for (const sNum of seasonKeys) {
        seriesObj.seasons[sNum].sort((a, b) => a.episode - b.episode);
      }

      // Primeiro episódio para reprodução rápida no card
      const firstSeason = seasonKeys[0];
      const firstEp = (firstSeason && seriesObj.seasons[firstSeason]) ? seriesObj.seasons[firstSeason][0] : null;
      const firstEpStream = firstEp ? `/api/stream/${encodeURIComponent(this.encryptUrl(firstEp.rawUrl))}.mp4` : '';

      // Identifica se a série é Adulta (+18)
      const isAdultSeries = Boolean(
        seriesObj.isAdult ||
        this.isAdultGroup(seriesObj.group) ||
        this.isAdultItem({ name: seriesObj.name, group: seriesObj.group }) ||
        /\b(playboy|pornoxplotaci[oó]n|supersexo|explicando o sexo|quarto do sexo|morrendo por sexo|bebidas apostas e sexo|ashley madison|sexo e a cidade)\b/i.test(seriesObj.name || '')
      );
      seriesObj.isAdult = isAdultSeries;

      const seriesCard = {
        id: seriesObj.id,
        name: seriesObj.name,
        logo: seriesObj.logo,
        cover: seriesObj.cover || seriesObj.logo,
        backdrop: seriesObj.backdrop || seriesObj.logo,
        group: seriesObj.group,
        itemType: 'series',
        totalSeasons: seriesObj.totalSeasons,
        totalEpisodes: seriesObj.totalEpisodes,
        mediaType: 'mp4',
        isAdult: isAdultSeries,
        rating: isAdultSeries ? '18' : this.getContentRating({ name: seriesObj.name, group: seriesObj.group, isAdult: false, itemType: 'series' }),
        streamUrl: firstEpStream,
        firstEpisode: firstEp ? {
          name: firstEp.name,
          season: firstEp.season,
          episode: firstEp.episode,
          streamUrl: firstEpStream
        } : null
      };

      this.series.push(seriesCard);
      seriesByIdObj[seriesObj.id] = seriesObj;
    }

    this.enrichSeriesWithMetadata();

    // Hero: Escolhe um filme de destaque (Lançamentos 2026, nunca adulto)
    const generalMovies = this.movies.filter(m => !m.isAdult && !this.isAdultGroup(m.group));
    const adultMovies = this.movies.filter(m => m.isAdult || this.isAdultGroup(m.group)).sort((a, b) => {
      const getAdultSortRank = (item) => {
        const n = (item.name || '').trim();
        const isDotLegacy = /^xxx\./i.test(n);
        if (isDotLegacy) return 3;
        const cenaMatch = n.match(/\(\s*cena\s*(\d+)\s*\)/i);
        if (cenaMatch) {
          const cNum = parseInt(cenaMatch[1], 10) || 1;
          return cNum === 1 ? 1 : 2;
        }
        return 0; // Filmes completos standalone XxX: e XXX primeiro
      };
      return getAdultSortRank(a) - getAdultSortRank(b);
    });
    this.movies = [...generalMovies, ...adultMovies];
    const releases2026 = generalMovies.filter(m => m.group && m.group.includes('2026') && m.logo && m.logo.startsWith('http'));
    this.heroItem = releases2026.length ? releases2026[Math.floor(Math.random() * Math.min(releases2026.length, 10))] : (generalMovies[0] || this.series[0] || null);

    this.channels = [];
    this.isReady = true;
    const adultMoviesCount = adultMovies.length;
    const adultSeriesCount = this.series.filter(s => s.isAdult).length;
    console.log(`[Parser] Catálogo VOD Otimizado pronto! Total: ${this.movies.length} filmes (${generalMovies.length} gerais + ${adultMoviesCount} filmes adultos +18), ${this.series.length} séries únicas (${adultSeriesCount} séries adultas +18, ${this.totalEpisodesCount} episódios agrupados).`);

    try {
      this.prebuilt = {
        version: 3,
        catalogVersion: this.catalogVersion || Date.now(),
        lastUpdated: this.lastUpdated || new Date().toISOString(),
        heroItem: this.heroItem,
        totalChannels: 0,
        totalMovies: this.movies.length,
        totalSeries: this.series.length,
        totalEpisodesCount: this.totalEpisodesCount,
        channels: [],
        movies: this.movies,
        series: this.series,
        seriesById: seriesByIdObj,
        catalogs: {
          ALL: this.buildCatalog('ALL'),
          MOVIES: this.buildCatalog('MOVIES'),
          SERIES: this.buildCatalog('SERIES')
        }
      };
      const jsonStr = JSON.stringify(this.prebuilt);
      fs.writeFileSync(CACHE_FILE, jsonStr, 'utf-8');
      try {
        const zlib = require('zlib');
        fs.writeFileSync(GZ_CACHE_FILE, zlib.gzipSync(Buffer.from(jsonStr, 'utf-8')));
      } catch (gzErr) {}
      console.log('[Parser] Cache pré-compilado salvo com sucesso!');
    } catch (err) {
      console.warn('[Parser] Falha ao salvar cache:', err.message);
    }
  }

  /**
   * Enriquece todas as séries com capas (posters verticais) e backdrops (wallpapers 16:9) oficiais
   * Prioriza o poster oficial promocional (s.cover) com o logo da série, evitando frames aleatórios
   */
  enrichSeriesWithMetadata() {
    let updated = 0;
    for (const s of this.series) {
      const meta = epgManager.getSeriesDetails(s.name);
      if (meta) {
        if (meta.cover && meta.cover.startsWith('http')) {
          s.cover = meta.cover;
          s.logo = meta.cover;
          updated++;
        } else if (s.logo && s.logo.startsWith('http')) {
          s.cover = s.logo;
        }
        if (meta.backdrop && meta.backdrop.startsWith('http')) {
          s.backdrop = meta.backdrop;
        } else {
          s.backdrop = s.cover || s.logo;
        }
      } else {
        if (!s.cover) s.cover = s.logo;
        if (!s.backdrop) s.backdrop = s.logo;
      }

      const sFull = this.seriesById.get(s.id);
      if (sFull) {
        sFull.cover = s.cover;
        sFull.backdrop = s.backdrop;
        sFull.logo = s.logo;
      }
    }
    if (this.prebuilt) {
      this.prebuilt.series = this.series;
    }
    console.log(`[Manager] ${updated} séries enriquecidas com capas oficiais do EPG!`);
  }

  /**
   * Retorna os detalhes de uma série específica com todas as temporadas e episódios
   */
  getSeriesById(id) {
    const s = this.seriesById.get(Number(id));
    if (!s) return null;

    // Constrói objeto com URLs criptografadas sob demanda para os episódios
    const seasons = {};
    for (const [seasonNum, episodes] of Object.entries(s.seasons)) {
      seasons[seasonNum] = episodes.map(ep => {
        const encToken = this.encryptUrl(ep.rawUrl);
        return {
          id: ep.id,
          episode: ep.episode,
          season: ep.season,
          name: ep.name,
          logo: ep.logo || s.backdrop || s.cover || s.logo,
          mediaType: 'mp4',
          streamUrl: `/api/stream/${encodeURIComponent(encToken)}.mp4`
        };
      });
    }

    return {
      id: s.id,
      name: s.name,
      logo: s.logo,
      cover: s.cover || s.logo,
      backdrop: s.backdrop || s.logo,
      group: s.group,
      itemType: 'series',
      totalSeasons: s.totalSeasons,
      totalEpisodes: s.totalEpisodes,
      seasons
    };
  }

  getCatalog(filter = 'ALL', isKids = false, allowAdult = false, userAge = null) {
    return this.buildCatalog(filter, isKids, allowAdult, userAge);
  }

  buildCatalog(filter = 'ALL', isKids = false, allowAdult = false, userAge = null) {
    if (!this.isReady && !this.prebuilt) {
      return { status: 'loading', hero: null, rows: [] };
    }

    const normFilter = (filter || 'ALL').toUpperCase();
    const ageNum = (userAge !== null && !isNaN(userAge)) ? parseInt(userAge, 10) : null;

    // Classificação Indicativa por Faixa Etária:
    // 1. Kids (<10 anos ou modo KIDS): Desenhos e Animações
    // 2. Pré-Teen (10-13 anos): Aventura, Família, Animações Teen, Comédias
    // 3. Teen / Jovem (14-17 anos, ex: 16 anos): Lançamentos 2026, Séries em Alta, Ação, Ficção, Animes (Sem +18 e Sem desenhos de bebê no topo!)
    // 4. Adulto (18+ anos): Catálogo geral + Conteúdos Adultos (+18 se ativado no perfil)
    const isKidsMode = Boolean(isKids || normFilter === 'KIDS' || (ageNum !== null && ageNum < 10));
    const isPreTeen = !isKidsMode && ageNum !== null && ageNum >= 10 && ageNum < 14;
    const isTeen = !isKidsMode && !isPreTeen && ageNum !== null && ageNum >= 14 && ageNum < 18;
    const adultAllowed = Boolean(allowAdult && !isKidsMode && (ageNum === null || ageNum >= 18));

    if (normFilter === 'LIVE') {
      return {
        status: 'ready',
        hero: this.heroItem,
        trending: [],
        isKids: isKidsMode,
        isPreTeen,
        isTeen,
        totalChannels: 0,
        totalMovies: this.movies.length,
        totalSeries: this.series.length,
        totalEpisodes: this.totalEpisodesCount,
        rows: []
      };
    }

    const rows = [];
    const addedGroupKeys = new Set();
    const addRow = (title, items, groupKey = '', type = 'movie') => {
      if (!items || items.length === 0) return;
      let finalItems = items.filter(it => !it.isAdult && !this.isAdultGroup(it.group));
      if (finalItems.length === 0) return;
      if (isKidsMode) {
        if (/terror|suspense|crime|horror|sangue|massacre|guerra/i.test(title) || /terror|suspense|crime|horror|sangue|massacre|guerra/i.test(groupKey)) {
          return;
        }
        finalItems = items.filter(it => this.isKidsItem(it) || !this.isAdultGroup(it.group));
        if (finalItems.length === 0) return;
      }

      rows.push({
        title,
        total: finalItems.length,
        type,
        groupKey,
        isAdult: false,
        items: finalItems.slice(0, 24).map(it => ({
          ...it,
          isAdult: false
        }))
      });
      if (groupKey) {
        addedGroupKeys.add(groupKey.toLowerCase().trim());
      }
    };

    const addAdultRow = (title, items, groupKey = '', type = 'adult') => {
      if (!adultAllowed || !items || items.length === 0) return;
      rows.push({
        title,
        total: items.length,
        type,
        groupKey,
        isAdult: true,
        items: items.slice(0, 30).map(it => ({
          ...it,
          isAdult: true,
          rating: '18'
        }))
      });
    };

    if (normFilter === 'ADULT') {
      if (!adultAllowed) {
        return {
          status: 'ready',
          hero: this.heroItem,
          trending: [],
          isKids: isKidsMode,
          isPreTeen,
          isTeen,
          totalChannels: 0,
          totalMovies: this.movies.length,
          totalSeries: this.series.length,
          totalEpisodes: this.totalEpisodesCount,
          rows: []
        };
      }
      const adultMoviesAll = this.movies.filter(m => m.isAdult || this.isAdultGroup(m.group));
      const adultSeriesAll = this.series.filter(s => s.isAdult || this.isAdultGroup(s.group));
      const adultStandalone = adultMoviesAll.filter(m => !/\(\s*cena\s*\d+\s*\)/i.test(m.name || '') && !/^xxx\./i.test(m.name || ''));
      const adultNacionais = adultMoviesAll.filter(m => /brasileirinhas|teste de fudelidade|sexy hot|safada|gatas/i.test(m.name || ''));
      const adultInternacionais = adultMoviesAll.filter(m => /brazzers|reality kings|private|penthouse|hustler|redlight|wicked|vivid|dorcel|evil angel|naughty|playboy/i.test(m.name || ''));
      const adultCenas = adultMoviesAll.filter(m => /\(\s*cena\s*\d+\s*\)/i.test(m.name || ''));
      const adultClassicos = adultMoviesAll.filter(m => /^xxx\./i.test(m.name || ''));

      addAdultRow('🔞 Séries & Coleções Adultas (+18)', adultSeriesAll, '', 'adult_series');
      addAdultRow('🔞 Filmes Adultos (+18) — Destaques Completos', adultStandalone, '', 'adult_movies');
      addAdultRow('🔞 Filmes Adultos | Brasileirinhas & Nacionais (+18)', adultNacionais, '', 'adult_movies');
      addAdultRow('🔞 Filmes Adultos | Internacionais & Studios (+18)', adultInternacionais, '', 'adult_movies');
      addAdultRow('🔞 Cenas & Episódios Adultos (+18)', adultCenas, '', 'adult_movies');
      addAdultRow('🔞 Acervo Clássico & Legendado (+18)', adultClassicos, '', 'adult_movies');
      addAdultRow('🔞 Todos os Filmes Adultos (+18)', adultMoviesAll, '', 'adult_movies');

      return {
        status: 'ready',
        hero: adultMoviesAll[0] || this.heroItem,
        trending: [],
        isKids: false,
        isPreTeen: false,
        isTeen: false,
        totalChannels: 0,
        totalMovies: this.movies.length,
        totalSeries: this.series.length,
        totalEpisodes: this.totalEpisodesCount,
        rows
      };
    }

    // MODO INFANTIL / KIDS / MENOR DE IDADE
    if (isKidsMode) {
      if (normFilter === 'MOVIES') {
        const animacao = this.movies.filter(m => (m.group && (m.group.includes('Animacao') || m.group.includes('Infantil'))) || this.isKidsItem(m));
        addRow('🧸 Filmes: Animação & Infantil', animacao, 'Animação', 'movie');

        const lancKids = this.movies.filter(m => (m.group && (m.group.includes('2026') || m.group.includes('2025'))) && this.isKidsItem(m));
        addRow('🍿 Filmes: Lançamentos Kids', lancKids, 'Lançamentos', 'movie');

        const aventura = this.movies.filter(m => m.group && m.group.includes('Aventura') && this.isKidsItem(m));
        addRow('🗡️ Filmes: Aventura & Fantasia', aventura, 'Aventura', 'movie');

        const comedia = this.movies.filter(m => m.group && (m.group.includes('Comedia') || m.group.includes('Comédia')) && this.isKidsItem(m));
        addRow('😂 Filmes: Comédias Divertidas', comedia, 'Comédia', 'movie');

        const ficcao = this.movies.filter(m => m.group && (m.group.includes('Ficcao') || m.group.includes('Ficção')) && this.isKidsItem(m));
        addRow('🚀 Filmes: Ficção & Aventura', ficcao, 'Ficção', 'movie');
      } else if (normFilter === 'SERIES') {
        const animacaoSeries = this.series.filter(s => (s.group && (s.group.includes('Anima') || s.group.includes('Desenho'))) || this.isKidsItem(s));
        addRow('📺 SÉRIES | Desenhos & Animações', animacaoSeries, 'Animação', 'series');

        const disney = this.series.filter(s => s.group && (s.group.includes('Disney') || s.group.includes('Star+')));
        addRow('🔵 SÉRIES | Disney+ & Família', disney, 'Disney', 'series');

        const animes = this.series.filter(s => s.group && s.group.includes('Animes') && !this.isAdultItem(s));
        addRow('⛩️ SÉRIES | Animes Japoneses', animes, 'Animes', 'series');

        const netflix = this.series.filter(s => s.group && s.group.includes('Netflix') && this.isKidsItem(s));
        addRow('🔴 SÉRIES | Netflix Kids', netflix, 'Netflix', 'series');

        const prime = this.series.filter(s => s.group && s.group.includes('Amazon') && this.isKidsItem(s));
        addRow('🟡 SÉRIES | Amazon Prime Família', prime, 'Amazon', 'series');
      } else {
        // ABA INÍCIO (ALL) para Crianças:
        const animacao = this.movies.filter(m => (m.group && (m.group.includes('Animacao') || m.group.includes('Infantil'))) || this.isKidsItem(m));
        addRow('🧸 Filmes: Animação & Infantil', animacao, 'Animacao', 'movie');

        const seriesDesenhos = this.series.filter(s => (s.group && (s.group.includes('Anima') || s.group.includes('Desenho'))) || this.isKidsItem(s));
        addRow('📺 SÉRIES | Desenhos & Animação', seriesDesenhos, 'Animacao', 'series');

        const disney = this.series.filter(s => s.group && (s.group.includes('Disney') || s.group.includes('Star+')));
        addRow('🔵 SÉRIES | Disney+ & Família', disney, 'Disney', 'series');

        const lancKids = this.movies.filter(m => (m.group && (m.group.includes('2026') || m.group.includes('2025'))) && this.isKidsItem(m));
        addRow('🍿 Filmes: Lançamentos Kids', lancKids, 'Lançamentos', 'movie');

        const comedia = this.movies.filter(m => m.group && (m.group.includes('Comedia') || m.group.includes('Comédia')) && this.isKidsItem(m));
        addRow('😂 Filmes: Comédias Divertidas', comedia, 'Comedia', 'movie');

        const aventura = this.movies.filter(m => m.group && m.group.includes('Aventura') && this.isKidsItem(m));
        addRow('🗡️ Filmes: Aventura & Fantasia', aventura, 'Aventura', 'movie');

        const animes = this.series.filter(s => s.group && s.group.includes('Animes') && !this.isAdultItem(s));
        addRow('⛩️ SÉRIES | Animes & Desenhos', animes, 'Animes', 'series');
      }
    } else {
      // 1. ABA FILMES
      if (normFilter === 'MOVIES') {
        const lanc2026 = this.movies.filter(m => m.group && m.group.includes('2026'));
        addRow('🔥 Filmes: Lançamentos 2026', lanc2026, '2026', 'movie');

        const lanc2025 = this.movies.filter(m => m.group && m.group.includes('2025'));
        addRow('🎬 Filmes: Lançamentos 2025', lanc2025, '2025', 'movie');

        const cinema = this.movies.filter(m => m.group && m.group.includes('Cinema'));
        addRow('🍿 Filmes: [Qualidade Cinema]', cinema, 'Cinema', 'movie');

        const acao = this.movies.filter(m => m.group && (m.group.includes('Acao') || m.group.includes('Ação')));
        addRow('💥 Filmes: Ação & Adrenalina', acao, 'Ação', 'movie');

        const terror = this.movies.filter(m => m.group && (m.group.includes('Terror') || m.group.includes('Suspense')));
        addRow('😱 Filmes: Terror & Suspense', terror, 'Terror', 'movie');

        const comedia = this.movies.filter(m => m.group && (m.group.includes('Comedia') || m.group.includes('Comédia')));
        addRow('😂 Filmes: Comédia para Rir', comedia, 'Comédia', 'movie');

        const animacao = this.movies.filter(m => m.group && (m.group.includes('Animacao') || m.group.includes('Infantil')));
        addRow('🧸 Filmes: Animação & Infantil', animacao, 'Animação', 'movie');

        const ficcao = this.movies.filter(m => m.group && (m.group.includes('Ficcao') || m.group.includes('Ficção')));
        addRow('🚀 Filmes: Ficção Científica', ficcao, 'Ficção', 'movie');

        const aventura = this.movies.filter(m => m.group && m.group.includes('Aventura'));
        addRow('🗡️ Filmes: Aventura Fantástica', aventura, 'Aventura', 'movie');

        const drama = this.movies.filter(m => m.group && m.group.includes('Drama'));
        addRow('🎭 Filmes: Drama Emocionante', drama, 'Drama', 'movie');

        const nacionais = this.movies.filter(m => m.group && m.group.includes('Nacionais'));
        addRow('🇧🇷 Filmes: Cinema Nacional', nacionais, 'Nacionais', 'movie');
      }

      // 2. ABA SÉRIES
      else if (normFilter === 'SERIES' || filter === 'SERIES') {
        const netflix = this.series.filter(s => s.group && s.group.includes('Netflix'));
        addRow('🔴 SÉRIES | Netflix Originais', netflix, 'Netflix', 'series');

        const prime = this.series.filter(s => s.group && s.group.includes('Amazon'));
        addRow('🟡 SÉRIES | Amazon Prime Video', prime, 'Amazon', 'series');

        const disney = this.series.filter(s => s.group && (s.group.includes('Disney') || s.group.includes('Star+')));
        addRow('🔵 SÉRIES | Disney+ & Star+', disney, 'Disney', 'series');

        const hbo = this.series.filter(s => s.group && s.group.includes('HBOMAX'));
        addRow('🟣 SÉRIES | Max (HBO)', hbo, 'HBOMAX', 'series');

        const globo = this.series.filter(s => s.group && s.group.includes('GloboPlay'));
        addRow('🟢 SÉRIES | Globoplay & Novelas', globo, 'GloboPlay', 'series');

        const apple = this.series.filter(s => s.group && s.group.includes('Apple'));
        addRow('🍎 SÉRIES | Apple TV+ Séries', apple, 'Apple', 'series');

        const doramas = this.series.filter(s => s.group && s.group.includes('Dorama'));
        addRow('🌸 SÉRIES | Doramas & K-Dramas', doramas, 'Dorama', 'series');

        const animes = this.series.filter(s => s.group && s.group.includes('Animes'));
        addRow('⛩️ SÉRIES | Animes Japoneses', animes, 'Animes', 'series');

        const acaoSeries = this.series.filter(s => s.group && s.group.includes('Ação'));
        addRow('💥 SÉRIES | Ação & Investigação', acaoSeries, 'Ação', 'series');

        const comediaSeries = this.series.filter(s => s.group && s.group.includes('Comédia'));
        addRow('😂 SÉRIES | Comédias & Sitcoms', comediaSeries, 'Comédia', 'series');
      }

      // 3. ABA INÍCIO (ALL) - Apenas Filmes e Séries Otimizados
      else {
        // 1º Filmes Lançamentos 2026
        const lanc2026 = this.movies.filter(m => m.group && m.group.includes('2026'));
        addRow('🔥 Filmes: Lançamentos 2026', lanc2026, '2026', 'movie');

        // 2º Séries Netflix
        const netflix = this.series.filter(s => s.group && s.group.includes('Netflix'));
        addRow('🔴 SÉRIES | Netflix Originais', netflix, 'Netflix', 'series');

        // 3º Filmes Cinema
        const cinema = this.movies.filter(m => m.group && m.group.includes('Cinema'));
        addRow('🍿 Filmes: [Qualidade Cinema]', cinema, 'Cinema', 'movie');

        // 4º Séries Max / HBO
        const hbo = this.series.filter(s => s.group && s.group.includes('HBOMAX'));
        addRow('🟣 SÉRIES | Max (HBO Imperdíveis)', hbo, 'HBOMAX', 'series');

        // 5º Filmes Ação
        const acao = this.movies.filter(m => m.group && (m.group.includes('Acao') || m.group.includes('Ação')));
        addRow('💥 Filmes: Ação & Adrenalina', acao, 'Acao', 'movie');

        // 6º Séries Prime Video
        const prime = this.series.filter(s => s.group && s.group.includes('Amazon'));
        addRow('🟡 SÉRIES | Amazon Prime Video', prime, 'Amazon', 'series');

        // 7º Filmes Terror & Suspense
        const terror = this.movies.filter(m => m.group && (m.group.includes('Terror') || m.group.includes('Suspense')));
        addRow('😱 Filmes: Terror & Suspense', terror, 'Terror', 'movie');

        // 8º Séries Disney+
        const disney = this.series.filter(s => s.group && (s.group.includes('Disney') || s.group.includes('Star+')));
        addRow('🔵 SÉRIES | Disney+ & Star+', disney, 'Disney', 'series');

        // 9º Filmes Comédias
        const comedia = this.movies.filter(m => m.group && (m.group.includes('Comedia') || m.group.includes('Comédia')));
        addRow('😂 Filmes: Comédias Divertidas', comedia, 'Comedia', 'movie');

        // 10º Séries Apple TV+
        const apple = this.series.filter(s => s.group && s.group.includes('Apple'));
        addRow('🍎 SÉRIES | Apple TV+ Aclamadas', apple, 'Apple', 'series');

        // 11º Filmes Animação & Família
        const animacao = this.movies.filter(m => m.group && (m.group.includes('Animacao') || m.group.includes('Infantil')));
        addRow('🧸 Filmes: Animação & Família', animacao, 'Animacao', 'movie');

        // 12º Séries Doramas
        const doramas = this.series.filter(s => s.group && s.group.includes('Dorama'));
        addRow('🌸 SÉRIES | Doramas & K-Dramas', doramas, 'Dorama', 'series');

        // 13º Filmes Ficção Científica
        const ficcao = this.movies.filter(m => m.group && (m.group.includes('Ficcao') || m.group.includes('Ficção')));
        addRow('🚀 Filmes: Ficção Científica', ficcao, 'Ficcao', 'movie');

        // 14º Séries Animes
        const animes = this.series.filter(s => s.group && s.group.includes('Animes'));
        addRow('⛩️ SÉRIES | Animes Japoneses', animes, 'Animes', 'series');

        // 15º Filmes Aventura
        const aventura = this.movies.filter(m => m.group && m.group.includes('Aventura'));
        addRow('🗡️ Filmes: Aventura & Fantasia', aventura, 'Aventura', 'movie');

        // 16º Séries Globoplay
        const globo = this.series.filter(s => s.group && s.group.includes('GloboPlay'));
        addRow('🟢 SÉRIES | Globoplay & Novelas', globo, 'GloboPlay', 'series');
      }
    }

    // === CARROSSÉIS DE CONTEÚDOS ADULTOS (+18) NO PAINEL PRINCIPAL PARA MAIORES DE 18 ===
    if (adultAllowed) {
      const adultMoviesAll = this.movies.filter(m => m.isAdult || this.isAdultGroup(m.group));
      const adultSeriesAll = this.series.filter(s => s.isAdult || this.isAdultGroup(s.group));
      const adultNacionais = adultMoviesAll.filter(m => /brasileirinhas|teste de fudelidade|sexy hot|safada|gatas/i.test(m.name || ''));
      const adultInternacionais = adultMoviesAll.filter(m => /brazzers|reality kings|private|penthouse|hustler|redlight|wicked|vivid|dorcel|evil angel|naughty|playboy/i.test(m.name || ''));

      if (normFilter === 'MOVIES') {
        addAdultRow('🔞 Filmes Adultos (+18) — Acervo Completo', adultMoviesAll, '', 'adult_movies');
        addAdultRow('🔞 Filmes Adultos | Brasileirinhas & Nacionais (+18)', adultNacionais, '', 'adult_movies');
        addAdultRow('🔞 Filmes Adultos | Internacionais & Studios (+18)', adultInternacionais, '', 'adult_movies');
      } else if (normFilter === 'SERIES') {
        addAdultRow('🔞 Séries & Coleções Adultas (+18)', adultSeriesAll, '', 'adult_series');
      } else {
        addAdultRow('🔞 Filmes Adultos (+18)', adultMoviesAll, '', 'adult_movies');
        addAdultRow('🔞 Séries & Coleções Adultas (+18)', adultSeriesAll, '', 'adult_series');
      }
    }

    // === GERAÇÃO DINÂMICA DE CATEGORIAS DE QUALQUER LISTA IPTV (SOMENTE FILMES GERAIS E SÉRIES) ===
    const nonAdultMovies = this.movies.filter(m => !m.isAdult && !this.isAdultGroup(m.group));
    const nonAdultSeries = this.series.filter(s => !s.isAdult && !this.isAdultGroup(s.group));
    let targetItems = [];
    if (normFilter === 'MOVIES') targetItems = nonAdultMovies;
    else if (normFilter === 'SERIES') targetItems = nonAdultSeries;
    else targetItems = [...nonAdultMovies, ...nonAdultSeries];

    const dynamicGroupsMap = new Map();
    for (let i = 0; i < targetItems.length; i++) {
      const it = targetItems[i];
      if (it.isAdult || this.isAdultGroup(it.group)) continue;
      const g = (it.group || 'Geral').trim();
      if (!g) continue;
      if (!dynamicGroupsMap.has(g)) {
        dynamicGroupsMap.set(g, []);
      }
      dynamicGroupsMap.get(g).push(it);
    }

    const normalRows = [];

    for (const [groupName, groupItems] of dynamicGroupsMap.entries()) {
      const gLower = groupName.toLowerCase().trim();
      // Não duplica se já foi adicionado
      let alreadyAdded = false;
      for (const added of addedGroupKeys) {
        if (gLower === added || gLower.includes(added) || added.includes(gLower)) {
          alreadyAdded = true;
          break;
        }
      }
      if (alreadyAdded) continue;

      if (this.isAdultGroup(groupName)) {
        continue;
      }
      if (isKidsMode && /terror|crime|crimes|guerra|xxx|adulto|suspense|horror|sangue/i.test(groupName)) {
        continue;
      }

      let filteredGroupItems = groupItems;
      if (isKidsMode) {
        filteredGroupItems = groupItems.filter(it => this.isKidsItem(it) || !this.isAdultGroup(it.group));
        if (filteredGroupItems.length === 0) continue;
      }

      const firstItem = filteredGroupItems[0] || {};
      const itemType = firstItem.itemType || (normFilter === 'SERIES' ? 'series' : 'movie');

      let icon = itemType === 'series' ? '📺' : '🎬';

      let cleanName = groupName
        .replace(/^Filmes:\s*/i, 'Filmes | ')
        .replace(/^Séries:\s*/i, 'Séries | ')
        .replace(/^Series:\s*/i, 'Séries | ')
        .trim();

      const rowObj = {
        title: `${icon} ${cleanName}`,
        total: filteredGroupItems.length,
        type: itemType,
        groupKey: groupName,
        isAdult: false,
        items: filteredGroupItems.slice(0, 24).map(it => ({
          ...it,
          isAdult: false
        }))
      };

      normalRows.push(rowObj);
    }

    if (isKidsMode) {
      // 1. Modo Kids (< 10 anos):
      // Exibe desenhos e animações no topo
      const kidsOnlyRows = normalRows.filter(r => this.isKidsGroup(r.groupKey) || this.isKidsGroup(r.title));
      const safeFamilyRows = normalRows.filter(r => !kidsOnlyRows.includes(r) && !/terror|crime|crimes|guerra|xxx|adulto|suspense|horror/i.test(r.groupKey));
      kidsOnlyRows.forEach(r => rows.push(r));
      safeFamilyRows.forEach(r => rows.push(r));
    } else if (isPreTeen) {
      // 2. Pré-adolescente (10 - 13 anos):
      const safeFamilyRows = normalRows.filter(r => !/terror|crime|crimes|guerra|xxx|adulto|suspense|horror|sangue/i.test(r.groupKey));
      safeFamilyRows.forEach(r => rows.push(r));
    } else if (isTeen) {
      // 3. Jovem / Teen (14 - 17 anos, ex: 16 anos):
      const nonAdultRows = normalRows.filter(r => !this.isAdultGroup(r.groupKey) && !this.isAdultGroup(r.title));
      const mainTeenRows = nonAdultRows.filter(r => !this.isKidsGroup(r.groupKey) && !this.isKidsGroup(r.title));
      const otherRows = nonAdultRows.filter(r => !mainTeenRows.includes(r));
      mainTeenRows.forEach(r => rows.push(r));
      otherRows.forEach(r => rows.push(r));
    } else {
      // 4. Geral (Filmes e Séries):
      normalRows.forEach(r => rows.push(r));
    }

    const trending = this.getDailyTop10(normFilter, isKidsMode, false, ageNum);
    let hero = null;
    if (trending.length > 0) {
      hero = trending[0];
    } else if (isKidsMode) {
      hero = nonAdultMovies.find(m => this.isKidsItem(m)) || nonAdultSeries.find(s => this.isKidsItem(s)) || nonAdultMovies[0] || null;
    } else {
      hero = (normFilter === 'SERIES' ? nonAdultSeries[0] : (this.heroItem || nonAdultMovies[0] || null));
    }

    return {
      status: 'ready',
      hero,
      trending,
      isKids: isKidsMode,
      isPreTeen,
      isTeen,
      totalChannels: 0,
      totalMovies: this.movies.length,
      totalSeries: this.series.length,
      totalEpisodes: this.totalEpisodesCount,
      rows
    };
  }

  /**
   * Top 10 em Alta Diários com rotação dinâmica e metadados ricos:
   * Adapta-se automaticamente à categoria ativa e ao Modo Kids (Menor de Idade):
   * - KIDS: Top 10 composto estritamente por filmes de animação, séries infantis e canais educativos
   * - SERIES: Top 10 Séries aclamadas com capas e posters oficiais
   * - MOVIES: Top 10 Filmes de sucesso e lançamentos
   * - LIVE: Top 10 Canais ao vivo mais assistidos
   * - ALL: Mix equilibrado dos 10 melhores conteúdos
   */
  getDailyTop10(filter = 'ALL', isKids = false, allowAdult = false, userAge = null) {
    if (!this.isReady) return [];

    const normFilter = (filter || 'ALL').toUpperCase();
    const ageNum = (userAge !== null && !isNaN(userAge)) ? parseInt(userAge, 10) : null;
    const isKidsMode = Boolean(isKids || normFilter === 'KIDS' || (ageNum !== null && ageNum < 10));
    const isPreTeen = !isKidsMode && ageNum !== null && ageNum >= 10 && ageNum < 14;
    const isTeen = !isKidsMode && !isPreTeen && ageNum !== null && ageNum >= 14 && ageNum < 18;
    const now = new Date();
    // Gera semente diária determinística baseada na data atual (ex: 20261018)
    const daySeed = (now.getFullYear() * 10000) + ((now.getMonth() + 1) * 100) + now.getDate();

    const nonAdultMovies = this.movies.filter(m => !m.isAdult && !this.isAdultGroup(m.group));
    const nonAdultSeries = this.series.filter(s => !s.isAdult && !this.isAdultGroup(s.group));
    let movieCandidates = [];
    let seriesCandidates = [];
    let liveCandidates = [];

    if (isKidsMode) {
      // 1. Filmes Infantis & Animações com imagem válida (Disney, Pixar, DreamWorks, Minions)
      movieCandidates = nonAdultMovies.filter(m => 
        m.logo && m.logo.startsWith('http') && this.isKidsItem(m)
      );
      if (!movieCandidates.length) {
        movieCandidates = nonAdultMovies.filter(m => this.isKidsItem(m));
      }

      // 2. Séries de Animação e Infantis (Disney+, Desenhos, Gloob, Cartoon)
      seriesCandidates = nonAdultSeries.filter(s => 
        (s.cover || s.backdrop || s.logo) && this.isKidsItem(s)
      );
      if (!seriesCandidates.length) {
        seriesCandidates = nonAdultSeries.filter(s => this.isKidsItem(s));
      }

      // 3. Canais Ao Vivo Infantis & 24 Horas Desenhos
      liveCandidates = this.channels.filter(c => 
        c.logo && c.logo.startsWith('http') && this.isKidsItem(c)
      );
      if (!liveCandidates.length) {
        liveCandidates = this.channels.filter(c => this.isKidsItem(c));
      }
    } else if (isPreTeen) {
      // 1. Filmes para Pré-Adolescentes (10 - 13 anos): Aventura, Ficção, Família
      movieCandidates = nonAdultMovies.filter(m => 
        m.logo && m.logo.startsWith('http') && !/terror|massacre|crime|sangue/i.test(m.group || '')
      );
      seriesCandidates = nonAdultSeries.filter(s => 
        !/terror|massacre/i.test(s.group || '')
      );
    } else if (isTeen) {
      // 1. Filmes para Jovens / Teens (14 - 17 anos, ex: 16 anos): Lançamentos 2026, Cinema, Ação, Ficção
      movieCandidates = nonAdultMovies.filter(m => 
        m.logo && m.logo.startsWith('http') && !this.isKidsGroup(m.group)
      );
      if (!movieCandidates.length) {
        movieCandidates = nonAdultMovies;
      }

      seriesCandidates = nonAdultSeries.filter(s => 
        (s.cover || s.backdrop || s.logo) && !this.isKidsGroup(s.group)
      );
      if (!seriesCandidates.length) {
        seriesCandidates = nonAdultSeries;
      }
    } else {
      // 1. Filmes de alta relevância geral (Lançamentos 2026 / 2025 / Cinema / Ação)
      movieCandidates = nonAdultMovies.filter(m => 
        m.logo && m.logo.startsWith('http')
      );

      // 2. Séries aclamadas
      seriesCandidates = nonAdultSeries.filter(s => 
        (s.cover || s.backdrop || s.logo)
      );
    }

    const pickItems = (list, count, salt) => {
      if (!list || !list.length) return [];
      const res = [];
      const total = list.length;
      for (let i = 0; i < count; i++) {
        const idx = Math.abs((daySeed * 13 + salt + i * 29) % total);
        const candidate = list[idx];
        if (candidate && !res.some(item => item.name === candidate.name)) {
          res.push(candidate);
        }
      }
      return res;
    };

    let selectedList = [];

    if (normFilter === 'SERIES') {
      const pool = seriesCandidates.length >= 10 ? seriesCandidates : nonAdultSeries;
      selectedList = pickItems(pool, 10, 53);
    } else if (normFilter === 'MOVIES') {
      const pool = movieCandidates.length >= 10 ? movieCandidates : nonAdultMovies;
      selectedList = pickItems(pool, 10, 17);
    } else {
      // Início: Mix dinâmico Top 10 (Filmes e Séries)
      const pickedMovies = pickItems(movieCandidates.length ? movieCandidates : nonAdultMovies, 5, 17);
      const pickedSeries = pickItems(seriesCandidates.length ? seriesCandidates : nonAdultSeries, 5, 53);

      selectedList = [
        this.heroItem || pickedMovies[0],
        pickedSeries[0],
        pickedMovies[1],
        pickedSeries[1],
        pickedMovies[2],
        pickedSeries[2],
        pickedMovies[3],
        pickedSeries[3],
        pickedMovies[4],
        pickedSeries[4]
      ].filter(Boolean);
    }

    return selectedList.map((item, index) => {
      let overview = '';
      let genre = item.group || (isKidsMode ? 'Animação e Família' : 'Destaques');
      let year = '2026';
      let rating = (8.8 + ((index * 3) % 11) / 10).toFixed(1);
      let rankText = isKidsMode ? `#${index + 1} EM ALTA KIDS 🧸` : `#${index + 1} EM ALTA HOJE NO BRASIL`;

      if (item.itemType === 'series') {
        rankText = isKidsMode ? `#${index + 1} SÉRIE KIDS EM ALTA` : `#${index + 1} SÉRIE EM ALTA HOJE NO BRASIL`;
        const meta = epgManager.getSeriesDetails(item.name);
        if (meta) {
          if (meta.plot) overview = meta.plot;
          if (meta.genre) genre = meta.genre;
          if (meta.rating && meta.rating !== '0') rating = meta.rating;
          if (meta.releaseDate) year = meta.releaseDate.substr(0, 4);
        }
        if (!overview) {
          overview = isKidsMode
            ? `Diversão garantida para toda a família com as melhores animações, filmes e séries infantis no NovaFlix Kids!`
            : `Aproveite a melhor programação de filmes em alta definição, séries originais completas e canais ao vivo com a experiência de navegação premium da NovaFlix.`;
        }
      } else if (item.itemType === 'live') {
        rankText = isKidsMode ? `#${index + 1} CANAL INFANTIL AO VIVO` : `#${index + 1} CANAL MAIS ASSISTIDO AO VIVO`;
        const epgData = epgManager.getEPGForChannel(item.tvgId, item.name);
        if (epgData && epgData.current && epgData.current.desc) {
          overview = `${epgData.current.title} — ${epgData.current.desc}`;
        } else {
          overview = isKidsMode
            ? `Assista aos melhores desenhos e programas infantis 24 horas por dia no NovaFlix Kids!`
            : `Aproveite a melhor programação de filmes em alta definição, séries originais completas e canais ao vivo com a experiência de navegação premium da NovaFlix.`;
        }
        year = 'AO VIVO';
      } else {
        rankText = isKidsMode ? `#${index + 1} FILME KIDS EM ALTA` : `#${index + 1} FILME EM ALTA HOJE NO BRASIL`;
        const vodMeta = epgManager.vodDetailsCache?.get?.(String(item.id));
        if (vodMeta && vodMeta.plot) {
          overview = vodMeta.plot;
          if (vodMeta.genre) genre = vodMeta.genre;
          if (vodMeta.rating && vodMeta.rating !== '0') rating = vodMeta.rating;
          if (vodMeta.releaseDate) year = vodMeta.releaseDate.substr(0, 4);
        } else {
          overview = isKidsMode
            ? `Diversão garantida para toda a família com as melhores animações e filmes infantis no NovaFlix Kids!`
            : `Aproveite a melhor programação de filmes em alta definição, séries originais completas e canais ao vivo com a experiência de navegação premium da NovaFlix.`;
        }
      }

      return {
        id: item.id,
        name: item.name,
        logo: item.logo,
        cover: item.cover || item.logo,
        backdrop: item.backdrop || item.cover || item.logo,
        group: item.group,
        itemType: item.itemType,
        mediaType: item.mediaType || 'mp4',
        streamUrl: item.streamUrl,
        firstEpisode: item.firstEpisode || null,
        rank: index + 1,
        rankText,
        overview,
        genre,
        year,
        rating,
        ageRating: this.getContentRating(item),
        match: 94 + (index % 6)
      };
    });
  }

  /**
   * Retorna itens de uma categoria com paginação e busca para o modo "Ver Tudo / Grade Completa"
   * Inclui suporte completo a Filmes Adultos (+18) e Séries Adultas (+18) quando allowAdult === true
   */
  getCategoryItems({ type = 'all', group = '', page = 1, limit = 120, search = '', isKidsMode = false, allowAdult = false }) {
    if (!this.isReady) return { items: [], total: 0, page, limit, totalPages: 0, groups: [] };

    const canSeeAdult = Boolean(allowAdult && !isKidsMode);
    const adultMovies = this.movies.filter(m => m.isAdult || this.isAdultGroup(m.group));
    const adultSeries = this.series.filter(s => s.isAdult || this.isAdultGroup(s.group));
    const generalMovies = this.movies.filter(m => !m.isAdult && !this.isAdultGroup(m.group));
    const generalSeries = this.series.filter(s => !s.isAdult && !this.isAdultGroup(s.group));

    let source = [];
    const normType = (type || 'all').toLowerCase();

    if (normType === 'adult') {
      source = canSeeAdult ? [...adultMovies, ...adultSeries] : [];
    } else if (normType === 'adult_movies') {
      source = canSeeAdult ? adultMovies : [];
    } else if (normType === 'adult_series') {
      source = canSeeAdult ? adultSeries : [];
    } else if (normType === 'movies' || normType === 'movie') {
      source = canSeeAdult ? [...generalMovies, ...adultMovies] : generalMovies;
    } else if (normType === 'series') {
      source = canSeeAdult ? [...generalSeries, ...adultSeries] : generalSeries;
    } else {
      source = canSeeAdult
        ? [...generalMovies, ...generalSeries, ...adultMovies, ...adultSeries]
        : [...generalMovies, ...generalSeries];
    }

    if (isKidsMode) {
      source = source.filter(it => !it.isAdult && !this.isAdultGroup(it.group) && (this.isKidsItem(it) || !this.isAdultGroup(it.group)));
    }

    const normalize = str => (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    // Coleta grupos disponíveis
    const groupsSet = new Set();
    source.forEach(it => {
      if (it.group) {
        if (!canSeeAdult && this.isAdultGroup(it.group)) return;
        groupsSet.add(it.group);
      }
    });

    let filtered = source;
    if (group) {
      const gNorm = normalize(group);
      // Se estiver em modo adulto e o group for genérico, só filtra se houver correspondência real
      const groupMatched = filtered.filter(it => it.group && normalize(it.group).includes(gNorm));
      if (groupMatched.length > 0 || !normType.startsWith('adult')) {
        filtered = groupMatched;
      }
    }

    if (search) {
      const sNorm = normalize(search);
      filtered = filtered.filter(it => (it.name && normalize(it.name).includes(sNorm)) || (it.group && normalize(it.group).includes(sNorm)));
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const safePage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (safePage - 1) * limit;
    const paginatedItems = filtered.slice(startIndex, startIndex + limit).map(it => {
      const isAdultItem = Boolean(it.isAdult || this.isAdultGroup(it.group));
      return {
        ...it,
        isAdult: isAdultItem,
        rating: isAdultItem ? '18' : (it.rating || this.getContentRating(it))
      };
    });

    return {
      items: paginatedItems,
      total,
      page: safePage,
      limit,
      totalPages,
      groups: Array.from(groupsSet).sort()
    };
  }

  /**
   * Busca no catálogo: Retorna estritamente Filmes e Cards de Séries (incluindo Adultos +18 quando allowAdult=true).
   * NUNCA retorna episódios soltos.
   */
  search(query, allowAdult = false) {
    if (!query || !this.isReady) return [];
    const normalize = str => (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const qNorm = normalize(query);
    if (!qNorm) return [];

    const matchedMovies = [];
    const matchedSeries = [];

    const matchesItem = (item) => {
      const nameNorm = normalize(item.name || item.rawTitle || '');
      const groupNorm = normalize(item.group || '');
      return nameNorm.includes(qNorm) || groupNorm.includes(qNorm);
    };

    // 1. Filmes
    for (let i = 0; i < this.movies.length; i++) {
      const m = this.movies[i];
      const isAdultMovie = Boolean(m.isAdult || this.isAdultGroup(m.group));
      if (isAdultMovie && !allowAdult) continue;
      if (matchesItem(m)) {
        matchedMovies.push({ ...m, itemType: 'movie', isAdult: isAdultMovie, rating: isAdultMovie ? '18' : (m.rating || '12') });
        if (matchedMovies.length >= 150) break;
      }
    }

    // 2. Séries (apenas cards das séries com total de temporadas/episódios, NUNCA episódios soltos)
    for (let i = 0; i < this.series.length; i++) {
      const s = this.series[i];
      const isAdultSeries = Boolean(s.isAdult || this.isAdultGroup(s.group));
      if (isAdultSeries && !allowAdult) continue;
      if (matchesItem(s)) {
        matchedSeries.push({ ...s, itemType: 'series', isAdult: isAdultSeries, rating: isAdultSeries ? '18' : (s.rating || '12') });
        if (matchedSeries.length >= 100) break;
      }
    }

    return [...matchedMovies, ...matchedSeries].slice(0, 200);
  }
}

module.exports = new PlaylistManager();
