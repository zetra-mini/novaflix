const telemetryService = require('../services/telemetry-service');

class TelemetryController {
  /**
   * Recebe Heartbeat do cliente para controle de sessões simultâneas
   */
  async heartbeat(req, res) {
    const { uuid, device, userName, streamId } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    try {
      const result = await telemetryService.recordHeartbeat({
        uuid,
        ip: clientIp,
        device,
        userName,
        streamId
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Recebe métricas QoE de reprodução (drop-off, tempo assistido, bufferings)
   */
  async recordEvent(req, res) {
    const { uuid, itemId, itemName, itemType, durationWatched, dropOffMinute, bufferCount } = req.body;

    try {
      const result = await telemetryService.recordQoEEvent({
        uuid,
        itemId,
        itemName,
        itemType,
        durationWatched,
        dropOffMinute,
        bufferCount
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

module.exports = new TelemetryController();
