const { supabaseAdmin } = require('../config/supabase');
const { rangoAnterior } = require('../utils/rangos');
const { formatoISO } = require('../utils/fechas');

// Catálogo de reportes.
//
// Cada reporte es una función async(rango) que devuelve SIEMPRE la misma forma:
//
//   { kpis: [...], columnas: [...], filas: [...], grafica: {...} | null, nota }
//
// Gracias a eso hay una sola vista (views/admin/reportes/ver.ejs) y un solo
// exportador a CSV para todos: añadir un reporte nuevo es escribir una función
// aquí y una entrada en CATALOGO, sin tocar vistas ni rutas.
//
// Todas las consultas van acotadas por fecha, así que el volumen que viaja a
// Node está limitado por el rango que elige el usuario (no se descargan tablas
// enteras como pasaba en otras pantallas).

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
const FRECUENCIAS = { diario: 'Diario', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };

// Aplica el filtro de fechas solo si el extremo existe ('todo' no filtra).
function acotar(query, campo, { desde, hasta }) {
  if (desde) query = query.gte(campo, desde);
  if (hasta) query = query.lte(campo, hasta);
  return query;
}

// Cada reporte muestra SOLO los datos del usuario. `col` es la columna de dueño
// del recurso (creado_por, registrado_por…). Para recursos que cuelgan de un
// préstamo (pagos, cuotas) se filtra por el dueño del préstamo con !inner en la
// propia consulta, no aquí.
function delUsuario(query, col, usuarioId) {
  return query.eq(col, usuarioId);
}

function variacion(actual, anterior) {
  if (!anterior) return null; // sin base de comparación
  return Math.round(((actual - anterior) / anterior) * 1000) / 10;
}

// Agrupa importes por mes a partir de una lista de { fecha, valor }.
function serieMensual(filas) {
  const porMes = new Map();
  filas.forEach(({ fecha, valor }) => {
    const f = new Date(`${fecha}T00:00:00`);
    const clave = `${f.getFullYear()}-${String(f.getMonth()).padStart(2, '0')}`;
    if (!porMes.has(clave)) porMes.set(clave, { clave, etiqueta: `${MESES[f.getMonth()]} ${f.getFullYear()}`, total: 0, cantidad: 0 });
    const b = porMes.get(clave);
    b.total += valor;
    b.cantidad += 1;
  });
  return [...porMes.values()].sort((a, b) => (a.clave < b.clave ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 1. CAPITAL PRESTADO — el dinero que salió a la calle en el periodo.
//    (En el sector se le dice "colocación"; aquí se evita esa jerga porque no
//    se entiende de un vistazo.)
// ---------------------------------------------------------------------------
async function capitalPrestado(rango, usuarioId) {
  let q = supabaseAdmin
    .from('prestamos')
    .select('numero, fecha_inicio, monto_capital, monto_total_a_pagar, numero_cuotas, frecuencia_pago, estado, perfiles:clientes(nombre_completo, numero_documento)');
  q = delUsuario(q, 'creado_por', usuarioId);
  const { data, error } = await acotar(q, 'fecha_inicio', rango).order('fecha_inicio', { ascending: false });
  if (error) throw error;

  const prestamos = data || [];
  const capital = prestamos.reduce((a, p) => a + Number(p.monto_capital), 0);
  const aCobrar = prestamos.reduce((a, p) => a + Number(p.monto_total_a_pagar), 0);
  const interes = aCobrar - capital;

  // Comparación con el periodo anterior del mismo largo.
  let cambio = null;
  const prev = rangoAnterior(rango);
  if (prev) {
    const { data: dPrev } = await acotar(
      delUsuario(supabaseAdmin.from('prestamos').select('monto_capital'), 'creado_por', usuarioId), 'fecha_inicio', prev
    );
    cambio = variacion(capital, (dPrev || []).reduce((a, p) => a + Number(p.monto_capital), 0));
  }

  const serie = serieMensual(prestamos.map((p) => ({ fecha: p.fecha_inicio, valor: Number(p.monto_capital) })));

  return {
    kpis: [
      { etiqueta: 'Capital prestado', valor: capital, tipo: 'moneda', cambio },
      { etiqueta: 'Préstamos entregados', valor: prestamos.length, tipo: 'numero' },
      { etiqueta: 'Préstamo promedio', valor: prestamos.length ? Math.round(capital / prestamos.length) : 0, tipo: 'moneda' },
      { etiqueta: 'Interés a ganar', valor: interes, tipo: 'moneda', nota: capital ? `${Math.round((interes / capital) * 100)}% sobre el capital` : null },
    ],
    grafica: {
      etiqueta: 'Capital prestado por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.total),
    },
    columnas: [
      { clave: 'numero', titulo: 'N°' },
      { clave: 'fecha', titulo: 'Fecha' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'documento', titulo: 'Documento' },
      { clave: 'capital', titulo: 'Capital', tipo: 'moneda' },
      { clave: 'total', titulo: 'Total a pagar', tipo: 'moneda' },
      { clave: 'interes', titulo: 'Interés', tipo: 'moneda' },
      { clave: 'cuotas', titulo: 'Cuotas' },
      { clave: 'frecuencia', titulo: 'Frecuencia' },
      { clave: 'estado', titulo: 'Estado' },
    ],
    filas: prestamos.map((p) => ({
      numero: p.numero != null ? `#PR-${String(p.numero).padStart(5, '0')}` : '—',
      fecha: p.fecha_inicio,
      cliente: p.perfiles?.nombre_completo || 'Cliente',
      documento: p.perfiles?.numero_documento || '—',
      capital: Number(p.monto_capital),
      total: Number(p.monto_total_a_pagar),
      interes: Number(p.monto_total_a_pagar) - Number(p.monto_capital),
      cuotas: p.numero_cuotas,
      frecuencia: FRECUENCIAS[p.frecuencia_pago] || p.frecuencia_pago,
      estado: p.estado,
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. RECAUDO — el dinero que entró en el periodo
// ---------------------------------------------------------------------------
async function recaudo(rango, usuarioId) {
  let q = supabaseAdmin
    .from('pagos')
    .select('monto, fecha_pago, metodo, tipo, prestamos:prestamo_id!inner(numero, creado_por, perfiles:clientes(nombre_completo, numero_documento))')
    .eq('prestamos.creado_por', usuarioId);
  const { data, error } = await acotar(q, 'fecha_pago', rango).order('fecha_pago', { ascending: false });
  if (error) throw error;

  const pagos = data || [];
  const total = pagos.reduce((a, p) => a + Number(p.monto), 0);

  let cambio = null;
  const prev = rangoAnterior(rango);
  if (prev) {
    const { data: dPrev } = await acotar(
      supabaseAdmin.from('pagos').select('monto, prestamos:prestamo_id!inner(creado_por)').eq('prestamos.creado_por', usuarioId),
      'fecha_pago', prev);
    cambio = variacion(total, (dPrev || []).reduce((a, p) => a + Number(p.monto), 0));
  }

  // Reparto por método de pago: útil para cuadrar el efectivo real en mano.
  const porMetodo = new Map();
  pagos.forEach((p) => {
    const k = METODOS[p.metodo] || 'Sin especificar';
    porMetodo.set(k, (porMetodo.get(k) || 0) + Number(p.monto));
  });

  const soloInteres = pagos.filter((p) => p.tipo === 'interes').reduce((a, p) => a + Number(p.monto), 0);
  const serie = serieMensual(pagos.map((p) => ({ fecha: p.fecha_pago, valor: Number(p.monto) })));
  const dias = new Set(pagos.map((p) => p.fecha_pago)).size;

  return {
    kpis: [
      { etiqueta: 'Total recaudado', valor: total, tipo: 'moneda', cambio },
      { etiqueta: 'Número de pagos', valor: pagos.length, tipo: 'numero' },
      { etiqueta: 'Pago promedio', valor: pagos.length ? Math.round(total / pagos.length) : 0, tipo: 'moneda' },
      { etiqueta: 'Días con recaudo', valor: dias, tipo: 'numero', nota: soloInteres ? `Incluye ${soloInteres.toLocaleString('es-CO')} de solo interés` : null },
    ],
    grafica: {
      etiqueta: 'Recaudo por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.total),
    },
    resumenLateral: {
      titulo: 'Por método de pago',
      filas: [...porMetodo.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ etiqueta: k, valor: v, pct: total ? Math.round((v / total) * 100) : 0 })),
    },
    columnas: [
      { clave: 'fecha', titulo: 'Fecha' },
      { clave: 'prestamo', titulo: 'Préstamo' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'documento', titulo: 'Documento' },
      { clave: 'metodo', titulo: 'Método' },
      { clave: 'tipo', titulo: 'Tipo' },
      { clave: 'monto', titulo: 'Monto', tipo: 'moneda' },
    ],
    filas: pagos.map((p) => ({
      fecha: p.fecha_pago,
      prestamo: p.prestamos?.numero != null ? `#PR-${String(p.prestamos.numero).padStart(5, '0')}` : '—',
      cliente: p.prestamos?.perfiles?.nombre_completo || 'Cliente',
      documento: p.prestamos?.perfiles?.numero_documento || '—',
      metodo: METODOS[p.metodo] || '—',
      tipo: p.tipo === 'interes' ? 'Solo interés' : 'Abono',
      monto: Number(p.monto),
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. MORA — antigüedad de la deuda vencida (aging)
//
// Este reporte NO se filtra por el rango: la mora es una foto de HOY. El rango
// se ignora a propósito y la vista lo advierte.
// ---------------------------------------------------------------------------
async function mora(rango, usuarioId) {
  const hoy = formatoISO(new Date());
  const { data, error } = await supabaseAdmin
    .from('cuotas')
    .select('numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, prestamos:prestamo_id!inner(numero, cliente_id, creado_por, perfiles:clientes(nombre_completo, numero_documento, telefono))')
    .eq('prestamos.creado_por', usuarioId)
    .in('estado', ['pendiente', 'parcial', 'vencida'])
    .lt('fecha_vencimiento', hoy)
    .order('fecha_vencimiento', { ascending: true });
  if (error) throw error;

  const cuotas = data || [];
  const hoyD = new Date(`${hoy}T00:00:00`);

  // Tramos de antigüedad: cuanto más viejo, menos probable es recuperarlo.
  const TRAMOS = [
    { etiqueta: '1 a 30 días', min: 1, max: 30, total: 0, cuotas: 0 },
    { etiqueta: '31 a 60 días', min: 31, max: 60, total: 0, cuotas: 0 },
    { etiqueta: '61 a 90 días', min: 61, max: 90, total: 0, cuotas: 0 },
    { etiqueta: 'Más de 90 días', min: 91, max: Infinity, total: 0, cuotas: 0 },
  ];

  const filas = [];
  const clientes = new Set();
  let totalMora = 0;

  cuotas.forEach((c) => {
    const saldo = Number(c.monto_esperado) - Number(c.monto_pagado);
    if (saldo <= 0) return;
    const dias = Math.round((hoyD - new Date(`${c.fecha_vencimiento}T00:00:00`)) / 86400000);
    const tramo = TRAMOS.find((t) => dias >= t.min && dias <= t.max);
    if (tramo) { tramo.total += saldo; tramo.cuotas += 1; }
    totalMora += saldo;
    if (c.prestamos?.cliente_id) clientes.add(c.prestamos.cliente_id);

    filas.push({
      prestamo: c.prestamos?.numero != null ? `#PR-${String(c.prestamos.numero).padStart(5, '0')}` : '—',
      cliente: c.prestamos?.perfiles?.nombre_completo || 'Cliente',
      documento: c.prestamos?.perfiles?.numero_documento || '—',
      telefono: c.prestamos?.perfiles?.telefono || '—',
      cuota: c.numero_cuota,
      vencimiento: c.fecha_vencimiento,
      dias,
      saldo,
      tramo: tramo ? tramo.etiqueta : '—',
    });
  });

  filas.sort((a, b) => b.dias - a.dias);
  const masVieja = filas.length ? filas[0].dias : 0;

  return {
    nota: 'La mora es una foto de hoy: este reporte no depende del rango de fechas.',
    kpis: [
      { etiqueta: 'Saldo en mora', valor: totalMora, tipo: 'moneda' },
      { etiqueta: 'Cuotas vencidas', valor: filas.length, tipo: 'numero' },
      { etiqueta: 'Clientes en mora', valor: clientes.size, tipo: 'numero' },
      { etiqueta: 'Mora más antigua', valor: masVieja, tipo: 'numero', nota: masVieja ? 'días de atraso' : null },
    ],
    grafica: {
      etiqueta: 'Saldo vencido por antigüedad',
      labels: TRAMOS.map((t) => t.etiqueta),
      datos: TRAMOS.map((t) => t.total),
    },
    resumenLateral: {
      titulo: 'Antigüedad de la mora',
      filas: TRAMOS.map((t) => ({
        etiqueta: `${t.etiqueta} (${t.cuotas})`,
        valor: t.total,
        pct: totalMora ? Math.round((t.total / totalMora) * 100) : 0,
      })),
    },
    columnas: [
      { clave: 'prestamo', titulo: 'Préstamo' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'documento', titulo: 'Documento' },
      { clave: 'telefono', titulo: 'Teléfono' },
      { clave: 'cuota', titulo: 'Cuota' },
      { clave: 'vencimiento', titulo: 'Venció' },
      { clave: 'dias', titulo: 'Días' },
      { clave: 'tramo', titulo: 'Antigüedad' },
      { clave: 'saldo', titulo: 'Saldo', tipo: 'moneda' },
    ],
    filas,
  };
}

// ---------------------------------------------------------------------------
// 4. RENTABILIDAD — cuánto interés se ganó de verdad en el periodo
// ---------------------------------------------------------------------------
async function rentabilidad(rango, usuarioId) {
  let q = supabaseAdmin
    .from('pagos')
    .select('monto, fecha_pago, prestamos:prestamo_id!inner(numero, creado_por, monto_capital, monto_total_a_pagar, perfiles:clientes(nombre_completo))')
    .eq('prestamos.creado_por', usuarioId);
  const { data, error } = await acotar(q, 'fecha_pago', rango).order('fecha_pago', { ascending: false });
  if (error) throw error;

  const pagos = data || [];

  // Cada abono se reparte entre capital e interés en la misma proporción que
  // tiene el préstamo. Es una aproximación (no hay tabla de amortización real),
  // pero es consistente con el resto de la app y suma siempre el total cobrado.
  const porPrestamo = new Map();
  let recaudado = 0, interesGanado = 0, capitalRecuperado = 0;

  pagos.forEach((pg) => {
    const pr = pg.prestamos || {};
    const total = Number(pr.monto_total_a_pagar) || 0;
    const capital = Number(pr.monto_capital) || 0;
    const ratio = total > 0 ? (total - capital) / total : 0;
    const monto = Number(pg.monto);
    const interes = Math.round(monto * ratio);

    recaudado += monto;
    interesGanado += interes;
    capitalRecuperado += monto - interes;

    const k = pr.numero ?? 'sin';
    if (!porPrestamo.has(k)) {
      porPrestamo.set(k, {
        prestamo: pr.numero != null ? `#PR-${String(pr.numero).padStart(5, '0')}` : '—',
        cliente: pr.perfiles?.nombre_completo || 'Cliente',
        cobrado: 0, capital: 0, interes: 0,
      });
    }
    const f = porPrestamo.get(k);
    f.cobrado += monto;
    f.interes += interes;
    f.capital += monto - interes;
  });

  const filas = [...porPrestamo.values()].sort((a, b) => b.interes - a.interes);
  const margen = recaudado ? Math.round((interesGanado / recaudado) * 1000) / 10 : 0;

  const serie = serieMensual(pagos.map((p) => {
    const pr = p.prestamos || {};
    const total = Number(pr.monto_total_a_pagar) || 0;
    const ratio = total > 0 ? (total - Number(pr.monto_capital || 0)) / total : 0;
    return { fecha: p.fecha_pago, valor: Math.round(Number(p.monto) * ratio) };
  }));

  return {
    nota: 'El interés de cada abono se estima con la proporción interés/total del préstamo.',
    kpis: [
      { etiqueta: 'Interés ganado', valor: interesGanado, tipo: 'moneda' },
      { etiqueta: 'Capital recuperado', valor: capitalRecuperado, tipo: 'moneda' },
      { etiqueta: 'Total recaudado', valor: recaudado, tipo: 'moneda' },
      { etiqueta: 'Margen', valor: margen, tipo: 'pct', nota: 'del recaudo es ganancia' },
    ],
    grafica: {
      etiqueta: 'Interés ganado por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.total),
    },
    columnas: [
      { clave: 'prestamo', titulo: 'Préstamo' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'cobrado', titulo: 'Cobrado', tipo: 'moneda' },
      { clave: 'capital', titulo: 'Capital', tipo: 'moneda' },
      { clave: 'interes', titulo: 'Interés (ganancia)', tipo: 'moneda' },
    ],
    filas,
  };
}

// ---------------------------------------------------------------------------
// 5. FLUJO DE CAJA — entradas y salidas reales del periodo
// ---------------------------------------------------------------------------
async function flujoCaja(rango, usuarioId) {
  // movimientos_caja marca la fecha en creado_en (timestamptz), no en una
  // columna date: el extremo 'hasta' se extiende al final del día.
  // Cada usuario ve solo SU caja (registrado_por).
  let q = supabaseAdmin.from('movimientos_caja').select('tipo, monto, concepto, origen, creado_en')
    .eq('registrado_por', usuarioId);
  if (rango.desde) q = q.gte('creado_en', `${rango.desde}T00:00:00`);
  if (rango.hasta) q = q.lte('creado_en', `${rango.hasta}T23:59:59.999`);
  const { data, error } = await q.order('creado_en', { ascending: false });
  if (error) throw error;

  const movs = data || [];
  const ingresos = movs.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + Number(m.monto), 0);
  const egresos = movs.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + Number(m.monto), 0);

  const ORIGENES = { prestamo: 'Préstamo otorgado', pago: 'Abono recibido', manual: 'Movimiento manual' };
  const porOrigen = new Map();
  movs.forEach((m) => {
    const k = ORIGENES[m.origen] || m.origen;
    const cur = porOrigen.get(k) || 0;
    porOrigen.set(k, cur + (m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto)));
  });

  const serie = serieMensual(movs.map((m) => ({
    fecha: m.creado_en.slice(0, 10),
    valor: m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto),
  })));

  return {
    kpis: [
      { etiqueta: 'Entradas', valor: ingresos, tipo: 'moneda' },
      { etiqueta: 'Salidas', valor: egresos, tipo: 'moneda' },
      { etiqueta: 'Flujo neto', valor: ingresos - egresos, tipo: 'moneda', nota: ingresos - egresos >= 0 ? 'Entró más de lo que salió' : 'Salió más de lo que entró' },
      { etiqueta: 'Movimientos', valor: movs.length, tipo: 'numero' },
    ],
    grafica: {
      etiqueta: 'Flujo neto por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.total),
    },
    resumenLateral: {
      titulo: 'Flujo neto por origen',
      filas: [...porOrigen.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k, v]) => ({ etiqueta: k, valor: v, pct: null })),
    },
    columnas: [
      { clave: 'fecha', titulo: 'Fecha' },
      { clave: 'tipo', titulo: 'Tipo' },
      { clave: 'origen', titulo: 'Origen' },
      { clave: 'concepto', titulo: 'Concepto' },
      { clave: 'monto', titulo: 'Monto', tipo: 'moneda' },
    ],
    filas: movs.map((m) => ({
      fecha: m.creado_en.slice(0, 10),
      tipo: m.tipo === 'ingreso' ? 'Entrada' : 'Salida',
      origen: ORIGENES[m.origen] || m.origen,
      concepto: m.concepto,
      monto: m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto),
    })),
  };
}

// ---------------------------------------------------------------------------
// 6. PROYECCIÓN DE COBROS — lo que se espera cobrar en el rango
// ---------------------------------------------------------------------------
async function proyeccion(rango, usuarioId) {
  let q = supabaseAdmin
    .from('cuotas')
    .select('numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado, prestamos:prestamo_id!inner(numero, creado_por, perfiles:clientes(nombre_completo, telefono))')
    .eq('prestamos.creado_por', usuarioId)
    .in('estado', ['pendiente', 'parcial']);
  const { data, error } = await acotar(q, 'fecha_vencimiento', rango).order('fecha_vencimiento', { ascending: true });
  if (error) throw error;

  const cuotas = (data || []).filter((c) => Number(c.monto_esperado) - Number(c.monto_pagado) > 0);
  const total = cuotas.reduce((a, c) => a + (Number(c.monto_esperado) - Number(c.monto_pagado)), 0);
  const serie = serieMensual(cuotas.map((c) => ({ fecha: c.fecha_vencimiento, valor: Number(c.monto_esperado) - Number(c.monto_pagado) })));

  return {
    nota: 'Solo cuotas pendientes o parciales que vencen dentro del rango. No incluye la mora ya vencida.',
    kpis: [
      { etiqueta: 'Por cobrar', valor: total, tipo: 'moneda' },
      { etiqueta: 'Cuotas', valor: cuotas.length, tipo: 'numero' },
      { etiqueta: 'Cuota promedio', valor: cuotas.length ? Math.round(total / cuotas.length) : 0, tipo: 'moneda' },
      { etiqueta: 'Clientes', valor: new Set(cuotas.map((c) => c.prestamos?.perfiles?.nombre_completo)).size, tipo: 'numero' },
    ],
    grafica: {
      etiqueta: 'Cobros esperados por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.total),
    },
    columnas: [
      { clave: 'vencimiento', titulo: 'Vence' },
      { clave: 'prestamo', titulo: 'Préstamo' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'telefono', titulo: 'Teléfono' },
      { clave: 'cuota', titulo: 'Cuota' },
      { clave: 'estado', titulo: 'Estado' },
      { clave: 'saldo', titulo: 'Por cobrar', tipo: 'moneda' },
    ],
    filas: cuotas.map((c) => ({
      vencimiento: c.fecha_vencimiento,
      prestamo: c.prestamos?.numero != null ? `#PR-${String(c.prestamos.numero).padStart(5, '0')}` : '—',
      cliente: c.prestamos?.perfiles?.nombre_completo || 'Cliente',
      telefono: c.prestamos?.perfiles?.telefono || '—',
      cuota: c.numero_cuota,
      estado: c.estado === 'parcial' ? 'Parcial' : 'Pendiente',
      saldo: Number(c.monto_esperado) - Number(c.monto_pagado),
    })),
  };
}

// ---------------------------------------------------------------------------
// 7. CLIENTES — altas del periodo y comportamiento de pago
// ---------------------------------------------------------------------------
async function clientes(rango, usuarioId) {
  // Los clientes son compartidos, así que el reporte lista TODOS los clientes
  // dados de alta en el periodo. Pero el capital que se les colocó cuenta solo
  // los préstamos de ESTE usuario (cada quien ve lo que él prestó).
  let q = supabaseAdmin.from('clientes').select('id, nombre_completo, numero_documento, telefono, activo, score_credito, creado_en');
  if (rango.desde) q = q.gte('creado_en', `${rango.desde}T00:00:00`);
  if (rango.hasta) q = q.lte('creado_en', `${rango.hasta}T23:59:59.999`);
  const { data, error } = await q.order('creado_en', { ascending: false });
  if (error) throw error;

  const nuevos = data || [];

  // Préstamos DE ESTE USUARIO a esos clientes.
  const ids = nuevos.map((c) => c.id);
  const porCliente = new Map();
  if (ids.length) {
    const { data: prest } = await supabaseAdmin
      .from('prestamos').select('cliente_id, monto_capital').eq('creado_por', usuarioId).in('cliente_id', ids);
    (prest || []).forEach((p) => {
      const cur = porCliente.get(p.cliente_id) || { n: 0, capital: 0 };
      cur.n += 1; cur.capital += Number(p.monto_capital);
      porCliente.set(p.cliente_id, cur);
    });
  }

  const conScore = nuevos.filter((c) => c.score_credito != null);
  const scorePromedio = conScore.length
    ? Math.round(conScore.reduce((a, c) => a + c.score_credito, 0) / conScore.length)
    : 0;

  const serie = serieMensual(nuevos.map((c) => ({ fecha: c.creado_en.slice(0, 10), valor: 1 })));

  return {
    kpis: [
      { etiqueta: 'Clientes nuevos', valor: nuevos.length, tipo: 'numero' },
      { etiqueta: 'Activos', valor: nuevos.filter((c) => c.activo).length, tipo: 'numero' },
      { etiqueta: 'Con préstamo', valor: [...porCliente.keys()].length, tipo: 'numero' },
      { etiqueta: 'Score promedio', valor: scorePromedio, tipo: 'numero', nota: conScore.length ? `de ${conScore.length} con historial` : 'sin historial aún' },
    ],
    grafica: {
      etiqueta: 'Clientes nuevos por mes',
      labels: serie.map((s) => s.etiqueta),
      datos: serie.map((s) => s.cantidad),
    },
    columnas: [
      { clave: 'alta', titulo: 'Alta' },
      { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'documento', titulo: 'Documento' },
      { clave: 'telefono', titulo: 'Teléfono' },
      { clave: 'prestamos', titulo: 'Préstamos' },
      { clave: 'capital', titulo: 'Capital recibido', tipo: 'moneda' },
      { clave: 'score', titulo: 'Score' },
      { clave: 'estado', titulo: 'Estado' },
    ],
    filas: nuevos.map((c) => {
      const d = porCliente.get(c.id) || { n: 0, capital: 0 };
      return {
        alta: c.creado_en.slice(0, 10),
        cliente: c.nombre_completo,
        documento: c.numero_documento || '—',
        telefono: c.telefono || '—',
        prestamos: d.n,
        capital: d.capital,
        score: c.score_credito != null ? c.score_credito : '—',
        estado: c.activo ? 'Activo' : 'Inactivo',
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 8. CRÉDITOS TOMADOS — la deuda propia (pasivos)
// ---------------------------------------------------------------------------
async function creditosTomados(rango, usuarioId) {
  let q = supabaseAdmin
    .from('creditos_tomados')
    .select('id, acreedor, fecha_inicio, monto_capital, monto_total_a_pagar, numero_cuotas, frecuencia_pago, estado')
    .eq('creado_por', usuarioId);
  const { data, error } = await acotar(q, 'fecha_inicio', rango).order('fecha_inicio', { ascending: false });
  if (error) throw error;

  const creditos = data || [];
  const ids = creditos.map((c) => c.id);

  const pagadoPorCredito = new Map();
  if (ids.length) {
    const { data: cuotas } = await supabaseAdmin
      .from('cuotas_credito_tomado').select('credito_id, monto').eq('estado', 'pagada').in('credito_id', ids);
    (cuotas || []).forEach((c) => {
      pagadoPorCredito.set(c.credito_id, (pagadoPorCredito.get(c.credito_id) || 0) + Number(c.monto));
    });
  }

  const capital = creditos.reduce((a, c) => a + Number(c.monto_capital), 0);
  const aPagar = creditos.reduce((a, c) => a + Number(c.monto_total_a_pagar), 0);
  const pagado = [...pagadoPorCredito.values()].reduce((a, v) => a + v, 0);

  return {
    nota: 'Créditos que TÚ tomaste: es deuda propia, no cartera.',
    kpis: [
      { etiqueta: 'Capital recibido', valor: capital, tipo: 'moneda' },
      { etiqueta: 'Total a pagar', valor: aPagar, tipo: 'moneda', nota: capital ? `Costo: ${(aPagar - capital).toLocaleString('es-CO')}` : null },
      { etiqueta: 'Ya pagado', valor: pagado, tipo: 'moneda' },
      { etiqueta: 'Saldo por pagar', valor: aPagar - pagado, tipo: 'moneda' },
    ],
    grafica: null,
    columnas: [
      { clave: 'fecha', titulo: 'Fecha' },
      { clave: 'acreedor', titulo: 'Acreedor' },
      { clave: 'capital', titulo: 'Capital', tipo: 'moneda' },
      { clave: 'total', titulo: 'Total a pagar', tipo: 'moneda' },
      { clave: 'costo', titulo: 'Costo', tipo: 'moneda' },
      { clave: 'pagado', titulo: 'Pagado', tipo: 'moneda' },
      { clave: 'saldo', titulo: 'Saldo', tipo: 'moneda' },
      { clave: 'estado', titulo: 'Estado' },
    ],
    filas: creditos.map((c) => {
      const p = pagadoPorCredito.get(c.id) || 0;
      return {
        fecha: c.fecha_inicio,
        acreedor: c.acreedor,
        capital: Number(c.monto_capital),
        total: Number(c.monto_total_a_pagar),
        costo: Number(c.monto_total_a_pagar) - Number(c.monto_capital),
        pagado: p,
        saldo: Number(c.monto_total_a_pagar) - p,
        estado: c.estado,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Catálogo: lo que ve el índice y lo que resuelven las rutas.
// ---------------------------------------------------------------------------
const CATALOGO = [
  { clave: 'capital-prestado', titulo: 'Capital prestado', descripcion: 'Cuánto dinero entregaste en préstamos: cuántos hiciste, de qué tamaño y cuánto interés vas a ganar.', icono: 'salida', calcular: capitalPrestado },
  { clave: 'recaudo', titulo: 'Recaudo', descripcion: 'Dinero que entró: pagos recibidos, desglose por método y promedio por pago.', icono: 'entrada', calcular: recaudo },
  { clave: 'mora', titulo: 'Mora y antigüedad', descripcion: 'Deuda vencida repartida por tramos de atraso (1-30, 31-60, 61-90, +90 días).', icono: 'alerta', calcular: mora, sinRango: true },
  { clave: 'rentabilidad', titulo: 'Rentabilidad', descripcion: 'Cuánto de lo cobrado fue ganancia y cuánto recuperación de capital.', icono: 'ganancia', calcular: rentabilidad },
  { clave: 'flujo-caja', titulo: 'Flujo de caja', descripcion: 'Entradas contra salidas del periodo y flujo neto por origen.', icono: 'caja', calcular: flujoCaja },
  { clave: 'proyeccion', titulo: 'Proyección de cobros', descripcion: 'Lo que esperas cobrar: cuotas que vencen dentro del rango.', icono: 'calendario', calcular: proyeccion },
  { clave: 'clientes', titulo: 'Clientes', descripcion: 'Altas del periodo, cuánto se les colocó y su score de crédito.', icono: 'clientes', calcular: clientes },
  { clave: 'creditos-tomados', titulo: 'Créditos tomados', descripcion: 'Tu deuda propia: capital recibido, costo y saldo por pagar.', icono: 'deuda', calcular: creditosTomados },
];

function buscarReporte(clave) {
  return CATALOGO.find((r) => r.clave === clave) || null;
}

module.exports = { CATALOGO, buscarReporte };
