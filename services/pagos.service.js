const { supabaseAdmin } = require('../config/supabase');
const cajaService = require('./caja.service');
const auditoria = require('./auditoria.service');
const scoreService = require('./score.service');
const { diasDeAtraso, siguienteFecha, formatoISO } = require('../utils/fechas');
const { formatCOP } = require('../utils/moneda');

// Si no se indica una cuota específica, el abono se aplica a la cuota pendiente
// más antigua del préstamo (FIFO), repartiendo el excedente a las siguientes.
async function obtenerCuotasPendientesOrdenadas(prestamoId) {
  const { data, error } = await supabaseAdmin
    .from('cuotas')
    .select('*')
    .eq('prestamo_id', prestamoId)
    .in('estado', ['pendiente', 'parcial', 'vencida'])
    .order('numero_cuota', { ascending: true });
  if (error) throw error;
  return data;
}

async function registrarAbono({ prestamoId, cuotaId, monto, fechaPago, metodo, notas, registradoPor, tipo, accion }) {
  // Un pago de SOLO INTERÉS tiene una mecánica y auditoría propias.
  if (tipo === 'interes') {
    return registrarPagoInteres({ prestamoId, cuotaId, monto, fechaPago, metodo, notas, registradoPor, accion: accion === 'extension' ? 'extension' : 'saldo' });
  }

  const { data: pago, error: errorPago } = await supabaseAdmin
    .from('pagos')
    .insert({
      prestamo_id: prestamoId,
      cuota_id: cuotaId || null,
      registrado_por: registradoPor,
      monto,
      fecha_pago: fechaPago,
      metodo,
      notas,
    })
    .select()
    .single();
  if (errorPago) throw errorPago;

  let restante = Number(monto);
  let cuotas;
  if (cuotaId) {
    // Se aplica primero a la cuota elegida y, si sobra dinero, el excedente
    // se reparte a las demás cuotas pendientes (FIFO). Antes el excedente se
    // perdía y dejaba el préstamo "activo" con saldo 0.
    const especifica = await obtenerCuotaPorId(cuotaId);
    const pendientes = await obtenerCuotasPendientesOrdenadas(prestamoId);
    cuotas = [especifica, ...pendientes.filter((c) => c.id !== cuotaId)];
  } else {
    cuotas = await obtenerCuotasPendientesOrdenadas(prestamoId);
  }

  // Reparto real de este abono entre las cuotas (FIFO). Se guarda en el pago
  // para que el comprobante muestre exactamente a qué cuotas fue el dinero y
  // quede como registro auditable (no se recalcula al vuelo).
  const distribucion = [];

  for (const cuota of cuotas) {
    if (restante <= 0) break;
    const saldoCuota = Number(cuota.monto_esperado) - Number(cuota.monto_pagado);
    if (saldoCuota <= 0) continue;

    const aplicado = Math.min(restante, saldoCuota);
    const nuevoPagado = Math.round((Number(cuota.monto_pagado) + aplicado) * 100) / 100;
    const nuevoEstado = nuevoPagado >= Number(cuota.monto_esperado) ? 'pagada' : 'parcial';

    const cambios = { monto_pagado: nuevoPagado, estado: nuevoEstado };
    // Al cerrar la cuota, congelamos con cuántos días de atraso quedó pagada
    // (0 = a tiempo o antes). Este es el dato base del score de crédito.
    if (nuevoEstado === 'pagada') {
      cambios.dias_atraso = diasDeAtraso(
        new Date(`${cuota.fecha_vencimiento}T00:00:00`),
        new Date(`${fechaPago}T00:00:00`)
      );
    }

    await supabaseAdmin.from('cuotas').update(cambios).eq('id', cuota.id);

    distribucion.push({
      cuota_id: cuota.id,
      cuota_numero: cuota.numero_cuota,
      monto_aplicado: aplicado,
      saldo_cuota: Math.round((Number(cuota.monto_esperado) - nuevoPagado) * 100) / 100,
      estado_resultante: nuevoEstado,
    });

    if (nuevoEstado === 'pagada') {
      await auditoria.registrar({
        tipo: 'cuota_pagada',
        descripcion: `Cuota #${cuota.numero_cuota} pagada${cambios.dias_atraso > 0 ? ` con ${cambios.dias_atraso} día(s) de atraso` : ' a tiempo'}.`,
        prestamoId: prestamoId,
        detalle: { cuota_id: cuota.id, dias_atraso: cambios.dias_atraso, monto_esperado: cuota.monto_esperado },
        actorId: registradoPor,
      });
    }

    restante -= aplicado;
  }

  // Excedente que no se pudo aplicar (el préstamo ya estaba saldado): queda a
  // favor y se refleja en el comprobante.
  const excedente = Math.round(restante * 100) / 100;

  // Guardar el reparto (y el excedente si lo hubo) en el pago.
  await supabaseAdmin
    .from('pagos')
    .update({ distribucion: { aplicaciones: distribucion, excedente } })
    .eq('id', pago.id);

  await actualizarEstadoPrestamoSiCompletado(prestamoId, registradoPor);

  const { data: prestamo } = await supabaseAdmin
    .from('prestamos')
    .select('cliente_id, perfiles:cliente_id(nombre_completo)')
    .eq('id', prestamoId)
    .single();

  // El abono completo (capital + intereses) entra de vuelta a la caja
  // disponible: es efectivo real recibido.
  await cajaService.registrarMovimiento({
    tipo: 'ingreso',
    monto,
    concepto: `Abono recibido de ${prestamo?.perfiles?.nombre_completo || 'cliente'}`,
    origen: 'pago',
    referenciaId: pago.id,
    registradoPor,
  });

  await auditoria.registrar({
    tipo: 'abono_registrado',
    descripcion: `Abono de ${formatCOP(monto)} recibido de ${prestamo?.perfiles?.nombre_completo || 'cliente'}.`,
    prestamoId,
    clienteId: prestamo?.cliente_id || null,
    detalle: { monto, metodo, fecha_pago: fechaPago, pago_id: pago.id },
    actorId: registradoPor,
  });

  // Recalcular score crediticio del cliente (fail-soft).
  await scoreService.recalcularYGuardar(prestamo?.cliente_id || null);

  return pago;
}

async function obtenerCuotaPorId(cuotaId) {
  const { data, error } = await supabaseAdmin.from('cuotas').select('*').eq('id', cuotaId).single();
  if (error) throw error;
  return data;
}

// Pago de SOLO INTERÉS sobre una cuota. Según la decisión:
//  - 'extension': la cuota queda saldada con lo pagado y su capital restante se
//    difiere a una nueva cuota al final, sumando un interés por cuota al total.
//  - 'saldo': la cuota queda parcial; el capital pendiente se cobra después
//    (renegociación), sin interés extra.
// Todo queda auditado: el pago de interés y el efecto sobre el plan.
async function registrarPagoInteres({ prestamoId, cuotaId, monto, fechaPago, metodo, notas, registradoPor, accion }) {
  const montoNum = Number(monto);

  const { data: prestamo, error: errorPrest } = await supabaseAdmin
    .from('prestamos')
    .select('*, perfiles:cliente_id(nombre_completo)')
    .eq('id', prestamoId)
    .single();
  if (errorPrest) throw errorPrest;

  // Cuota objetivo: la elegida o la pendiente más antigua.
  let cuota;
  if (cuotaId) {
    cuota = await obtenerCuotaPorId(cuotaId);
  } else {
    const pendientes = await obtenerCuotasPendientesOrdenadas(prestamoId);
    cuota = pendientes[0];
  }
  if (!cuota) throw new Error('No hay cuotas pendientes para registrar el pago de interés.');

  const { data: pago, error: errorPago } = await supabaseAdmin
    .from('pagos')
    .insert({
      prestamo_id: prestamoId,
      cuota_id: cuota.id,
      registrado_por: registradoPor,
      monto: montoNum,
      fecha_pago: fechaPago,
      metodo,
      notas,
      tipo: 'interes',
      accion,
    })
    .select()
    .single();
  if (errorPago) throw errorPago;

  const esperado = Number(cuota.monto_esperado);
  const pagadoPrevio = Number(cuota.monto_pagado);
  const aplicado = Math.min(montoNum, esperado - pagadoPrevio);
  const nuevoPagado = Math.round((pagadoPrevio + aplicado) * 100) / 100;
  const saldoCapitalCuota = Math.round((esperado - nuevoPagado) * 100) / 100;

  let detalleExt = null;

  if (accion === 'extension') {
    // La cuota se da por saldada con lo pagado (su esperado baja a lo pagado);
    // el capital restante se difiere a una cuota nueva al final.
    await supabaseAdmin
      .from('cuotas')
      .update({ monto_pagado: nuevoPagado, monto_esperado: nuevoPagado, estado: 'pagada' })
      .eq('id', cuota.id);

    const numeroCuotas = Number(prestamo.numero_cuotas);
    const interesTotal = Number(prestamo.monto_total_a_pagar) - Number(prestamo.monto_capital);
    const interesPorCuota = Math.round(interesTotal / numeroCuotas);

    const { data: ultimas } = await supabaseAdmin
      .from('cuotas')
      .select('numero_cuota, fecha_vencimiento')
      .eq('prestamo_id', prestamoId)
      .order('numero_cuota', { ascending: false })
      .limit(1);
    const ult = ultimas[0];
    const nuevaFecha = formatoISO(siguienteFecha(new Date(`${ult.fecha_vencimiento}T00:00:00`), prestamo.frecuencia_pago));
    const nuevoNumero = Number(ult.numero_cuota) + 1;
    const nuevoEsperado = Math.round((saldoCapitalCuota + interesPorCuota) * 100) / 100;

    await supabaseAdmin.from('cuotas').insert({
      prestamo_id: prestamoId,
      numero_cuota: nuevoNumero,
      fecha_vencimiento: nuevaFecha,
      monto_esperado: nuevoEsperado,
      monto_pagado: 0,
      estado: 'pendiente',
      origen: 'extension',
    });

    const totalNuevo = Math.round((Number(prestamo.monto_total_a_pagar) + interesPorCuota) * 100) / 100;
    const interesNuevo = Math.round((Number(prestamo.valor_interes || interesTotal) + interesPorCuota) * 100) / 100;
    await supabaseAdmin
      .from('prestamos')
      .update({ numero_cuotas: numeroCuotas + 1, monto_total_a_pagar: totalNuevo, valor_interes: interesNuevo })
      .eq('id', prestamoId);

    detalleExt = {
      interes_agregado: interesPorCuota,
      capital_diferido: saldoCapitalCuota,
      nueva_cuota_numero: nuevoNumero,
      nueva_cuota_monto: nuevoEsperado,
      total_anterior: Number(prestamo.monto_total_a_pagar),
      total_nuevo: totalNuevo,
    };
  } else {
    // Saldo pendiente: la cuota queda parcial; el capital se cobra después.
    const nuevoEstado = nuevoPagado >= esperado ? 'pagada' : 'parcial';
    await supabaseAdmin
      .from('cuotas')
      .update({ monto_pagado: nuevoPagado, estado: nuevoEstado })
      .eq('id', cuota.id);
  }

  // Reparto del pago de interés (una sola cuota) para el comprobante.
  const estadoResultante = accion === 'extension' ? 'pagada' : (nuevoPagado >= esperado ? 'pagada' : 'parcial');
  await supabaseAdmin
    .from('pagos')
    .update({
      distribucion: {
        aplicaciones: [{
          cuota_id: cuota.id,
          cuota_numero: cuota.numero_cuota,
          monto_aplicado: aplicado,
          saldo_cuota: accion === 'extension' ? 0 : saldoCapitalCuota,
          estado_resultante: estadoResultante,
        }],
        excedente: 0,
        tipo: 'interes',
      },
    })
    .eq('id', pago.id);

  // El interés recibido es efectivo real → entra a la caja disponible.
  await cajaService.registrarMovimiento({
    tipo: 'ingreso',
    monto: montoNum,
    concepto: `Pago de interés de ${prestamo?.perfiles?.nombre_completo || 'cliente'}`,
    origen: 'pago',
    referenciaId: pago.id,
    registradoPor,
  });

  await auditoria.registrar({
    tipo: 'pago_interes',
    descripcion:
      accion === 'extension'
        ? `Pago de solo interés ${formatCOP(montoNum)} de ${prestamo?.perfiles?.nombre_completo || 'cliente'}. Se extendió el crédito un periodo: interés +${formatCOP(detalleExt.interes_agregado)}, nueva cuota #${detalleExt.nueva_cuota_numero} por ${formatCOP(detalleExt.nueva_cuota_monto)} (total a pagar ahora ${formatCOP(detalleExt.total_nuevo)}).`
        : `Pago de solo interés ${formatCOP(montoNum)} de ${prestamo?.perfiles?.nombre_completo || 'cliente'}. Capital ${formatCOP(saldoCapitalCuota)} queda pendiente para renegociación (cuota #${cuota.numero_cuota}).`,
    prestamoId,
    clienteId: prestamo?.cliente_id || null,
    detalle: { monto: montoNum, metodo, fecha_pago: fechaPago, pago_id: pago.id, cuota_id: cuota.id, accion, ...(detalleExt || {}) },
    actorId: registradoPor,
  });

  // Recalcular score crediticio del cliente (fail-soft).
  await scoreService.recalcularYGuardar(prestamo?.cliente_id || null);

  return pago;
}

async function actualizarEstadoPrestamoSiCompletado(prestamoId, registradoPor) {
  const { data: prestamo } = await supabaseAdmin
    .from('prestamos')
    .select('estado, cliente_id, perfiles:cliente_id(nombre_completo)')
    .eq('id', prestamoId)
    .single();
  if (!prestamo || prestamo.estado === 'pagado') return;

  const { data: cuotas, error } = await supabaseAdmin
    .from('cuotas')
    .select('estado')
    .eq('prestamo_id', prestamoId);
  if (error) throw error;
  if (cuotas.length === 0) return;

  const todasPagadas = cuotas.every((c) => c.estado === 'pagada');
  if (todasPagadas) {
    await supabaseAdmin.from('prestamos').update({ estado: 'pagado' }).eq('id', prestamoId);
    await auditoria.registrar({
      tipo: 'prestamo_pagado',
      descripcion: `Préstamo pagado por completo (${prestamo.perfiles?.nombre_completo || 'cliente'}).`,
      prestamoId,
      clienteId: prestamo.cliente_id,
      actorId: registradoPor,
    });
  }
}

module.exports = { registrarAbono, obtenerCuotasPendientesOrdenadas };
