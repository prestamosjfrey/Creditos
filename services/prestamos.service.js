const { supabaseAdmin } = require('../config/supabase');
const { siguienteFecha, formatoISO } = require('../utils/fechas');
const { formatCOP } = require('../utils/moneda');
const cajaService = require('./caja.service');
const auditoria = require('./auditoria.service');
const scoreService = require('./score.service');
const realtime = require('./realtime');

// Genera las filas de `cuotas` para un préstamo ya creado.
// El admin siempre define valor_cuota, numero_cuotas y monto_total_a_pagar —
// esta función solo reparte fechas y montos, nunca recalcula una fórmula de interés.
function calcularPlanDeCuotas(prestamo) {
  const { numero_cuotas, valor_cuota, monto_total_a_pagar, frecuencia_pago, fecha_primer_pago } = prestamo;

  const cuotas = [];
  let fecha = new Date(`${fecha_primer_pago}T00:00:00`);
  let acumulado = 0;

  for (let i = 1; i <= numero_cuotas; i++) {
    const esUltima = i === numero_cuotas;
    // Cada cuota vale valor_cuota (que el formulario sugiere como total ÷ n para
    // que salgan iguales); la última absorbe la diferencia de redondeo.
    const montoEsperado = esUltima
      ? Math.round((monto_total_a_pagar - acumulado) * 100) / 100
      : Math.round(valor_cuota * 100) / 100;

    cuotas.push({
      numero_cuota: i,
      fecha_vencimiento: formatoISO(fecha),
      monto_esperado: montoEsperado,
      monto_pagado: 0,
      estado: 'pendiente',
    });

    acumulado += montoEsperado;
    fecha = siguienteFecha(fecha, frecuencia_pago);
  }

  return cuotas;
}

async function crearPrestamoConPlan(datosPrestamo) {
  const { data: prestamo, error } = await supabaseAdmin
    .from('prestamos')
    .insert(datosPrestamo)
    .select()
    .single();

  if (error) throw error;

  const cuotas = calcularPlanDeCuotas(prestamo).map((cuota) => ({
    ...cuota,
    prestamo_id: prestamo.id,
  }));

  const { error: errorCuotas } = await supabaseAdmin.from('cuotas').insert(cuotas);
  if (errorCuotas) throw errorCuotas;

  const { data: cliente } = await supabaseAdmin
    .from('clientes')
    .select('nombre_completo')
    .eq('id', prestamo.cliente_id)
    .single();

  // El capital prestado sale de la caja disponible. Solo se advierte si no
  // alcanza el saldo (no se bloquea la creación del préstamo).
  await cajaService.registrarMovimiento({
    tipo: 'egreso',
    monto: prestamo.monto_capital,
    concepto: `Capital prestado a ${cliente?.nombre_completo || 'cliente'}`,
    origen: 'prestamo',
    referenciaId: prestamo.id,
    registradoPor: prestamo.creado_por,
  });

  await auditoria.registrar({
    tipo: 'prestamo_creado',
    descripcion: `Préstamo creado a ${cliente?.nombre_completo || 'cliente'}: capital ${formatCOP(prestamo.monto_capital)} en ${prestamo.numero_cuotas} cuotas (${prestamo.frecuencia_pago}).`,
    prestamoId: prestamo.id,
    clienteId: prestamo.cliente_id,
    detalle: {
      monto_capital: prestamo.monto_capital,
      monto_total_a_pagar: prestamo.monto_total_a_pagar,
      numero_cuotas: prestamo.numero_cuotas,
      frecuencia_pago: prestamo.frecuencia_pago,
    },
    actorId: prestamo.creado_por,
  });

  realtime.emitir('datos:cambio', { origen: 'prestamo' });

  return prestamo;
}

// Sugerencia de valor_cuota para ayudar en el formulario — siempre editable a mano.
function sugerirValorCuota({ tipo_interes, monto_capital, valor_interes, tasa_interes, numero_cuotas }) {
  let montoTotalAPagar;

  if (tipo_interes === 'fijo_total') {
    montoTotalAPagar = monto_capital + (valor_interes || 0);
  } else if (tipo_interes === 'porcentaje_periodico') {
    const interesTotal = monto_capital * ((tasa_interes || 0) / 100) * numero_cuotas;
    montoTotalAPagar = monto_capital + interesTotal;
  } else {
    montoTotalAPagar = monto_capital;
  }

  const valorCuota = Math.round((montoTotalAPagar / numero_cuotas) * 100) / 100;
  return { montoTotalAPagar, valorCuota };
}

async function obtenerPrestamoConCuotas(prestamoId) {
  const { data: prestamo, error } = await supabaseAdmin
    .from('prestamos')
    .select('*, perfiles:clientes(nombre_completo, numero_documento, telefono, email, direccion)')
    .eq('id', prestamoId)
    .single();
  if (error) throw error;

  const { data: cuotas, error: errorCuotas } = await supabaseAdmin
    .from('cuotas')
    .select('*')
    .eq('prestamo_id', prestamoId)
    .order('numero_cuota', { ascending: true });
  if (errorCuotas) throw errorCuotas;

  const { data: pagos, error: errorPagos } = await supabaseAdmin
    .from('pagos')
    .select('*')
    .eq('prestamo_id', prestamoId)
    .order('fecha_pago', { ascending: false });
  if (errorPagos) throw errorPagos;

  return { prestamo, cuotas, pagos };
}

async function marcarCuotasVencidas() {
  const hoy = formatoISO(new Date());
  // .select() devuelve solo las cuotas que efectivamente cruzaron a mora en
  // esta corrida (las ya vencidas quedan excluidas por el filtro de estado),
  // así cada entrada en mora se audita una sola vez.
  const { data: nuevasEnMora } = await supabaseAdmin
    .from('cuotas')
    .update({ estado: 'vencida' })
    .lt('fecha_vencimiento', hoy)
    .in('estado', ['pendiente', 'parcial'])
    .select('id, prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado');

  // Clientes afectados por la mora (para recalcular score).
  const clientesEnMora = new Set();

  for (const cuota of nuevasEnMora || []) {
    await auditoria.registrar({
      tipo: 'cuota_mora',
      descripcion: `Cuota #${cuota.numero_cuota} entró en mora (vencía ${cuota.fecha_vencimiento}).`,
      prestamoId: cuota.prestamo_id,
      detalle: {
        cuota_id: cuota.id,
        saldo_cuota: Number(cuota.monto_esperado) - Number(cuota.monto_pagado),
      },
      actorId: null,
    });

    // Buscar el cliente_id de este préstamo para recalcular su score.
    const { data: pr } = await supabaseAdmin
      .from('prestamos').select('cliente_id').eq('id', cuota.prestamo_id).single();
    if (pr?.cliente_id) clientesEnMora.add(pr.cliente_id);
  }

  // Recalcular score de cada cliente afectado (fail-soft).
  for (const clienteId of clientesEnMora) {
    await scoreService.recalcularYGuardar(clienteId);
  }

  if ((nuevasEnMora || []).length) realtime.emitir('datos:cambio', { origen: 'mora' });
}

module.exports = {
  calcularPlanDeCuotas,
  crearPrestamoConPlan,
  sugerirValorCuota,
  obtenerPrestamoConCuotas,
  marcarCuotasVencidas,
};
