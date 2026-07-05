const express = require('express');
const router = express.Router();

const { requireAuth, requireCliente } = require('../middlewares/auth');
const panelController = require('../controllers/cliente/panel.controller');

router.use(requireAuth, requireCliente);

router.get('/panel', panelController.mostrarPanel);
router.get('/perfil', panelController.mostrarPerfil);
router.get('/prestamos/:id', panelController.mostrarPrestamo);

module.exports = router;
