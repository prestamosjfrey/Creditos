const { supabaseAdmin } = require('../config/supabase');
const { fechaDeCuota, formatoISO } = require('../utils/fechas');
const { formatCOP } = require('../utils/moneda');
const cajaService = require('./caja.service');
const auditoria = require('./auditoria.service');

function calcularPlanDeCuotas(credito) {
  const { numero_cuotas, valor_cuota, monto_total_a_pagar, frecuencia_pago, fecha_primer_pago } = credito;
  const cuotas = [];
  const primerPago = new Date(`${fecha_primer_pago}T00:00:00`);
  let acumulado = 0;

  for (let i = 1; i <= numero_cuotas; i++) {
    const esUltima = i === numero_cuotas;
    const monto = esUltima
      ? Math.round((monto_total_a_pagar - acumulado) * 100) / 100
      : Math.round(valor_cuota * 100) / 100;
    cuotas.push({
      numero_cuota: i,
      // Anclada al primer pago (ver fechaDeCuota en utils/fechas.js).
      fecha_vencimiento: formatoISO(fechaDeCuota(primerPago, frecuencia_pago, i - 1)),
      monto,
      estado: 'pendiente',
    });
    acumulado += monto;
  }
  return cuotas;
}

async function crearCreditoConPlan(datos) {
  const { data: credito, error } = await supabaseAdmin
    .from('creditos_tomados').insert(datos).select().single();
  if (error) throw error;

  const cuotas = calcularPlanDeCuotas(credito).map((c) => ({ ...c, credito_id: credito.id }));
  const { error: errCuotas } = await supabaseAdmin.from('cuotas_credito_tomado').insert(cuotas);
  if (errCuotas) throw errCuotas;

  // El dinero recibido entra a la caja disponible
  await cajaService.registrarMovimiento({
    tipo: 'ingreso',
    monto: credito.monto_capital,
    concepto: `Crédito tomado de ${credito.acreedor}`,
    origen: 'credito_tomado',
    referenciaId: credito.id,
    registradoPor: datos.creado_por,
  });

  await auditoria.registrar({
    tipo: 'credito_tomado_creado',
    descripcion: `Crédito tomado de ${credito.acreedor}: capital ${formatCOP(credito.monto_capital)} en ${credito.numero_cuotas} cuotas (${credito.frecuencia_pago}).`,
    detalle: { monto_capital: credito.monto_capital, acreedor: credito.acreedor },
    actorId: datos.creado_por,
  });

  return credito;
}

async function obtenerCreditoConCuotas(id) {
  const [{ data: credito, error: e1 }, { data: cuotas, error: e2 }, pagosRes] = await Promise.all([
    supabaseAdmin.from('creditos_tomados').select('*').eq('id', id).single(),
    supabaseAdmin.from('cuotas_credito_tomado').select('*').eq('credito_id', id).order('numero_cuota'),
    supabaseAdmin.from('pagos_credito_tomado').select('*').eq('credito_id', id).order('creado_en', { ascending: false }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  // Si aún no se corrió la migración de pagos_credito_tomado, el historial va vacío.
  const pagos = pagosRes && !pagosRes.error ? (pagosRes.data || []) : [];
  return { credito, cuotas: cuotas || [], pagos };
}

async function pagarCuota({ creditoId, cuotaId, monto, fechaPago, notas, registradoPor }) {
  // Marcar cuota como pagada
  const { error: e1 } = await supabaseAdmin
    .from('cuotas_credito_tomado')
    .update({ estado: 'pagada', pagado_en: new Date().toISOString() })
    .eq('id', cuotaId);
  if (e1) throw e1;

  // Salida de caja
  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('acreedor, numero_cuotas').eq('id', creditoId).single();

  await cajaService.registrarMovimiento({
    tipo: 'egreso',
    monto,
    concepto: `Pago cuota crédito tomado (${credito?.acreedor || 'acreedor'})`,
    origen: 'pago_credito_tomado',
    referenciaId: creditoId,
    registradoPor,
  });

  // Si todas las cuotas están pagadas → marcar crédito como pagado
  const { data: pendientes } = await supabaseAdmin
    .from('cuotas_credito_tomado')
    .select('id').eq('credito_id', creditoId).eq('estado', 'pendiente');

  if (!pendientes || pendientes.length === 0) {
    await supabaseAdmin.from('creditos_tomados').update({ estado: 'pagado' }).eq('id', creditoId);
  }

  await auditoria.registrar({
    tipo: 'cuota_credito_tomado_pagada',
    descripcion: `Cuota pagada a ${credito?.acreedor || 'acreedor'}: ${formatCOP(monto)}.`,
    detalle: { monto, fecha_pago: fechaPago, notas, cuota_id: cuotaId },
    actorId: registradoPor,
  });
}

// Pago "como un abono normal": recibe un monto y lo reparte en las cuotas
// pendientes (completas, en orden), registra UN egreso de caja con el método y
// marca el crédito como pagado si se saldó todo.
async function registrarPagoCreditoTomado({ creditoId, monto, metodo, fechaPago, notas, registradoPor }) {
  const montoTotal = Number(monto) || 0;
  if (montoTotal <= 0) throw new Error('El monto debe ser mayor a cero.');

  const [{ data: credito, error: eC }, { data: cuotas, error: eQ }] = await Promise.all([
    supabaseAdmin.from('creditos_tomados').select('acreedor, estado').eq('id', creditoId).single(),
    supabaseAdmin.from('cuotas_credito_tomado').select('id, numero_cuota, monto, estado').eq('credito_id', creditoId).order('numero_cuota'),
  ]);
  if (eC) throw eC;
  if (eQ) throw eQ;

  const pendientes = (cuotas || []).filter((q) => q.estado !== 'pagada');
  if (!pendientes.length) throw new Error('Este crédito ya está pagado por completo.');

  // Repartir en cuotas completas, en orden de vencimiento.
  let restante = montoTotal;
  const cubiertas = [];
  for (const q of pendientes) {
    const m = Number(q.monto);
    if (restante + 1e-6 >= m) { cubiertas.push(q); restante -= m; }
    else break;
  }
  if (!cubiertas.length) {
    throw new Error(`El monto no alcanza para pagar la próxima cuota (${formatCOP(Number(pendientes[0].monto))}).`);
  }
  const montoAplicado = cubiertas.reduce((a, q) => a + Number(q.monto), 0);

  const { error: eU } = await supabaseAdmin
    .from('cuotas_credito_tomado')
    .update({ estado: 'pagada', pagado_en: new Date().toISOString() })
    .in('id', cubiertas.map((q) => q.id));
  if (eU) throw eU;

  const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
  const metodoLbl = METODOS[metodo] || 'Efectivo';

  await cajaService.registrarMovimiento({
    tipo: 'egreso',
    monto: montoAplicado,
    concepto: `Pago crédito tomado (${credito?.acreedor || 'acreedor'}) · ${metodoLbl}`,
    origen: 'pago_credito_tomado',
    referenciaId: creditoId,
    registradoPor,
  });

  if (pendientes.length - cubiertas.length === 0) {
    await supabaseAdmin.from('creditos_tomados').update({ estado: 'pagado' }).eq('id', creditoId);
  }

  // Historial de pagos (para el detalle). Si la tabla aún no existe (migración
  // pendiente), no rompemos el pago: solo se omite el registro del historial.
  const { error: ePago } = await supabaseAdmin.from('pagos_credito_tomado').insert({
    credito_id: creditoId,
    monto: montoAplicado,
    metodo: metodo || 'efectivo',
    fecha_pago: fechaPago || null,
    notas: notas || null,
    cuotas: cubiertas.map((q) => q.numero_cuota),
    registrado_por: registradoPor,
  });
  if (ePago) console.warn('[creditos-tomados] pagos_credito_tomado no disponible:', ePago.message);

  await auditoria.registrar({
    tipo: 'pago_credito_tomado',
    descripcion: `Pago a ${credito?.acreedor || 'acreedor'}: ${formatCOP(montoAplicado)} (${metodoLbl}) — ${cubiertas.length} cuota${cubiertas.length === 1 ? '' : 's'}.`,
    detalle: { monto: montoAplicado, metodo, fecha_pago: fechaPago, notas: notas || null, cuotas: cubiertas.map((q) => q.numero_cuota) },
    actorId: registradoPor,
  });

  return { cuotasPagadas: cubiertas.length, montoAplicado, excedente: montoTotal - montoAplicado };
}

async function listarTodos() {
  const [{ data: creditos, error: e1 }, { data: todasCuotas, error: e2 }] = await Promise.all([
    supabaseAdmin.from('creditos_tomados').select('*').order('creado_en', { ascending: false }),
    supabaseAdmin.from('cuotas_credito_tomado').select('credito_id, estado, monto, fecha_vencimiento'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const hoy = formatoISO(new Date());
  return (creditos || []).map((c) => {
    const cuotas = (todasCuotas || []).filter((q) => q.credito_id === c.id);
    const pagado = cuotas.filter((q) => q.estado === 'pagada').reduce((a, q) => a + Number(q.monto), 0);
    const pendientes = cuotas.filter((q) => q.estado === 'pendiente' || q.estado === 'vencida');
    const proxVenc = pendientes.sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))[0];
    const enMora = pendientes.some((q) => q.fecha_vencimiento < hoy);
    return {
      ...c,
      abonado: pagado,
      saldo_pendiente: Number(c.monto_total_a_pagar) - pagado,
      cuotas_pagadas: cuotas.filter((q) => q.estado === 'pagada').length,
      prox_vencimiento: proxVenc?.fecha_vencimiento || null,
      en_mora: enMora,
    };
  });
}

module.exports = { crearCreditoConPlan, obtenerCreditoConCuotas, pagarCuota, registrarPagoCreditoTomado, listarTodos };
