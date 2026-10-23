let jwt = null;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  // Graceful fallback para crypto nativo do Node.js
}
const crypto = require('crypto');

// Chave secreta de alta entropia para assinatura dos tokens
const JWT_SECRET = process.env.STREAM_JWT_SECRET || 'novaflix_super_secure_jwt_token_secret_enterprise_2026';
const TOKEN_EXPIRY_SECONDS = 4 * 60 * 60; // 4 horas

class StreamTokenService {
  /**
   * Codifica payload com HMAC-SHA256 (Padrão JWT sem dependências externas)
   */
  _signNativeHmac(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  /**
   * Verifica assinatura HMAC-SHA256 nativa
   */
  _verifyNativeHmac(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Expirado
    }
    return payload;
  }

  /**
   * Gera um token assinado para o stream
   * @param {Object} payload { streamUrl, uuid, itemType, itemId }
   */
  generateStreamToken(payload) {
    const now = Math.floor(Date.now() / 1000);
    const data = {
      u: payload.streamUrl,
      uid: payload.uuid || 'anonymous',
      t: payload.itemType || 'vod',
      id: payload.itemId || null,
      iat: now,
      exp: now + TOKEN_EXPIRY_SECONDS
    };

    if (jwt) {
      try {
        return jwt.sign(data, JWT_SECRET, { expiresIn: '4h' });
      } catch (err) {}
    }
    return this._signNativeHmac(data);
  }

  /**
   * Verifica e decodifica o token
   * @param {string} token
   * @returns {Object|null}
   */
  verifyStreamToken(token) {
    if (!token) return null;
    try {
      let raw = String(token);
      try { raw = decodeURIComponent(raw); } catch(e) {}
      // Remove extensões se houver (ex: .mp4, .ts, .m3u8)
      const cleanToken = raw.replace(/\.(mp4|ts|m3u8|mkv)$/i, '');

      let decoded = null;
      if (jwt) {
        try {
          decoded = jwt.verify(cleanToken, JWT_SECRET);
        } catch (e) {}
      }

      if (!decoded) {
        decoded = this._verifyNativeHmac(cleanToken);
      }

      if (decoded && decoded.u) {
        return {
          streamUrl: decoded.u,
          uuid: decoded.uid,
          itemType: decoded.t,
          itemId: decoded.id
        };
      }
    } catch (err) {}

    // Fallback 1: Descriptografia AES-256 legada do playlistManager
    try {
      const playlistManager = require('../playlist-manager');
      const cleanToken = token.replace(/\.(mp4|ts|m3u8|mkv)$/i, '');
      const decrypted = playlistManager.decryptUrl(cleanToken) || playlistManager.decryptUrl(decodeURIComponent(cleanToken));
      if (decrypted && decrypted.startsWith('http')) {
        return { streamUrl: decrypted, uuid: 'legacy', itemType: 'vod' };
      }
    } catch (e) {}

    // Fallback 2: Base64 legado
    try {
      const cleanToken = token.replace(/\.(mp4|ts|m3u8|mkv)$/i, '');
      const decodedLegacy = Buffer.from(cleanToken, 'base64').toString('utf-8');
      if (decodedLegacy.startsWith('http')) {
        return { streamUrl: decodedLegacy, uuid: 'legacy', itemType: 'vod' };
      }
    } catch (e) {}

    return null;
  }

  /**
   * Converte uma URL de stream direta em uma rota protegida por token
   * @param {string} rawUrl
   * @param {string} itemType 'live' | 'vod' | 'movie' | 'series'
   * @param {string} uuid
   */
  tokenizeUrl(rawUrl, itemType = 'vod', uuid = 'app') {
    if (!rawUrl) return '';
    const token = this.generateStreamToken({ streamUrl: rawUrl, itemType, uuid });
    const ext = rawUrl.includes('.mp4') ? '.mp4' : (rawUrl.includes('.ts') ? '.ts' : '.m3u8');
    return `/api/stream/${encodeURIComponent(token)}${ext}`;
  }
}

module.exports = new StreamTokenService();
