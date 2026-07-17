const dashboardService = require('../../services/dashboard.service');
const prestamosService = require('../../services/prestamos.service');
const cajaService = require('../../services/caja.service');
const { formatoISO } = require('../../utils/fechas');

// Mismo filtro de periodo que las demás vistas (Hoy / Esta semana / Este mes /
// Este año / rango personalizado).
const PERIODOS = ['hoy', 'ayer', 'esta_semana', 'este_mes', 'este_anio', 'personalizado'];

function lunesDe(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

function rangoPeriodo(periodo, q = {}) {
  const hoy = new Date();
  const iso = (d) => formatoISO(d);
  if (periodo === 'hoy') return { desde: iso(hoy), hasta: iso(hoy) };
  if (periodo === 'ayer') { const a = new Date(hoy); a.setDate(a.getDate() - 1); return { desde: iso(a), hasta: iso(a) }; }
  if (periodo === 'esta_semana') { const s = lunesDe(hoy); const e = new Date(s); e.setDate(s.getDate() + 6); return { desde: iso(s), hasta: iso(e) }; }
  if (periodo === 'este_mes') { const s = new Date(hoy.getFullYear(), hoy.getMonth(), 1); const e = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0); return { desde: iso(s), hasta: iso(e) }; }
  if (periodo === 'este_anio') return { desde: iso(new Date(hoy.getFullYear(), 0, 1)), hasta: iso(new Date(hoy.getFullYear(), 11, 31)) };
  if (periodo === 'personalizado') return { desde: q.desde || null, hasta: q.hasta || null };
  return { desde: null, hasta: null };
}

async function mostrarDashboard(req, res, next) {
  try {
    // El marcado de cuotas vencidas ya NO se hace aquí: corre en un job propio
    // (services/mora-job.service.js) cada hora. Un GET no debe escribir en la
    // base, y la mora no puede depender de que alguien abra el dashboard.
    let periodo = req.query.periodo;
    if (!periodo) periodo = (req.query.desde || req.query.hasta) ? 'personalizado' : 'este_mes';
    if (!PERIODOS.includes(periodo)) periodo = 'este_mes';
    let { desde, hasta } = rangoPeriodo(periodo, req.query);
    if (!desde || !hasta) { const r = rangoPeriodo('este_mes'); desde = desde || r.desde; hasta = hasta || r.hasta; }

    const [
      kpis,
      resumenDestacado,
      saldoDisponible,
      creditosTomados,
      proximosCobros,
      actividadReciente,
      serie,
    ] = await Promise.all([
      dashboardService.calcularKpisRango({ desde, hasta }),
      dashboardService.obtenerResumenCarteraDestacado(),
      cajaService.obtenerSaldoDisponible(),
      dashboardService.obtenerResumenCreditosTomados(),
      dashboardService.obtenerProximosCobros(30),
      dashboardService.obtenerActividadReciente(6),
      dashboardService.obtenerSerieIngresosRango({ desde, hasta }),
    ]);

    res.render('admin/dashboard', {
      titulo: 'Dashboard',
      kpis,
      resumenDestacado,
      saldoDisponible,
      creditosTomados,
      proximosCobros,
      actividadReciente,
      serie,
      periodo,
      desde,
      hasta,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarDashboard };
