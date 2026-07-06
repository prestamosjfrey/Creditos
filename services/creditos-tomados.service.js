const { supabaseAdmin } = require('../config/supabase');
const { siguienteFecha, formatoISO } = require('../utils/fechas');
const { formatCOP } = require('../utils/moneda');
const cajaService = require('./caja.service');
const auditoria = require('./auditoria.service');

function calcularPlanDeCuotas(credito) {
  const { numero_cuotas, valor_cuota, monto_total_a_pagar, frecuencia_pago, fecha_primer_pago } = credito;
  const cuotas = [];
  let fecha = new Date(`${fecha_primer_pago}T00:00:00`);
  let acumulado = 0;

  for (let i = 1; i <= numero_cuotas; i++) {
    const esUltima = i === numero_cuotas;
    const monto = esUltima
      ? Math.round((monto_total_a_pagar - acumulado) * 100) / 100
      : Math.round(valor_cuota * 100) / 100;
    cuotas.push({ numero_cuota: i, fecha_vencimiento: formatoISO(fecha), monto, estado: 'pendiente' });
    acumulado += monto;
    fecha = siguienteFecha(fecha, frecuencia_pago);
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
  const [{ data: credito, error: e1 }, { data: cuotas, error: e2 }] = await Promise.all([
    supabaseAdmin.from('creditos_tomados').select('*').eq('id', id).single(),
    supabaseAdmin.from('cuotas_credito_tomado').select('*').eq('credito_id', id).order('numero_cuota'),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return { credito, cuotas: cuotas || [] };
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

async function listarTodos() {
  const { data, error } = await supabaseAdmin
    .from('creditos_tomados').select('*, cuotas:cuotas_credito_tomado(estado, monto, fecha_vencimiento)')
    .order('creado_en', { ascending: false });
  if (error) throw error;

  const hoy = formatoISO(new Date());
  return (data || []).map((c) => {
    const pagado = (c.cuotas || []).filter((q) => q.estado === 'pagada').reduce((a, q) => a + Number(q.monto), 0);
    const pendientes = (c.cuotas || []).filter((q) => q.estado === 'pendiente' || q.estado === 'vencida');
    const proxVenc = pendientes.sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))[0];
    const enMora = pendientes.some((q) => q.fecha_vencimiento < hoy);
    return {
      ...c,
      abonado: pagado,
      saldo_pendiente: Number(c.monto_total_a_pagar) - pagado,
      cuotas_pagadas: (c.cuotas || []).filter((q) => q.estado === 'pagada').length,
      prox_vencimiento: proxVenc?.fecha_vencimiento || null,
      en_mora: enMora,
    };
  });
}

module.exports = { crearCreditoConPlan, obtenerCreditoConCuotas, pagarCuota, listarTodos };
