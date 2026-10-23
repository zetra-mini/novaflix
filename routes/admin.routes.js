const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const adminManager = require('../admin-manager');

// Middleware de autenticação de administrador
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
  if (!token) {
    return res.status(401).json({ success: false, error: 'Acesso negado. Token ausente.' });
  }
  const user = (typeof adminManager.verifyJwt === 'function')
    ? adminManager.verifyJwt(token)
    : (typeof adminManager.verifyToken === 'function' ? adminManager.verifyToken(token) : null);

  if (!user) {
    return res.status(401).json({ success: false, error: 'Sessão expirada ou token inválido.' });
  }
  req.adminUser = user;
  next();
}

// 1-Click Infra Setup (Nginx + SSL)
router.post('/setup-domain', requireAdminAuth, (req, res) => adminController.setupDomain(req, res));

// Configuração Híbrida de Listas IPTV (Live TS + VOD M3U8)
router.post('/playlists', requireAdminAuth, (req, res) => adminController.savePlaylists(req, res));
router.get('/playlists', requireAdminAuth, (req, res) => adminController.getPlaylists(req, res));
router.post('/playlists/sync', requireAdminAuth, (req, res) => adminController.syncNow(req, res));

// Telemetria & QoE
router.get('/telemetry/stats', requireAdminAuth, (req, res) => adminController.getTelemetryStats(req, res));

module.exports = { router, requireAdminAuth };
