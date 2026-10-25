const http = require('http');
const https = require('https');
const streamTokenService = require('../services/stream-token-service');
const telemetryService = require('../services/telemetry-service');
const adminManager = require('../admin-manager');
const db = require('../services/db');

let activeStreamsCount = 0;
const redirectCache = new Map();
const activeStreamControllers = new Map();

class StreamController {
  hasActiveStreams() {
    return activeStreamsCount > 0;
  }

  getActiveStreamsCount() {
    return activeStreamsCount;
  }

  /**
   * Endpoint de Streaming com Tokenização JWT e Proxy Reverso
   */
  async handleStream(req, res) {
    let rawToken = req.params.token;
    if (!rawToken) {
      return res.status(400).send('Token de transmissão ausente.');
    }
    try { rawToken = decodeURIComponent(rawToken); } catch (e) {}

    let verified = streamTokenService.verifyStreamToken(rawToken);
    let targetUrl = verified?.streamUrl;

    if (!targetUrl) {
      try {
        const playlistManager = require('../playlist-manager');
        const clean = rawToken.replace(/\.(mp4|ts|m3u8|mkv)$/i, '');
        const dec = playlistManager.decryptUrl(clean);
        if (dec && dec.startsWith('http')) {
          targetUrl = dec;
          verified = { streamUrl: dec, uuid: 'playlist-mgr', itemType: 'vod' };
        }
      } catch (e) {}
    }

    if (!targetUrl) {
      return res.status(403).send('Token de streaming inválido ou expirado.');
    }
    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientIp = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const uuid = verified.uuid || 'app';

    try {
      const streamPath = targetUrl.replace(/^https?:\/\/[^\/]+/, '');
      adminManager.logEvent('STREAM', 'STREAMING', `Conexão de streaming aberta: ${streamPath.substring(0, 48)}`, {
        ip: clientIp,
        details: targetUrl.split('?')[0]
      });
    } catch (e) {}

    // Registra atividade na telemetria
    telemetryService.recordHeartbeat({
      uuid,
      ip: clientIp,
      device: req.headers['user-agent'] || 'Player',
      streamId: rawToken.substring(0, 16)
    }).catch(() => {});

    // Verifica modo de streaming configurado no painel administrativo
    const streamMode = adminManager.getStreamMode ? adminManager.getStreamMode() : 'proxy';

    const isHls = targetUrl.includes('.m3u8') || targetUrl.includes('output=m3u8') || verified.mediaType === 'hls' || verified.mediaType === 'm3u8';
    const isLiveTs = (targetUrl.includes('.ts') || targetUrl.includes('output=ts') || verified.mediaType === 'ts') && !isHls;
    const forceProxy = req.query.proxy === '1';

    // 1. Canais Ao Vivo HLS (.m3u8): Reescreve manifest com CDN de alta velocidade e CORS *
    if (isHls && !forceProxy) {
      return this.handleHlsPlaylist(targetUrl, req, res);
    }

    // 2. Filmes e Séries VOD (MP4): Se configurado em direct no painel ADM, redireciona 302 direto
    if (!isLiveTs && !forceProxy && streamMode === 'direct') {
      return res.redirect(302, targetUrl);
    }

    // 3. Canais Legados MPEG-TS (.ts): Modo Proxy Reverso Otimizado com Latência Mínima
    this.pipeStream(targetUrl, req, res);
  }

  /**
   * Processador HLS Inteligente: Resolve redirecionamentos da CDN IPTV e reescreve segmentos relativos
   * para URLs absolutas apontando diretamente para o Edge CDN com suporte nativo a CORS.
   */
  async handleHlsPlaylist(targetUrl, req, res) {
    try {
      let cdnBase = '';
      const fetchStep = (curUrl, depth = 6) => {
        return new Promise((resolve, reject) => {
          if (depth <= 0) return reject(new Error('Muitos redirecionamentos no servidor HLS.'));
          const isHttps = curUrl.startsWith('https:');
          const client = isHttps ? https : http;
          const headers = {
            'User-Agent': 'IPTVSmartersPro/1.0.0',
            'Accept': '*/*'
          };

          const mediaReq = client.get(curUrl, { headers, timeout: 15000 }, (mediaRes) => {
            if ([301, 302, 303, 307, 308].includes(mediaRes.statusCode) && mediaRes.headers.location) {
              let loc = mediaRes.headers.location;
              if (loc.startsWith('/')) {
                loc = new URL(curUrl).origin + loc;
              }
              if (loc.includes('b-cdn.net') || loc.includes('.cdn.') || loc.includes('cdn')) {
                try {
                  cdnBase = new URL(loc).origin;
                } catch (e) {}
              }
              try { mediaRes.resume(); } catch (e) {}
              return fetchStep(loc, depth - 1).then(resolve).catch(reject);
            }

            if (mediaRes.statusCode >= 400) {
              return reject(new Error(`Erro upstream HLS (${mediaRes.statusCode})`));
            }

            let body = '';
            mediaRes.setEncoding('utf8');
            mediaRes.on('data', chunk => body += chunk);
            mediaRes.on('end', () => {
              if (!cdnBase) {
                try { cdnBase = new URL(curUrl).origin; } catch (e) {}
              }
              resolve({ cdnBase, body });
            });
          });

          mediaReq.on('error', reject);
          mediaReq.on('timeout', () => {
            mediaReq.destroy();
            reject(new Error('Timeout de leitura da playlist HLS'));
          });
        });
      };

      const { cdnBase: originCdn, body } = await fetchStep(targetUrl);

      // Reescreve caminhos de segmentos relativos para a CDN de borda com CORS
      const lines = body.split('\n');
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            return line;
          }
          if (trimmed.startsWith('/')) {
            return originCdn + trimmed;
          }
          return originCdn + '/' + trimmed;
        }
        return line;
      }).join('\n');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).send(rewritten);
    } catch (err) {
      console.warn('[StreamController] Falha no processamento inteligente HLS, redirecionando direto:', err.message);
      if (!res.headersSent) {
        return res.redirect(302, targetUrl);
      }
    }
  }

  async pipeStream(targetUrl, req, res) {
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

    const isLiveTs = targetUrl.includes('.ts') || targetUrl.includes('output=ts');
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB por bloco de streaming contínuo sem travamentos

    let clientRange = req.headers.range;
    let upstreamRange = null;

    if (!isLiveTs) {
      if (clientRange) {
        const match = clientRange.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : null;
          if (end !== null && (end - start + 1) <= CHUNK_SIZE) {
            upstreamRange = `bytes=${start}-${end}`;
          } else {
            upstreamRange = `bytes=${start}-${start + CHUNK_SIZE - 1}`;
          }
        } else {
          upstreamRange = clientRange;
        }
      } else {
        upstreamRange = `bytes=0-${CHUNK_SIZE - 1}`;
      }
    } else if (clientRange) {
      upstreamRange = clientRange;
    }

    const requestHeaders = {
      'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
      'Accept': '*/*'
    };
    if (upstreamRange) {
      requestHeaders['Range'] = upstreamRange;
    }

    try {
      const cached = redirectCache.get(targetUrl);
      let fetchUrl = (cached && cached.expiresAt > Date.now()) ? cached.url : targetUrl;

      let upstream = await fetch(fetchUrl, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: abortController.signal
      });

      // Se a URL de CDN em cache expirou ou retornou erro, refaz pela URL original
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
}

module.exports = new StreamController();
