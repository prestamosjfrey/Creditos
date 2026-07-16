const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.get('/login', authController.mostrarLogin);
router.post('/login', authController.procesarLogin);
router.post('/logout', authController.procesarLogout);

// Recuperación de contraseña
router.get('/recuperar', authController.mostrarRecuperar);
router.post('/recuperar', authController.procesarRecuperar);
router.get('/nueva-clave', authController.mostrarNuevaClave);
router.post('/nueva-clave', authController.procesarNuevaClave);

module.exports = router;
