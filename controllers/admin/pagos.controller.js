const { supabaseAdmin } = require('../../config/supabase');
const pagosService = require('../../services/pagos.service');
const { parsearNumero } = require('../../utils/moneda');
const { formatoISO } = require('../../utils/fechas');

const PERIODOS = ['hoy', 'ayer', 'esta_semana', 'este_mes', 'este_anio', 'personalizado'];

// Calcula el rango [desde, hasta] (período completo) según el periodo elegido.
function rangoPeriodo(periodo, q) {
  const hoy = new Date();
  const iso = (d) => formatoISO(d);
  const lunesDe = (d) => { const x = new Date(d); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); return x; };
  if (periodo === 'hoy') return { desde: iso(hoy), hasta: iso(hoy) };
  if (periodo === 'ayer') { const a = new Date(hoy); a.setDate(a.getDate() - 1); return { desde: iso(a), hasta: iso(a) }; }
  if (periodo === 'esta_semana') { const s = lunesDe(hoy); const e = new Date(s); e.setDate(s.getDate() + 6); return { desde: iso(s), hasta: iso(e) }; }
  if (periodo === 'este_mes') { const s = new Date(hoy.getFullYear(), hoy.getMonth(), 1); const e = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0); return { desde: iso(s), hasta: iso(e) }; }
  if (periodo === 'este_anio') return { desde: iso(new Date(hoy.getFullYear(), 0, 1)), hasta: iso(new Date(hoy.getFullYear(), 11, 31)) };
  if (periodo === 'personalizado') return { desde: q.desde || null, hasta: q.hasta || null };
  return { desde: null, hasta: null };
}

async function listarTodos(req, res, next) {
  try {
    let periodo = req.query.periodo;
    if (!periodo) periodo = (req.query.desde || req.query.hasta) ? 'personalizado' : 'esta_semana';
    if (!PERIODOS.includes(periodo)) periodo = 'esta_semana';
    let { desde, hasta } = rangoPeriodo(periodo, req.query);
    if (!desde || !hasta) { const r = rangoPeriodo('esta_semana'); desde = desde || r.desde; hasta = hasta || r.hasta; }

    // Solo los pagos de los préstamos del usuario. El !inner obliga a que el
    // préstamo exista y sea suyo (creado_por), así el pago queda acotado.
    const uid = req.usuario.id;
    const { data: pagos, error } = await supabaseAdmin
      .from('pagos')
      .select('*, prestamos:prestamo_id!inner(creado_por, perfiles:clientes(nombre_completo))')
      .eq('prestamos.creado_por', uid)
      .gte('fecha_pago', desde)
      .lte('fecha_pago', hasta)
      .order('fecha_pago', { ascending: false });
    if (error) throw error;

    // Período anterior (mismo largo) para el % de cambio.
    const MS = 86400000;
    const dDesde = new Date(desde + 'T00:00:00');
    const dHasta = new Date(hasta + 'T00:00:00');
    const numDias = Math.round((dHasta - dDesde) / MS) + 1;
    const prevHasta = new Date(dDesde); prevHasta.setDate(prevHasta.getDate() - 1);
    const prevDesde = new Date(prevHasta); prevDesde.setDate(prevDesde.getDate() - (numDias - 1));
    const { data: prevPagos } = await supabaseAdmin
      .from('pagos').select('monto, prestamos:prestamo_id!inner(creado_por)')
      .eq('prestamos.creado_por', uid)
      .gte('fecha_pago', formatoISO(prevDesde)).lte('fecha_pago', formatoISO(prevHasta));
    const prevTotal = (prevPagos || []).reduce((a, p) => a + Number(p.monto), 0);

    let total = 0;
    let masAlto = null;
    pagos.forEach((p) => {
      const m = Number(p.monto);
      total += m;
      if (!masAlto || m > Number(masAlto.monto)) masAlto = p;
    });

    const stats = {
      total,
      count: pagos.length,
      promedioDia: numDias > 0 ? Math.round(total / numDias) : 0,
      masAlto,
      cambioPct: prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null,
    };

    const chartPagos = pagos.map((p) => ({ f: p.fecha_pago, m: Number(p.monto) }));
    const granularidad = periodo === 'este_anio' ? 'mes' : 'dia';

    // Todos los pagos del año en curso para el filtro independiente de la gráfica
    const anoActual = new Date().getFullYear();
    const { data: todosPagosAnio } = await supabaseAdmin
      .from('pagos').select('fecha_pago, monto, prestamos:prestamo_id!inner(creado_por)')
      .eq('prestamos.creado_por', uid)
      .gte('fecha_pago', `${anoActual}-01-01`)
      .lte('fecha_pago', `${anoActual}-12-31`);
    const chartPagosAll = (todosPagosAnio || []).map((p) => ({ f: p.fecha_pago, m: Number(p.monto) }));

    res.render('admin/pagos/lista', { titulo: 'Pagos', pagos, stats, periodo, desde, hasta, chartPagos, chartPagosAll, granularidad });
  } catch (err) {
    next(err);
  }
}

async function registrarAbono(req, res, next) {
  const { id: prestamoId } = req.params;
  const { cuota_id, monto, fecha_pago, metodo, notas, tipo, accion } = req.body;

  try {
    const pago = await pagosService.registrarAbono({
      prestamoId,
      cuotaId: cuota_id || null,
      monto: parsearNumero(monto),
      fechaPago: fecha_pago,
      metodo,
      notas: notas || null,
      registradoPor: req.usuario.id,
      tipo: tipo === 'interes' ? 'interes' : 'abono',
      accion: accion || null,
    });

    res.redirect(`/admin/prestamos/${prestamoId}?abono=${pago.id}`);
  } catch (err) {
    next(err);
  }
}

module.exports = { listarTodos, registrarAbono };
