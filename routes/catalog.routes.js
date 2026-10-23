const express = require('express');
const router = express.Router();
const catalogController = require('../controllers/catalog.controller');

router.get('/catalog', (req, res) => catalogController.getCatalog(req, res));
router.get('/trending', (req, res) => catalogController.getTrending(req, res));
router.get('/category-items', (req, res) => catalogController.getCategoryItems(req, res));
router.get('/search', (req, res) => catalogController.search(req, res));

module.exports = router;
