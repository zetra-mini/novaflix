let cron = null;
try {
  cron = require('node-cron');
} catch (e) {
  // Graceful fallback para setInterval nativo
}
const db = require('./db');
const m3uStreamParser = require('./m3u-stream-parser');

class CronService {
  constructor() {
    this.cronTask = null;
    this.intervalTask = null;
    this.hasActiveStreamsChecker = null;
  }

  setStreamChecker(checkerFn) {
    this.hasActiveStreamsChecker = checkerFn;
  }

  /**
   * Inicia o agendador de atualização automática periódica (Padrão: a cada 12 horas)
   */
  async start() {
    await db.init();

    // Cron padrão a cada 12 horas: '0 */12 * * *'
    const cronSchedule = '0 */12 * * *';

    console.log(`[AutoUpdate Cron] Agendador automático configurado para cada 12 horas (${cronSchedule}).`);

    if (this.cronTask && typeof this.cronTask.stop === 'function') {
      this.cronTask.stop();
    }
    if (this.intervalTask) {
      clearInterval(this.intervalTask);
    }

    if (cron && typeof cron.schedule === 'function') {
      this.cronTask = cron.schedule(cronSchedule, async () => {
        console.log('[AutoUpdate Cron] Disparo de sincronização automática a cada 12 horas...');
        await this.runSync();
      });
    } else {
      // Fallback sem dependências: roda a cada 12h via setInterval
      const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
      this.intervalTask = setInterval(async () => {
        console.log('[AutoUpdate Cron/Interval] Disparo de sincronização periódica a cada 12 horas...');
        await this.runSync();
      }, TWELVE_HOURS_MS);
    }
  }

  async runSync(force = false) {
    try {
      // Proteção de estabilidade: se houver stream ativo, adia para não congelar o vídeo
      if (!force && this.hasActiveStreamsChecker && this.hasActiveStreamsChecker()) {
        console.log('[AutoUpdate Cron] Usuários assistindo vídeo no momento. Sincronização adiada.');
        return { success: false, reason: 'active_streams_deferred' };
      }

      const liveUrl = await db.getSetting('live_list_url');
      const vodUrl = await db.getSetting('vod_list_url');

      if (!liveUrl && !vodUrl) {
        // Fallback para lista primária configurada
        const fallbackUrl = await db.getSetting('primary_playlist');
        if (fallbackUrl) {
          console.log('[AutoUpdate Cron] Sincronizando via lista primária legada...');
          return await m3uStreamParser.syncHybridLists(fallbackUrl, fallbackUrl);
        }
        console.log('[AutoUpdate Cron] Nenhuma lista configurada no banco SQLite.');
        return { success: false, reason: 'no_urls_configured' };
      }

      console.log('[AutoUpdate Cron] Iniciando processamento streaming das listas...');
      const result = await m3uStreamParser.syncHybridLists(liveUrl, vodUrl);
      console.log('[AutoUpdate Cron] Sincronização concluída com sucesso:', result);
      return result;
    } catch (err) {
      console.error('[AutoUpdate Cron] Erro durante sincronização:', err.message);
      return { success: false, error: err.message };
    }
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
  }
}

module.exports = new CronService();
