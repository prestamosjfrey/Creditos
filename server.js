require('dotenv').config();

// Antes de nada: si falta configuración, no se arranca (mensaje claro y salida).
require('./config/env').validarEntorno();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const { Server } = require('socket.io');
const realtime = require('./services/realtime');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const errorHandler = require('./middlewares/errorHandler');
const { csrfProteccion } = require('./middlewares/csrf');
const { formatCOP } = require('./utils/moneda');

const app = express();

// Detrás del proxy de Render: confía en X-Forwarded-Proto para que req.protocol
// sea 'https' y las URLs de redirect (p. ej. el enlace de recuperar contraseña)
// se generen correctamente.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/base');

// Cabeceras de seguridad. La CSP permite 'unsafe-inline' en scripts porque las
// vistas EJS incorporan scripts en línea (gráficas, SweetAlert). Todo lo demás
// queda restringido al propio origen: no se carga nada desde CDNs.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'wss:', 'ws:'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  // Los PDFs y descargas se abren en pestaña propia.
  crossOriginResourcePolicy: { policy: 'same-site' },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
}));

// Límite de tamaño del cuerpo: evita que un POST gigante agote memoria.
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser(process.env.SESSION_COOKIE_SECRET));
app.use(express.static(path.join(__dirname, 'public')));
// Cliente de Socket.IO auto-hospedado (nunca CDN).
app.use('/vendor/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));

// Versión del CSS para cache-busting: cambia cada vez que se recompila
// output.css, forzando al navegador a cargar el CSS nuevo (no el cacheado).
// Se calcula UNA vez al arrancar: hacer statSync en cada request bloquea el
// event loop sin aportar nada (el CSS no cambia con el proceso vivo).
const ASSET_V = (() => {
  try {
    return String(Math.round(fs.statSync(path.join(__dirname, 'public/css/output.css')).mtimeMs));
  } catch (e) { return '1'; }
})();

// Los mensajes flash llegan por query string tras un redirect. El texto se
// escapa al renderizar (JSON.stringify + Swal `text`, que usa textContent), así
// que no hay XSS; se recorta a 200 caracteres para que un enlace manipulado no
// pueda volcar un texto enorme en la interfaz.
const flash = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);

// Disponible en todas las vistas sin tener que pasarlo en cada render.
app.use((req, res, next) => {
  res.locals.formatCOP = formatCOP;
  // Mensajes flash vía query string tras un redirect (?ok=... o ?error=...).
  // Las vistas que renderizan directamente (sin redirect) pueden sobrescribir
  // flashExito/flashError pasándolos explícitamente al res.render().
  res.locals.flashExito = flash(req.query.ok);
  res.locals.flashError = flash(req.query.error);
  res.locals.rutaActual = req.path;
  res.locals.assetV = ASSET_V;
  next();
});

app.get('/', (req, res) => res.redirect('/auth/login'));

// CSRF antes de las rutas: valida el token en todo POST/PUT/DELETE y expone
// res.locals.csrfToken a las vistas para incrustarlo en los formularios.
app.use(csrfProteccion);

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).render('errores/404'));
app.use(errorHandler);

const { programarRecordatorios } = require('./services/recordatorios.service');
const { programarMarcadoDeMora } = require('./services/mora-job.service');
const { usuarioDesdeToken } = require('./middlewares/auth');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Socket.IO para actualizaciones en tiempo real (p. ej. Centro de Mora).
const io = new Server(server);

// Solo el staff autenticado puede abrir el canal: sin esto, cualquiera en
// internet podía conectarse y observar el pulso de actividad del negocio.
io.use(async (socket, next) => {
  try {
    const cookies = socket.handshake.headers.cookie || '';
    const token = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('sb-access-token='))
      ?.slice('sb-access-token='.length);

    const usuario = token ? await usuarioDesdeToken(decodeURIComponent(token)) : null;
    if (!usuario) return next(new Error('no autorizado'));
    socket.data.usuario = { id: usuario.id, rol: usuario.rol };
    next();
  } catch (err) {
    next(new Error('no autorizado'));
  }
});

realtime.setIo(io);
io.on('connection', () => { /* el cliente solo escucha eventos de datos */ });

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  programarRecordatorios();
  programarMarcadoDeMora();
});
