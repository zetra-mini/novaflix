process.on('uncaughtException', (err) => {
  console.error('[FATAL ERROR PREVENTED] Uncaught Exception:', err);
  try {
    const adminManager = require('./admin-manager');
    adminManager.logEvent('ERROR', 'SISTEMA', `Erro crítico capturado (anti-crash): ${err.message}`);
  } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL ERROR PREVENTED] Unhandled Rejection:', reason);
  try {
    const adminManager = require('./admin-manager');
    adminManager.logEvent('ERROR', 'SISTEMA', `Promise rejeitada capturada (anti-crash): ${reason?.message || reason}`);
  } catch (e) {}
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const playlistManager = require('./playlist-manager');
const epgManager = require('./epg-manager');
const adminManager = require('./admin-manager');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Reconhece tráfego via Cloudflare / Nginx / Load Balancer (CF-Connecting-IP, X-Forwarded-Proto)
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'public')));

// User-Agent padrão e timeout dinâmicos (compatíveis com o Extreme-InfiniTV)
let currentUserAgent = 'VLC/3.0.20 LibVLC/3.0.20';
let currentNetworkTimeoutMs = 30000;

let activeStreamsCount = 0;
const redirectCache = new Map();
const activeStreamControllers = new Map();
function hasActiveStreams() {
  return activeStreamsCount > 0;
}
if (playlistManager) {
  playlistManager.hasActiveStreams = hasActiveStreams;
}

/**
 * Função para seguir múltiplos redirecionamentos internos (CDN/Edge)
 * e transmitir o áudio/vídeo contínuo sem cortes ou timeout indevido de socket.
 */
async function pipeStream(targetUrl, req, res) {
  const { Readable } = require('stream');

  const abortController = new AbortController();
  let isClosed = false;

  const cleanup = () => {
    if (!isClosed) {
      isClosed = true;
      activeStreamsCount = Math.max(0, activeStreamsCount - 1);
      try { abortController.abort(); } catch (e) {}
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);

  activeStreamsCount++;

  const requestHeaders = {
    'User-Agent': currentUserAgent || 'VLC/3.0.18 LibVLC/3.0.18',
    'Accept': '*/*'
  };
  if (req.headers.range) {
    requestHeaders['Range'] = req.headers.range;
  }

  try {
    const cached = redirectCache.get(targetUrl);
    let fetchUrl = (cached && cached.expiresAt > Date.now()) ? cached.url : targetUrl;

    let upstream = await fetch(fetchUrl, {
      headers: requestHeaders,
      redirect: 'follow',
      signal: abortController.signal
    });

    if (fetchUrl !== targetUrl && upstream.status >= 400) {
      redirectCache.delete(targetUrl);
      upstream = await fetch(targetUrl, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: abortController.signal
      });
    }

    if (upstream.ok && upstream.url && upstream.url !== targetUrl) {
      redirectCache.set(targetUrl, {
        url: upstream.url,
        expiresAt: Date.now() + 10 * 60 * 1000
      });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Accel-Buffering', 'no');

    const contentType = upstream.headers.get('content-type') || (targetUrl.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
    res.setHeader('Content-Type', contentType);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(upstream.status);

    if (upstream.body) {
      const nodeReadable = Readable.fromWeb(upstream.body);
      nodeReadable.on('error', () => {
        cleanup();
      });
      nodeReadable.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    cleanup();
    if (!res.headersSent) {
      if (err.name === 'AbortError') return;
      console.warn('[Proxy Stream] Erro upstream:', err.message);
      res.status(502).send('Falha de conexão com a fonte IPTV.');
    }
  }
}

/**
 * ==============================================================================
 * ROTAS MODULARES DA ARQUITETURA ENTERPRISE (Catálogo, Stream, Telemetria e Infra)
 * ==============================================================================
 */
const catalogRoutes = require('./routes/catalog.routes');
const streamRoutes = require('./routes/stream.routes');
const telemetryRoutes = require('./routes/telemetry.routes');
const { router: adminExtraRoutes } = require('./routes/admin.routes');

app.use('/api/netflix', catalogRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/admin', adminExtraRoutes);

/**
 * Status do Catálogo
 */
app.get('/api/netflix/status', (req, res) => {
  res.json({
    isReady: playlistManager.isReady,
    isDownloading: playlistManager.isDownloading,
    catalogVersion: playlistManager.catalogVersion || 1,
    lastUpdated: playlistManager.lastUpdated || null,
    totalChannels: playlistManager.channels.length,
    totalMovies: playlistManager.movies.length,
    totalSeries: playlistManager.series.length,
    totalEpisodes: playlistManager.totalEpisodesCount
  });
});

/**
 * Detalhes completos da Série (todas as temporadas e episódios com streams)
 */
app.get('/api/netflix/series/:id', (req, res) => {
  const seriesId = parseInt(req.params.id, 10);
  const seriesData = playlistManager.getSeriesById(seriesId);
  if (!seriesData) {
    return res.status(404).json({ error: 'Série não encontrada' });
  }
  res.json(seriesData);
});

/**
 * Metadados detalhados (EPG oficial, sinopses, capas TMDB, elenco e trailers)
 * para Filmes, Séries e Canais Ao Vivo
 */
app.get('/api/netflix/details', async (req, res) => {
  const { type = 'movie', name = '', id = '', token = '', tvgId = '' } = req.query;

  try {
    if (type === 'series') {
      let seriesItem = null;
      if (id) {
        seriesItem = playlistManager.series.find(s => s.id === parseInt(id, 10));
      }
      if (!seriesItem && name) {
        seriesItem = playlistManager.series.find(s => s.name === name);
      }
      const details = epgManager.getSeriesDetails(name);
      return res.json({ success: true, details: details || null });
    }

    if (type === 'movie') {
      let targetVodId = req.query.vodId;
      if (!targetVodId && token) {
        let cleanToken = decodeURIComponent(token).replace('/api/stream/', '').replace(/\..*$/, '');
        const targetUrl = playlistManager.decryptUrl(cleanToken);
        if (targetUrl) {
          const m = targetUrl.match(/\/movie\/[^\/]+\/[^\/]+\/(\d+)/);
          if (m) targetVodId = m[1];
        }
      }

      let movieItem = null;
      if (id) {
        movieItem = playlistManager.movies.find(m => m.id === parseInt(id, 10));
      }
      if (!movieItem && name) {
        movieItem = playlistManager.movies.find(m => m.name === name);
      }

      if (!targetVodId && movieItem && movieItem.streamUrl) {
        let cleanToken = decodeURIComponent(movieItem.streamUrl).replace('/api/stream/', '').replace(/\..*$/, '');
        const targetUrl = playlistManager.decryptUrl(cleanToken);
        if (targetUrl) {
          const m = targetUrl.match(/\/movie\/[^\/]+\/[^\/]+\/(\d+)/);
          if (m) targetVodId = m[1];
        }
      }

      let details = await epgManager.getVodDetails(targetVodId, name);
      if (!details || !details.plot) {
        details = epgManager.generateFallbackDetails(name, movieItem);
      }
      return res.json({ success: true, details: details || null });
    }

    if (type === 'live') {
      const details = epgManager.getEPGForChannel(tvgId, name);
      return res.json({ success: true, details: details || null });
    }

    res.json({ success: false, details: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Guia de Programação EPG e Capas Oficiais
 */
app.get('/api/netflix/epg', (req, res) => {
  const { tvgId, name } = req.query;
  const data = epgManager.getEPGForChannel(tvgId, name);
  res.json(data);
});

/**
 * Retorna itens de uma categoria com paginação e busca para o modo "Ver Tudo / Grade Completa"
 */
app.get('/api/netflix/category-items', (req, res) => {
  const { type = 'all', group = '', page = 1, limit = 48, search = '' } = req.query;
  const isKids = req.query.kids === '1' || req.query.kids === 'true';
  const allowAdult = req.query.adult === '1' || req.query.adult === 'true';
  const data = playlistManager.getCategoryItems({
    type,
    group,
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    search,
    isKidsMode: isKids,
    allowAdult: allowAdult && !isKids
  });
  res.json(data);
});

/**
 * Endpoint de Streaming com Descriptografia em Tempo Real (AES-256)
 */
app.get('/api/stream/:token', (req, res) => {
  let token = req.params.token;
  if (!token) {
    return res.status(400).send('Token de transmissão ausente');
  }
  try { token = decodeURIComponent(token); } catch(e) {}

  // Remove extensões adicionadas para o navegador (.mp4, .m3u8, .ts, etc.)
  token = token.replace(/\.(mp4|m3u8|ts|mkv)$/i, '');

  const targetUrl = playlistManager.decryptUrl(token);
  if (!targetUrl) {
    adminManager.logEvent('WARN', 'STREAMING', 'Tentativa de reprodução com token inválido ou expirado', { ip: req.ip });
    return res.status(403).json({ error: 'Token de stream inválido ou expirado' });
  }

  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '127.0.0.1';
  const clientIp = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
  const streamPath = targetUrl.replace(/^http:\/\/[^\/]+/, '');
  adminManager.logEvent('STREAM', 'STREAMING', `Conexão de streaming aberta: ${streamPath.substring(0, 40)}...`, { 
    ip: clientIp, 
    details: targetUrl.split('?')[0] 
  });

  // MODO DE TRANSMISSÃO INTELIGENTE:
  // Se o ADM estiver configurado com 'direct' (Decodificação Direta na Ponta / CDN de Alta Velocidade)
  // ou se o cliente explicitamente solicitar ?direct=1:
  // O servidor responde com HTTP 302 Found para a URL direta do provedor / BunnyCDN.
  // VANTAGEM: Zero consumo de banda e CPU da VPS de 1GB, eliminação total do travamento aos 30s!
  const streamMode = adminManager.getStreamMode ? adminManager.getStreamMode() : 'proxy';
  const forceDirect = req.query.direct === '1';
  const forceProxy = req.query.proxy === '1';

  if ((streamMode === 'direct' || forceDirect) && !forceProxy) {
    return res.redirect(302, targetUrl);
  }

  activeStreamsCount++;
  let isStreamClosed = false;
  const onStreamClose = () => {
    if (!isStreamClosed) {
      isStreamClosed = true;
      activeStreamsCount = Math.max(0, activeStreamsCount - 1);
    }
  };
  res.on('close', onStreamClose);
  res.on('finish', onStreamClose);

  pipeStream(targetUrl, req, res);
});

/**
 * Endpoint para Decodificação Direta na Ponta (Client-Side Decoding para Apps Desktop/Tauri/Android)
 * Retorna a URL direta do fornecedor para reprodução sem passar pela VPS (evita consumo de banda)
 */
app.get('/api/stream/direct/:token', (req, res) => {
  let token = req.params.token;
  if (!token) return res.status(400).json({ success: false, error: 'Token de stream ausente' });
  token = token.replace(/\.(mp4|m3u8|ts|mkv)$/i, '');

  const targetUrl = playlistManager.decryptUrl(token);
  if (!targetUrl) {
    return res.status(403).json({ success: false, error: 'Token de stream inválido ou expirado' });
  }

  res.json({
    success: true,
    directUrl: targetUrl
  });
});

/**
 * Endpoints de Download Direto de Aplicativos Nativos (Windows .exe e Android .apk)
 */
app.get('/download/NovaFlix.exe', (req, res) => {
  const exePaths = [
    path.join(__dirname, 'dist-electron', 'NovaFlix.exe'),
    path.join(__dirname, 'dist-electron', 'NovaFlix 2.0.5.exe'),
    path.join(__dirname, 'dist-electron', 'NovaFlix 2.0.0.exe'),
    path.join(__dirname, 'dist-electron', 'win-unpacked', 'NovaFlix.exe')
  ];
  for (const p of exePaths) {
    if (fs.existsSync(p)) {
      return res.download(p, 'NovaFlix.exe');
    }
  }
  res.status(404).send('Executável Windows ainda não compilado no servidor.');
});

app.get('/download/NovaFlix.apk', (req, res) => {
  const apkPaths = [
    path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(__dirname, 'NovaFlix.apk'),
    path.join(__dirname, 'build-artifacts', 'NovaFlix-Android.apk'),
    path.join(__dirname, 'public', 'NovaFlix.apk')
  ];
  for (const p of apkPaths) {
    if (fs.existsSync(p)) {
      return res.download(p, 'NovaFlix.apk');
    }
  }
  // Se ainda não estiver compilado/colocado na pasta do servidor, exibe aviso amigável sem redirecionamento confuso
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Download NovaFlix APK</title>
      <style>
        body { background: #141414; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { max-width: 460px; width: 100%; background: #1c1c1c; border: 1px solid #333; border-radius: 20px; padding: 32px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.8); }
        .badge { display: inline-flex; width: 56px; height: 56px; border-radius: 50%; background: rgba(229,9,20,0.15); color: #e50914; align-items: center; justify-content: center; font-size: 26px; border: 1px solid rgba(229,9,20,0.3); margin-bottom: 16px; }
        h2 { font-size: 20px; font-weight: 800; margin: 0 0 10px; color: #fff; }
        p { color: #aaa; font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
        .tip-box { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.25); border-radius: 12px; padding: 14px; text-align: left; margin: 18px 0; font-size: 12px; color: #6ee7b7; line-height: 1.5; }
        .btn { display: inline-block; background: #e50914; color: #fff; font-weight: bold; font-size: 13px; text-decoration: none; padding: 12px 24px; border-radius: 12px; transition: background 0.2s; }
        .btn:hover { background: #b80710; }
        .btn-ghost { display: inline-block; background: rgba(255,255,255,0.08); color: #ccc; font-weight: 600; font-size: 12px; text-decoration: none; padding: 10px 20px; border-radius: 10px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">📱</div>
        <h2>Instalação no Android</h2>
        <p>O arquivo <strong>NovaFlix.apk</strong> ainda não foi colocado na pasta deste servidor.</p>
        <div class="tip-box">
          <strong>⚡ Instalação Instantânea Recomendada:</strong><br>
          Você não precisa de arquivo APK! No Chrome do celular, toque nos <strong>3 pontinhos (⋮)</strong> e selecione <strong>"Adicionar à tela inicial"</strong>. O app roda em tela cheia igual a um app nativo!
        </div>
        <div>
          <a href="/" class="btn">Abrir NovaFlix no Navegador</a>
        </div>
        <div>
          <a href="https://github.com/zetra-mini/novaflix/releases" target="_blank" class="btn-ghost">Ver Releases no GitHub</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

/**
 * Consulta de Status do Gateway de Pagamento (Público para inicialização limpa do cliente)
 * Se não houver API Key cadastrada no ADM, retorna hasGateway: false (Modo 100% Gratuito)
 */
app.get('/api/payment/status', (req, res) => {
  const cfg = adminManager.getPaymentGatewayConfig();
  res.json({
    success: true,
    hasGateway: cfg.isActive
  });
});

/**
 * Endpoints de Configurações de Rede e Proxy (Extreme-InfiniTV Architecture)
 */
app.get('/api/settings/network', (req, res) => {
  res.json({
    success: true,
    userAgent: currentUserAgent,
    timeoutSeconds: Math.round(currentNetworkTimeoutMs / 1000)
  });
});

app.post('/api/settings/network', (req, res) => {
  const { userAgent, timeoutSeconds } = req.body;
  if (typeof userAgent === 'string' && userAgent.trim()) {
    currentUserAgent = userAgent.trim();
  }
  if (typeof timeoutSeconds === 'number' && timeoutSeconds >= 5) {
    currentNetworkTimeoutMs = Math.round(timeoutSeconds * 1000);
  }
  res.json({
    success: true,
    userAgent: currentUserAgent,
    timeoutSeconds: Math.round(currentNetworkTimeoutMs / 1000)
  });
});

/**
 * ==============================================================================
 * ROTAS DO PAINEL ADMINISTRATIVO & API PÚBLICA (ANTI-QUEDA & SAC)
 * ==============================================================================
 */

// Servir Painel Administrativo em /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/**
 * 1. GET /api/config (Consumida pelo Player ao iniciar para contingência de domínios e listas)
 */
app.get('/api/config', (req, res) => {
  res.json(adminManager.getPublicConfig());
});

/**
 * 2. POST /api/feedback (Consumida pelo botão do Player para SAC, Reclamações e Sugestões)
 */
app.post('/api/feedback', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  
  // Validação de Rate Limiting por IP
  if (!adminManager.checkRateLimit(clientIp)) {
    return res.status(429).json({
      success: false,
      error: 'Limite de mensagens atingido para este endereço IP. Aguarde alguns minutos antes de enviar outro feedback.'
    });
  }

  const { tipo, mensagem } = req.body;
  if (!mensagem || !String(mensagem).trim()) {
    return res.status(400).json({ success: false, error: 'A mensagem não pode estar vazia.' });
  }

  try {
    const item = await adminManager.addFeedback({ tipo, mensagem, ip: clientIp });
    adminManager.logEvent('INFO', 'FEEDBACK', `Novo feedback recebido (${tipo}): "${mensagem.substring(0, 40)}..."`, { 
      ip: clientIp 
    });
    res.json({
      success: true,
      message: 'Feedback enviado com sucesso! Agradecemos sua colaboração.',
      feedbackId: item.id
    });
  } catch (err) {
    adminManager.logEvent('ERROR', 'FEEDBACK', `Falha ao salvar feedback: ${err.message}`, { ip: clientIp });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Middleware de Autenticação Segura JWT para o Painel ADM
 */
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Acesso não autorizado. Faça login no Painel ADM.' });
  }

  const decoded = adminManager.verifyJwt(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Sessão expirada ou token inválido. Faça login novamente.' });
  }

  req.adminUser = decoded;
  next();
}

/**
 * 3. POST /api/admin/login (Login e Geração de Token JWT)
 */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '127.0.0.1';
  const auth = adminManager.authenticate(username, password);

  if (!auth) {
    adminManager.logEvent('WARN', 'SEGURANÇA', `Falha de autenticação: credenciais incorretas para "${username || 'desconhecido'}"`, { 
      ip: clientIp 
    });
    return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos.' });
  }

  adminManager.logEvent('AUTH', 'SEGURANÇA', `Login administrativo autorizado para "${username}"`, { 
    ip: clientIp 
  });
  res.json({ success: true, ...auth });
});

/**
 * 4. GET /api/admin/dashboard (Métricas Gerais, Status do Domínio e Health Checks)
 */
app.get('/api/admin/dashboard', requireAdminAuth, (req, res) => {
  const metrics = adminManager.getFeedbackMetrics();
  const domainConfig = adminManager.getDomainConfig();
  const playlistConfig = adminManager.getPlaylistConfig();
  const recentFeedbacks = adminManager.getFeedbacks({ page: 1, limit: 5 }).items;

  res.json({
    success: true,
    mainDomain: domainConfig.mainDomain,
    health: playlistConfig.healthChecks,
    metrics,
    recentFeedbacks
  });
});

/**
 * 5. Endpoints de Domínios & Anti-Queda (Tela 2)
 */
app.get('/api/admin/detect-vps-ip', requireAdminAuth, async (req, res) => {
  try {
    const host = req.get('host') || '';
    const isHostLocal = host.includes('localhost') || host.includes('127.0.0.1');
    const requestUrl = (!isHostLocal && host) ? `${req.protocol}://${host}` : null;
    const activePort = parseInt(process.env.PORT, 10) || 80;
    const isStandardPort = (activePort === 80 || activePort === 443);

    let publicIp = null;
    try {
      publicIp = await adminManager.detectPublicIp();
    } catch (e) {}

    const ipUrl = publicIp ? (isStandardPort ? `http://${publicIp}` : `http://${publicIp}:${activePort}`) : null;
    const detectedUrl = requestUrl || ipUrl || (host ? `${req.protocol}://${host}` : `http://localhost:${activePort}`);

    // Se o domínio cadastrado ainda for localhost, auto-atualiza com o endereço real
    if (adminManager.store && (!adminManager.store.config.mainDomain || adminManager.store.config.mainDomain.includes('localhost'))) {
      if (detectedUrl && !detectedUrl.includes('localhost')) {
        adminManager.updateDomainConfig({ mainDomain: detectedUrl });
      }
    }

    res.json({
      success: true,
      publicIp: publicIp || (requestUrl ? host.split(':')[0] : '127.0.0.1'),
      detectedUrl,
      requestUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/domains', requireAdminAuth, (req, res) => {
  const host = req.get('host') || '';
  const isHostLocal = host.includes('localhost') || host.includes('127.0.0.1');
  if (!isHostLocal && host && adminManager.store && (!adminManager.store.config.mainDomain || adminManager.store.config.mainDomain.includes('localhost'))) {
    adminManager.updateDomainConfig({ mainDomain: `${req.protocol}://${host}` });
  }
  res.json(adminManager.getDomainConfig());
});

app.post('/api/admin/domains', requireAdminAuth, (req, res) => {
  const { mainDomain, mirrorDomains } = req.body;
  const updated = adminManager.updateDomainConfig({ mainDomain, mirrorDomains });
  res.json({ success: true, ...updated });
});

app.get('/api/admin/apps-status', requireAdminAuth, (req, res) => {
  const domainConfig = adminManager.getDomainConfig();
  const baseDomain = domainConfig.mainDomain || `${req.protocol}://${req.get('host')}`;

  const exePaths = [
    path.join(__dirname, 'dist-electron', 'NovaFlix.exe'),
    path.join(__dirname, 'dist-electron', 'NovaFlix 2.0.5.exe'),
    path.join(__dirname, 'dist-electron', 'NovaFlix 2.0.0.exe'),
    path.join(__dirname, 'dist-electron', 'win-unpacked', 'NovaFlix.exe')
  ];
  let exeFound = false;
  let exeSizeMb = 0;
  for (const p of exePaths) {
    if (fs.existsSync(p)) {
      exeFound = true;
      exeSizeMb = (fs.statSync(p).size / (1024 * 1024)).toFixed(1);
      break;
    }
  }

  const apkPaths = [
    path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(__dirname, 'NovaFlix.apk')
  ];
  let apkFound = false;
  let apkSizeMb = 0;
  for (const p of apkPaths) {
    if (fs.existsSync(p)) {
      apkFound = true;
      apkSizeMb = (fs.statSync(p).size / (1024 * 1024)).toFixed(1);
      break;
    }
  }

  let serverConfig = null;
  try {
    const scPath = path.join(__dirname, 'public', 'server_config.json');
    if (fs.existsSync(scPath)) {
      serverConfig = JSON.parse(fs.readFileSync(scPath, 'utf8'));
    }
  } catch (e) {}

  res.json({
    success: true,
    mainDomain: domainConfig.mainDomain,
    serverConfig,
    apps: {
      exe: {
        availableLocally: exeFound,
        sizeMb: exeSizeMb,
        url: `${baseDomain}/download/NovaFlix.exe`
      },
      apk: {
        availableLocally: apkFound,
        sizeMb: apkSizeMb,
        url: `${baseDomain}/download/NovaFlix.apk`,
        fallbackUrl: 'https://github.com/zetra-mini/novaflix/releases/latest'
      },
      web: {
        url: baseDomain
      }
    }
  });
});

/**
 * 6. Endpoints de Listas IPTV & Failover (Tela 3)
 */
const adminController = require('./controllers/admin.controller');
app.get('/api/admin/playlists', requireAdminAuth, (req, res) => adminController.getPlaylists(req, res));
app.post('/api/admin/playlists', requireAdminAuth, (req, res) => adminController.savePlaylists(req, res));

app.post('/api/admin/health-check', requireAdminAuth, async (req, res) => {
  const results = await adminManager.runHealthChecks();
  res.json({ success: true, healthChecks: results });
});

app.post('/api/admin/playlists/sync', requireAdminAuth, async (req, res) => {
  try {
    adminManager.logEvent('INFO', 'LISTAS', 'Sincronização manual do catálogo solicitada no painel ADM.');
    const result = await playlistManager.backgroundSync(true);
    res.json({ success: true, ...result });
  } catch (err) {
    adminManager.logEvent('ERROR', 'LISTAS', `Erro ao sincronizar catálogo: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 7. Endpoints da Central de Mensagens & SAC (Tela 4)
 */
app.get('/api/admin/feedback', requireAdminAuth, (req, res) => {
  const page = parseInt(req.query.page || 1, 10);
  const limit = parseInt(req.query.limit || 20, 10);
  const tipo = req.query.tipo || '';
  const status = req.query.status || '';
  const search = req.query.search || '';

  const data = adminManager.getFeedbacks({ page, limit, tipo, status, search });
  res.json({ success: true, ...data });
});

app.put('/api/admin/feedback/:id', requireAdminAuth, (req, res) => {
  const { status } = req.body;
  try {
    const updated = adminManager.updateFeedbackStatus(req.params.id, status || 'read');
    res.json({ success: true, feedback: updated });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/feedback/:id', requireAdminAuth, (req, res) => {
  try {
    adminManager.deleteFeedback(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

/**
 * 8. Endpoints de Configurações Técnicas & Alertas (Tela 5)
 */
app.get('/api/admin/settings', requireAdminAuth, (req, res) => {
  res.json(adminManager.getSettings());
});

app.post('/api/admin/settings', requireAdminAuth, (req, res) => {
  const { telegram, rateLimit, corsAllowedDomains, streamMode, syncInterval } = req.body;
  const updated = adminManager.updateSettings({ telegram, rateLimit, corsAllowedDomains, streamMode, syncInterval });
  if (syncInterval && playlistManager && typeof playlistManager.scheduleAutoUpdate === 'function') {
    playlistManager.scheduleAutoUpdate();
  }
  res.json({ success: true, settings: updated });
});

/**
 * 9. Endpoints de Gestão de Usuários Administradores (Tela 6)
 */
app.get('/api/admin/users', requireAdminAuth, (req, res) => {
  res.json({ success: true, users: adminManager.getUsers() });
});

app.post('/api/admin/users', requireAdminAuth, (req, res) => {
  const { username, password, name, role } = req.body;
  try {
    const newUser = adminManager.addUser({ username, password, name, role });
    res.json({ success: true, user: newUser });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/users/me', requireAdminAuth, (req, res) => {
  const { username, newPassword, name } = req.body;
  try {
    const updated = adminManager.updateProfile(req.adminUser.userId, { username, newPassword, name });
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/users/:id/password', requireAdminAuth, (req, res) => {
  const { password } = req.body;
  try {
    adminManager.updateUserPassword(req.params.id, password);
    res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdminAuth, (req, res) => {
  try {
    adminManager.deleteUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * 10. Endpoints de Monitoramento de Sessões em Tempo Real
 */
app.post('/api/heartbeat', (req, res) => {
  const { sessionId, uuid, currentTitle, itemType, durationSeconds, profile, donationStats } = req.body || {};
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const ip = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
  const userAgent = req.headers['user-agent'] || '';

  const result = adminManager.recordHeartbeat({
    sessionId,
    uuid,
    ip,
    userAgent,
    currentTitle,
    itemType,
    durationSeconds,
    profile,
    donationStats
  });

  res.json(result);
});

app.get('/api/admin/sessions', requireAdminAuth, (req, res) => {
  const sessions = adminManager.getActiveSessions();
  res.json({ success: true, count: sessions.length, sessions });
});

app.post('/api/admin/sessions/message', requireAdminAuth, (req, res) => {
  try {
    const { targetSessionId, text, type, title } = req.body || {};
    const result = adminManager.sendEncryptedMessage({ targetSessionId, text, type, title });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Disparo de Comando Remoto Criptografado (AES-256)
 * Permite reproduzir imediatamente no cliente ou enviar pop-up com ação
 */
app.post('/api/admin/remote-command', requireAdminAuth, (req, res) => {
  try {
    const { targetSessionId, commandType, contentType, item, url, title, message, buttonText } = req.body || {};
    const result = adminManager.sendRemoteCommand({
      targetSessionId,
      commandType,
      contentType,
      item,
      url,
      title,
      message,
      buttonText
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/sessions/:id', requireAdminAuth, (req, res) => {
  const ok = adminManager.terminateSession(req.params.id);
  res.json({ success: ok });
});

/**
 * 11. Endpoints do Terminal de Logs do Sistema em Tempo Real
 */
app.get('/api/admin/logs', requireAdminAuth, (req, res) => {
  const { limit = 150, level = 'ALL', category = 'ALL', search = '' } = req.query;
  const data = adminManager.getLogs({ limit, level, category, search });
  res.json({ success: true, ...data });
});

app.delete('/api/admin/logs', requireAdminAuth, (req, res) => {
  adminManager.clearLogs();
  res.json({ success: true, message: 'Logs do sistema limpos com sucesso.' });
});

/**
 * 12. Configurações de Pagamento (Gateway) & Controle de Usuários via UUID
 */
app.get('/api/admin/payment-gateway', requireAdminAuth, (req, res) => {
  res.json({
    success: true,
    ...adminManager.getPaymentGatewayConfig()
  });
});

app.post('/api/admin/payment-gateway', requireAdminAuth, (req, res) => {
  const { apiKey } = req.body || {};
  const updated = adminManager.updatePaymentGatewayConfig({ apiKey });
  res.json({ success: true, ...updated });
});

app.get('/api/admin/users-control', requireAdminAuth, (req, res) => {
  const users = adminManager.getUsersControlList();
  res.json({ success: true, count: users.length, users });
});

app.post('/api/admin/users-control/override', requireAdminAuth, (req, res) => {
  const { uuid, abolishDonation, forceDonation, customInitialValues, customRecurringValues, name } = req.body || {};
  try {
    const updated = adminManager.setUserOverride(uuid, {
      abolishDonation,
      forceDonation,
      customInitialValues,
      customRecurringValues,
      name
    });
    res.json({ success: true, override: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * 13. Confirmação de Conteúdo Adulto (+18) do Usuário
 * Registra a confirmação na sessão ativa e gera log de auditoria no painel ADM
 */
app.post('/api/user/confirm-adult', (req, res) => {
  const { sessionId, profile } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const cleanIp = String(ip).replace('::ffff:', '');
  const userName = (profile && profile.name) ? String(profile.name).trim() : 'Visitante';
  const gender = (profile && profile.gender) ? String(profile.gender).trim() : 'Não informado';

  if (sessionId && adminManager.activeSessions.has(sessionId)) {
    const sess = adminManager.activeSessions.get(sessionId);
    if (!sess.profile) sess.profile = {};
    sess.profile.isAdultConfirmed = true;
    sess.profile.adultConfirmedAt = new Date().toISOString();
  }

  adminManager.logEvent('INFO', 'SEGURANÇA', `Usuário "${userName}" (${gender}) confirmou termo de maioridade (+18) a partir do IP ${cleanIp}.`);
  res.json({ success: true, isAdultConfirmed: true, confirmedAt: new Date().toISOString() });
});

// Middleware global de tratamento de erros para rotas /api (Garante retorno JSON)
app.use((err, req, res, next) => {
  console.error('[API Error]', err.stack || err.message);
  if (res.headersSent) {
    return next(err);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Erro interno no servidor'
    });
  }
  next(err);
});

// SPA fallback para index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicia servidores e catálogo quando executado diretamente
if (require.main === module) {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  // Na VPS com Nginx, a porta padrão do Node upstream é 3000. Se 80 estiver livre (ex: sem Nginx), vincula 80 também.
  const portsToTry = envPort ? [envPort] : [3000, 80];
  const activeServers = [];

  const startServerOnPort = (port) => {
    return new Promise((resolve) => {
      const s = http.createServer(app);
      s.timeout = 0; // Desativa timeout global para suportar streaming ininterrupto de horas
      s.keepAliveTimeout = 120000;
      s.headersTimeout = 125000;

      s.on('error', (err) => {
        if (err.code === 'EACCES') {
          console.warn(`[Web Server] Porta ${port} requer privilégios de administrador (sudo/root) no Linux.`);
        } else if (err.code === 'EADDRINUSE') {
          console.warn(`[Web Server] Porta ${port} já está em uso por outro processo (ex: Nginx).`);
        } else {
          console.warn(`[Web Server] Erro na porta ${port}:`, err.message);
        }
        try { s.close(); } catch (e) {}
        resolve(null);
      });

      s.listen(port, () => {
        activeServers.push({ port, server: s });
        resolve(s);
      });
    });
  };

  (async () => {
    for (const p of portsToTry) {
      await startServerOnPort(p);
    }

    const boundPorts = activeServers.map(s => s.port);
    const primaryBoundPort = boundPorts[0] || envPort || 3000;
    console.log(`=======================================================`);
    console.log(` 🍿 NOVAFLIX STREAMING INICIALIZADO COM SUCESSO`);
    console.log(` 🔒 Criptografia AES-256 e Proxy IP Fixo (VLC Engine)`);
    console.log(` 🌐 Portas Ativas (Cloudflare / Domínios / IP): [ ${boundPorts.join(', ') || primaryBoundPort} ]`);
    console.log(` 🚀 Acesso Web Oficial: http://localhost${boundPorts.includes(80) ? '' : `:${primaryBoundPort}`}`);
    console.log(`=======================================================`);

    const db = require('./services/db');
    const cronService = require('./services/cron-service');
    const streamController = require('./controllers/stream.controller');

    db.init().then(() => {
      cronService.setStreamChecker(() => streamController.hasActiveStreams());
      cronService.start();
    }).catch(err => {
      console.warn('[SQLite] Aviso na inicialização:', err.message);
    });

    playlistManager.init().catch(err => {
      console.error('[Manager] Erro na inicialização:', err.message);
    });

    const activePortForConfig = boundPorts.includes(80) ? 80 : (boundPorts[0] || primaryPort);
    adminManager.autoConfigureVpsIp(activePortForConfig).then(detected => {
      if (detected && !detected.includes('localhost')) {
        console.log(` 🔗 Domínio Principal Vinculado: ${detected}`);
      }
    }).catch(err => {
      console.warn('[Admin] Aviso ao auto-configurar IP da VPS:', err.message);
    });
  })();
} else {
  // Inicialização assíncrona para ambiente Serverless (Vercel)
  playlistManager.init().catch(err => {
    console.warn('[Manager] Aviso inicialização serverless:', err.message);
  });
}

module.exports = app;
