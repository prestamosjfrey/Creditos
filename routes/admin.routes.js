const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// Subida de documentos en memoria (se reenvía el buffer a Supabase Storage).
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const { requireAuth, requireAdmin } = require('../middlewares/auth');
const dashboardController = require('../controllers/admin/dashboard.controller');
const clientesController = require('../controllers/admin/clientes.controller');
const prestamosController = require('../controllers/admin/prestamos.controller');
const pagosController = require('../controllers/admin/pagos.controller');
const cobrosController = require('../controllers/admin/cobros.controller');
const reportesController = require('../controllers/admin/reportes.controller');
const configuracionController = require('../controllers/admin/configuracion.controller');
const cajaController = require('../controllers/admin/caja.controller');
const auditoriaController = require('../controllers/admin/auditoria.controller');
const archivoController = require('../controllers/admin/archivo.controller');
const renegociadosController = require('../controllers/admin/renegociados.controller');
const creditosTomadosController = require('../controllers/admin/creditos-tomados.controller');
const dashboardService = require('../services/dashboard.service');

router.use(requireAuth, requireAdmin);

// Conteos reales (mora, cobros de hoy) disponibles en el header/sidebar de
// cualquier vista admin, sin que cada controlador tenga que calcularlos.
router.use(async (req, res, next) => {
  try {
    const conteos = await dashboardService.obtenerConteosNotificacion();
    res.locals.moraCount = conteos.moraCount;
    res.locals.cobrosHoyCount = conteos.cobrosHoyCount;
    res.locals.clientesCount = conteos.clientesCount;
    res.locals.prestamosCount = conteos.prestamosCount;
    res.locals.renegCount = conteos.renegCount;
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard', dashboardController.mostrarDashboard);

router.get('/clientes', clientesController.listarClientes);
router.get('/clientes/nuevo', clientesController.mostrarFormularioNuevo);
router.post('/clientes', clientesController.crearCliente);
router.get('/clientes/:id', clientesController.mostrarFicha);
router.get('/clientes/:id/editar', clientesController.mostrarFormularioEditar);
router.post('/clientes/:id/editar', clientesController.editarCliente);
router.post('/clientes/:id/estado', clientesController.cambiarEstado);
router.post('/clientes/:id/notas', clientesController.guardarNotas);
router.post('/clientes/:id/documentos', subida.single('documento'), clientesController.subirDocumento);
router.get('/clientes/:id/documentos/:docId/ver', clientesController.verDocumento);
router.post('/clientes/:id/documentos/:docId/eliminar', clientesController.eliminarDocumento);

router.get('/prestamos', prestamosController.listarTodos);
router.get('/prestamos/exportar', prestamosController.exportarCsv);
router.get('/prestamos/nuevo', prestamosController.mostrarFormularioNuevo);
router.post('/prestamos', prestamosController.crearPrestamo);
router.get('/prestamos/:id', prestamosController.mostrarDetalle);
router.get('/prestamos/:id/comprobante', prestamosController.generarComprobante);
router.get('/prestamos/:id/paz-y-salvo', prestamosController.generarPazYSalvo);
router.get('/prestamos/:id/cuotas/:cuotaId/comprobante', prestamosController.generarComprobanteCuota);
router.get('/prestamos/:id/pagos/:pagoId/comprobante', prestamosController.generarComprobantePago);
router.post('/prestamos/:id/pagos', pagosController.registrarAbono);

router.get('/pagos', pagosController.listarTodos);

router.get('/caja', cajaController.mostrarCaja);
router.post('/caja', cajaController.registrarMovimientoManual);

router.get('/creditos-tomados', creditosTomadosController.listarTodos);
router.get('/creditos-tomados/nuevo', creditosTomadosController.mostrarFormularioNuevo);
router.post('/creditos-tomados', creditosTomadosController.crearCredito);
router.get('/creditos-tomados/:id', creditosTomadosController.mostrarDetalle);
router.post('/creditos-tomados/:id/cuotas', creditosTomadosController.pagarCuota);
router.post('/creditos-tomados/:id/pagos', creditosTomadosController.registrarPago);

router.get('/cobros', cobrosController.mostrarCobros);
router.post('/cobros/notificar', cobrosController.notificarCobrosHoy);
router.get('/mora', cobrosController.mostrarMora);
router.get('/mora/datos', cobrosController.datosMora);

router.get('/reportes', reportesController.mostrarIndice);
router.get('/reportes/capital-prestado', reportesController.mostrarCapitalPrestado);

router.get('/auditoria', auditoriaController.mostrarAuditoria);

router.get('/archivo', archivoController.mostrarArchivo);
router.get('/renegociados', renegociadosController.mostrarRenegociados);

router.get('/configuracion', configuracionController.mostrarConfiguracion);

router.get('/descargar-app', (req, res) => {
  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) {
    return res.status(404).send('El instalador no está disponible todavía. Ejecuta npm run electron:build primero.');
  }
  const archivos = fs.readdirSync(distDir).filter(f => f.endsWith('.exe') && f.includes('Setup'));
  if (archivos.length === 0) {
    return res.status(404).send('No se encontró el instalador en la carpeta dist/.');
  }
  const instalador = path.join(distDir, archivos[0]);
  res.download(instalador, archivos[0]);
});

module.exports = router;
