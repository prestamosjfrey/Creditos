const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// Sin estos límites, /auth/login acepta intentos ilimitados: un atacante puede
// probar millones de contraseñas contra cuentas que tienen acceso total a la
// cartera. `trust proxy` ya está configurado en server.js, así que la IP que se
// mide es la real del cliente y no la del proxy de Render.

const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                  // 10 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // un login correcto no gasta cupo
  message: 'Demasiados intentos de inicio de sesión. Espera 15 minutos e inténtalo de nuevo.',
  handler: (req, res) => {
    res.status(429).render('auth/login', {
      error: 'Demasiados intentos fallidos. Por seguridad, espera 15 minutos antes de volver a intentarlo.',
      layout: false,
    });
  },
});

// Recuperación / reenvío del código. El guardia real es el cooldown de 2 minutos
// por usuario (recuperacion.service.js): este límite por IP solo evita que
// alguien golpee el endpoint para muchos usuarios distintos. Se deja holgado
// para no bloquear los reenvíos legítimos (uno cada 2 min).
const limitadorRecuperar = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('auth/recuperar', {
      error: 'Demasiadas solicitudes. Espera una hora antes de pedir otro enlace.',
      exito: null,
      valores: {},
      layout: false,
    });
  },
});

// Cambio de contraseña con token: limita la fuerza bruta sobre el access_token.
const limitadorNuevaClave = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('auth/nueva-clave', {
      error: 'Demasiados intentos. Espera una hora e inténtalo de nuevo.',
      exito: null,
      usuario: (req.body && req.body.usuario) || '',
      paso: 1,
      layout: false,
    });
  },
});

router.get('/login', authController.mostrarLogin);
router.post('/login', limitadorLogin, authController.procesarLogin);
router.post('/logout', authController.procesarLogout);

// Recuperación de contraseña
router.get('/recuperar', authController.mostrarRecuperar);
router.post('/recuperar', limitadorRecuperar, authController.procesarRecuperar);
router.get('/nueva-clave', authController.mostrarNuevaClave);
// Paso 1: validar el código de WhatsApp. Limitado para que no se pueda probar
// código tras código por fuerza bruta (además del tope de 5 intentos por código).
router.post('/verificar-codigo', limitadorNuevaClave, authController.procesarVerificarCodigo);
// Paso 2: elegir la contraseña nueva (requiere el ticket del paso 1).
router.post('/nueva-clave', limitadorNuevaClave, authController.procesarNuevaClave);

module.exports = router;
