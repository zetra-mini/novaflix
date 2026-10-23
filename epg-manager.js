const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'data');
const EPG_FILE = path.join(DATA_DIR, 'epg.xml');
const SERIES_FILE = process.env.VERCEL
  ? (fs.existsSync(path.join('/tmp', 'series_metadata.json')) ? path.join('/tmp', 'series_metadata.json') : path.join(__dirname, 'data', 'series_metadata.json'))
  : path.join(DATA_DIR, 'series_metadata.json');
const VOD_CACHE_FILE = path.join(DATA_DIR, 'vod_details_cache.json');

class EpgManager {
  constructor() {
    this.channelIcons = new Map(); // id/name -> icon url
    this.channelNames = new Map(); // id -> name
    this.programmesByChannel = new Map(); // channelId -> array of programmes
    this.seriesMetadata = new Map(); // seriesName -> { plot, cast, backdrop, cover, genre, ... }
    this.vodDetailsCache = new Map(); // vodId -> { plot, cast, duration, ... }
    this.isReady = false;
  }

  getProviderCredentials() {
    let rawUrl = '';
    try {
      const adminManager = require('./admin-manager');
      const conf = adminManager.getPlaylistConfig();
      rawUrl = conf.playlists?.live_list_url || conf.playlists?.primary || '';
    } catch (e) {}

    if (!rawUrl) {
      try {
        const pm = require('./playlist-manager');
        rawUrl = pm.playlistUrl || '';
      } catch (e) {}
    }

    if (!rawUrl) {
      rawUrl = 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=ts';
    }

    try {
      const parsed = new URL(rawUrl);
      const host = `${parsed.protocol}//${parsed.host}`;
      const username = parsed.searchParams.get('username') || 'Jm5Udq';
      const password = parsed.searchParams.get('password') || 'BQ5TxN';
      return { host, username, password };
    } catch (e) {
      return { host: 'http://cdn888.ovh', username: 'Jm5Udq', password: 'BQ5TxN' };
    }
  }

  get epgUrl() {
    if (process.env.EPG_URL) return process.env.EPG_URL;
    const creds = this.getProviderCredentials();
    return `${creds.host}/xmltv.php?username=${creds.username}&password=${creds.password}`;
  }

  async init() {
    this.loadSeriesMetadata();
    this.loadVodCache();

    try {
      // Se não existir ou tiver mais de 24 horas, baixa o EPG
      if (!fs.existsSync(EPG_FILE) || (Date.now() - fs.statSync(EPG_FILE).mtimeMs > 24 * 3600 * 1000)) {
        console.log('[EPG] Baixando guia de programação (EPG XMLTV)...');
        await this.downloadEPG();
      }

      if (fs.existsSync(EPG_FILE)) {
        console.log('[EPG] Indexando guia de programação e capas...');
        this.parseEPGFile();
      }
    } catch (err) {
      console.warn('[EPG] Aviso: Não foi possível carregar EPG remoto:', err.message);
    }

    if (this.seriesMetadata.size === 0) {
      this.syncSeriesMetadataRemote().catch(e => console.warn('[EPG] Aviso séries:', e.message));
    }
  }

  async updateIfExpired() {
    try {
      if (!fs.existsSync(EPG_FILE) || (Date.now() - fs.statSync(EPG_FILE).mtimeMs > 12 * 3600 * 1000)) {
        console.log('[EPG] Atualizando guia de programação em segundo plano...');
        await this.downloadEPG();
        this.parseEPGFile();
      }
    } catch (e) {
      console.warn('[EPG] Falha na auto-atualização do EPG:', e.message);
    }
  }

  downloadEPG() {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(EPG_FILE);
      const client = this.epgUrl.startsWith('https') ? https : http;

      const req = client.get(this.epgUrl, {
        headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Accept': '*/*' },
        timeout: 60000
      }, (res) => {
        if (res.statusCode !== 200) {
          fileStream.close();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          console.log('[EPG] Guia EPG baixado com sucesso!');
          resolve();
        });
      });

      req.on('error', err => {
        fileStream.close();
        reject(err);
      });
    });
  }

  parseEPGFile() {
    const start = Date.now();
    try {
      const xml = fs.readFileSync(EPG_FILE, 'utf8');

      // 1. Extração rápida de Canais e Capas / Ícones
      const chanRegex = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/gi;
      let chanMatch;
      while ((chanMatch = chanRegex.exec(xml)) !== null) {
        const id = chanMatch[1].trim().toLowerCase();
        const content = chanMatch[2];
        const nameMatch = content.match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
        const iconMatch = content.match(/<icon\s+src="([^"]+)"/i);
        const name = nameMatch ? nameMatch[1].trim() : '';
        const icon = iconMatch ? iconMatch[1].trim() : '';

        if (id && icon) this.channelIcons.set(id, icon);
        if (name && icon) {
          this.channelIcons.set(name.toLowerCase(), icon);
          // Variações sem tags de resolução como FHD, HD, 4K
          const cleanName = name.replace(/\s+(FHD|HD|SD|4K|\[H265\]|\[Alt\])/gi, '').trim().toLowerCase();
          this.channelIcons.set(cleanName, icon);
        }
        if (id && name) this.channelNames.set(id, name);
      }

      // 2. Extração de Programação Atual e Próximos Programas
      const progRegex = /<programme\s+start="([^"]+)"\s+stop="([^"]+)"\s+channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/gi;
      let progMatch;
      let progCount = 0;

      while ((progMatch = progRegex.exec(xml)) !== null) {
        const startStr = progMatch[1];
        const stopStr = progMatch[2];
        const channelId = progMatch[3].trim().toLowerCase();
        const inner = progMatch[4];

        const titleMatch = inner.match(/<title[^>]*>([^<]+)<\/title>/i);
        const descMatch = inner.match(/<desc[^>]*>([^<]+)<\/desc>/i);

        const title = titleMatch ? titleMatch[1].trim() : 'Programação Normal';
        const desc = descMatch ? descMatch[1].trim() : '';

        if (!this.programmesByChannel.has(channelId)) {
          this.programmesByChannel.set(channelId, []);
        }

        this.programmesByChannel.get(channelId).push({
          start: this.formatEpgTime(startStr),
          stop: this.formatEpgTime(stopStr),
          rawStart: startStr,
          rawStop: stopStr,
          title,
          desc
        });
        progCount++;
      }

      this.isReady = true;
      console.log(`[EPG] Pronto em ${Date.now() - start}ms! ${this.channelIcons.size} capas/canais indexados e ${progCount} programas disponíveis.`);
    } catch (e) {
      console.error('[EPG] Erro ao ler arquivo EPG:', e.message);
    }
  }

  formatEpgTime(dateStr) {
    // Ex: "20261016212700 -0300" -> "21:27"
    if (!dateStr || dateStr.length < 12) return '';
    const hours = dateStr.substr(8, 2);
    const minutes = dateStr.substr(10, 2);
    return `${hours}:${minutes}`;
  }

  getChannelIcon(tvgId, channelName) {
    if (tvgId && this.channelIcons.has(tvgId.toLowerCase())) {
      return this.channelIcons.get(tvgId.toLowerCase());
    }
    if (channelName) {
      const lower = channelName.toLowerCase();
      if (this.channelIcons.has(lower)) {
        return this.channelIcons.get(lower);
      }
      const clean = lower.replace(/\s+(fhd|hd|sd|4k|\[h265\]|\[alt\])/gi, '').trim();
      if (this.channelIcons.has(clean)) {
        return this.channelIcons.get(clean);
      }
    }
    return null;
  }

  getEPGForChannel(tvgId, channelName) {
    let channelKey = null;
    if (tvgId && this.programmesByChannel.has(tvgId.toLowerCase())) {
      channelKey = tvgId.toLowerCase();
    } else if (channelName) {
      const lower = channelName.toLowerCase();
      if (this.programmesByChannel.has(lower)) {
        channelKey = lower;
      } else {
        const clean = lower.replace(/\s+(fhd|hd|sd|4k|\[h265\]|\[alt\])/gi, '').trim();
        for (const k of this.programmesByChannel.keys()) {
          if (k.includes(clean) || clean.includes(k)) {
            channelKey = k;
            break;
          }
        }
      }
    }

    const icon = this.getChannelIcon(tvgId, channelName);
    const progs = channelKey ? (this.programmesByChannel.get(channelKey) || []) : [];

    const current = progs.length ? progs[0] : {
      title: 'Transmissão Ao Vivo',
      desc: 'Programação ao vivo transmitida em alta definição.',
      start: 'Ao Vivo',
      stop: ''
    };

    const next = progs.slice(1, 6);

    return {
      channel: channelName || tvgId,
      icon,
      current,
      next
    };
  }

  normalizeKey(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/['’`´"]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  loadSeriesMetadata() {
    try {
      if (fs.existsSync(SERIES_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
        this.seriesMetadata = new Map();
        for (const [k, v] of Object.entries(raw)) {
          this.seriesMetadata.set(k.toLowerCase().trim(), v);
          const norm = this.normalizeKey(k);
          if (norm && !this.seriesMetadata.has(norm)) {
            this.seriesMetadata.set(norm, v);
          }
        }
        console.log(`[EPG/Metadata] ${this.seriesMetadata.size} séries indexadas (com variantes normalizadas) com sinopses e capas oficiais.`);
      }
    } catch (e) {
      console.warn('[EPG/Metadata] Aviso ao carregar metadados de séries:', e.message);
    }
  }

  async syncSeriesMetadataRemote() {
    try {
      const creds = this.getProviderCredentials();
      const url = `${creds.host}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_series`;
      const list = await this.fetchJson(url);
      if (Array.isArray(list)) {
        const map = {};
        for (const s of list) {
          const key = (s.name || '').toLowerCase().trim();
          map[key] = {
            seriesId: s.series_id,
            name: s.name,
            cover: s.cover,
            plot: s.plot || '',
            cast: s.cast || '',
            director: s.director || '',
            genre: s.genre || '',
            releaseDate: s.releaseDate || '',
            rating: s.rating || '',
            backdrop: s.backdrop_path && s.backdrop_path[0] ? s.backdrop_path[0] : '',
            trailer: s.youtube_trailer || '',
            runTime: s.episode_run_time || ''
          };
        }
        fs.writeFileSync(SERIES_FILE, JSON.stringify(map));
        this.seriesMetadata = new Map();
        for (const [k, v] of Object.entries(map)) {
          this.seriesMetadata.set(k.toLowerCase().trim(), v);
          const norm = this.normalizeKey(k);
          if (norm && !this.seriesMetadata.has(norm)) {
            this.seriesMetadata.set(norm, v);
          }
        }
        console.log(`[EPG/Metadata] ${this.seriesMetadata.size} séries sincronizadas com sucesso do servidor!`);
      }
    } catch (err) {
      console.warn('[EPG/Metadata] Falha ao sincronizar séries remotas:', err.message);
    }
  }

  loadVodCache() {
    try {
      if (fs.existsSync(VOD_CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(VOD_CACHE_FILE, 'utf8'));
        this.vodDetailsCache = new Map(Object.entries(raw));
      }
    } catch (e) {
      this.vodDetailsCache = new Map();
    }
  }

  saveVodCacheDebounced() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const obj = Object.fromEntries(this.vodDetailsCache);
        fs.writeFileSync(VOD_CACHE_FILE, JSON.stringify(obj));
      } catch (e) {}
    }, 2000);
  }

  generateSmartSynopsis(name, meta = {}) {
    if (!name) return 'Produção disponível em alta definição com qualidade cinematográfica e áudio imersivo no catálogo NovaFlix.';
    const cleanName = name.replace(/\s*\(\d{4}\).*$/, '').trim();
    const yr = meta.releaseDate ? (meta.releaseDate.substr(0, 4) || meta.releaseDate) : (name.match(/\((\d{4})\)/)?.[1] || '');
    const yrText = yr ? ` (${yr})` : '';
    const dur = meta.duration ? ` com ${meta.duration.startsWith('0') ? meta.duration.substr(1) : meta.duration} de duração` : '';

    if (meta.type === 'series') {
      const dirText = meta.director ? ` sob direção de ${meta.director}` : '';
      const castList = meta.cast ? meta.cast.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3) : [];
      const castText = castList.length ? `, estrelando ${castList.join(', ')} e grande elenco` : '';
      const genreText = meta.genre ? ` de ${meta.genre.replace('/', 'e').toLowerCase()}` : '';
      const seasonsText = meta.totalSeasons ? ` com ${meta.totalSeasons} temporada${meta.totalSeasons > 1 ? 's' : ''} completas` : '';

      return `"${cleanName}"${yrText} é uma aclamada série${genreText}${dirText}${castText}${seasonsText}. Uma produção envolvente repleta de reviravoltas marcantes, dramas profundos e alta fidelidade de imagem disponível para maratonar na NovaFlix.`;
    }

    // Movie
    const dirText = meta.director ? `, sob a direção de ${meta.director},` : '';
    const castList = meta.cast ? meta.cast.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4) : [];
    const castText = castList.length ? ` estrelando ${castList.join(', ')} e grande elenco,` : '';
    const genreText = meta.genre ? ` de ${meta.genre.replace('/', 'e').toLowerCase()}` : ' cinematográfica';

    return `Em "${cleanName}"${yrText}${dirText} uma envolvente trama${genreText}${castText} mergulha o espectador em uma narrativa intensa repleta de suspense, emoção e momentos inesquecíveis${dur}. Disponível em qualidade cinematográfica 4K Ultra HD com som estéreo imersivo na NovaFlix.`;
  }

  generateFallbackDetails(name, movieItem = null) {
    const yr = name ? (name.match(/\((\d{4})\)/)?.[1] || '2025') : '2025';
    const cleanGenre = movieItem?.group ? movieItem.group.replace(/^(filmes\s*:\s*|filmes\s*\|\s*)/i, '').trim() : 'Cinema & Destaques';
    const fallbackMeta = {
      name: name || movieItem?.name || 'Filme',
      genre: cleanGenre,
      releaseDate: yr,
      duration: '01:50:00',
      rating: '8.8',
      type: 'movie'
    };

    return {
      name: name || movieItem?.name || 'Filme',
      plot: this.generateSmartSynopsis(name, fallbackMeta),
      cast: 'Elenco Oficial em Alta Definição',
      director: 'Produção Cinematográfica Oficial',
      genre: cleanGenre,
      releaseDate: yr,
      duration: '01:50:00',
      rating: '8.8',
      backdrop: movieItem?.backdrop || movieItem?.cover || movieItem?.logo || '',
      cover: movieItem?.cover || movieItem?.logo || '',
      trailer: ''
    };
  }

  getSeriesDetails(seriesName) {
    if (!seriesName) return null;
    let details = null;
    const clean = seriesName.toLowerCase().trim();
    if (this.seriesMetadata.has(clean)) {
      details = this.seriesMetadata.get(clean);
    }
    if (!details) {
      const norm = this.normalizeKey(seriesName);
      if (norm && this.seriesMetadata.has(norm)) {
        details = this.seriesMetadata.get(norm);
      }
    }

    // Tenta correspondência sem sufixos de temporada, áudio ou ano
    if (!details) {
      const stripped = clean.replace(/\s+(s\d+|t\d+|dub|leg|legendado|dublado|\d{4}).*$/i, '').trim();
      if (stripped && this.seriesMetadata.has(stripped)) {
        details = this.seriesMetadata.get(stripped);
      }
      if (!details) {
        const normStripped = this.normalizeKey(stripped);
        if (normStripped && this.seriesMetadata.has(normStripped)) {
          details = this.seriesMetadata.get(normStripped);
        }
      }
    }

    // Busca por inclusão parcial em strings normalizadas
    if (!details) {
      const normStripped = this.normalizeKey(clean.replace(/\s+(s\d+|t\d+|dub|leg|legendado|dublado|\d{4}).*$/i, '').trim());
      if (normStripped && normStripped.length >= 4) {
        for (const [k, v] of this.seriesMetadata.entries()) {
          if (k.includes(normStripped) || (normStripped.length > 5 && normStripped.includes(k))) {
            details = v;
            break;
          }
        }
      }
    }

    if (details) {
      // Se não tiver plot, enriquece dinamicamente
      if (!details.plot) {
        return {
          ...details,
          plot: this.generateSmartSynopsis(details.name || seriesName, { ...details, type: 'series' })
        };
      }
      return details;
    }

    // Se a série não estiver na lista prévia, gera metadados inteligentes padrão
    return {
      name: seriesName,
      plot: this.generateSmartSynopsis(seriesName, { type: 'series' }),
      cast: 'Elenco Original da Série',
      director: 'Direção Geral',
      genre: 'Série Dramática / Suspense',
      releaseDate: '2025',
      rating: '8.9',
      backdrop: '',
      cover: '',
      trailer: '',
      runTime: '45'
    };
  }

  async getVodDetails(vodId, movieName = '') {
    const vId = vodId ? String(vodId) : null;
    if (vId && this.vodDetailsCache.has(vId)) {
      const cached = this.vodDetailsCache.get(vId);
      if (!cached.plot) {
        cached.plot = this.generateSmartSynopsis(cached.name || movieName, cached);
      }
      return cached;
    }

    if (!vId) {
      return this.generateFallbackDetails(movieName);
    }

    try {
      const creds = this.getProviderCredentials();
      const url = `${creds.host}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_vod_info&vod_id=${vId}`;
      const data = await this.fetchJson(url);
      if (data && data.info) {
        const info = data.info;
        let plot = (info.plot || info.description || '').trim();

        // Se a sinopse original veio vazia do provedor, gera sinopse contextual inteligente com os dados reais
        if (!plot) {
          plot = this.generateSmartSynopsis(info.name || movieName, {
            genre: info.genre,
            director: info.director,
            cast: info.cast || info.actors,
            releaseDate: info.releasedate,
            duration: info.duration,
            type: 'movie'
          });
        }

        const backdropUrl = info.backdrop_path && info.backdrop_path[0] 
          ? info.backdrop_path[0] 
          : (info.backdrop || info.cover_big || info.movie_image || '');

        const details = {
          name: info.name || movieName,
          plot,
          cast: info.cast || info.actors || 'Elenco Principal',
          director: info.director || 'Direção Oficial',
          genre: info.genre || 'Filmes & Lançamentos',
          releaseDate: info.releasedate || (movieName.match(/\((\d{4})\)/)?.[1] || '2025'),
          duration: info.duration || '01:50:00',
          rating: info.rating_kinopoisk || info.rating || '8.7',
          backdrop: backdropUrl,
          cover: info.cover_big || info.movie_image || '',
          trailer: info.youtube_trailer || ''
        };

        this.vodDetailsCache.set(vId, details);
        this.saveVodCacheDebounced();
        return details;
      }
    } catch (e) {
      console.warn('[EPG] Erro ao buscar VOD details:', e.message);
    }

    return this.generateFallbackDetails(movieName);
  }

  fetchJson(targetUrl) {
    return new Promise((resolve) => {
      try {
        const parsed = new URL(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(targetUrl, {
          headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*' },
          timeout: 10000
        }, res => {
          if (res.statusCode !== 200) {
            return resolve(null);
          }
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try {
              resolve(JSON.parse(d));
            } catch (e) {
              resolve(null);
            }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      } catch (err) {
        resolve(null);
      }
    });
  }
}

module.exports = new EpgManager();
