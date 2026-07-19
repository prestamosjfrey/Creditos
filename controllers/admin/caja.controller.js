const cajaService = require('../../services/caja.service');
const auditoria = require('../../services/auditoria.service');
const { formatCOP, parsearNumero } = require('../../utils/moneda');

async function mostrarCaja(req, res, next) {
  try {
    const [saldoDisponible, movimientos] = await Promise.all([
      cajaService.obtenerSaldoDisponible(req.usuario.id),
      cajaService.obtenerMovimientos(req.usuario.id),
    ]);

    res.render('admin/caja/index', {
      titulo: 'Disponible para préstamo',
      saldoDisponible,
      movimientos,
    });
  } catch (err) {
    next(err);
  }
}

async function registrarMovimientoManual(req, res, next) {
  const { tipo, monto, concepto, volver_a } = req.body;
  const montoNum = parsearNumero(monto);

  try {
    await cajaService.registrarMovimiento({
      tipo,
      monto: montoNum,
      concepto,
      origen: 'manual',
      registradoPor: req.usuario.id,
    });

    await auditoria.registrar({
      tipo: tipo === 'ingreso' ? 'caja_ingreso' : 'caja_egreso',
      descripcion: `${tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} manual de caja: ${formatCOP(montoNum)} — ${concepto}.`,
      detalle: { tipo, monto: montoNum, concepto },
      actorId: req.usuario.id,
    });

    const destino = volver_a && volver_a.startsWith('/admin/') ? volver_a : '/admin/caja';
    res.redirect(`${destino}?ok=${encodeURIComponent('Movimiento registrado correctamente.')}`);
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarCaja, registrarMovimientoManual };
