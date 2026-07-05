const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.get('/login', authController.mostrarLogin);
router.post('/login', authController.procesarLogin);
router.post('/logout', authController.procesarLogout);

module.exports = router;
