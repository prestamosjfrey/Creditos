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
    supabaseAdmin.from('prestamos').select('id, numero, monto_capital, monto_total_a_pagar, perfiles:clientes(nombre_completo)').lte('fecha_inicio', corte),
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

// KPIs de la ACTIVIDAD dentro de un rango [desde, hasta] (YYYY-MM-DD), alineados
// con la gráfica del dashboard (que también cuenta eventos del periodo):
//   • Capital prestado  = capital de préstamos creados en el periodo.
//   • Total recuperado  = pagos recibidos en el periodo (de cualquier préstamo).
//   • Interés cobrado   = parte de interés de esos pagos del periodo.
//   • Pendiente         = saldo actual de los préstamos creados en el periodo.
// El desglose por préstamo reparte cada columna para que sume su KPI.
async function calcularKpisRango({ desde, hasta }) {
  const [
    { data: prestamosRango, error: e1 },
    { data: pagosRango, error: e2 },
  ] = await Promise.all([
    // Préstamos originados en el periodo (para capital y saldo pendiente).
    supabaseAdmin.from('prestamos')
      .select('id, numero, monto_capital, monto_total_a_pagar, perfiles:clientes(nombre_completo)')
      .gte('fecha_inicio', desde).lte('fecha_inicio', hasta),
    // Pagos recibidos en el periodo, con su préstamo (para recuperado e interés).
    supabaseAdmin.from('pagos')
      .select('prestamo_id, monto, prestamos:prestamo_id(numero, monto_capital, monto_total_a_pagar, perfiles:clientes(nombre_completo))')
      .gte('fecha_pago', desde).lte('fecha_pago', hasta),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  // Para el saldo de los préstamos del periodo se necesitan TODOS sus abonos
  // (no solo los del periodo).
  const idsRango = (prestamosRango || []).map((p) => p.id);
  const pagadoTotal = new Map();
  if (idsRango.length) {
    const { data, error: e3 } = await supabaseAdmin
      .from('pagos').select('prestamo_id, monto').in('prestamo_id', idsRango);
    if (e3) throw e3;
    (data || []).forEach((p) => {
      pagadoTotal.set(p.prestamo_id, (pagadoTotal.get(p.prestamo_id) || 0) + Number(p.monto));
    });
  }

  // Una fila por préstamo participante; cada columna suma su KPI respectivo.
  const filas = new Map();
  const fila = (id, numero, cliente) => {
    if (!filas.has(id)) filas.set(id, { numero, cliente, capital: 0, pagado: 0, interesCobrado: 0, saldo: 0 });
    return filas.get(id);
  };

  (prestamosRango || []).forEach((p) => {
    const f = fila(p.id, p.numero, p.perfiles?.nombre_completo || 'Cliente');
    f.capital += Number(p.monto_capital);
    const saldo = Number(p.monto_total_a_pagar) - (pagadoTotal.get(p.id) || 0);
    if (saldo > 0.01) f.saldo += saldo;
  });

  (pagosRango || []).forEach((pg) => {
    const pr = pg.prestamos || {};
    const f = fila(pg.prestamo_id, pr.numero, pr.perfiles?.nombre_completo || 'Cliente');
    const monto = Number(pg.monto);
    const total = Number(pr.monto_total_a_pagar) || 0;
    const capital = Number(pr.monto_capital) || 0;
    const ratioInteres = total > 0 ? (total - capital) / total : 0;
    f.pagado += monto;
    f.interesCobrado += Math.round(monto * ratioInteres);
  });

  const desglose = [...filas.values()].sort((a, b) => (a.numero || 0) - (b.numero || 0));
  return {
    capitalPrestado: desglose.reduce((s, f) => s + f.capital, 0),
    totalRecuperado: desglose.reduce((s, f) => s + f.pagado, 0),
    interesesCobrados: desglose.reduce((s, f) => s + f.interesCobrado, 0),
    carteraActiva: desglose.reduce((s, f) => s + f.saldo, 0),
    desglose,
  };
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
    .select('*, prestamos:prestamo_id(cliente_id, perfiles:clientes(nombre_completo, telefono))')
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
    .select('*, prestamos:prestamo_id(cliente_id, perfiles:clientes(nombre_completo, telefono))')
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
    supabaseAdmin.from('clientes').select('id', { count: 'exact', head: true })
      .eq('activo', true),
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
    .select('*, prestamos:prestamo_id(perfiles:clientes(nombre_completo))')
    .order('creado_en', { ascending: false })
    .limit(limite);
  if (error) throw error;
  return data;
}

// Línea de tiempo combinada: pagos recibidos, préstamos nuevos y cuotas
// vencidas (mora), todo real, ordenado por fecha descendente.
async function obtenerActividadReciente(limite = 8) {
  const desde = formatoISO(new Date(new Date().setDate(new Date().getDate() - 30)));

  const [
    { data: pagos, error: e1 },
    { data: prestamos, error: e2 },
    { data: mora, error: e3 },
    { data: pagosTomados, error: e4 },
    { data: creditosTomados, error: e5 },
  ] = await Promise.all([
    supabaseAdmin
      .from('pagos')
      .select('monto, creado_en, prestamos:prestamo_id(perfiles:clientes(nombre_completo))')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: false })
      .limit(limite),
    supabaseAdmin
      .from('prestamos')
      .select('monto_capital, creado_en, perfiles:clientes(nombre_completo)')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: false })
      .limit(limite),
    supabaseAdmin
      .from('cuotas')
      .select('monto_esperado, monto_pagado, fecha_vencimiento, prestamos:prestamo_id(perfiles:clientes(nombre_completo))')
      .eq('estado', 'vencida')
      .gte('fecha_vencimiento', desde)
      .order('fecha_vencimiento', { ascending: false })
      .limit(limite),
    // Pagos de cuotas de créditos que NOSOTROS tomamos (nuestros pasivos).
    supabaseAdmin
      .from('cuotas_credito_tomado')
      .select('monto, pagado_en, creditos_tomados:credito_id(acreedor)')
      .eq('estado', 'pagada')
      .gte('pagado_en', desde)
      .order('pagado_en', { ascending: false })
      .limit(limite),
    // Créditos que NOSOTROS tomamos (creación del pasivo → capital que entró a caja).
    supabaseAdmin
      .from('creditos_tomados')
      .select('monto_capital, creado_en, acreedor')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: false })
      .limit(limite),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (e4) throw e4;
  if (e5) throw e5;

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
    ...(pagosTomados || []).map((c) => ({
      tipo: 'pago_tomado',
      cliente: c.creditos_tomados?.acreedor || 'Acreedor',
      monto: Number(c.monto),
      fecha: new Date(c.pagado_en),
    })),
    ...(creditosTomados || []).map((c) => ({
      tipo: 'credito_tomado',
      cliente: c.acreedor || 'Acreedor',
      monto: Number(c.monto_capital),
      fecha: new Date(c.creado_en),
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

// Serie de ingresos sobre un rango explícito [desde, hasta] (YYYY-MM-DD),
// usada por el filtro del dashboard (Hoy/Esta semana/Este mes/Este año/rango).
// La granularidad se elige según el largo del rango: diaria hasta 31 días,
// semanal hasta ~3 meses, mensual en rangos más largos.
async function obtenerSerieIngresosRango({ desde, hasta }) {
  const inicio = new Date(`${desde}T00:00:00`);
  const fin = new Date(`${hasta}T00:00:00`);
  const dias = Math.max(1, Math.round((fin - inicio) / 86400000) + 1);

  let granularidad = 'dia';
  if (dias > 92) granularidad = 'mes';
  else if (dias > 31) granularidad = 'semana';

  const [{ data, error }, { data: prestamosRango, error: errorPrestamos }] = await Promise.all([
    supabaseAdmin.from('pagos').select('fecha_pago, monto').gte('fecha_pago', desde).lte('fecha_pago', hasta),
    supabaseAdmin.from('prestamos').select('fecha_inicio, monto_capital, monto_total_a_pagar').gte('fecha_inicio', desde).lte('fecha_inicio', hasta),
  ]);
  if (error) throw error;
  if (errorPrestamos) throw errorPrestamos;

  const inicioDia = new Date(`${desde}T00:00:00`);
  const buckets = [];
  if (granularidad === 'dia') {
    let cursor = new Date(inicio);
    while (cursor <= fin) {
      buckets.push({
        clave: formatoISO(cursor),
        etiqueta: `${cursor.getDate()} ${MESES_ES[cursor.getMonth()]}`,
        etiquetaCompleta: `${cursor.getDate()} de ${MESES_ES[cursor.getMonth()]} de ${cursor.getFullYear()}`,
        total: 0, capitalPrestado: 0, totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  } else if (granularidad === 'semana') {
    let cursor = new Date(inicioDia);
    while (cursor <= fin) {
      const finSem = new Date(cursor); finSem.setDate(finSem.getDate() + 6);
      buckets.push({
        clave: `w${formatoISO(cursor)}`,
        etiqueta: `${cursor.getDate()} ${MESES_ES[cursor.getMonth()]}`,
        etiquetaCompleta: `Semana del ${cursor.getDate()} de ${MESES_ES[cursor.getMonth()]} al ${finSem.getDate()} de ${MESES_ES[finSem.getMonth()]}`,
        total: 0, capitalPrestado: 0, totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
    }
  } else {
    let cursor = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
    const finMes = new Date(fin.getFullYear(), fin.getMonth(), 1);
    while (cursor <= finMes) {
      buckets.push({
        clave: `${cursor.getFullYear()}-${String(cursor.getMonth()).padStart(2, '0')}`,
        etiqueta: `${MESES_ES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        etiquetaCompleta: `${MESES_ES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        total: 0, capitalPrestado: 0, totalConGanancia: 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }

  const indicePorClave = new Map(buckets.map((b, i) => [b.clave, i]));
  const diasConIngresos = new Set();
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
  prestamosRango.forEach((p) => {
    const idx = indiceDe(p.fecha_inicio);
    if (idx === undefined) return;
    buckets[idx].capitalPrestado += Number(p.monto_capital);
    buckets[idx].totalConGanancia += Number(p.monto_total_a_pagar);
  });

  const total = buckets.reduce((a, b) => a + b.total, 0);
  return {
    labels: buckets.map((b) => b.etiqueta),
    tooltips: buckets.map((b) => b.etiquetaCompleta),
    valores: buckets.map((b) => b.total),
    valoresCapitalPrestado: buckets.map((b) => b.capitalPrestado),
    valoresTotalConGanancia: buckets.map((b) => b.totalConGanancia),
    estadisticas: {
      total,
      promedioDiario: Math.round(total / dias),
      diasConIngresos: diasConIngresos.size,
      diasTotales: dias,
    },
  };
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
  calcularKpisRango,
  obtenerResumenCarteraDestacado,
  obtenerResumenCreditosTomados,
  obtenerAlertasMora,
  obtenerProximosCobros,
  obtenerConteosNotificacion,
  obtenerSerieIngresos,
  obtenerSerieIngresosRango,
  obtenerPagosRecientes,
  obtenerActividadReciente,
  obtenerCapitalPrestadoPorMes,
};
