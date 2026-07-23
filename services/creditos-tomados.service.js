const { supabaseAdmin } = require('../config/supabase');
const { scope } = require('../utils/alcance');
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

// Detalle EXIGIENDO que el crédito sea del usuario (creado_por). Si no es suyo,
// credito=null y el controlador responde 404 (evita ver el crédito de otro por
// su id en la URL).
async function obtenerCreditoConCuotas(id, usuarioId) {
  let q = supabaseAdmin.from('creditos_tomados').select('*').eq('id', id);
  if (usuarioId) q = q.eq('creado_por', usuarioId);
  const { data: credito, error: e1 } = await q.maybeSingle();
  if (e1) throw e1;
  if (!credito) return { credito: null, cuotas: [], pagos: [] };

  const [{ data: cuotas, error: e2 }, pagosRes] = await Promise.all([
    supabaseAdmin.from('cuotas_credito_tomado').select('*').eq('credito_id', id).order('numero_cuota'),
    supabaseAdmin.from('pagos_credito_tomado').select('*').eq('credito_id', id).order('creado_en', { ascending: false }),
  ]);
  if (e2) throw e2;
  // Si aún no se corrió la migración de pagos_credito_tomado, el historial va vacío.
  const pagos = pagosRes && !pagosRes.error ? (pagosRes.data || []) : [];
  return { credito, cuotas: cuotas || [], pagos };
}

// Verifica que el crédito sea del usuario antes de operar sobre él.
async function exigirPropiedad(creditoId, usuarioId) {
  const { data } = await supabaseAdmin
    .from('creditos_tomados').select('id').eq('id', creditoId).eq('creado_por', usuarioId).maybeSingle();
  if (!data) throw Object.assign(new Error('El crédito no existe o no es tuyo.'), { status: 404 });
}

async function pagarCuota({ creditoId, cuotaId, monto, fechaPago, notas, registradoPor }) {
  await exigirPropiedad(creditoId, registradoPor);

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
  await exigirPropiedad(creditoId, registradoPor);

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

// Pago de SOLO INTERÉS (igual que en préstamos). Se paga únicamente el interés
// de una cuota; esa cuota se salda con lo pagado y su capital se difiere a una
// cuota nueva al final:
//   · 'extension' → la cuota nueva suma un interés más (el crédito crece).
//   · 'saldo'     → solo se difiere el capital, sin interés extra.
// El interés pagado SALE de tu caja (le pagas al acreedor).
async function pagarSoloInteres({ creditoId, cuotaId, monto, fechaPago, metodo, notas, accion, registradoPor }) {
  await exigirPropiedad(creditoId, registradoPor);

  const interes = Number(monto) || 0;
  if (interes <= 0) throw Object.assign(new Error('El monto del interés debe ser mayor que cero.'), { status: 400 });
  const esExtension = accion === 'extension';

  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('*').eq('id', creditoId).single();

  // Cuota objetivo: la elegida, o la pendiente más antigua.
  let cuota;
  if (cuotaId) {
    const { data } = await supabaseAdmin
      .from('cuotas_credito_tomado').select('*').eq('id', cuotaId).eq('credito_id', creditoId).maybeSingle();
    cuota = data;
  } else {
    const { data } = await supabaseAdmin
      .from('cuotas_credito_tomado').select('*').eq('credito_id', creditoId)
      .neq('estado', 'pagada').order('numero_cuota', { ascending: true }).limit(1).maybeSingle();
    cuota = data;
  }
  if (!cuota) throw Object.assign(new Error('No hay cuotas pendientes para registrar el pago de interés.'), { status: 400 });
  if (cuota.estado === 'pagada') throw Object.assign(new Error('Esa cuota ya está pagada.'), { status: 400 });

  const montoCuota = Number(cuota.monto);
  if (interes >= montoCuota) {
    throw Object.assign(new Error(`El interés (${formatCOP(interes)}) debe ser menor al valor de la cuota (${formatCOP(montoCuota)}).`), { status: 400 });
  }

  const capitalDiferido = Math.round((montoCuota - interes) * 100) / 100;
  const interesTotal = Math.max(0, Number(credito.monto_total_a_pagar) - Number(credito.monto_capital));
  const interesXCuota = Math.round(interesTotal / (Number(credito.numero_cuotas) || 1));
  const interesAgregado = esExtension ? interesXCuota : 0;

  // 1) Saldar la cuota con lo pagado (el interés).
  await supabaseAdmin.from('cuotas_credito_tomado')
    .update({ monto: interes, estado: 'pagada', pagado_en: new Date().toISOString() })
    .eq('id', cuota.id);

  // 2) Nueva cuota al final con el capital diferido (+ interés si es extensión).
  const { data: ultima } = await supabaseAdmin
    .from('cuotas_credito_tomado').select('numero_cuota').eq('credito_id', creditoId)
    .order('numero_cuota', { ascending: false }).limit(1).maybeSingle();
  const nuevoNumero = ((ultima && ultima.numero_cuota) || cuota.numero_cuota) + 1;
  const primerPago = new Date(`${credito.fecha_primer_pago}T00:00:00`);
  const nuevaFecha = formatoISO(fechaDeCuota(primerPago, credito.frecuencia_pago, nuevoNumero - 1));
  const nuevaMonto = Math.round((capitalDiferido + interesAgregado) * 100) / 100;
  const hoy = formatoISO(new Date());
  await supabaseAdmin.from('cuotas_credito_tomado').insert({
    credito_id: creditoId,
    numero_cuota: nuevoNumero,
    fecha_vencimiento: nuevaFecha,
    monto: nuevaMonto,
    estado: nuevaFecha < hoy ? 'vencida' : 'pendiente',
  });

  // 3) Actualizar el crédito (crece un periodo).
  await supabaseAdmin.from('creditos_tomados').update({
    numero_cuotas: Number(credito.numero_cuotas) + 1,
    monto_total_a_pagar: Number(credito.monto_total_a_pagar) + interesAgregado,
    valor_interes: (Number(credito.valor_interes) || 0) + interesAgregado,
    estado: 'activo',
  }).eq('id', creditoId);

  // 4) Caja: el interés pagado SALE de tu caja.
  const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
  const metodoLbl = METODOS[metodo] || 'Efectivo';
  await cajaService.registrarMovimiento({
    tipo: 'egreso',
    monto: interes,
    concepto: `Pago de solo interés crédito tomado (${credito.acreedor}) · ${metodoLbl}`,
    origen: 'pago_credito_tomado',
    referenciaId: creditoId,
    registradoPor,
  });

  // 5) Historial + auditoría (detalle guarda lo necesario para revertir).
  const detalle = {
    accion: esExtension ? 'extension' : 'saldo',
    cuota_id: cuota.id, cuota_numero: cuota.numero_cuota, cuota_monto_original: montoCuota,
    interes_pagado: interes, capital_diferido: capitalDiferido, interes_agregado: interesAgregado,
    nueva_cuota_numero: nuevoNumero, nueva_cuota_monto: nuevaMonto,
  };
  const { error: ePago } = await supabaseAdmin.from('pagos_credito_tomado').insert({
    credito_id: creditoId, monto: interes, metodo: metodo || 'efectivo',
    fecha_pago: fechaPago || null, notas: notas || null,
    cuotas: [cuota.numero_cuota], registrado_por: registradoPor,
    tipo: 'interes', accion: esExtension ? 'extension' : 'saldo', detalle,
  });
  if (ePago) console.warn('[creditos-tomados] no se registró el pago de interés (¿falta la migración solo-interes-credito-tomado.sql?):', ePago.message);

  const desc = esExtension
    ? `Pago de solo interés ${formatCOP(interes)} al crédito de ${credito.acreedor}. Se extendió un periodo: interés +${formatCOP(interesAgregado)}, nueva cuota #${nuevoNumero} por ${formatCOP(nuevaMonto)} (total a pagar ahora ${formatCOP(Number(credito.monto_total_a_pagar) + interesAgregado)}).`
    : `Pago de solo interés ${formatCOP(interes)} al crédito de ${credito.acreedor}. El capital ${formatCOP(capitalDiferido)} se difirió a la cuota #${nuevoNumero} (sin interés extra).`;
  await auditoria.registrar({
    tipo: 'pago_credito_tomado',
    descripcion: desc,
    detalle: { credito_id: creditoId, ...detalle },
    actorId: registradoPor,
  });

  return { interes, nuevaMonto, nuevoNumero };
}

// =====================================================================
// MODO EDICIÓN (todo queda auditado; la caja se ajusta cuando corresponde)
//
// Igual que en préstamos: solo se tocan las cuotas PENDIENTES. Una cuota ya
// pagada representa un egreso real de caja con su registro, así que no se edita
// ni se borra desde aquí (para revertir un pago está "eliminar pago").
// =====================================================================

// Recalcula el estado del crédito (pagado / activo) según cuántas cuotas
// quedan pendientes, tras una edición o una reversión.
async function refrescarEstadoCredito(creditoId) {
  const { data: pend } = await supabaseAdmin
    .from('cuotas_credito_tomado').select('id').eq('credito_id', creditoId).neq('estado', 'pagada');
  const nuevoEstado = (!pend || pend.length === 0) ? 'pagado' : 'activo';
  await supabaseAdmin.from('creditos_tomados').update({ estado: nuevoEstado }).eq('id', creditoId);
  return nuevoEstado;
}

// Editar el valor y/o la fecha de una cuota PENDIENTE. El total del crédito
// sigue a la suma de sus cuotas, así que se ajusta por la diferencia.
async function editarCuota({ creditoId, cuotaId, monto, fecha, usuarioId }) {
  await exigirPropiedad(creditoId, usuarioId);

  const { data: cuota } = await supabaseAdmin
    .from('cuotas_credito_tomado').select('*').eq('id', cuotaId).eq('credito_id', creditoId).maybeSingle();
  if (!cuota) throw Object.assign(new Error('La cuota no pertenece a este crédito.'), { status: 404 });
  if (cuota.estado === 'pagada') throw Object.assign(new Error('No se puede editar una cuota que ya está pagada.'), { status: 400 });
  if (!monto || monto <= 0) throw Object.assign(new Error('El valor de la cuota debe ser mayor que cero.'), { status: 400 });

  const hoy = formatoISO(new Date());
  const nuevoEstado = fecha < hoy ? 'vencida' : 'pendiente';
  const delta = Number(monto) - Number(cuota.monto);

  const { error: e1 } = await supabaseAdmin
    .from('cuotas_credito_tomado')
    .update({ monto, fecha_vencimiento: fecha, estado: nuevoEstado })
    .eq('id', cuotaId);
  if (e1) throw e1;

  // El total a pagar del crédito sigue a la suma de sus cuotas.
  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('acreedor, monto_total_a_pagar').eq('id', creditoId).single();
  await supabaseAdmin
    .from('creditos_tomados')
    .update({ monto_total_a_pagar: Number(credito.monto_total_a_pagar) + delta })
    .eq('id', creditoId);

  await auditoria.registrar({
    tipo: 'credito_tomado_editado',
    descripcion: `Cuota #${cuota.numero_cuota} del crédito de ${credito?.acreedor || 'acreedor'} modificada: valor ${formatCOP(cuota.monto)} → ${formatCOP(monto)}, vence ${cuota.fecha_vencimiento} → ${fecha}.`,
    detalle: {
      credito_id: creditoId, cuota_id: cuotaId, numero_cuota: cuota.numero_cuota,
      monto_anterior: cuota.monto, monto_nuevo: monto,
      fecha_anterior: cuota.fecha_vencimiento, fecha_nueva: fecha,
    },
    actorId: usuarioId,
  });
}

// Editar el plan: total a pagar y número de cuotas. Las cuotas ya pagadas se
// conservan; las pendientes se regeneran repartiendo el saldo, con las fechas
// ancladas al primer pago (misma rejilla que al crear).
async function editarPlan({ creditoId, total, numeroCuotas, usuarioId }) {
  await exigirPropiedad(creditoId, usuarioId);

  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('*').eq('id', creditoId).single();
  const { data: cuotas } = await supabaseAdmin
    .from('cuotas_credito_tomado').select('*').eq('credito_id', creditoId);

  const pagadas = (cuotas || []).filter((c) => c.estado === 'pagada');
  const sumaPagadas = pagadas.reduce((a, c) => a + Number(c.monto), 0);
  const nPagadas = pagadas.length;

  if (numeroCuotas < nPagadas) throw Object.assign(new Error(`No puede haber menos cuotas (${numeroCuotas}) que las ya pagadas (${nPagadas}).`), { status: 400 });
  if (numeroCuotas === nPagadas) throw Object.assign(new Error(`Todas las cuotas quedarían pagadas: usa un número mayor a ${nPagadas}.`), { status: 400 });
  if (total <= sumaPagadas) throw Object.assign(new Error(`El total (${formatCOP(total)}) debe ser mayor a lo ya pagado (${formatCOP(sumaPagadas)}).`), { status: 400 });

  const restantes = numeroCuotas - nPagadas;
  const saldo = total - sumaPagadas;
  const valor = Math.round(saldo / restantes);
  const primerPago = new Date(`${credito.fecha_primer_pago}T00:00:00`);
  const hoy = formatoISO(new Date());

  // Fuera las pendientes: se regeneran. Las pagadas (numero_cuota 1..nPagadas)
  // no se tocan; los pagos referencian por número de cuota, que se conserva.
  const { error: eDel } = await supabaseAdmin
    .from('cuotas_credito_tomado').delete().eq('credito_id', creditoId).neq('estado', 'pagada');
  if (eDel) throw eDel;

  let acumulado = 0;
  const nuevas = [];
  for (let i = 1; i <= restantes; i++) {
    const monto = i === restantes ? saldo - acumulado : valor;
    acumulado += monto;
    const numero = nPagadas + i;
    const fecha = formatoISO(fechaDeCuota(primerPago, credito.frecuencia_pago, numero - 1));
    nuevas.push({
      credito_id: creditoId,
      numero_cuota: numero,
      fecha_vencimiento: fecha,
      monto,
      estado: fecha < hoy ? 'vencida' : 'pendiente',
    });
  }
  const { error: eIns } = await supabaseAdmin.from('cuotas_credito_tomado').insert(nuevas);
  if (eIns) throw eIns;

  await supabaseAdmin.from('creditos_tomados').update({
    monto_total_a_pagar: total,
    numero_cuotas: numeroCuotas,
    valor_cuota: valor,
    estado: 'activo',
  }).eq('id', creditoId);

  await auditoria.registrar({
    tipo: 'credito_tomado_editado',
    descripcion: `Plan del crédito de ${credito.acreedor} modificado: total ${formatCOP(credito.monto_total_a_pagar)} → ${formatCOP(total)}, cuotas ${credito.numero_cuotas} → ${numeroCuotas} (${nPagadas} ya pagadas se conservaron).`,
    detalle: {
      credito_id: creditoId,
      total_anterior: credito.monto_total_a_pagar, total_nuevo: total,
      cuotas_anterior: credito.numero_cuotas, cuotas_nuevo: numeroCuotas,
      cuotas_pagadas_conservadas: nPagadas, cuotas_regeneradas: restantes,
    },
    actorId: usuarioId,
  });
}

// Eliminar el crédito por completo y devolver la caja al estado previo.
// El capital recibido al crearlo ENTRÓ a caja (ingreso) → se compensa con un
// egreso. Cada pago hecho SALIÓ de caja (egreso) → se compensa con un ingreso.
// El libro de caja es histórico: no se borran líneas, se agregan ajustes.
async function eliminarCredito({ creditoId, usuarioId }) {
  await exigirPropiedad(creditoId, usuarioId);

  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('*').eq('id', creditoId).single();

  // Total efectivamente pagado (por cuotas pagadas). También sumamos los pagos
  // registrados como respaldo, pero las cuotas pagadas son la fuente contable.
  const { data: pagadas } = await supabaseAdmin
    .from('cuotas_credito_tomado').select('monto').eq('credito_id', creditoId).eq('estado', 'pagada');
  const totalPagado = (pagadas || []).reduce((a, c) => a + Number(c.monto), 0);

  // Auditar ANTES de borrar: es el único rastro que quedará.
  await auditoria.registrar({
    tipo: 'credito_tomado_eliminado',
    descripcion: `Crédito tomado de ${credito.acreedor} ELIMINADO. Capital ${formatCOP(credito.monto_capital)}; se habían pagado ${formatCOP(totalPagado)}. La caja se ajustó.`,
    detalle: {
      credito_id: creditoId, acreedor: credito.acreedor,
      monto_capital: credito.monto_capital, monto_total_a_pagar: credito.monto_total_a_pagar,
      total_pagado: totalPagado, fecha_inicio: credito.fecha_inicio,
    },
    actorId: usuarioId,
  });

  // Ajustes de caja (compensan los movimientos originales, que se conservan).
  await cajaService.registrarMovimiento({
    tipo: 'egreso',
    monto: credito.monto_capital,
    concepto: `Ajuste: se retira el capital del crédito tomado eliminado (${credito.acreedor})`,
    origen: 'ajuste',
    referenciaId: creditoId,
    registradoPor: usuarioId,
  });
  if (totalPagado > 0) {
    await cajaService.registrarMovimiento({
      tipo: 'ingreso',
      monto: totalPagado,
      concepto: `Ajuste: se revierten los pagos del crédito tomado eliminado (${credito.acreedor})`,
      origen: 'ajuste',
      referenciaId: creditoId,
      registradoPor: usuarioId,
    });
  }

  // Borrar historial de pagos (si la tabla existe), cuotas y el crédito.
  await supabaseAdmin.from('pagos_credito_tomado').delete().eq('credito_id', creditoId);
  await supabaseAdmin.from('cuotas_credito_tomado').delete().eq('credito_id', creditoId);
  const { error } = await supabaseAdmin.from('creditos_tomados').delete().eq('id', creditoId);
  if (error) throw error;
}

// Revertir UN pago del historial: sus cuotas vuelven a pendiente/vencida, se
// reintegra el dinero a la caja (ingreso que compensa el egreso original) y se
// borra la línea del historial. El crédito vuelve a "activo" si hacía falta.
async function eliminarPago({ creditoId, pagoId, usuarioId }) {
  await exigirPropiedad(creditoId, usuarioId);

  const { data: pago } = await supabaseAdmin
    .from('pagos_credito_tomado').select('*').eq('id', pagoId).eq('credito_id', creditoId).maybeSingle();
  if (!pago) throw Object.assign(new Error('El pago no pertenece a este crédito.'), { status: 404 });

  // GUARDARRAÍL DE ORDEN: solo se puede revertir el pago MÁS RECIENTE. Si hay
  // pagos posteriores, hay que revertirlos primero (así no queda la cuota 4
  // pendiente con la 5 pagada ni se descuadra la caja).
  const { data: ultimo } = await supabaseAdmin
    .from('pagos_credito_tomado').select('id, monto, cuotas')
    .eq('credito_id', creditoId)
    .order('creado_en', { ascending: false }).limit(1).maybeSingle();
  if (ultimo && ultimo.id !== pagoId) {
    const cuotasTxt = Array.isArray(ultimo.cuotas) && ultimo.cuotas.length ? ultimo.cuotas.join(', ') : '—';
    throw Object.assign(
      new Error(`Para no descuadrar, revierte los pagos del más reciente al más antiguo. Primero va el pago de la(s) cuota(s) ${cuotasTxt} (${formatCOP(ultimo.monto)}).`),
      { status: 400 });
  }

  const { data: credito } = await supabaseAdmin
    .from('creditos_tomados').select('*').eq('id', creditoId).single();

  const numeros = Array.isArray(pago.cuotas) ? pago.cuotas : [];
  const hoy = formatoISO(new Date());

  if (pago.tipo === 'interes' && pago.detalle) {
    // Revertir un pago de SOLO INTERÉS: borra la cuota nueva que se difirió,
    // restaura la cuota original a su valor y (si fue extensión) baja el total y
    // el número de cuotas del crédito. Como solo se revierte el pago más reciente
    // (guardarraíl de arriba), la cuota nueva sigue intacta.
    const d = pago.detalle;
    await supabaseAdmin.from('cuotas_credito_tomado')
      .delete().eq('credito_id', creditoId).eq('numero_cuota', d.nueva_cuota_numero);

    if (d.cuota_id) {
      const { data: orig } = await supabaseAdmin
        .from('cuotas_credito_tomado').select('fecha_vencimiento').eq('id', d.cuota_id).maybeSingle();
      const venc = orig && orig.fecha_vencimiento < hoy ? 'vencida' : 'pendiente';
      await supabaseAdmin.from('cuotas_credito_tomado')
        .update({ monto: d.cuota_monto_original, estado: venc, pagado_en: null })
        .eq('id', d.cuota_id);
    }

    await supabaseAdmin.from('creditos_tomados').update({
      numero_cuotas: Number(credito.numero_cuotas) - 1,
      monto_total_a_pagar: Number(credito.monto_total_a_pagar) - Number(d.interes_agregado || 0),
      valor_interes: (Number(credito.valor_interes) || 0) - Number(d.interes_agregado || 0),
    }).eq('id', creditoId);
  } else if (numeros.length) {
    // Pago normal: las cuotas que cubrió vuelven a estar por pagar.
    const { data: cuotasAfect } = await supabaseAdmin
      .from('cuotas_credito_tomado').select('id, fecha_vencimiento')
      .eq('credito_id', creditoId).in('numero_cuota', numeros);
    for (const c of (cuotasAfect || [])) {
      await supabaseAdmin.from('cuotas_credito_tomado')
        .update({ estado: c.fecha_vencimiento < hoy ? 'vencida' : 'pendiente', pagado_en: null })
        .eq('id', c.id);
    }
  }

  // Reintegrar el dinero a la caja (compensa el egreso del pago).
  await cajaService.registrarMovimiento({
    tipo: 'ingreso',
    monto: pago.monto,
    concepto: `Ajuste: se revierte un pago del crédito tomado (${credito?.acreedor || 'acreedor'})`,
    origen: 'ajuste',
    referenciaId: creditoId,
    registradoPor: usuarioId,
  });

  await supabaseAdmin.from('pagos_credito_tomado').delete().eq('id', pagoId);
  await refrescarEstadoCredito(creditoId);

  await auditoria.registrar({
    tipo: 'pago_credito_tomado_revertido',
    descripcion: `Pago de ${formatCOP(pago.monto)} al crédito de ${credito?.acreedor || 'acreedor'} REVERTIDO. El dinero volvió a la caja.`,
    detalle: {
      credito_id: creditoId, pago_id: pagoId, monto: pago.monto,
      cuotas: numeros, metodo: pago.metodo, fecha_pago: pago.fecha_pago,
    },
    actorId: usuarioId,
  });
}

async function listarTodos(usuarioId) {
  // usuarioId es el alcance: null = super admin (ve los créditos de todos).
  const { data: creditos, error: e1 } = await scope(
    supabaseAdmin.from('creditos_tomados').select('*'), 'creado_por', usuarioId)
    .order('creado_en', { ascending: false });
  if (e1) throw e1;

  // Cuotas solo de los créditos de este usuario.
  const ids = (creditos || []).map((c) => c.id);
  let todasCuotas = [];
  if (ids.length) {
    const { data, error: e2 } = await supabaseAdmin
      .from('cuotas_credito_tomado').select('credito_id, estado, monto, fecha_vencimiento').in('credito_id', ids);
    if (e2) throw e2;
    todasCuotas = data || [];
  }

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

module.exports = {
  crearCreditoConPlan, obtenerCreditoConCuotas, pagarCuota, registrarPagoCreditoTomado, pagarSoloInteres, listarTodos,
  editarCuota, editarPlan, eliminarCredito, eliminarPago,
};
