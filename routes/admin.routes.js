const express = require('express');
const multer = require('multer');
const router = express.Router();

// Subida de documentos en memoria (se reenvía el buffer a Supabase Storage).
// Solo se aceptan los formatos que tienen sentido en un expediente (cédulas,
// contratos, soportes). Sin esta lista, cualquiera podía cargar un .exe o un
// .html — este último especialmente peligroso: al abrirlo desde la URL firmada
// se ejecutaría su JavaScript en el dominio de Supabase Storage.
const MIMES_PERMITIDOS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!MIMES_PERMITIDOS.has(file.mimetype)) {
      return cb(new Error('Formato no permitido. Sube un PDF o una imagen (JPG, PNG, WEBP).'));
    }
    cb(null, true);
  },
});

const { requireAuth, requireAdmin } = require('../middlewares/auth');
const {
  revisar,
  esUuid,
  validarPrestamo,
  validarAbono,
  validarCliente,
  validarCreditoTomado,
  validarPagoCreditoTomado,
  validarMovimientoCaja,
  validarUsuarioNuevo,
  validarUsuarioEdicion,
  validarPerfilPropio,
} = require('../middlewares/validar');
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
const usuariosController = require('../controllers/admin/usuarios.controller');
const dashboardService = require('../services/dashboard.service');

router.use(requireAuth, requireAdmin);

// Conteos reales (mora, cobros de hoy) disponibles en el header/sidebar de
// cualquier vista admin, sin que cada controlador tenga que calcularlos.
router.use(async (req, res, next) => {
  try {
    const conteos = await dashboardService.obtenerConteosNotificacion(req.usuario.id);
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
router.post('/clientes',
  validarCliente,
  revisar(clientesController.renderNuevoConError),
  clientesController.crearCliente);
router.get('/clientes/:id', esUuid('id'), revisar(), clientesController.mostrarFicha);
router.get('/clientes/:id/editar', esUuid('id'), revisar(), clientesController.mostrarFormularioEditar);
router.post('/clientes/:id/editar',
  esUuid('id'), validarCliente,
  revisar(clientesController.renderEditarConError),
  clientesController.editarCliente);
router.post('/clientes/:id/estado', esUuid('id'), revisar(), clientesController.cambiarEstado);
router.post('/clientes/:id/notas', esUuid('id'), revisar(), clientesController.guardarNotas);
router.post('/clientes/:id/documentos', esUuid('id'), revisar(), subida.single('documento'), clientesController.subirDocumento);
router.get('/clientes/:id/documentos/:docId/ver', esUuid('id'), esUuid('docId'), revisar(), clientesController.verDocumento);
router.post('/clientes/:id/documentos/:docId/eliminar', esUuid('id'), esUuid('docId'), revisar(), clientesController.eliminarDocumento);

router.get('/prestamos', prestamosController.listarTodos);
router.get('/prestamos/exportar', prestamosController.exportarCsv);
router.get('/prestamos/nuevo', prestamosController.mostrarFormularioNuevo);
router.post('/prestamos',
  validarPrestamo,
  revisar(prestamosController.renderCrearConError),
  prestamosController.crearPrestamo);
router.get('/prestamos/:id', esUuid('id'), revisar(), prestamosController.mostrarDetalle);
router.get('/prestamos/:id/comprobante', esUuid('id'), revisar(), prestamosController.generarComprobante);
router.get('/prestamos/:id/paz-y-salvo', esUuid('id'), revisar(), prestamosController.generarPazYSalvo);
router.get('/prestamos/:id/cuotas/:cuotaId/comprobante', esUuid('id'), esUuid('cuotaId'), revisar(), prestamosController.generarComprobanteCuota);
router.get('/prestamos/:id/pagos/:pagoId/comprobante', esUuid('id'), esUuid('pagoId'), revisar(), prestamosController.generarComprobantePago);
router.post('/prestamos/:id/pagos', validarAbono, revisar(), pagosController.registrarAbono);

router.get('/pagos', pagosController.listarTodos);

router.get('/caja', cajaController.mostrarCaja);
router.post('/caja', validarMovimientoCaja, revisar(), cajaController.registrarMovimientoManual);

router.get('/creditos-tomados', creditosTomadosController.listarTodos);
router.get('/creditos-tomados/nuevo', creditosTomadosController.mostrarFormularioNuevo);
router.post('/creditos-tomados',
  validarCreditoTomado,
  revisar(creditosTomadosController.renderCrearConError),
  creditosTomadosController.crearCredito);
router.get('/creditos-tomados/:id', esUuid('id'), revisar(), creditosTomadosController.mostrarDetalle);
router.post('/creditos-tomados/:id/cuotas', validarPagoCreditoTomado, revisar(), creditosTomadosController.pagarCuota);
router.post('/creditos-tomados/:id/pagos', validarPagoCreditoTomado, revisar(), creditosTomadosController.registrarPago);

router.get('/cobros', cobrosController.mostrarCobros);
router.post('/cobros/notificar', cobrosController.notificarCobrosHoy);
router.get('/mora', cobrosController.mostrarMora);
router.get('/mora/datos', cobrosController.datosMora);

router.get('/reportes', reportesController.mostrarIndice);
// La exportación va ANTES de /:clave para que "exportar" no se lea como el
// nombre de un reporte.
router.get('/reportes/:clave/exportar', reportesController.exportarReporte);
router.get('/reportes/:clave', reportesController.mostrarReporte);

router.get('/auditoria', auditoriaController.mostrarAuditoria);

router.get('/archivo', archivoController.mostrarArchivo);
router.get('/renegociados', renegociadosController.mostrarRenegociados);

router.get('/configuracion', configuracionController.mostrarConfiguracion);
// Cuenta propia: cada quien edita sus datos y cambia su clave (exige la actual).
router.post('/configuracion/perfil', validarPerfilPropio, revisar(), configuracionController.editarMiPerfil);
router.post('/configuracion/clave', configuracionController.cambiarMiClave);

// --- Usuarios del sistema (staff) ---
// Crear usuarios y restablecer contraseñas es dar acceso a toda la cartera:
// requireAdmin ya cubre todo /admin, así que un cobrador no llega aquí.
router.get('/usuarios', usuariosController.listar);
router.get('/usuarios/nuevo', usuariosController.mostrarFormularioNuevo);
router.post('/usuarios', validarUsuarioNuevo, revisar(), usuariosController.crear);
router.get('/usuarios/:id/editar', esUuid('id'), revisar(), usuariosController.mostrarFormularioEditar);
router.post('/usuarios/:id/editar', esUuid('id'), validarUsuarioEdicion, revisar(), usuariosController.editar);
router.post('/usuarios/:id/estado', esUuid('id'), revisar(), usuariosController.cambiarEstado);
router.post('/usuarios/:id/clave', esUuid('id'), revisar(), usuariosController.restablecerClave);
// Envía un WhatsApp de prueba para verificar teléfono + apikey de CallMeBot.
router.post('/usuarios/:id/probar-whatsapp', esUuid('id'), revisar(), usuariosController.probarWhatsApp);

module.exports = router;
