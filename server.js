require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');
const { Server } = require('socket.io');
const realtime = require('./services/realtime');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const clienteRoutes = require('./routes/cliente.routes');
const errorHandler = require('./middlewares/errorHandler');
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
// Cliente de Socket.IO auto-hospedado (nunca CDN).
app.use('/vendor/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));

// Disponible en todas las vistas sin tener que pasarlo en cada render.
app.use((req, res, next) => {
  res.locals.formatCOP = formatCOP;
  // Mensajes flash vía query string tras un redirect (?ok=... o ?error=...).
  // Las vistas que renderizan directamente (sin redirect) pueden sobrescribir
  // flashExito/flashError pasándolos explícitamente al res.render().
  res.locals.flashExito = req.query.ok || null;
  res.locals.flashError = req.query.error || null;
  res.locals.rutaActual = req.path;
  // Versión del CSS para cache-busting: cambia cada vez que se recompila
  // output.css, forzando al navegador a cargar el CSS nuevo (no el cacheado).
  try {
    res.locals.assetV = String(Math.round(fs.statSync(path.join(__dirname, 'public/css/output.css')).mtimeMs));
  } catch (e) { res.locals.assetV = '1'; }
  next();
});

app.get('/', (req, res) => res.redirect('/auth/login'));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/cliente', clienteRoutes);

app.use((req, res) => res.status(404).render('errores/404'));
app.use(errorHandler);

const { programarRecordatorios } = require('./services/recordatorios.service');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Socket.IO para actualizaciones en tiempo real (p. ej. Centro de Mora).
const io = new Server(server);
realtime.setIo(io);
io.on('connection', () => { /* el cliente solo escucha eventos de datos */ });

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  programarRecordatorios();
});
