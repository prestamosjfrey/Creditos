const { supabaseAdmin } = require('../config/supabase');
const { formatDistanceToNow } = require('date-fns');
const { es } = require('date-fns/locale');
const { diasDeAtraso, formatoISO, formatoRelativoDias } = require('../utils/fechas');

const MESES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Recalcula los 4 KPIs de cartera "como estaban" a una fecha de corte (inclusive),
// usando fecha_inicio/fecha_pago reales. El saldo pendiente > 0 a esa fecha es el
// proxy de "préstamo activo" (no se guarda histórico de `estado`).
async function calcularKpisAlCorte(fechaCorte) {
  const corte = formatoISO(fechaCorte);

  const [{ data: prestamos, error: errorPrestamos }, { data: pagos, error: errorPagos }] = await Promise.all([
    supabaseAdmin.from('prestamos').select('id, numero, monto_capital, monto_total_a_pagar, perfiles:cliente_id(nombre_completo)').lte('fecha_inicio', corte),
    supabaseAdmin.from('pagos').select('prestamo_id, monto').lte('fecha_pago', corte),
  ]);
  if (errorPrestamos) throw errorPrestamos;
  if (errorPagos) throw errorPagos;

  const pagadoPorPrestamo = new Map();
  pagos.forEach((p) => {
    pagadoPorPrestamo.set(p.prestamo_id, (pagadoPorPrestamo.get(p.prestamo_id) || 0) + Number(p.monto));
  });

  let capitalPrestado = 0;
  let totalRecuperado = 0;
  let interesesCobrados = 0;
  let carteraActiva = 0;
  // Detalle por préstamo para poder explicar de dónde sale cada total.
  const desglose = [];

  prestamos.forEach((p) => {
    const capital = Number(p.monto_capital);
    const total = Number(p.monto_total_a_pagar);
    const pagado = pagadoPorPrestamo.get(p.id) || 0;
    const interesPorCuota = total - capital;
    // Porcentaje del préstamo ya cobrado → aplicar al interés total pactado.
    // Esto aproxima cuánto interés real ya entró: si pagó el 60% del total,
    // cobró el 60% del interés pactado.
    const pctCobrado = total > 0 ? Math.min(1, pagado / total) : 0;
    const interesCobrado = Math.round(interesPorCuota * pctCobrado);
    const saldo = total - pagado;
    capitalPrestado += capital;
    totalRecuperado += pagado;
    interesesCobrados += interesCobrado;
    if (saldo > 0.01) carteraActiva += saldo;

    desglose.push({
      numero: p.numero,
      cliente: p.perfiles?.nombre_completo || 'Cliente',
      capital,
      pagado,
      interesCobrado,
      saldo: saldo > 0.01 ? saldo : 0,
    });
  });

  // Ordenar por número de préstamo para una lectura estable.
  desglose.sort((a, b) => (a.numero || 0) - (b.numero || 0));

  return { capitalPrestado, totalRecuperado, interesesCobrados, carteraActiva, desglose };
}

function calcularCambioPorcentual(actual, anterior) {
  if (!anterior) return actual > 0 ? null : 0;
  return Math.round(((actual - anterior) / anterior) * 100);
}

// KPIs de hoy + % de cambio frente al cierre del mes anterior. `null` en el
// cambio significa "sin base de comparación" (la vista lo muestra como "Nuevo").
async function obtenerKpisConTendencia() {
  const hoy = new Date();
  const finMesAnterior = new Date(hoy.getFullYear(), hoy.getMonth(), 0);

  const [actual, anterior] = await Promise.all([
    calcularKpisAlCorte(hoy),
    calcularKpisAlCorte(finMesAnterior),
  ]);

  const cambios = {};
  Object.keys(actual).forEach((clave) => {
    if (clave === 'desglose') return; // el desglose es un detalle, no un número comparable
    cambios[clave] = calcularCambioPorcentual(actual[clave], anterior[clave]);
  });

  return { kpis: actual, cambios };
}

// Datos para la tarjeta destacada: cartera activa, intereses generados este mes
// y número de clientes distintos con al menos un préstamo activo/en mora.
async function obtenerResumenCarteraDestacado() {
  const hoy = new Date();
  const inicioMes = formatoISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1));

  const { data, error } = await supabaseAdmin.from('vista_cartera').select('*');
  if (error) throw error;

  const carteraActiva = data
    .filter((p) => p.estado === 'activo' || p.estado === 'en_mora')
    .reduce((acc, p) => acc + Number(p.saldo_pendiente), 0);

  const clientesActivos = new Set(
    data.filter((p) => p.estado === 'activo' || p.estado === 'en_mora').map((p) => p.cliente_id)
  ).size;

  const { data: prestamosDelMes, error: errorMes } = await supabaseAdmin
    .from('prestamos')
    .select('monto_capital, monto_total_a_pagar')
    .gte('fecha_inicio', inicioMes);
  if (errorMes) throw errorMes;

  const interesesEsteMes = prestamosDelMes.reduce(
    (acc, p) => acc + (Number(p.monto_total_a_pagar) - Number(p.monto_capital)),
    0
  );

  return { carteraActiva, clientesActivos, interesesEsteMes };
}

async function obtenerAlertasMora() {
  const hoy = formatoISO(new Date());
  const { data, error } = await supabaseAdmin
    .from('cuotas')
    .select('*, prestamos:prestamo_id(cliente_id, perfiles:cliente_id(nombre_completo, telefono))')
    .in('estado', ['pendiente', 'parcial', 'vencida'])
    .lt('fecha_vencimiento', hoy)
    .order('fecha_vencimiento', { ascending: true });
  if (error) throw error;

  return data
    .map((cuota) => ({
      ...cuota,
      diasAtraso: diasDeAtraso(new Date(`${cuota.fecha_vencimiento}T00:00:00`)),
    }))
    .sort((a, b) => b.diasAtraso - a.diasAtraso);
}

async function obtenerProximosCobros(diasAdelante = 7) {
  const hoy = new Date();
  const limite = new Date(hoy);
  limite.setDate(limite.getDate() + diasAdelante);

  const { data, error } = await supabaseAdmin
    .from('cuotas')
    .select('*, prestamos:prestamo_id(cliente_id, perfiles:cliente_id(nombre_completo, telefono))')
    .in('estado', ['pendiente', 'parcial'])
    .gte('fecha_vencimiento', formatoISO(hoy))
    .lte('fecha_vencimiento', formatoISO(limite))
    .order('fecha_vencimiento', { ascending: true });
  if (error) throw error;

  return data.map((cuota) => ({
    ...cuota,
    etiquetaVencimiento: formatoRelativoDias(new Date(`${cuota.fecha_vencimiento}T00:00:00`)),
  }));
}

// Serie de ingresos para un periodo dado, con buckets diarios (7d/30d) o
// mensuales (3m/12m), más sus mini-estadísticas (total, promedio diario,
// días con ingresos). Todo calculado en una sola pasada de datos reales.
async function obtenerSerieIngresos(periodo) {
  const hoy = new Date();
  let dias = 0;
  let granularidad = 'dia';

  // Granularidad por periodo: corta (diaria) en 7 días, semanal en rangos
  // medianos (30 días / 3 meses) para no llenar de puntos vacíos, y mensual
  // en 12 meses.
  if (periodo === '7d') { dias = 7; granularidad = 'dia'; }
  else if (periodo === '30d') { dias = 30; granularidad = 'semana'; }
  else if (periodo === '3m') { dias = 91; granularidad = 'semana'; }
  else if (periodo === '12m') { dias = 365; granularidad = 'mes'; }
  else { dias = 30; granularidad = 'semana'; }

  const inicio = new Date(hoy);
  inicio.setDate(inicio.getDate() - (dias - 1));
  const inicioISO = formatoISO(inicio);

  const [{ data, error }, { data: prestamosRango, error: errorPrestamos }] = await Promise.all([
    supabaseAdmin.from('pagos').select('fecha_pago, monto').gte('fecha_pago', inicioISO),
    supabaseAdmin.from('prestamos').select('fecha_inicio, monto_capital, monto_total_a_pagar').gte('fecha_inicio', inicioISO),
  ]);
  if (error) throw error;
  if (errorPrestamos) throw errorPrestamos;

  const inicioDia = new Date(`${inicioISO}T00:00:00`);
  const buckets = [];
  if (granularidad === 'dia') {
    let cursor = new Date(inicio);
    while (cursor <= hoy) {
      buckets.push({
        clave: formatoISO(cursor),
        etiqueta: `${cursor.getDate()} ${MESES_ES[cursor.getMonth()]}`,
        etiquetaCompleta: `${cursor.getDate()} de ${MESES_ES[cursor.getMonth()]} de ${cursor.getFullYear()}`,
        total: 0,
        capitalPrestado: 0,
        totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  } else if (granularidad === 'semana') {
    let cursor = new Date(inicioDia);
    while (cursor <= hoy) {
      const fin = new Date(cursor);
      fin.setDate(fin.getDate() + 6);
      buckets.push({
        clave: `w${formatoISO(cursor)}`,
        etiqueta: `${cursor.getDate()} ${MESES_ES[cursor.getMonth()]}`,
        etiquetaCompleta: `Semana del ${cursor.getDate()} de ${MESES_ES[cursor.getMonth()]} al ${fin.getDate()} de ${MESES_ES[fin.getMonth()]}`,
        total: 0,
        capitalPrestado: 0,
        totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
    }
  } else {
    let cursor = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    while (cursor <= finMes) {
      buckets.push({
        clave: `${cursor.getFullYear()}-${String(cursor.getMonth()).padStart(2, '0')}`,
        etiqueta: `${MESES_ES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        etiquetaCompleta: `${MESES_ES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        total: 0,
        capitalPrestado: 0,
        totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }

  const indicePorClave = new Map(buckets.map((b, i) => [b.clave, i]));
  const diasConIngresos = new Set();

  // Índice del bucket al que cae una fecha 'YYYY-MM-DD' según la granularidad.
  function indiceDe(fechaISO) {
    if (granularidad === 'semana') {
      const f = new Date(`${fechaISO}T00:00:00`);
      const idx = Math.floor((f - inicioDia) / (7 * 86400000));
      return idx >= 0 && idx < buckets.length ? idx : undefined;
    }
    if (granularidad === 'mes') {
      const f = new Date(`${fechaISO}T00:00:00`);
      return indicePorClave.get(`${f.getFullYear()}-${String(f.getMonth()).padStart(2, '0')}`);
    }
    return indicePorClave.get(fechaISO);
  }

  data.forEach((pago) => {
    const idx = indiceDe(pago.fecha_pago);
    if (idx === undefined) return;
    buckets[idx].total += Number(pago.monto);
    diasConIngresos.add(pago.fecha_pago);
  });

  prestamosRango.forEach((prestamo) => {
    const idx = indiceDe(prestamo.fecha_inicio);
    if (idx === undefined) return;
    buckets[idx].capitalPrestado += Number(prestamo.monto_capital);
    buckets[idx].totalConGanancia += Number(prestamo.monto_total_a_pagar);
  });

  const total = buckets.reduce((acc, b) => acc + b.total, 0);
  const promedioDiario = Math.round(total / dias);

  return {
    labels: buckets.map((b) => b.etiqueta),
    tooltips: buckets.map((b) => b.etiquetaCompleta),
    valores: buckets.map((b) => b.total),
    valoresCapitalPrestado: buckets.map((b) => b.capitalPrestado),
    valoresTotalConGanancia: buckets.map((b) => b.totalConGanancia),
    estadisticas: {
      total,
      promedioDiario,
      diasConIngresos: diasConIngresos.size,
      diasTotales: dias,
    },
  };
}

// Resumen de créditos tomados activos (deuda propia pendiente).
async function obtenerResumenCreditosTomados() {
  const [{ data: creditos, error: e1 }, { data: cuotas, error: e2 }] = await Promise.all([
    supabaseAdmin.from('creditos_tomados').select('id, monto_capital, monto_total_a_pagar').eq('estado', 'activo'),
    supabaseAdmin.from('cuotas_credito_tomado').select('credito_id, monto').eq('estado', 'pagada'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const pagadoPorCredito = new Map();
  (cuotas || []).forEach((c) => {
    pagadoPorCredito.set(c.credito_id, (pagadoPorCredito.get(c.credito_id) || 0) + Number(c.monto));
  });

  let totalDeuda = 0;
  let capitalRecibido = 0;
  (creditos || []).forEach((c) => {
    const pagado = pagadoPorCredito.get(c.id) || 0;
    totalDeuda += Number(c.monto_total_a_pagar) - pagado;
    capitalRecibido += Number(c.monto_capital);
  });

  return { activos: (creditos || []).length, totalDeuda, capitalRecibido };
}

// Conteos reales y livianos usados en el header/sidebar de todas las vistas
// admin: cuotas en mora (badge de la campana) y cuotas que vencen hoy
// (widget "Resumen rápido" del sidebar).
async function obtenerConteosNotificacion() {
  const hoy = formatoISO(new Date());

  const [
    { count: moraCount, error: errorMora },
    { count: cobrosHoyCount, error: errorHoy },
    { count: clientesCount, error: errorCli },
    { count: prestamosCount, error: errorPrest },
    { data: renegData, error: errorReneg },
  ] = await Promise.all([
    supabaseAdmin.from('cuotas').select('id', { count: 'exact', head: true })
      .in('estado', ['pendiente', 'parcial', 'vencida']).lt('fecha_vencimiento', hoy),
    supabaseAdmin.from('cuotas').select('id', { count: 'exact', head: true })
      .in('estado', ['pendiente', 'parcial']).eq('fecha_vencimiento', hoy),
    supabaseAdmin.from('perfiles').select('id', { count: 'exact', head: true })
      .eq('rol', 'cliente').eq('activo', true),
    supabaseAdmin.from('prestamos').select('id', { count: 'exact', head: true })
      .eq('estado', 'activo'),
    supabaseAdmin.from('pagos').select('prestamo_id, prestamos:prestamo_id(estado)').eq('tipo', 'interes'),
  ]);
  if (errorMora) throw errorMora;
  if (errorHoy) throw errorHoy;

  // Solo se cuentan los renegociados que siguen ACTIVOS (activo o en mora);
  // los ya pagados o cancelados no suman al badge.
  const renegActivos = (renegData || []).filter(
    (r) => r.prestamos && (r.prestamos.estado === 'activo' || r.prestamos.estado === 'en_mora')
  );
  const renegCount = new Set(renegActivos.map((r) => r.prestamo_id)).size;

  return {
    moraCount: moraCount || 0,
    cobrosHoyCount: cobrosHoyCount || 0,
    clientesCount: clientesCount || 0,
    prestamosCount: prestamosCount || 0,
    renegCount,
  };
}

async function obtenerPagosRecientes(limite = 8) {
  const { data, error } = await supabaseAdmin
    .from('pagos')
    .select('*, prestamos:prestamo_id(perfiles:cliente_id(nombre_completo))')
    .order('creado_en', { ascending: false })
    .limit(limite);
  if (error) throw error;
  return data;
}

// Línea de tiempo combinada: pagos recibidos, préstamos nuevos y cuotas
// vencidas (mora), todo real, ordenado por fecha descendente.
async function obtenerActividadReciente(limite = 8) {
  const desde = formatoISO(new Date(new Date().setDate(new Date().getDate() - 30)));

  const [{ data: pagos, error: e1 }, { data: prestamos, error: e2 }, { data: mora, error: e3 }] = await Promise.all([
    supabaseAdmin
      .from('pagos')
      .select('monto, creado_en, prestamos:prestamo_id(perfiles:cliente_id(nombre_completo))')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: false })
      .limit(limite),
    supabaseAdmin
      .from('prestamos')
      .select('monto_capital, creado_en, perfiles:cliente_id(nombre_completo)')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: false })
      .limit(limite),
    supabaseAdmin
      .from('cuotas')
      .select('monto_esperado, monto_pagado, fecha_vencimiento, prestamos:prestamo_id(perfiles:cliente_id(nombre_completo))')
      .eq('estado', 'vencida')
      .gte('fecha_vencimiento', desde)
      .order('fecha_vencimiento', { ascending: false })
      .limit(limite),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;

  const eventos = [
    ...pagos.map((p) => ({
      tipo: 'pago',
      cliente: p.prestamos?.perfiles?.nombre_completo || 'Cliente',
      monto: Number(p.monto),
      fecha: new Date(p.creado_en),
    })),
    ...prestamos.map((p) => ({
      tipo: 'prestamo',
      cliente: p.perfiles?.nombre_completo || 'Cliente',
      monto: Number(p.monto_capital),
      fecha: new Date(p.creado_en),
    })),
    ...mora.map((c) => ({
      tipo: 'mora',
      cliente: c.prestamos?.perfiles?.nombre_completo || 'Cliente',
      monto: Number(c.monto_esperado) - Number(c.monto_pagado),
      fecha: new Date(`${c.fecha_vencimiento}T00:00:00`),
    })),
  ]
    .sort((a, b) => b.fecha - a.fecha)
    .slice(0, limite)
    .map((evento) => ({
      ...evento,
      hace: formatDistanceToNow(evento.fecha, { locale: es, addSuffix: true }),
    }));

  return eventos;
}

// Capital prestado agrupado por mes, con filtro opcional de rango de fechas
// (desde/hasta, formato 'YYYY-MM-DD'). Sin filtro, cubre todo el histórico.
async function obtenerCapitalPrestadoPorMes({ desde, hasta } = {}) {
  let query = supabaseAdmin.from('prestamos').select('fecha_inicio, monto_capital');
  if (desde) query = query.gte('fecha_inicio', desde);
  if (hasta) query = query.lte('fecha_inicio', hasta);

  const { data, error } = await query.order('fecha_inicio', { ascending: true });
  if (error) throw error;

  const porMes = new Map();
  data.forEach((p) => {
    const fecha = new Date(`${p.fecha_inicio}T00:00:00`);
    const clave = `${fecha.getFullYear()}-${String(fecha.getMonth()).padStart(2, '0')}`;
    if (!porMes.has(clave)) {
      porMes.set(clave, { clave, etiqueta: `${MESES_ES[fecha.getMonth()]} ${fecha.getFullYear()}`, total: 0, cantidad: 0 });
    }
    const bucket = porMes.get(clave);
    bucket.total += Number(p.monto_capital);
    bucket.cantidad += 1;
  });

  const meses = Array.from(porMes.values()).sort((a, b) => (a.clave < b.clave ? 1 : -1));
  const total = data.reduce((acc, p) => acc + Number(p.monto_capital), 0);

  return { meses, total, cantidad: data.length };
}

module.exports = {
  obtenerKpisConTendencia,
  obtenerResumenCarteraDestacado,
  obtenerResumenCreditosTomados,
  obtenerAlertasMora,
  obtenerProximosCobros,
  obtenerConteosNotificacion,
  obtenerSerieIngresos,
  obtenerPagosRecientes,
  obtenerActividadReciente,
  obtenerCapitalPrestadoPorMes,
};
