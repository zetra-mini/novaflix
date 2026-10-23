const { exec } = require('child_process');
const path = require('path');
const db = require('../services/db');
const adminManager = require('../admin-manager');
const m3uStreamParser = require('../services/m3u-stream-parser');
const telemetryService = require('../services/telemetry-service');

class AdminController {
  /**
   * 1-Click Infra Setup: Executa o script bash scripts/setup-infra.sh
   */
  async setupDomain(req, res) {
    const { domain, port = 3000 } = req.body;

    if (!domain || !domain.trim()) {
      return res.status(400).json({ success: false, error: 'O domínio é obrigatório.' });
    }

    const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const cleanPort = parseInt(port, 10) || 3000;

    console.log(`[Admin] Iniciando automação 1-Click Infra para domínio: ${cleanDomain} (Porta: ${cleanPort})...`);
    adminManager.logEvent('INFO', 'INFRA', `Iniciando automação Nginx + SSL para ${cleanDomain} (Porta ${cleanPort})`);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'setup-infra.sh');
    const command = `sudo bash "${scriptPath}" "${cleanDomain}" "${cleanPort}"`;

    exec(command, { timeout: 180000 }, async (error, stdout, stderr) => {
      if (error) {
        console.error('[Admin] Erro na execução do setup-infra:', error.message);
        adminManager.logEvent('ERROR', 'INFRA', `Falha ao configurar ${cleanDomain}: ${error.message}`);
        return res.json({
          success: false,
          error: error.message,
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }

      await db.setSetting('main_domain', `https://${cleanDomain}`);
      if (typeof adminManager.updateDomainConfig === 'function') {
        adminManager.updateDomainConfig({ mainDomain: `https://${cleanDomain}` });
      }
      adminManager.logEvent('INFO', 'INFRA', `Infraestrutura Nginx e SSL configurada com sucesso para ${cleanDomain}`);

      return res.json({
        success: true,
        message: 'Nginx e SSL configurados com sucesso!',
        stdout: stdout || '',
        stderr: stderr || ''
      });
    });
  }

  /**
   * Salva configurações de playlists (Suporte a Lista Única HLS M3U8)
   */
  async savePlaylists(req, res) {
    try {
      const {
        primary = '',
        backup1 = '',
        backup2 = '',
        live_list_url = '',
        vod_list_url = '',
        activePlaylist = 'primary'
      } = req.body || {};

      try {
        await db.init();
      } catch (dbErr) {
        console.warn('[AdminController] db.init warning:', dbErr.message);
      }

      // Normaliza / Formata link principal para o protocolo HLS M3U8
      let cleanMaster = (primary || vod_list_url || live_list_url || '').trim();
      if (!cleanMaster) {
        cleanMaster = 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8';
      }

      // Garante protocolo HLS m3u8
      if (cleanMaster.includes('output=ts')) {
        cleanMaster = cleanMaster.replace('output=ts', 'output=m3u8');
      } else if (!cleanMaster.includes('output=m3u8')) {
        cleanMaster += (cleanMaster.includes('?') ? '&' : '?') + 'output=m3u8';
      }

      const cleanBackup1 = (backup1 || '').trim();
      const cleanBackup2 = (backup2 || '').trim();

      // 1. Salva no SQLite e Cache de Configurações
      try {
        await db.setSetting('primary_playlist', cleanMaster);
        await db.setSetting('live_list_url', cleanMaster);
        await db.setSetting('vod_list_url', cleanMaster);
        await db.setSetting('active_playlist', activePlaylist);
      } catch (dbSetErr) {
        console.warn('[AdminController] db.setSetting warning:', dbSetErr.message);
      }

      // 2. Atualiza adminManager em memória e persistência em admin_store.json
      try {
        if (typeof adminManager.updatePlaylistConfig === 'function') {
          adminManager.updatePlaylistConfig({
            primary: cleanMaster,
            backup1: cleanBackup1,
            backup2: cleanBackup2,
            live_list_url: cleanMaster,
            vod_list_url: cleanMaster,
            activePlaylist
          });
        }
      } catch (amErr) {
        console.warn('[AdminController] adminManager.updatePlaylistConfig warning:', amErr.message);
      }

      // 3. Atualiza playlistManager em memória
      const pm = require('../playlist-manager');
      try {
        if (typeof pm.setPlaylistUrl === 'function') {
          pm.setPlaylistUrl(cleanMaster);
        } else {
          pm.playlistUrl = cleanMaster;
        }
      } catch (pmErr) {}

      // 4. Dispara sincronização em segundo plano da lista M3U8 única
      pm.downloadPlaylist()
        .then(res => console.log('[AdminController] Sincronização da lista M3U8 concluída com sucesso!'))
        .catch(err => console.warn('[AdminController] Aviso na sincronização:', err.message));

      adminManager.logEvent('INFO', 'PLAYLISTS', 'Lista única HLS M3U8 configurada e salva com sucesso.');

      res.json({
        success: true,
        message: 'Lista única HLS M3U8 salva com sucesso! Sincronização do catálogo iniciada.',
        config: {
          primary: cleanMaster,
          backup1: cleanBackup1,
          backup2: cleanBackup2,
          live_list_url: cleanMaster,
          vod_list_url: cleanMaster,
          activePlaylist
        }
      });
    } catch (err) {
      console.error('[AdminController] Erro ao salvar playlists:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Obtém configuração atual de playlists
   */
  async getPlaylists(req, res) {
    try {
      let masterUrl = '';
      try {
        const pm = require('../playlist-manager');
        masterUrl = pm.playlistUrl || '';
      } catch(e) {}

      if (!masterUrl) {
        masterUrl = 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8';
      }

      const conf = adminManager.getPlaylistConfig() || {};
      const primary = conf.playlists?.primary || masterUrl;

      res.json({
        success: true,
        playlists: {
          primary: primary,
          backup1: conf.playlists?.backup1 || '',
          backup2: conf.playlists?.backup2 || '',
          live_list_url: primary,
          vod_list_url: primary
        },
        activePlaylist: conf.activePlaylist || 'primary',
        syncStatus: 'online'
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Dispara sincronização da lista única HLS M3U8 imediatamente
   */
  async syncNow(req, res) {
    try {
      const pm = require('../playlist-manager');
      adminManager.logEvent('INFO', 'SYNC', 'Sincronização manual da lista única HLS M3U8 disparada pelo administrador.');

      // Executa em segundo plano para não dar timeout no frontend
      pm.downloadPlaylist()
        .then(result => {
          adminManager.logEvent('INFO', 'SYNC', `Sincronização M3U8 concluída com sucesso.`);
        })
        .catch(err => {
          adminManager.logEvent('ERROR', 'SYNC', `Falha na sincronização M3U8: ${err.message}`);
        });

      res.json({
        success: true,
        message: 'Sincronização da lista única HLS M3U8 iniciada em segundo plano. O catálogo está sendo atualizado.'
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Métricas de Telemetria e QoE para o Painel ADM
   */
  async getTelemetryStats(req, res) {
    try {
      const stats = await telemetryService.getAnalyticsSummary();
      res.json({ success: true, ...stats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

module.exports = new AdminController();
