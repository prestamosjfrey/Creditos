const creditosService = require('../../services/creditos-tomados.service');
const { parsearNumero } = require('../../utils/moneda');

async function listarTodos(req, res, next) {
  try {
    const lista = await creditosService.listarTodos();
    const stats = {
      activos: lista.filter((c) => c.estado === 'activo').length,
      totalDeuda: lista.filter((c) => c.estado === 'activo').reduce((a, c) => a + c.saldo_pendiente, 0),
      totalCapital: lista.filter((c) => c.estado === 'activo').reduce((a, c) => a + Number(c.monto_capital), 0),
      enMora: lista.filter((c) => c.estado === 'activo' && c.en_mora).length,
    };
    res.render('admin/creditos-tomados/lista', { titulo: 'Créditos tomados', creditos: lista, stats });
  } catch (err) { next(err); }
}

async function mostrarFormularioNuevo(req, res, next) {
  try {
    res.render('admin/creditos-tomados/crear', { titulo: 'Nuevo crédito tomado', error: null, valores: {} });
  } catch (err) { next(err); }
}

async function crearCredito(req, res, next) {
  const {
    acreedor, monto_capital, tipo_interes, valor_interes, tasa_interes,
    monto_total_a_pagar, numero_cuotas, valor_cuota, frecuencia_pago,
    fecha_inicio, fecha_primer_pago, notas,
  } = req.body;

  const esAjax = req.headers['x-requested-with'] === 'XMLHttpRequest';

  try {
    const credito = await creditosService.crearCreditoConPlan({
      acreedor: acreedor?.trim(),
      monto_capital: parsearNumero(monto_capital),
      tipo_interes,
      valor_interes: parsearNumero(valor_interes),
      tasa_interes: tasa_interes ? Number(tasa_interes) : 0,
      monto_total_a_pagar: parsearNumero(monto_total_a_pagar),
      numero_cuotas: Number(numero_cuotas),
      valor_cuota: parsearNumero(valor_cuota),
      frecuencia_pago,
      fecha_inicio,
      fecha_primer_pago,
      notas: notas || null,
      creado_por: req.usuario.id,
    });
    if (esAjax) {
      return res.json({ ok: true, redirigir: `/admin/creditos-tomados/${credito.id}?creado=1` });
    }
    res.redirect(`/admin/creditos-tomados/${credito.id}?creado=1`);
  } catch (err) {
    if (esAjax) {
      return res.status(400).json({ ok: false, mensaje: err.message || 'No se pudo crear el crédito.' });
    }
    res.status(400).render('admin/creditos-tomados/crear', {
      titulo: 'Nuevo crédito tomado',
      error: err.message || 'No se pudo crear el crédito.',
      valores: req.body,
    });
  }
}

async function mostrarDetalle(req, res, next) {
  try {
    const { credito, cuotas, pagos } = await creditosService.obtenerCreditoConCuotas(req.params.id);
    if (!credito) return res.status(404).render('errores/404');
    res.render('admin/creditos-tomados/detalle', {
      titulo: `Crédito — ${credito.acreedor}`,
      credito,
      cuotas,
      pagos,
      recienCreado: req.query.creado === '1',
    });
  } catch (err) { next(err); }
}

async function pagarCuota(req, res, next) {
  const { id } = req.params;
  const { cuota_id, monto, fecha_pago, notas } = req.body;
  try {
    await creditosService.pagarCuota({
      creditoId: id,
      cuotaId: cuota_id,
      monto: parsearNumero(monto),
      fechaPago: fecha_pago,
      notas: notas || null,
      registradoPor: req.usuario.id,
    });
    res.redirect(`/admin/creditos-tomados/${id}?pago=1`);
  } catch (err) { next(err); }
}

async function registrarPago(req, res, next) {
  const { id } = req.params;
  const { monto, metodo, fecha_pago, notas } = req.body;
  try {
    await creditosService.registrarPagoCreditoTomado({
      creditoId: id,
      monto: parsearNumero(monto),
      metodo,
      fechaPago: fecha_pago,
      notas: notas || null,
      registradoPor: req.usuario.id,
    });
    res.redirect(`/admin/creditos-tomados/${id}?pago=1`);
  } catch (err) {
    res.redirect(`/admin/creditos-tomados/${id}?error=${encodeURIComponent(err.message || 'No se pudo registrar el pago.')}`);
  }
}

module.exports = { listarTodos, mostrarFormularioNuevo, crearCredito, mostrarDetalle, pagarCuota, registrarPago };
