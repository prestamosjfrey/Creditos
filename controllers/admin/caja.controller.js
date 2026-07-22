const cajaService = require('../../services/caja.service');
const auditoria = require('../../services/auditoria.service');
const { formatCOP, parsearNumero } = require('../../utils/moneda');
const { alcanceDe } = require('../../utils/alcance');

async function mostrarCaja(req, res, next) {
  try {
    // Super admin ve la caja global (suma de todas); el resto, solo la suya.
    const uid = alcanceDe(req.usuario);
    const [saldoDisponible, movimientos] = await Promise.all([
      cajaService.obtenerSaldoDisponible(uid),
      cajaService.obtenerMovimientos(uid),
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
