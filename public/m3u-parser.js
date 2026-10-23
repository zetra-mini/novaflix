/**
 * M3U Parser de alta performance para Web
 * Processa listas M3U/M3U8 com metadados (tvg-logo, tvg-name, group-title, etc.)
 */
class M3UParser {
  /**
   * Analisa o texto bruto de uma lista M3U
   * @param {string} content Conteúdo do arquivo M3U
   * @param {function} onProgress Callback de progresso opcional
   * @returns {Promise<{channels: Array, movies: Array, series: Array, categories: Object}>}
   */
  static async parse(content, onProgress = null) {
    return new Promise((resolve) => {
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      const channels = [];
      const movies = [];
      const series = [];

      const categories = {
        live: new Set(),
        movies: new Set(),
        series: new Set()
      };

      let currentItem = null;
      let idCounter = 1;

      // Regex para capturar atributos no EXTINF
      const extinfRegex = /^#EXTINF:(-?\d+)?\s*(.*?),(.*)$/i;
      const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

      for (let i = 0; i < totalLines; i++) {
        const line = lines[i].trim();

        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
          const match = line.match(extinfRegex);
          if (match) {
            const rawAttrs = match[2] || '';
            const rawName = (match[3] || 'Canal sem nome').trim();

            const attrs = {};
            let attrMatch;
            while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
              attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
            }

            // Atributos comuns
            const name = attrs['tvg-name'] || rawName;
            const logo = attrs['tvg-logo'] || '';
            const group = attrs['group-title'] || 'Outros';
            const tvgId = attrs['tvg-id'] || '';

            currentItem = {
              id: idCounter++,
              name: name,
              rawName: rawName,
              logo: logo,
              group: group,
              tvgId: tvgId,
              url: ''
            };
          }
        } else if (line.startsWith('#')) {
          // Outras diretivas (#EXTGRP, etc.)
          if (currentItem && line.startsWith('#EXTGRP:')) {
            currentItem.group = line.replace('#EXTGRP:', '').trim() || currentItem.group;
          }
        } else if (currentItem) {
          // É a linha da URL
          currentItem.url = line;

          // Categorização inteligente (Live TV vs Filmes vs Séries)
          const lowerGroup = (currentItem.group || '').toLowerCase();
          const lowerUrl = currentItem.url.toLowerCase();
          const lowerName = currentItem.name.toLowerCase();

          const isMovie = 
            lowerGroup.includes('filme') || 
            lowerGroup.includes('movie') || 
            lowerGroup.includes('vod') || 
            lowerGroup.includes('cinema') ||
            lowerUrl.endsWith('.mp4') || 
            lowerUrl.endsWith('.mkv') ||
            lowerUrl.includes('/movie/');

          const isSeries = 
            lowerGroup.includes('série') || 
            lowerGroup.includes('serie') || 
            lowerGroup.includes('season') || 
            lowerGroup.includes('temporada') ||
            lowerUrl.includes('/series/') ||
            /s\d{2}e\d{2}/i.test(lowerName) ||
            /t\d{1,2}\s*ep?\s*\d{1,2}/i.test(lowerName);

          if (isSeries) {
            series.push(currentItem);
            categories.series.add(currentItem.group);
          } else if (isMovie) {
            movies.push(currentItem);
            categories.movies.add(currentItem.group);
          } else {
            channels.push(currentItem);
            categories.live.add(currentItem.group);
          }

          currentItem = null;
        }

        // Relatório de progresso para listas gigantes a cada 5000 linhas
        if (onProgress && i % 5000 === 0) {
          onProgress(Math.round((i / totalLines) * 100));
        }
      }

      if (onProgress) onProgress(100);

      resolve({
        channels,
        movies,
        series,
        categories: {
          live: Array.from(categories.live).sort(),
          movies: Array.from(categories.movies).sort(),
          series: Array.from(categories.series).sort()
        },
        totalCount: channels.length + movies.length + series.length
      });
    });
  }
}

/**
 * Gerenciador de Armazenamento IndexedDB para suportar listas gigantes sem travar a memória
 */
class PlaylistStorage {
  static DB_NAME = 'NovaFlixDB';
  static DB_VERSION = 1;
  static STORE_NAME = 'playlists';

  static async getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async savePlaylist(id, name, data, sourceInfo = {}) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const record = {
        id,
        name,
        data,
        sourceInfo,
        updatedAt: new Date().toISOString()
      };
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  static async getPlaylist(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  static async getAllPlaylistsMeta() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.openCursor();
      const list = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          list.push({
            id: val.id,
            name: val.name,
            updatedAt: val.updatedAt,
            channelsCount: val.data?.channels?.length || 0,
            moviesCount: val.data?.movies?.length || 0,
            seriesCount: val.data?.series?.length || 0
          });
          cursor.continue();
        } else {
          resolve(list);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  static async deletePlaylist(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }
}

window.M3UParser = M3UParser;
window.PlaylistStorage = PlaylistStorage;
