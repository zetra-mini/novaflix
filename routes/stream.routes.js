const express = require('express');
const router = express.Router();
const streamController = require('../controllers/stream.controller');

router.get('/:token', (req, res) => streamController.handleStream(req, res));

module.exports = router;
