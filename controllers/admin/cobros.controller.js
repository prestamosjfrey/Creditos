const { supabaseAdmin } = require('../../config/supabase');
const { scope, alcanceDe } = require('../../utils/alcance');
const { formatoISO } = require('../../utils/fechas');
const callmebot = require('../../services/callmebot.service');
const moraService = require('../../services/mora.service');

async function obtenerCobros(diasAdelante = 30, usuarioId) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const hoyISO = formatoISO(hoy);
  const limite = new Date(hoy); limite.setDate(limite.getDate() + diasAdelante);
  const semanaISO = formatoISO(new Date(hoy.getTime() + 6 * 86400000));

  // El !inner sobre prestamos + el filtro creado_por deja solo las cuotas de
  // los préstamos de este usuario.
  const campos = `
    id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado, prestamo_id,
    prestamos:prestamo_id!inner(
      id, numero, numero_cuotas, estado, creado_por,
      perfiles:clientes(nombre_completo, numero_documento, telefono)
    )
  `;

  // Cuotas próximas (hoy → +30 días) + cuotas en mora (vencidas antes de hoy)
  const [{ data: proximas, error: e1 }, { data: vencidas, error: e2 }] = await Promise.all([
    scope(supabaseAdmin.from('cuotas').select(campos)
      , 'prestamos.creado_por', usuarioId)
      .in('estado', ['pendiente', 'parcial'])
      .gte('fecha_vencimiento', hoyISO)
      .lte('fecha_vencimiento', formatoISO(limite))
      .order('fecha_vencimiento', { ascending: true }),
    scope(supabaseAdmin.from('cuotas').select(campos)
      , 'prestamos.creado_por', usuarioId)
      .in('estado', ['pendiente', 'parcial', 'vencida'])
      .lt('fecha_vencimiento', hoyISO)
      .order('fecha_vencimiento', { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const mapear = (c, mora) => {
    const saldo = Number(c.monto_esperado) - Number(c.monto_pagado);
    const venc = c.fecha_vencimiento;
    const diff = Math.round((new Date(venc + 'T00:00:00') - hoy) / 86400000);
    let etiqueta, colorEtiqueta;
    if (mora) {
      const dias = Math.abs(diff);
      etiqueta = dias === 1 ? 'Desde ayer' : `${dias} día${dias > 1 ? 's' : ''} de mora`;
      colorEtiqueta = 'mora';
    } else {
      etiqueta = diff === 0 ? 'Hoy' : diff === 1 ? 'Mañana' : `En ${diff} días`;
      colorEtiqueta = diff === 0 ? 'rojo' : diff === 1 ? 'ambar' : 'verde';
    }
    const num = c.prestamos?.numero != null ? String(c.prestamos.numero).padStart(5, '0') : null;
    return {
      ...c, saldo, etiqueta, colorEtiqueta, enMora: mora,
      numeroPrestamo: num ? `#PR-${num}` : null,
      estaHoy: venc === hoyISO,
      estaEnSemana: venc >= hoyISO && venc <= semanaISO,
    };
  };

  // Mora primero (más urgente), luego próximas
  return [
    ...(vencidas || []).map((c) => mapear(c, true)),
    ...(proximas || []).map((c) => mapear(c, false)),
  ];
}

async function mostrarCobros(req, res, next) {
  try {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const hoyISO = formatoISO(hoy);
    const semanaISO = formatoISO(new Date(hoy.getTime() + 6 * 86400000));

    const cobros = await obtenerCobros(30, alcanceDe(req.usuario));

    const clientesSet = new Set(cobros.map((c) => c.prestamos?.perfiles?.numero_documento).filter(Boolean));
    const hoyItems = cobros.filter((c) => c.estaHoy);
    const semanaItems = cobros.filter((c) => c.estaEnSemana);

    const { data: inactivosData } = await supabaseAdmin
      .from('clientes').select('activo', { count: 'exact' }).eq('activo', false);

    const moraItems = cobros.filter((c) => c.enMora);
    const stats = {
      totalClientes: clientesSet.size,
      clientesActivos: cobros.filter((c) => c.prestamos?.perfiles).reduce((s, c) => { s.add(c.prestamos.perfiles.numero_documento); return s; }, new Set()).size,
      clientesInactivos: (inactivosData || []).length,
      totalPorCobrar: cobros.reduce((a, c) => a + c.saldo, 0),
      vencenHoy: hoyItems.length,
      totalHoy: hoyItems.reduce((a, c) => a + c.saldo, 0),
      vencenSemana: semanaItems.length,
      totalSemana: semanaItems.reduce((a, c) => a + c.saldo, 0),
      enMora: moraItems.length,
      totalMora: moraItems.reduce((a, c) => a + c.saldo, 0),
    };

    res.render('admin/cobros/index', {
      titulo: 'Cobros',
      cobros,
      stats,
      notificacionActiva: callmebot.parseDestinos().length > 0,
      hoyISO,
      hastaISO: formatoISO(new Date(hoy.getTime() + 30 * 86400000)),
    });
  } catch (err) { next(err); }
}

async function notificarCobrosHoy(req, res, next) {
  try {
    const r = await callmebot.notificarCuotasDeHoy();
    if (r.ok) {
      const msg = r.cuotas > 0
        ? `Recordatorio enviado: ${r.cuotas} cliente(s) con cuota hoy (${r.enviados}/${r.total} destinos).`
        : `Aviso enviado: hoy no hay cuotas por cobrar (${r.enviados}/${r.total} destinos).`;
      return res.redirect(`/admin/cobros?ok=${encodeURIComponent(msg)}`);
    }
    const detalle = (r.errores && r.errores[0]) || 'No se pudo enviar.';
    return res.redirect(`/admin/cobros?error=${encodeURIComponent('CallMeBot: ' + detalle)}`);
  } catch (err) { next(err); }
}

async function mostrarMora(req, res, next) {
  try {
    const centro = await moraService.obtenerCentroMora(alcanceDe(req.usuario));
    res.render('admin/mora/index', { titulo: 'Mora', centro });
  } catch (err) { next(err); }
}

// Mismos datos en JSON, para refrescar el Centro de Mora en tiempo real.
async function datosMora(req, res, next) {
  try {
    const centro = await moraService.obtenerCentroMora(alcanceDe(req.usuario));
    res.json(centro);
  } catch (err) { next(err); }
}

module.exports = { mostrarCobros, notificarCobrosHoy, mostrarMora, datosMora };
