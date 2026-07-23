const { body, param, query, validationResult } = require('express-validator');
const { parsearNumero } = require('../utils/moneda');

// Validación de entrada en el servidor.
//
// Hasta ahora la app confiaba en los CHECK de Postgres para rechazar datos
// incoherentes. Eso tiene dos problemas: el error llega crudo ("new row for
// relation ... violates check constraint") y hay reglas de negocio que la base
// no conoce (que el total a pagar no sea menor que el capital, que la primera
// cuota no caiga antes del desembolso, que un pago no tenga fecha futura).
//
// Estos validadores se ejecutan ANTES de tocar la base y devuelven mensajes
// que un usuario entiende.

// Contraseña segura: mínimo 8 caracteres con mayúscula, minúscula, número y un
// carácter especial. Se valida en el SERVIDOR además de en el navegador, porque
// la validación del formulario se salta con cualquier herramienta.
//
// La misma expresión y las mismas reglas se reflejan en el checklist en vivo del
// formulario (views/admin/usuarios/form.ejs) para que coincidan.
const REGLAS_PASSWORD = [
  { prueba: (v) => v.length >= 8, error: 'La contraseña debe tener al menos 8 caracteres.' },
  { prueba: (v) => /[A-Z]/.test(v), error: 'La contraseña debe incluir al menos una mayúscula.' },
  { prueba: (v) => /[a-z]/.test(v), error: 'La contraseña debe incluir al menos una minúscula.' },
  { prueba: (v) => /\d/.test(v), error: 'La contraseña debe incluir al menos un número.' },
  { prueba: (v) => /[^A-Za-z0-9]/.test(v), error: 'La contraseña debe incluir al menos un carácter especial.' },
];

function passwordSegura(campo) {
  return body(campo).custom((valor) => {
    const v = String(valor || '');
    const falla = REGLAS_PASSWORD.find((r) => !r.prueba(v));
    if (falla) throw new Error(falla.error);
    return true;
  });
}

const FRECUENCIAS = ['diario', 'semanal', 'quincenal', 'mensual'];
// 'cuota_manual' se retiró de los formularios: ya no se acepta como entrada.
// El CHECK de la base sigue admitiéndolo por si hubiera registros históricos.
const TIPOS_INTERES = ['fijo_total', 'porcentaje_periodico'];
const METODOS = ['efectivo', 'transferencia', 'nequi', 'daviplata', 'otro'];

// Los montos llegan formateados desde el navegador ("1.500.000"); parsearNumero
// los deja en número crudo. Se sanea ANTES de validar para que las reglas
// (isInt, min, max) se apliquen sobre el valor real que se va a guardar.
const montoSaneado = (campo) => body(campo).customSanitizer(parsearNumero);

// Tope defensivo: numeric(14,2) admite hasta 12 dígitos enteros. Cortar antes
// evita que un cero de más reviente la inserción con un error técnico.
const MONTO_MAX = 999999999999;

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// Recoge los errores y, si los hay, corta la petición. Cada ruta decide cómo
// mostrarlos: `alRenderizar` recibe el primer mensaje y arma su propia vista.
function revisar(alRenderizar) {
  return (req, res, next) => {
    const errores = validationResult(req);
    if (errores.isEmpty()) return next();

    const mensaje = errores.array()[0].msg;

    if (typeof alRenderizar === 'function') return alRenderizar(req, res, mensaje);

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(400).json({ ok: false, mensaje });
    }
    const volverA = req.get('referer') || '/admin/dashboard';
    const sep = volverA.includes('?') ? '&' : '?';
    return res.redirect(`${volverA}${sep}error=${encodeURIComponent(mensaje)}`);
  };
}

const esUuid = (campo, ubicacion = param) =>
  ubicacion(campo).isUUID().withMessage('Identificador inválido.');

const validarPrestamo = [
  body('cliente_id').isUUID().withMessage('Selecciona un cliente válido.'),

  montoSaneado('monto_capital')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El capital debe ser un monto mayor que cero.'),

  montoSaneado('monto_total_a_pagar')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El total a pagar debe ser mayor que cero.')
    .bail()
    .custom((total, { req }) => {
      if (Number(total) < Number(req.body.monto_capital)) {
        throw new Error('El total a pagar no puede ser menor que el capital prestado.');
      }
      return true;
    }),

  montoSaneado('valor_cuota')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El valor de la cuota debe ser mayor que cero.'),

  body('numero_cuotas')
    .isInt({ min: 1, max: 500 })
    .withMessage('El número de cuotas debe estar entre 1 y 500.'),

  body('tipo_interes').isIn(TIPOS_INTERES).withMessage('Tipo de interés inválido.'),
  body('frecuencia_pago').isIn(FRECUENCIAS).withMessage('Frecuencia de pago inválida.'),

  body('fecha_inicio').isISO8601().withMessage('La fecha de inicio no es válida.'),

  body('fecha_primer_pago')
    .isISO8601().withMessage('La fecha del primer pago no es válida.')
    .bail()
    .custom((primerPago, { req }) => {
      if (primerPago < req.body.fecha_inicio) {
        throw new Error('El primer pago no puede ser anterior a la fecha de inicio del préstamo.');
      }
      return true;
    }),

  body('tasa_interes').optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 1000 }).withMessage('La tasa de interés no es válida.'),

  body('notas').optional({ values: 'falsy' })
    .isLength({ max: 2000 }).withMessage('Las notas son demasiado largas (máximo 2000 caracteres).'),
];

const validarAbono = [
  esUuid('id'),
  body('cuota_id').optional({ values: 'falsy' }).isUUID().withMessage('Cuota inválida.'),

  montoSaneado('monto')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El monto del abono debe ser mayor que cero.'),

  body('fecha_pago')
    .isISO8601().withMessage('La fecha de pago no es válida.')
    .bail()
    .custom((fecha) => {
      // Registrar un pago con fecha futura descuadra la caja y el cálculo de
      // días de atraso (base del score). Se permite retroactivo, no futuro.
      if (fecha > hoyISO()) throw new Error('No se puede registrar un pago con fecha futura.');
      return true;
    }),

  body('metodo').optional({ values: 'falsy' }).isIn(METODOS).withMessage('Método de pago inválido.'),
  body('tipo').optional({ values: 'falsy' }).isIn(['abono', 'interes']).withMessage('Tipo de pago inválido.'),
  body('accion').optional({ values: 'falsy' }).isIn(['extension', 'saldo']).withMessage('Acción inválida.'),
  body('notas').optional({ values: 'falsy' }).isLength({ max: 1000 }).withMessage('Las notas son demasiado largas.'),
];

// Edición de una cuota pendiente (modo edición del detalle del préstamo).
// La regla de "no menor a lo ya abonado" y "no si está pagada" la aplica la
// función SQL, que es quien ve el estado real dentro de la transacción.
const validarEdicionCuota = [
  esUuid('id'),
  esUuid('cuotaId'),
  montoSaneado('monto')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El valor de la cuota debe ser mayor que cero.'),
  body('fecha_vencimiento').isISO8601().withMessage('La fecha de vencimiento no es válida.'),
];

// Edición del plan: total a pagar y número de cuotas.
const validarEdicionPlan = [
  esUuid('id'),
  montoSaneado('monto_total_a_pagar')
    .isInt({ min: 1, max: MONTO_MAX })
    .withMessage('El total a pagar debe ser mayor que cero.'),
  body('numero_cuotas')
    .isInt({ min: 1, max: 500 })
    .withMessage('El número de cuotas debe estar entre 1 y 500.'),
];

const validarCliente = [
  body('nombre_completo')
    .trim()
    .isLength({ min: 3, max: 150 })
    .withMessage('El nombre debe tener entre 3 y 150 caracteres.'),

  body('numero_documento').optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 4, max: 30 }).withMessage('El número de documento no es válido.')
    .matches(/^[\w.\-]+$/).withMessage('El documento solo puede tener letras, números, puntos y guiones.'),

  body('telefono').optional({ values: 'falsy' })
    .trim()
    .matches(/^[\d+\s()\-]{7,20}$/).withMessage('El teléfono no es válido.'),

  body('email').optional({ values: 'falsy' })
    .trim()
    .isEmail().withMessage('El correo no es válido.')
    .normalizeEmail(),

  body('direccion').optional({ values: 'falsy' })
    .trim().isLength({ max: 200 }).withMessage('La dirección es demasiado larga.'),
];

const validarCreditoTomado = [
  body('acreedor').trim().isLength({ min: 2, max: 150 }).withMessage('Indica el nombre del acreedor.'),

  montoSaneado('monto_capital')
    .isInt({ min: 1, max: MONTO_MAX }).withMessage('El capital debe ser mayor que cero.'),

  montoSaneado('monto_total_a_pagar')
    .isInt({ min: 1, max: MONTO_MAX }).withMessage('El total a pagar debe ser mayor que cero.')
    .bail()
    .custom((total, { req }) => {
      if (Number(total) < Number(req.body.monto_capital)) {
        throw new Error('El total a pagar no puede ser menor que el capital recibido.');
      }
      return true;
    }),

  montoSaneado('valor_cuota').isInt({ min: 1, max: MONTO_MAX }).withMessage('El valor de la cuota debe ser mayor que cero.'),
  body('numero_cuotas').isInt({ min: 1, max: 500 }).withMessage('El número de cuotas debe estar entre 1 y 500.'),
  body('frecuencia_pago').isIn(FRECUENCIAS).withMessage('Frecuencia de pago inválida.'),
  body('fecha_inicio').isISO8601().withMessage('La fecha de inicio no es válida.'),
  body('fecha_primer_pago')
    .isISO8601().withMessage('La fecha del primer pago no es válida.')
    .bail()
    .custom((primerPago, { req }) => {
      if (primerPago < req.body.fecha_inicio) {
        throw new Error('El primer pago no puede ser anterior a la fecha de inicio.');
      }
      return true;
    }),
];

const validarPagoCreditoTomado = [
  esUuid('id'),
  montoSaneado('monto').isInt({ min: 1, max: MONTO_MAX }).withMessage('El monto debe ser mayor que cero.'),
  body('fecha_pago')
    .isISO8601().withMessage('La fecha de pago no es válida.')
    .bail()
    .custom((fecha) => {
      if (fecha > hoyISO()) throw new Error('No se puede registrar un pago con fecha futura.');
      return true;
    }),
  body('metodo').optional({ values: 'falsy' }).isIn(METODOS).withMessage('Método de pago inválido.'),
  body('cuota_id').optional({ values: 'falsy' }).isUUID().withMessage('Cuota inválida.'),
  body('tipo').optional({ values: 'falsy' }).isIn(['abono', 'interes']).withMessage('Tipo de pago inválido.'),
  body('accion').optional({ values: 'falsy' }).isIn(['saldo', 'extension']).withMessage('Acción inválida.'),
];

// El nombre de usuario es el identificador de login y acaba dentro de un correo
// sintético (usuario@cartera.local), así que se restringe a lo que es válido
// ahí. El correo REAL de contacto no lleva validación de unicidad a propósito:
// varios empleados comparten el del jefe.
const validarUsuarioNuevo = [
  body('usuario')
    .trim()
    .isLength({ min: 3, max: 30 }).withMessage('El usuario debe tener entre 3 y 30 caracteres.')
    .matches(/^[a-zA-Z0-9._-]+$/).withMessage('El usuario solo admite letras, números, punto, guion y guion bajo.'),
  body('nombre_completo').trim().isLength({ min: 3, max: 150 }).withMessage('Escribe el nombre completo.'),
  // El rol NO se valida ni se toma del formulario: todos se crean como admin
  // (crearUsuario lo fija). Si llega en el POST, se ignora.
  passwordSegura('password'),
  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('El correo no es válido.'),
  body('telefono').optional({ values: 'falsy' })
    .trim().matches(/^[\d+\s()-]{7,20}$/).withMessage('El teléfono no es válido.'),
  body('callmebot_apikey').optional({ values: 'falsy' })
    .trim().isLength({ max: 40 }).withMessage('La apikey de CallMeBot no es válida.'),
];

// Edición de la cuenta propia. No incluye `rol` ni `activo`: aunque llegaran en
// el formulario, el servicio los ignora — nadie se asciende a sí mismo.
const validarPerfilPropio = [
  body('nombre_completo').trim().isLength({ min: 3, max: 150 }).withMessage('Escribe tu nombre completo.'),
  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('El correo no es válido.'),
  body('telefono').optional({ values: 'falsy' })
    .trim().matches(/^[\d+\s()-]{7,20}$/).withMessage('El teléfono no es válido.'),
  body('numero_documento').optional({ values: 'falsy' })
    .trim().isLength({ max: 30 }).withMessage('El documento no es válido.'),
  body('callmebot_apikey').optional({ values: 'falsy' })
    .trim().isLength({ max: 40 }).withMessage('La apikey de CallMeBot no es válida.'),
];

const validarUsuarioEdicion = [
  body('nombre_completo').trim().isLength({ min: 3, max: 150 }).withMessage('Escribe el nombre completo.'),
  body('rol').optional({ values: 'falsy' }).isIn(['admin', 'cobrador']).withMessage('Rol inválido.'),
  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('El correo no es válido.'),
  body('telefono').optional({ values: 'falsy' })
    .trim().matches(/^[\d+\s()-]{7,20}$/).withMessage('El teléfono no es válido.'),
];

const validarMovimientoCaja = [
  body('tipo').isIn(['ingreso', 'egreso']).withMessage('El tipo de movimiento debe ser ingreso o egreso.'),
  montoSaneado('monto').isInt({ min: 1, max: MONTO_MAX }).withMessage('El monto debe ser mayor que cero.'),
  body('concepto').trim().isLength({ min: 3, max: 200 }).withMessage('Describe el concepto (mínimo 3 caracteres).'),
];

module.exports = {
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
  validarEdicionCuota,
  validarEdicionPlan,
};
