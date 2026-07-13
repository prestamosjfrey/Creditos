const { supabaseAdmin } = require('../../config/supabase');
const prestamosService = require('../../services/prestamos.service');
const cajaService = require('../../services/caja.service');
const comprobanteService = require('../../services/comprobante.service');
const { parsearNumero } = require('../../utils/moneda');
const { formatoISO, formatoRelativoDias } = require('../../utils/fechas');

// Rango de fechas (sobre fecha_inicio) según el periodo del filtro.
function rangoFechaInicio(periodo, q) {
  const hoy = new Date();
  const iso = (d) => formatoISO(d);
  const lunes = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  if (periodo === 'hoy') return { desde: iso(hoy), hasta: iso(hoy) };
  if (periodo === 'esta_semana') { const s = lunes(hoy); const e = new Date(s); e.setDate(s.getDate() + 6); return { desde: iso(s), hasta: iso(e) }; }
  if (periodo === 'este_mes') return { desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)) };
  if (periodo === 'este_anio') return { desde: iso(new Date(hoy.getFullYear(), 0, 1)), hasta: iso(new Date(hoy.getFullYear(), 11, 31)) };
  if (periodo === 'personalizado') return { desde: q.desde || null, hasta: q.hasta || null };
  return { desde: null, hasta: null };
}

// Construye la lista de préstamos enriquecida + filtrada (compartida por la
// vista y la exportación a CSV).
async function obtenerListaFiltrada(query) {
  const hoy = formatoISO(new Date());
  const hoyDate = new Date(hoy + 'T00:00:00');
  const filtrosValidos = ['todos', 'activos', 'pagados', 'vencidos', 'proximos'];
  const filtro = filtrosValidos.includes(query.estado) ? query.estado : 'todos';
  const periodosValidos = ['todos', 'hoy', 'esta_semana', 'este_mes', 'este_anio', 'personalizado'];
  let periodo = periodosValidos.includes(query.periodo) ? query.periodo : ((query.desde || query.hasta) ? 'personalizado' : 'todos');
  const { desde, hasta } = rangoFechaInicio(periodo, query);

  const [{ data: prestamos, error: e1 }, { data: pagos, error: e2 }, { data: cuotas, error: e3 }] = await Promise.all([
    supabaseAdmin.from('prestamos').select('*, perfiles:cliente_id(nombre_completo, numero_documento, telefono)').order('creado_en', { ascending: false }),
    supabaseAdmin.from('pagos').select('prestamo_id, monto'),
    supabaseAdmin.from('cuotas').select('prestamo_id, estado, fecha_vencimiento'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;

  const pagadoMap = new Map();
  pagos.forEach((p) => pagadoMap.set(p.prestamo_id, (pagadoMap.get(p.prestamo_id) || 0) + Number(p.monto)));

  const cuMap = new Map();
  cuotas.forEach((c) => {
    const e = cuMap.get(c.prestamo_id) || { total: 0, pendientes: 0, proxVenc: null, enMora: false };
    e.total += 1;
    if (c.estado !== 'pagada') {
      e.pendientes += 1;
      if (!e.proxVenc || c.fecha_vencimiento < e.proxVenc) e.proxVenc = c.fecha_vencimiento;
      if (c.estado === 'vencida' || c.fecha_vencimiento < hoy) e.enMora = true;
    }
    cuMap.set(c.prestamo_id, e);
  });

  let lista = prestamos.map((p) => {
    const pagado = pagadoMap.get(p.id) || 0;
    const cu = cuMap.get(p.id) || { total: p.numero_cuotas, pendientes: 0, proxVenc: null, enMora: false };
    const total = Number(p.monto_total_a_pagar);
    const pagadas = cu.total - cu.pendientes;
    const enMora = p.estado === 'activo' && cu.enMora;
    const proxDias = cu.proxVenc ? Math.round((new Date(cu.proxVenc + 'T00:00:00') - hoyDate) / 86400000) : null;
    return {
      ...p,
      abonado: pagado,
      saldo_pendiente: total - pagado,
      cuotas_total: cu.total,
      cuotas_pagadas: pagadas,
      pct_pagado: cu.total > 0 ? Math.round((pagadas / cu.total) * 100) : 0,
      en_mora: enMora,
      prox_dias: p.estado === 'activo' ? proxDias : null,
    };
  });

  const activosAll = lista.filter((l) => l.estado === 'activo');
  const stats = {
    capitalCalle: activosAll.reduce((a, l) => a + Number(l.monto_capital), 0),
    porCobrar: activosAll.reduce((a, l) => a + l.saldo_pendiente, 0),
    recuperado: lista.reduce((a, l) => a + l.abonado, 0),
    enMora: lista.filter((l) => l.en_mora).length,
  };

  let tabla = lista;
  if (filtro === 'activos') tabla = tabla.filter((l) => l.estado === 'activo' && !l.en_mora);
  else if (filtro === 'pagados') tabla = tabla.filter((l) => l.estado === 'pagado');
  else if (filtro === 'vencidos') tabla = tabla.filter((l) => l.en_mora);
  else if (filtro === 'proximos') tabla = tabla.filter((l) => l.estado === 'activo' && !l.en_mora && l.prox_dias != null && l.prox_dias >= 0 && l.prox_dias <= 7);
  if (desde) tabla = tabla.filter((l) => l.fecha_inicio >= desde);
  if (hasta) tabla = tabla.filter((l) => l.fecha_inicio <= hasta);

  return { tabla, lista, stats, filtro, periodo, desde, hasta };
}

async function listarTodos(req, res, next) {
  try {
    const { tabla, lista, stats, filtro, periodo, desde, hasta } = await obtenerListaFiltrada(req.query);
    res.render('admin/prestamos/lista', { titulo: 'Préstamos', prestamos: tabla, todosPrestamos: lista, stats, filtro, periodo, desde, hasta });
  } catch (err) {
    next(err);
  }
}

async function exportarCsv(req, res, next) {
  try {
    const { tabla } = await obtenerListaFiltrada(req.query);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const cab = ['N°', 'Cliente', 'Documento', 'Fecha inicio', 'Capital', 'Total a pagar', 'Abonado', 'Saldo', 'Cuotas pagadas', 'Cuotas total', 'Estado'];
    const filas = tabla.map((l) => [
      l.numero != null ? String(l.numero).padStart(3, '0') : '',
      l.perfiles?.nombre_completo || '',
      l.perfiles?.numero_documento || '',
      l.fecha_inicio,
      l.monto_capital,
      l.monto_total_a_pagar,
      l.abonado,
      l.saldo_pendiente,
      l.cuotas_pagadas,
      l.cuotas_total,
      l.en_mora ? 'En mora' : (l.estado === 'pagado' ? 'Pagado' : l.estado === 'cancelado' ? 'Cancelado' : 'Activo'),
    ].map(esc).join(','));
    const csv = '﻿' + [cab.map(esc).join(','), ...filas].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prestamos.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

async function mostrarFormularioNuevo(req, res, next) {
  try {
    const [{ data: clientes, error }, saldoDisponible] = await Promise.all([
      supabaseAdmin
        .from('perfiles')
        .select('id, nombre_completo, numero_documento')
        .eq('rol', 'cliente')
        .order('nombre_completo', { ascending: true }),
      cajaService.obtenerSaldoDisponible(),
    ]);
    if (error) throw error;

    res.render('admin/prestamos/crear', {
      titulo: 'Nuevo préstamo',
      clientes,
      saldoDisponible,
      error: null,
      valores: { cliente_id: req.query.cliente_id || '' },
    });
  } catch (err) {
    next(err);
  }
}

async function crearPrestamo(req, res, next) {
  const {
    cliente_id,
    monto_capital,
    tipo_interes,
    valor_interes,
    tasa_interes,
    monto_total_a_pagar,
    numero_cuotas,
    valor_cuota,
    frecuencia_pago,
    fecha_inicio,
    fecha_primer_pago,
    notas,
  } = req.body;

  try {
    const prestamo = await prestamosService.crearPrestamoConPlan({
      cliente_id,
      creado_por: req.usuario.id,
      monto_capital: parsearNumero(monto_capital),
      tipo_interes,
      valor_interes: valor_interes ? parsearNumero(valor_interes) : null,
      tasa_interes: tasa_interes ? Number(tasa_interes) : null,
      monto_total_a_pagar: parsearNumero(monto_total_a_pagar),
      numero_cuotas: Number(numero_cuotas),
      valor_cuota: parsearNumero(valor_cuota),
      frecuencia_pago,
      fecha_inicio,
      fecha_primer_pago,
      notas: notas || null,
    });

    res.redirect(`/admin/prestamos/${prestamo.id}?creado=1`);
  } catch (err) {
    const [{ data: clientes }, saldoDisponible] = await Promise.all([
      supabaseAdmin
        .from('perfiles')
        .select('id, nombre_completo, numero_documento')
        .eq('rol', 'cliente')
        .order('nombre_completo', { ascending: true }),
      cajaService.obtenerSaldoDisponible(),
    ]);

    res.status(400).render('admin/prestamos/crear', {
      titulo: 'Nuevo préstamo',
      clientes,
      saldoDisponible,
      error: err.message || 'No se pudo crear el préstamo.',
      valores: req.body,
    });
  }
}

async function mostrarDetalle(req, res, next) {
  try {
    const { id } = req.params;
    const { prestamo, cuotas, pagos } = await prestamosService.obtenerPrestamoConCuotas(id);
    if (!prestamo) return res.status(404).render('errores/404');

    res.render('admin/prestamos/detalle', {
      titulo: `Préstamo de ${prestamo.perfiles?.nombre_completo || 'cliente'}`,
      prestamo,
      cuotas,
      pagos,
      recienCreado: req.query.creado === '1',
      abonoId: req.query.abono || null,
    });
  } catch (err) {
    next(err);
  }
}

async function generarComprobante(req, res, next) {
  try {
    const { id } = req.params;
    const { prestamo, cuotas, pagos } = await prestamosService.obtenerPrestamoConCuotas(id);
    if (!prestamo) return res.status(404).render('errores/404');

    const nombre = (prestamo.perfiles?.nombre_completo || 'cliente').replace(/[^\w]+/g, '_');
    const disp = req.query.ver === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disp}; filename="comprobante-${nombre}.pdf"`);
    comprobanteService.generarComprobantePDF({ prestamo, cuotas, pagos }, res);
  } catch (err) {
    next(err);
  }
}

async function generarComprobantePago(req, res, next) {
  try {
    const { id, pagoId } = req.params;
    const { prestamo, cuotas, pagos } = await prestamosService.obtenerPrestamoConCuotas(id);
    if (!prestamo) return res.status(404).render('errores/404');
    const pago = (pagos || []).find((p) => p.id === pagoId);
    if (!pago) return res.status(404).render('errores/404');

    const abonadoTotal = (pagos || []).reduce((a, p) => a + Number(p.monto), 0);
    const saldo = Number(prestamo.monto_total_a_pagar) - abonadoTotal;
    const cuotasTotal = (cuotas || []).length || prestamo.numero_cuotas;
    const cuotasPagadas = (cuotas || []).filter((c) => c.estado === 'pagada').length;

    const disp = req.query.ver === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disp}; filename="comprobante-pago.pdf"`);
    comprobanteService.generarComprobantePagoPDF({ prestamo, pago, saldo, cuotasPagadas, cuotasTotal }, res);
  } catch (err) {
    next(err);
  }
}

async function generarComprobanteCuota(req, res, next) {
  try {
    const { id, cuotaId } = req.params;
    const { prestamo, cuotas, pagos } = await prestamosService.obtenerPrestamoConCuotas(id);
    if (!prestamo) return res.status(404).render('errores/404');
    const cuota = cuotas.find((c) => c.id === cuotaId);
    if (!cuota) return res.status(404).render('errores/404');

    // Método(s) de pago de los abonos que aplicaron a esta cuota (según la
    // distribución guardada). Si son varios distintos → "Varios".
    const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
    const metodosSet = new Set();
    let pagoInteres = null;
    (pagos || []).forEach((p) => {
      const aplic = p.distribucion && Array.isArray(p.distribucion.aplicaciones) ? p.distribucion.aplicaciones : [];
      if (aplic.some((a) => a.cuota_id === cuotaId)) {
        if (p.metodo) metodosSet.add(METODOS[p.metodo] || p.metodo);
        if (p.tipo === 'interes' && !pagoInteres) pagoInteres = p;
      }
    });
    const metodoPago = metodosSet.size === 0 ? null : (metodosSet.size === 1 ? [...metodosSet][0] : 'Varios');

    const disp = req.query.ver === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');

    // Si la cuota se pagó con un abono de SOLO INTERÉS, el comprobante correcto
    // es el del pago de interés (no el de cuota normal) — así no se duplican.
    if (pagoInteres) {
      const abonadoTotal = (pagos || []).reduce((a, p) => a + Number(p.monto), 0);
      const saldo = Number(prestamo.monto_total_a_pagar) - abonadoTotal;
      const cuotasTotal = (cuotas || []).length || prestamo.numero_cuotas;
      const cuotasPagadas = (cuotas || []).filter((c) => c.estado === 'pagada').length;
      res.setHeader('Content-Disposition', `${disp}; filename="comprobante-interes-cuota-${cuota.numero_cuota}.pdf"`);
      return comprobanteService.generarComprobantePagoPDF({ prestamo, pago: pagoInteres, saldo, cuotasPagadas, cuotasTotal }, res);
    }

    res.setHeader('Content-Disposition', `${disp}; filename="cuota-${cuota.numero_cuota}.pdf"`);
    comprobanteService.generarComprobanteCuotaPDF({ prestamo, cuota, metodoPago }, res);
  } catch (err) {
    next(err);
  }
}

async function generarPazYSalvo(req, res, next) {
  try {
    const { id } = req.params;
    const { prestamo, cuotas, pagos } = await prestamosService.obtenerPrestamoConCuotas(id);
    if (!prestamo) return res.status(404).render('errores/404');
    if (prestamo.estado !== 'pagado') {
      return res.status(400).send('El paz y salvo solo está disponible para préstamos pagados en su totalidad.');
    }

    const disp = req.query.ver === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disp}; filename="paz-y-salvo.pdf"`);
    comprobanteService.generarPazYSalvoPDF({ prestamo, cuotas, pagos }, res);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listarTodos,
  exportarCsv,
  mostrarFormularioNuevo,
  crearPrestamo,
  mostrarDetalle,
  generarComprobante,
  generarComprobanteCuota,
  generarComprobantePago,
  generarPazYSalvo,
};
