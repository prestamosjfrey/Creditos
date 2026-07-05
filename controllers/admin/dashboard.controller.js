const dashboardService = require('../../services/dashboard.service');
const prestamosService = require('../../services/prestamos.service');
const cajaService = require('../../services/caja.service');

const PERIODOS = ['7d', '30d', '3m', '12m'];

async function mostrarDashboard(req, res, next) {
  try {
    await prestamosService.marcarCuotasVencidas();

    const [
      { kpis, cambios },
      resumenDestacado,
      saldoDisponible,
      proximosCobros,
      actividadReciente,
      ...series
    ] = await Promise.all([
      dashboardService.obtenerKpisConTendencia(),
      dashboardService.obtenerResumenCarteraDestacado(),
      cajaService.obtenerSaldoDisponible(),
      dashboardService.obtenerProximosCobros(30),
      dashboardService.obtenerActividadReciente(6),
      ...PERIODOS.map((p) => dashboardService.obtenerSerieIngresos(p)),
    ]);

    const seriesPorPeriodo = {};
    PERIODOS.forEach((p, i) => { seriesPorPeriodo[p] = series[i]; });

    res.render('admin/dashboard', {
      titulo: 'Dashboard',
      kpis,
      cambios,
      resumenDestacado,
      saldoDisponible,
      proximosCobros,
      actividadReciente,
      seriesPorPeriodo,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarDashboard };
