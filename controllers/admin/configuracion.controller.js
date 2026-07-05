const cajaService = require('../../services/caja.service');

async function mostrarConfiguracion(req, res, next) {
  try {
    const saldoDisponible = await cajaService.obtenerSaldoDisponible();
    res.render('admin/configuracion', { titulo: 'Configuración', saldoDisponible });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarConfiguracion };
