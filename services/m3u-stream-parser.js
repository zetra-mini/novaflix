const fs = require('fs');
const readline = require('readline');
const http = require('http');
const https = require('https');
const path = require('path');
const db = require('./db');
const epgManager = require('../epg-manager');

class M3UStreamParser {
  constructor() {
    this.isParsing = false;
  }

  /**
   * Extração segura de atributos e título de linha #EXTINF
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

  isAdult(name, group) {
    const g = String(group || '').toLowerCase();
    const n = String(name || '').toLowerCase();
    if (/xxx\s*[:\-]\s*(reativado|state of the union|triplo x)/i.test(n)) return false;
    const regex = /\b(adult|adulto|adultos|porn|porno|pornô|erotic|erótica|erótico|sensual|sexy|playboy|venus|for man|penthouse|hustler|redlight|brazzers|privé|prive)\b/i;
    return regex.test(g) || regex.test(n) || /\bxxx\b/i.test(g) || /\bxxx\b/i.test(n) ||
           g.includes('+18') || g.includes('18+') || g.includes('🔞') ||
           n.includes('+18') || n.includes('18+') || n.includes('🔞');
  }

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
      seriesName = sMatch ? sMatch[1].trim() : beforeSE.replace(/[\-_]+$/, '').trim();
    } else {
      const altMatch = rawTitle.match(/^(.*?)(?:[\s\-_]+[SsTt](\d{1,3}))[\s\-_]+(?:E|EP|Episódio|Capítulo)[\s\-_]*(\d+)(?:[\s\-_]+(.*))?$/i);
      if (altMatch) {
        seriesName = altMatch[1].trim();
        season = parseInt(altMatch[2], 10);
        episode = parseInt(altMatch[3], 10);
        episodeTitle = (altMatch[4] || '').trim();
      }
    }

    seriesName = seriesName
      .replace(/\s+-\s+$/, '')
      .replace(/\s+\[L\]$/, '')
      .replace(/\s+\[D\]$/, '')
      .replace(/\s+LEG$/, '')
      .replace(/\s+DUB$/, '')
      .trim();

    return { seriesName, season, episode, episodeTitle: episodeTitle || `Episódio ${episode}` };
  }

  /**
   * Baixa URL remota para arquivo local via Streams com suporte a redirecionamentos
   */
  fetchUrlToFile(targetUrl, destinationPath, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(destinationPath);
      const isHttps = targetUrl.startsWith('https');
      const client = isHttps ? https : http;

      const req = client.get(targetUrl, {
        headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*' },
        timeout: timeoutMs
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          fileStream.close();
          try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
          return this.fetchUrlToFile(res.headers.location, destinationPath, timeoutMs).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          fileStream.close();
          try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch (e) {}
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destinationPath));
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
        reject(new Error(`Timeout (${timeoutMs / 1000}s)`));
      });
    });
  }

  /**
   * Processa via Stream a Lista Ao Vivo (TS)
   * Extrai exclusivamente canais ao vivo
   */
  async parseLiveListStream(filePath) {
    const channels = [];
    let currentItem = null;
    let idCounter = 1;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        const parsed = this.parseExtinf(line);
        if (parsed) {
          currentItem = {
            id: idCounter++,
            tvgId: parsed.attrs['tvg-id'] || '',
            tvgType: parsed.attrs['tvg-type'] || '',
            name: parsed.title,
            logo: parsed.attrs['tvg-logo'] || '',
            group: parsed.attrs['group-title'] || 'Canais Ao Vivo'
          };
        }
      } else if (currentItem && !line.startsWith('#')) {
        const rawUrl = line;
        const grp = currentItem.group.toUpperCase();
        const tvgType = (currentItem.tvgType || '').toUpperCase();

        // Extrai EXCLUSIVAMENTE canais ao vivo (rejeita filmes e séries da lista ao vivo)
        const isMovieOrSeries = grp.includes('FILME') || grp.includes('MOVIE') || grp.includes('SÉRIE') || grp.includes('SERIE') || rawUrl.includes('/movie/') || rawUrl.includes('/series/');
        const isExplicitLive = tvgType === 'LIVE' || grp.includes('CANAL') || grp.includes('CANAIS') || grp.includes('24 HORAS') || grp.includes('AO VIVO') || rawUrl.includes('/live/') || rawUrl.endsWith('.ts');

        if (!isMovieOrSeries && (isExplicitLive || !rawUrl.includes('/series/'))) {
          // Garante que o stream Ao Vivo esteja em MPEG-TS
          let tsStreamUrl = rawUrl;
          if (tsStreamUrl.includes('output=m3u8')) {
            tsStreamUrl = tsStreamUrl.replace('output=m3u8', 'output=ts');
          }

          const isAdult = this.isAdult(currentItem.name, currentItem.group);

          channels.push({
            id: currentItem.id,
            tvgId: currentItem.tvgId,
            name: currentItem.name,
            logo: currentItem.logo,
            groupTitle: currentItem.group,
            streamUrl: tsStreamUrl,
            isLive: 1,
            isAdult: isAdult ? 1 : 0
          });
        }
        currentItem = null;
      }
    }

    return channels;
  }

  /**
   * Processa via Stream a Lista VOD (M3U8)
   * Extrai exclusivamente Filmes e Séries
   */
  async parseVodListStream(filePath) {
    const movies = [];
    const seriesByGroupMap = new Map();
    let currentItem = null;
    let idCounter = 1;
    let seriesCounter = 1;

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        const parsed = this.parseExtinf(line);
        if (parsed) {
          currentItem = {
            id: idCounter++,
            name: parsed.title,
            logo: parsed.attrs['tvg-logo'] || '',
            group: parsed.attrs['group-title'] || 'Filmes'
          };
        }
      } else if (currentItem && !line.startsWith('#')) {
        const rawUrl = line;
        const grp = currentItem.group.toUpperCase();

        // Descarta canais da lista VOD
        const isLiveChannel = (grp.includes('CANAL') || grp.includes('CANAIS') || grp.includes('24 HORAS')) && !grp.includes('FILMES E SÉRIES');

        if (!isLiveChannel) {
          const isAdultItem = this.isAdult(currentItem.name, currentItem.group);
          const isSeries = grp.includes('SÉRIE') || grp.includes('SERIE') || grp.includes('NOVELA') || grp.includes('ANIME') || grp.includes('DORAMA') || rawUrl.includes('/series/');

          // Garante que o stream VOD esteja em HLS/M3U8 ou MP4
          let vodStreamUrl = rawUrl;
          if (vodStreamUrl.includes('output=ts')) {
            vodStreamUrl = vodStreamUrl.replace('output=ts', 'output=m3u8');
          }

          if (isSeries) {
            // Agrupamento de Episódios em Série Única
            const { seriesName, season, episode, episodeTitle } = this.parseSeriesTitle(currentItem.name);
            const seriesKey = `${currentItem.group}:::${seriesName}`.toLowerCase();

            if (!seriesByGroupMap.has(seriesKey)) {
              seriesByGroupMap.set(seriesKey, {
                id: seriesCounter++,
                name: seriesName,
                logo: currentItem.logo,
                cover: currentItem.logo,
                backdrop: currentItem.logo,
                group: currentItem.group,
                isAdult: isAdultItem ? 1 : 0,
                isVod: 1,
                totalSeasons: 1,
                totalEpisodes: 0,
                firstEpisodeStream: vodStreamUrl,
                seasons: {}
              });
            }

            const seriesObj = seriesByGroupMap.get(seriesKey);
            if (!seriesObj.seasons[season]) {
              seriesObj.seasons[season] = [];
            }

            seriesObj.seasons[season].push({
              id: currentItem.id,
              season,
              episode,
              name: episodeTitle,
              logo: currentItem.logo,
              streamUrl: vodStreamUrl
            });
            seriesObj.totalEpisodes++;
            seriesObj.totalSeasons = Object.keys(seriesObj.seasons).length;
          } else {
            // Filme Individual
            movies.push({
              id: currentItem.id,
              name: currentItem.name,
              logo: currentItem.logo,
              cover: currentItem.logo,
              backdrop: currentItem.logo,
              groupTitle: currentItem.group,
              streamUrl: vodStreamUrl,
              isVod: 1,
              isAdult: isAdultItem ? 1 : 0,
              overview: '',
              year: '2026',
              rating: '8.8',
              matchPct: 94 + (currentItem.id % 6)
            });
          }
        }
        currentItem = null;
      }
    }

    // Enriquece séries com metadados do EPG
    const seriesList = [];
    for (const s of seriesByGroupMap.values()) {
      const meta = epgManager.getSeriesDetails(s.name);
      if (meta) {
        if (meta.cover && meta.cover.startsWith('http')) s.cover = meta.cover;
        if (meta.backdrop && meta.backdrop.startsWith('http')) s.backdrop = meta.backdrop;
        if (meta.plot) s.overview = meta.plot;
        if (meta.rating) s.rating = meta.rating;
        if (meta.year) s.year = meta.year;
      }
      seriesList.push(s);
    }

    return { movies, series: seriesList };
  }

  /**
   * Executa o Merge Híbrido Seguro dentro de uma transação atômica no SQLite
   */
  async mergeIntoDatabase({ channels, movies, series }) {
    await db.init();
    console.log(`[Parser Híbrido] Salvando no SQLite: ${channels.length} canais, ${movies.length} filmes, ${series.length} séries...`);

    // Inicia transação atômica
    await db.execAsync('BEGIN TRANSACTION;');

    try {
      // 1. Atualiza Canais
      if (channels && channels.length > 0) {
        await db.execAsync('DELETE FROM channels;');
        const stmtChannel = 'INSERT OR REPLACE INTO channels (id, tvg_id, name, logo, group_title, stream_url, is_live, is_adult) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
        for (const c of channels) {
          await db.runAsync(stmtChannel, [c.id, c.tvgId, c.name, c.logo, c.groupTitle, c.streamUrl, c.isLive, c.isAdult]);
        }
      }

      // 2. Atualiza Filmes
      if (movies && movies.length > 0) {
        await db.execAsync('DELETE FROM movies;');
        const stmtMovie = 'INSERT OR REPLACE INTO movies (id, name, logo, cover, backdrop, group_title, stream_url, is_vod, is_adult, overview, year, rating, match_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        for (const m of movies) {
          await db.runAsync(stmtMovie, [m.id, m.name, m.logo, m.cover, m.backdrop, m.groupTitle, m.streamUrl, m.isVod, m.isAdult, m.overview || '', m.year || '2026', m.rating || '8.8', m.matchPct || 95]);
        }
      }

      // 3. Atualiza Séries
      if (series && series.length > 0) {
        await db.execAsync('DELETE FROM series;');
        const stmtSeries = 'INSERT OR REPLACE INTO series (id, name, logo, cover, backdrop, group_title, total_seasons, total_episodes, first_episode_stream, is_vod, is_adult, overview, year, rating, seasons_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        for (const s of series) {
          await db.runAsync(stmtSeries, [s.id, s.name, s.logo, s.cover, s.backdrop, s.group, s.totalSeasons, s.totalEpisodes, s.firstEpisodeStream, s.isVod, s.isAdult, s.overview || '', s.year || '2026', s.rating || '8.8', JSON.stringify(s.seasons || {})]);
        }
      }

      await db.setSetting('catalog_last_updated', new Date().toISOString());
      await db.setSetting('catalog_version', Date.now());

      await db.execAsync('COMMIT;');
      console.log('[Parser Híbrido] Merge no SQLite concluído com sucesso total!');

      // Sincroniza em tempo real com a memória do PlaylistManager para refletir imediatamente no Web Player
      try {
        const playlistManager = require('../playlist-manager');
        if (channels && channels.length > 0) playlistManager.channels = channels;
        if (movies && movies.length > 0) playlistManager.movies = movies;
        if (series && series.length > 0) {
          playlistManager.series = series;
          series.forEach(s => {
            if (s.id) playlistManager.seriesById.set(s.id, s);
          });
        }
        playlistManager.catalogVersion = Date.now();
        playlistManager.lastUpdated = new Date().toISOString();
        playlistManager.prebuilt = null; // Invalida cache estático para regeneração instantânea
        playlistManager.isReady = true;
        console.log('[Parser Híbrido] Memória do PlaylistManager atualizada em tempo real com o novo catálogo!');
      } catch (pmSyncErr) {
        console.warn('[Parser Híbrido] Aviso ao atualizar PlaylistManager em memória:', pmSyncErr.message);
      }

      return { success: true, totalChannels: channels.length, totalMovies: movies.length, totalSeries: series.length };
    } catch (err) {
      await db.execAsync('ROLLBACK;');
      console.error('[Parser Híbrido] Falha no merge, transação revertida (ROLLBACK):', err.message);
      throw err;
    }
  }

  /**
   * Sincronização Híbrida Completa:
   * Baixa e processa a lista Ao Vivo (TS) e a lista VOD (M3U8)
   */
  async syncHybridLists(liveUrl, vodUrl) {
    if (this.isParsing) {
      return { success: false, reason: 'already_syncing' };
    }

    this.isParsing = true;
    const tempDir = path.join(__dirname, '..', 'data', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const liveTemp = path.join(tempDir, 'live_list.m3u');
    const vodTemp = path.join(tempDir, 'vod_list.m3u');

    try {
      let channels = [];
      let movies = [];
      let series = [];

      // 1. Processa Lista Ao Vivo se configurada
      if (liveUrl && liveUrl.trim().startsWith('http')) {
        console.log(`[Parser Híbrido] Baixando Lista Ao Vivo (TS)...`);
        await this.fetchUrlToFile(liveUrl.trim(), liveTemp);
        channels = await this.parseLiveListStream(liveTemp);
        console.log(`[Parser Híbrido] ${channels.length} canais ao vivo extraídos.`);
      }

      // 2. Processa Lista VOD se configurada
      if (vodUrl && vodUrl.trim().startsWith('http')) {
        console.log(`[Parser Híbrido] Baixando Lista VOD (M3U8)...`);
        await this.fetchUrlToFile(vodUrl.trim(), vodTemp);
        const vodData = await this.parseVodListStream(vodTemp);
        movies = vodData.movies;
        series = vodData.series;
        console.log(`[Parser Híbrido] ${movies.length} filmes e ${series.length} séries VOD extraídos.`);
      }

      const result = await this.mergeIntoDatabase({ channels, movies, series });

      // Limpa arquivos temporários
      try { if (fs.existsSync(liveTemp)) fs.unlinkSync(liveTemp); } catch (e) {}
      try { if (fs.existsSync(vodTemp)) fs.unlinkSync(vodTemp); } catch (e) {}

      this.isParsing = false;
      return result;
    } catch (err) {
      this.isParsing = false;
      try { if (fs.existsSync(liveTemp)) fs.unlinkSync(liveTemp); } catch (e) {}
      try { if (fs.existsSync(vodTemp)) fs.unlinkSync(vodTemp); } catch (e) {}
      throw err;
    }
  }
}

module.exports = new M3UStreamParser();
