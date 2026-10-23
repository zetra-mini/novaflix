let sqlite3 = null;
try {
  sqlite3 = require('sqlite3').verbose();
} catch (e) {
  // Graceful fallback se sqlite3 não estiver instalado ou falhar compilação
}
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'novaflix.db');

class DatabaseService {
  constructor() {
    this.db = null;
    this.isReady = false;
    this.settingsCache = {};
  }

  async init() {
    if (this.isReady) return this;

    if (!sqlite3) {
      console.warn('[SQLite] Driver nativo sqlite3 indisponível. Ativando engine JSON/Memory de alta disponibilidade.');
      this.isReady = true;
      this._loadJsonSettingsFallback();
      return this;
    }

    return new Promise((resolve) => {
      try {
        this.db = new sqlite3.Database(DB_PATH, (err) => {
          if (err) {
            console.warn('[SQLite] Erro ao abrir arquivo SQLite (' + err.message + '). Ativando engine JSON/Memory.');
            this.db = null;
            this.isReady = true;
            this._loadJsonSettingsFallback();
            return resolve(this);
          }
          console.log('[SQLite] Conectado ao banco de dados:', DB_PATH);
          this._createTables()
            .then(() => {
              this.isReady = true;
              this._migrateInitialSettings();
              resolve(this);
            })
            .catch((err) => {
              console.warn('[SQLite] Erro ao criar tabelas (' + err.message + '). Ativando engine JSON/Memory.');
              this.db = null;
              this.isReady = true;
              this._loadJsonSettingsFallback();
              resolve(this);
            });
        });
      } catch (err) {
        console.warn('[SQLite] Exceção ao instanciar SQLite:', err.message);
        this.db = null;
        this.isReady = true;
        this._loadJsonSettingsFallback();
        resolve(this);
      }
    });
  }

  _loadJsonSettingsFallback() {
    try {
      const adminStorePath = path.join(DATA_DIR, 'admin_store.json');
      if (fs.existsSync(adminStorePath)) {
        const raw = JSON.parse(fs.readFileSync(adminStorePath, 'utf-8'));
        if (raw.playlists) {
          this.settingsCache['live_list_url'] = raw.playlists.live_list_url || raw.playlists.primary || '';
          this.settingsCache['vod_list_url'] = raw.playlists.vod_list_url || raw.playlists.backup1 || '';
          this.settingsCache['active_playlist'] = raw.playlists.activePlaylist || 'primary';
        }
        if (raw.technical) {
          this.settingsCache['stream_mode'] = raw.technical.streamMode || 'direct';
          this.settingsCache['sync_interval'] = raw.technical.syncInterval || '12h';
        }
        if (raw.mainDomain) {
          this.settingsCache['main_domain'] = raw.mainDomain;
        }
      }
    } catch (e) {}
  }

  runAsync(sql, params = []) {
    if (!this.db) {
      return Promise.resolve({ lastID: 0, changes: 0 });
    }
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  getAsync(sql, params = []) {
    if (!this.db) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  allAsync(sql, params = []) {
    if (!this.db) {
      return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  execAsync(sql) {
    if (!this.db) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async _createTables() {
    // Modo WAL para performance máxima e concorrência sem travas
    await this.execAsync('PRAGMA journal_mode = WAL;');
    await this.execAsync('PRAGMA synchronous = NORMAL;');

    const schema = `
      -- 1. Tabela de Configurações do Sistema
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. Canais Ao Vivo (MPEG-TS)
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        tvg_id TEXT,
        name TEXT NOT NULL,
        logo TEXT,
        group_title TEXT,
        stream_url TEXT,
        is_live INTEGER DEFAULT 1,
        is_adult INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 3. Filmes (HLS / M3U8)
      CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        logo TEXT,
        cover TEXT,
        backdrop TEXT,
        group_title TEXT,
        stream_url TEXT,
        is_vod INTEGER DEFAULT 1,
        is_adult INTEGER DEFAULT 0,
        overview TEXT,
        year TEXT,
        rating TEXT,
        match_pct INTEGER DEFAULT 95,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 4. Séries Únicas (Shows com Episódios)
      CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        logo TEXT,
        cover TEXT,
        backdrop TEXT,
        group_title TEXT,
        total_seasons INTEGER DEFAULT 1,
        total_episodes INTEGER DEFAULT 1,
        first_episode_stream TEXT,
        is_vod INTEGER DEFAULT 1,
        is_adult INTEGER DEFAULT 0,
        overview TEXT,
        year TEXT,
        rating TEXT,
        seasons_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 5. Controle de Sessões Simultâneas & Heartbeat de Usuários
      CREATE TABLE IF NOT EXISTS user_sessions (
        uuid TEXT PRIMARY KEY,
        ip TEXT,
        device TEXT,
        user_name TEXT,
        is_active INTEGER DEFAULT 1,
        current_stream_id TEXT,
        last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 6. Telemetria QoE & Analytics de Consumo
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT,
        item_id TEXT,
        item_name TEXT,
        item_type TEXT,
        duration_watched INTEGER DEFAULT 0,
        drop_off_minute REAL DEFAULT 0,
        buffer_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 7. Terminal de Logs do Sistema
      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        level TEXT DEFAULT 'INFO',
        category TEXT DEFAULT 'SYSTEM',
        message TEXT
      );

      -- Índices de Alta Velocidade para Pesquisa e Filtros Instantâneos
      CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
      CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_title);
      CREATE INDEX IF NOT EXISTS idx_channels_adult ON channels(is_adult);

      CREATE INDEX IF NOT EXISTS idx_movies_name ON movies(name);
      CREATE INDEX IF NOT EXISTS idx_movies_group ON movies(group_title);
      CREATE INDEX IF NOT EXISTS idx_movies_adult ON movies(is_adult);

      CREATE INDEX IF NOT EXISTS idx_series_name ON series(name);
      CREATE INDEX IF NOT EXISTS idx_series_group ON series(group_title);
      CREATE INDEX IF NOT EXISTS idx_series_adult ON series(is_adult);

      CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON user_sessions(uuid);
      CREATE INDEX IF NOT EXISTS idx_telemetry_uuid ON telemetry(uuid);
    `;

    await this.execAsync(schema);
    console.log('[SQLite] Tabelas e índices verificados com sucesso.');
  }

  async _migrateInitialSettings() {
    try {
      const adminStorePath = path.join(DATA_DIR, 'admin_store.json');
      if (fs.existsSync(adminStorePath)) {
        const raw = JSON.parse(fs.readFileSync(adminStorePath, 'utf-8'));
        if (raw.playlists) {
          const liveUrl = raw.playlists.live_list_url || raw.playlists.primary || '';
          const vodUrl = raw.playlists.vod_list_url || raw.playlists.backup1 || '';
          await this.setSetting('live_list_url', liveUrl);
          await this.setSetting('vod_list_url', vodUrl);
          await this.setSetting('active_playlist', raw.playlists.activePlaylist || 'primary');
        }
        if (raw.technical) {
          await this.setSetting('stream_mode', raw.technical.streamMode || 'direct');
          await this.setSetting('sync_interval', raw.technical.syncInterval || '12h');
        }
        if (raw.mainDomain) {
          await this.setSetting('main_domain', raw.mainDomain);
        }
      }
    } catch (e) {
      console.warn('[SQLite] Aviso na migração inicial de settings:', e.message);
    }
  }

  async getSetting(key, defaultValue = null) {
    if (!this.db) {
      return this.settingsCache[key] !== undefined ? this.settingsCache[key] : defaultValue;
    }
    try {
      const row = await this.getAsync('SELECT value FROM settings WHERE key = ?', [key]);
      return row ? row.value : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  async setSetting(key, value) {
    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    this.settingsCache[key] = value;

    // Resiliência: sincroniza sempre com admin_store.json para tolerância a falhas
    try {
      const adminStorePath = path.join(DATA_DIR, 'admin_store.json');
      if (fs.existsSync(adminStorePath)) {
        const raw = JSON.parse(fs.readFileSync(adminStorePath, 'utf-8'));
        if (!raw.playlists) raw.playlists = {};
        if (key === 'live_list_url') raw.playlists.live_list_url = value;
        if (key === 'vod_list_url') raw.playlists.vod_list_url = value;
        if (key === 'active_playlist') raw.playlists.activePlaylist = value;
        fs.writeFileSync(adminStorePath, JSON.stringify(raw, null, 2));
      }
    } catch (e) {}

    if (!this.db) {
      return;
    }

    try {
      await this.runAsync(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [key, valStr]
      );
    } catch (dbErr) {
      console.warn(`[SQLite] Aviso ao gravar configuração "${key}" no banco:`, dbErr.message);
    }
  }

  async getAllSettings() {
    if (!this.db) {
      return { ...this.settingsCache };
    }
    const rows = await this.allAsync('SELECT key, value FROM settings');
    const result = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value);
      } catch (e) {
        result[r.key] = r.value;
      }
    }
    return result;
  }
}

module.exports = new DatabaseService();
