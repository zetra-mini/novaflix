const db = require('./db');

class TelemetryService {
  constructor() {
    // Mapa em memória para verificação de sessões ativas instantânea (<1ms)
    this.activeSessions = new Map(); // uuid -> { ip, device, lastHeartbeat, streamId, active }
  }

  /**
   * Registra heartbeat de sessão e valida concorrência
   * Se um mesmo UUID abrir em outro IP/dispositivo, a sessão anterior é marcada como revogada
   */
  async recordHeartbeat({ uuid, ip, device, streamId, userName }) {
    if (!uuid) return { valid: true };
    await db.init();

    const now = Date.now();
    const existing = this.activeSessions.get(uuid);

    // Verificação de concorrência: Se o IP ou dispositivo mudou durante streaming ativo
    let conflict = false;
    if (existing && existing.active && existing.streamId && streamId && existing.streamId !== streamId) {
      if (existing.ip !== ip) {
        console.warn(`[Segurança] Concorrência detectada para UUID ${uuid}: IP anterior ${existing.ip} vs novo IP ${ip}. Sessão anterior derrubada.`);
        conflict = true;
      }
    }

    const sessionData = {
      ip: ip || '127.0.0.1',
      device: device || 'Web',
      user_name: userName || 'Usuário',
      lastHeartbeat: now,
      streamId: streamId || (existing ? existing.streamId : null),
      active: true
    };

    this.activeSessions.set(uuid, sessionData);

    // Persiste no SQLite
    try {
      await db.runAsync(
        `INSERT INTO user_sessions (uuid, ip, device, user_name, is_active, current_stream_id, last_heartbeat)
         VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(uuid) DO UPDATE SET
           ip = excluded.ip,
           device = excluded.device,
           user_name = COALESCE(excluded.user_name, user_sessions.user_name),
           is_active = 1,
           current_stream_id = excluded.current_stream_id,
           last_heartbeat = CURRENT_TIMESTAMP`,
        [uuid, sessionData.ip, sessionData.device, sessionData.user_name, sessionData.streamId]
      );
    } catch (e) {
      console.warn('[Telemetry] Falha ao persistir sessão:', e.message);
    }

    return {
      valid: true,
      hasConflict: conflict,
      message: conflict ? 'Sessão anterior encerrada devido a nova conexão em outro dispositivo.' : 'OK'
    };
  }

  /**
   * Encerra uma sessão de stream
   */
  async endStreamSession(uuid) {
    if (!uuid) return;
    const sess = this.activeSessions.get(uuid);
    if (sess) {
      sess.streamId = null;
      sess.active = false;
    }
    try {
      await db.runAsync('UPDATE user_sessions SET is_active = 0, current_stream_id = NULL WHERE uuid = ?', [uuid]);
    } catch (e) {}
  }

  /**
   * Registra evento de consumo / QoE (Analytics)
   */
  async recordQoEEvent({ uuid, itemId, itemName, itemType, durationWatched, dropOffMinute, bufferCount }) {
    await db.init();
    try {
      await db.runAsync(
        `INSERT INTO telemetry (uuid, item_id, item_name, item_type, duration_watched, drop_off_minute, buffer_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid || 'anon',
          String(itemId || ''),
          String(itemName || 'Desconhecido'),
          String(itemType || 'vod'),
          parseInt(durationWatched || 0, 10),
          parseFloat(dropOffMinute || 0),
          parseInt(bufferCount || 0, 10)
        ]
      );
      return { success: true };
    } catch (err) {
      console.warn('[Telemetry] Erro ao registrar evento QoE:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Obtém métricas de consumo e saúde de transmissão para o Painel ADM
   */
  async getAnalyticsSummary() {
    await db.init();
    try {
      // 1. Títulos mais assistidos
      const topWatched = await db.allAsync(`
        SELECT item_name, item_type, COUNT(*) as views, SUM(duration_watched) as total_duration, AVG(buffer_count) as avg_buffers
        FROM telemetry
        GROUP BY item_name
        ORDER BY views DESC
        LIMIT 10
      `);

      // 2. Média de Drop-off por minuto
      const dropOffStats = await db.allAsync(`
        SELECT item_name, AVG(drop_off_minute) as avg_drop_off_min, COUNT(*) as exits
        FROM telemetry
        WHERE drop_off_minute > 0
        GROUP BY item_name
        ORDER BY exits DESC
        LIMIT 10
      `);

      // 3. Taxa total de travamentos (Buffer events)
      const bufferStats = await db.getAsync(`
        SELECT SUM(buffer_count) as total_buffers, COUNT(*) as total_events, AVG(buffer_count) as avg_buffer_per_session
        FROM telemetry
      `);

      // 4. Sessões ativas atuais
      const activeCount = await db.getAsync(`
        SELECT COUNT(*) as count FROM user_sessions WHERE last_heartbeat >= datetime('now', '-5 minute')
      `);

      return {
        topWatched,
        dropOffStats,
        bufferStats: {
          totalBuffers: bufferStats?.total_buffers || 0,
          totalEvents: bufferStats?.total_events || 0,
          avgBufferPerSession: Number(bufferStats?.avg_buffer_per_session || 0).toFixed(2)
        },
        activeUsersNow: activeCount?.count || 0
      };
    } catch (err) {
      console.warn('[Telemetry] Erro ao gerar analytics:', err.message);
      return { topWatched: [], dropOffStats: [], bufferStats: {}, activeUsersNow: 0 };
    }
  }
}

module.exports = new TelemetryService();
