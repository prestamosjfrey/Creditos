const { supabaseAdmin } = require('../config/supabase');

// Score crediticio 0–1000. Factores y pesos:
//
//  A. Puntualidad en cuotas PAGADAS (50 pts por cuota, con descuento por atraso)
//     0 días  → 50 pts (perfecto)
//     1–3     → 35 pts (leve)
//     4–7     → 20 pts (moderado)
//     8–15    → 5 pts  (grave)
//     16+     → 0 pts  (muy grave)
//
//  B. Penalización por cuotas ACTUALMENTE EN MORA (-60 pts c/u, máx –300)
//
//  C. Bono por préstamos COMPLETAMENTE PAGADOS sin ninguna cuota tardía (+50 c/u)
//
// El resultado se normaliza a 0–1000 dividiendo sobre el máximo teórico posible
// y aplicando un piso de 0.

const PUNTOS_BASE = 50;
const PUNTOS = [50, 35, 20, 5, 0]; // índice: 0=perfecto, 1=1-3d, 2=4-7d, 3=8-15d, 4=16+d
const PENALIZACION_MORA = 60;
const MAX_PENALIZACION_MORA = 300;
const BONO_PRESTAMO_LIMPIO = 50;

function puntosPorAtraso(dias) {
  if (dias <= 0) return PUNTOS[0];
  if (dias <= 3) return PUNTOS[1];
  if (dias <= 7) return PUNTOS[2];
  if (dias <= 15) return PUNTOS[3];
  return PUNTOS[4];
}

function etiquetaScore(score) {
  if (score >= 900) return { etiqueta: 'Excelente', color: 'emerald' };
  if (score >= 750) return { etiqueta: 'Muy bueno', color: 'blue' };
  if (score >= 600) return { etiqueta: 'Bueno', color: 'teal' };
  if (score >= 450) return { etiqueta: 'Regular', color: 'amber' };
  if (score >= 300) return { etiqueta: 'Malo', color: 'orange' };
  return { etiqueta: 'Muy malo', color: 'red' };
}

async function calcularScoreCliente(clienteId) {
  const resultado = await calcularScoreDetallado(clienteId);
  return resultado ? resultado.score : null;
}

async function calcularScoreDetallado(clienteId) {
  const { data: prestamos, error: ep } = await supabaseAdmin
    .from('prestamos')
    .select('id, estado, numero, fecha_inicio, monto_capital')
    .eq('cliente_id', clienteId);
  if (ep) throw ep;
  if (!prestamos || prestamos.length === 0) return null;

  const prestamoIds = prestamos.map((p) => p.id);

  const { data: cuotas, error: ec } = await supabaseAdmin
    .from('cuotas')
    .select('id, prestamo_id, numero_cuota, estado, dias_atraso, fecha_vencimiento, monto_esperado')
    .in('prestamo_id', prestamoIds);
  if (ec) throw ec;

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  const pagadas = cuotas.filter((c) => c.estado === 'pagada');
  if (pagadas.length === 0 && cuotas.filter((c) => c.estado !== 'pendiente').length === 0) return null;

  // A: puntualidad.
  const detallePagadas = pagadas.map((c) => {
    const dias = c.dias_atraso ?? 0;
    const pts = puntosPorAtraso(dias);
    return { prestamo_id: c.prestamo_id, numero_cuota: c.numero_cuota, dias_atraso: dias, puntos: pts, max: PUNTOS_BASE };
  });
  const puntajeA = detallePagadas.reduce((a, d) => a + d.puntos, 0);
  const maxA = pagadas.length * PUNTOS_BASE;

  // B: mora activa.
  const enMora = cuotas.filter((c) =>
    ['pendiente', 'parcial', 'vencida'].includes(c.estado) &&
    new Date(c.fecha_vencimiento + 'T00:00:00') < hoy
  );
  const penB = Math.min(enMora.length * PENALIZACION_MORA, MAX_PENALIZACION_MORA);

  // C: bonos préstamos limpios.
  const cuotasPorPrestamo = new Map();
  cuotas.forEach((c) => {
    if (!cuotasPorPrestamo.has(c.prestamo_id)) cuotasPorPrestamo.set(c.prestamo_id, []);
    cuotasPorPrestamo.get(c.prestamo_id).push(c);
  });

  const prestamosLimpios = [];
  let bonosC = 0;
  prestamos.forEach((p) => {
    if (p.estado !== 'pagado') return;
    const cs = cuotasPorPrestamo.get(p.id) || [];
    const limpio = cs.every((c) => c.estado === 'pagada' && (c.dias_atraso ?? 0) === 0);
    if (limpio) { bonosC += BONO_PRESTAMO_LIMPIO; prestamosLimpios.push(p); }
  });

  const maximo = Math.max(1, maxA + bonosC);
  const bruto = puntajeA + bonosC - penB;
  const score = Math.min(1000, Math.max(0, Math.round((bruto / maximo) * 1000)));

  // Agrupar cuotas pagadas por préstamo para el desglose.
  const numeroPorId = new Map(prestamos.map((p) => [p.id, p.numero]));
  const cuotasPorPrest = new Map();
  detallePagadas.forEach((d) => {
    const num = numeroPorId.get(d.prestamo_id);
    const clave = num != null ? String(num).padStart(5, '0') : d.prestamo_id.slice(0, 8);
    if (!cuotasPorPrest.has(clave)) cuotasPorPrest.set(clave, { ref: `#PR-${clave}`, cuotas: [], ptsTotales: 0, maxTotales: 0 });
    const gr = cuotasPorPrest.get(clave);
    gr.cuotas.push(d);
    gr.ptsTotales += d.puntos;
    gr.maxTotales += d.max;
  });

  return {
    score,
    factores: {
      A: { puntaje: puntajeA, maximo: maxA, grupos: Array.from(cuotasPorPrest.values()) },
      B: { mora: enMora.length, penalizacion: penB, maxPen: MAX_PENALIZACION_MORA },
      C: { bonos: bonosC, prestamos: prestamosLimpios.length },
    },
    maximo,
    bruto,
  };
}

// Recalcula y persiste el score de un cliente. Fail-soft: no interrumpe
// la operación de negocio si falla.
async function recalcularYGuardar(clienteId) {
  if (!clienteId) return;
  try {
    const score = await calcularScoreCliente(clienteId);
    if (score === null) return; // sin historial suficiente
    await supabaseAdmin.from('clientes').update({
      score_credito: score,
      score_actualizado_en: new Date().toISOString(),
    }).eq('id', clienteId);
  } catch (err) {
    console.warn('[score] error al recalcular para', clienteId, '-', err.message);
  }
}

module.exports = { calcularScoreCliente, calcularScoreDetallado, recalcularYGuardar, etiquetaScore };
