const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetry.controller');

router.post('/heartbeat', (req, res) => telemetryController.heartbeat(req, res));
router.post('/event', (req, res) => telemetryController.recordEvent(req, res));

module.exports = router;
