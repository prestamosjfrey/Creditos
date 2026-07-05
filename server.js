require('dotenv').config();

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const clienteRoutes = require('./routes/cliente.routes');
const errorHandler = require('./middlewares/errorHandler');
const { formatCOP } = require('./utils/moneda');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/base');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Disponible en todas las vistas sin tener que pasarlo en cada render.
app.use((req, res, next) => {
  res.locals.formatCOP = formatCOP;
  // Mensajes flash vía query string tras un redirect (?ok=... o ?error=...).
  // Las vistas que renderizan directamente (sin redirect) pueden sobrescribir
  // flashExito/flashError pasándolos explícitamente al res.render().
  res.locals.flashExito = req.query.ok || null;
  res.locals.flashError = req.query.error || null;
  res.locals.rutaActual = req.path;
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
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  programarRecordatorios();
});
