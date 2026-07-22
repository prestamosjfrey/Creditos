const { supabaseAdmin } = require('../config/supabase');
const { fechaDeCuota, formatoISO } = require('../utils/fechas');
const auditoria = require('./auditoria.service');
const scoreService = require('./score.service');
const realtime = require('./realtime');

// Genera las filas de `cuotas` para un préstamo ya creado.
// El admin siempre define valor_cuota, numero_cuotas y monto_total_a_pagar —
// esta función solo reparte fechas y montos, nunca recalcula una fórmula de interés.
function calcularPlanDeCuotas(prestamo) {
  const { numero_cuotas, valor_cuota, monto_total_a_pagar, frecuencia_pago, fecha_primer_pago } = prestamo;

  const cuotas = [];
  const primerPago = new Date(`${fecha_primer_pago}T00:00:00`);
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
      // Cada fecha se calcula desde el primer pago, nunca desde la cuota
      // anterior: así un mes corto no desplaza todo el resto del plan.
      fecha_vencimiento: formatoISO(fechaDeCuota(primerPago, frecuencia_pago, i - 1)),
      monto_esperado: montoEsperado,
      monto_pagado: 0,
      estado: 'pendiente',
    });

    acumulado += montoEsperado;
  }

  return cuotas;
}

// Crea el préstamo junto con su plan de cuotas, el egreso de caja y la entrada
// de bitácora en UNA sola transacción (ver supabase/rpc-registrar-abono.sql).
//
// Antes eran cuatro escrituras sueltas: si fallaba la segunda, quedaba un
// préstamo SIN cuotas — irrecuperable desde la interfaz. El plan se sigue
// calculando aquí (las reglas de fechas por frecuencia viven en utils/fechas)
// y se envía ya resuelto al RPC.
async function crearPrestamoConPlan(datosPrestamo) {
  const cuotas = calcularPlanDeCuotas(datosPrestamo);

  const { data: prestamoId, error } = await supabaseAdmin.rpc('crear_prestamo_con_plan', {
    p_prestamo: datosPrestamo,
    p_cuotas: cuotas,
  });
  if (error) throw error;

  const { data: prestamo, error: errorLectura } = await supabaseAdmin
    .from('prestamos')
    .select('*')
    .eq('id', prestamoId)
    .single();
  if (errorLectura) throw errorLectura;

  realtime.emitir('datos:cambio', { origen: 'prestamo' });

  return prestamo;
}

// Devuelve el préstamo con sus cuotas y pagos, EXIGIENDO que sea del usuario
// (creado_por). Si no es suyo, devuelve prestamo=null y el controlador responde
// 404 — así un usuario no puede abrir el préstamo de otro escribiendo su id en
// la URL (IDOR).
async function obtenerPrestamoConCuotas(prestamoId, usuarioId) {
  let q = supabaseAdmin
    .from('prestamos')
    .select('*, perfiles:clientes(nombre_completo, numero_documento, telefono, email, direccion)')
    .eq('id', prestamoId);
  if (usuarioId) q = q.eq('creado_por', usuarioId);

  const { data: prestamo, error } = await q.maybeSingle();
  if (error) throw error;
  if (!prestamo) return { prestamo: null, cuotas: [], pagos: [] };

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

// --- Edición y eliminación de un préstamo ya creado ---
//
// Toda la lógica vive en funciones de Postgres (supabase/editar-prestamos.sql)
// para que cada operación sea atómica y quede auditada. Aquí solo se comprueba
// que el préstamo sea del usuario y se traduce el error para la interfaz.

// Un usuario solo puede tocar SUS préstamos, aunque escriba el id de otro.
async function exigirPropiedad(prestamoId, usuarioId) {
  const { data } = await supabaseAdmin
    .from('prestamos').select('id').eq('id', prestamoId).eq('creado_por', usuarioId).maybeSingle();
  if (!data) throw Object.assign(new Error('El préstamo no existe o no es tuyo.'), { status: 404 });
}

// Los mensajes de las funciones SQL están escritos para el usuario final
// ("No se puede editar una cuota que ya está pagada"), así que se dejan pasar.
function errorLegible(error, porDefecto) {
  const msg = (error && error.message) || '';
  const limpio = msg.replace(/^.*?:\s*/, '').trim();
  return Object.assign(new Error(limpio || porDefecto), { status: 400 });
}

async function editarCuota({ prestamoId, cuotaId, monto, fecha, usuarioId }) {
  await exigirPropiedad(prestamoId, usuarioId);

  // La cuota debe ser de ESTE préstamo (si no, se podría editar la de otro).
  const { data: cuota } = await supabaseAdmin
    .from('cuotas').select('id').eq('id', cuotaId).eq('prestamo_id', prestamoId).maybeSingle();
  if (!cuota) throw Object.assign(new Error('La cuota no pertenece a este préstamo.'), { status: 404 });

  const { error } = await supabaseAdmin.rpc('editar_cuota', {
    p_cuota_id: cuotaId,
    p_monto: monto,
    p_fecha: fecha,
    p_actor: usuarioId,
  });
  if (error) throw errorLegible(error, 'No se pudo editar la cuota.');

  realtime.emitir('datos:cambio', { origen: 'prestamo' });
}

async function editarPlan({ prestamoId, total, numeroCuotas, usuarioId }) {
  await exigirPropiedad(prestamoId, usuarioId);

  const { error } = await supabaseAdmin.rpc('editar_plan_prestamo', {
    p_prestamo_id: prestamoId,
    p_total: total,
    p_numero_cuotas: numeroCuotas,
    p_actor: usuarioId,
  });
  if (error) throw errorLegible(error, 'No se pudo actualizar el plan.');

  realtime.emitir('datos:cambio', { origen: 'prestamo' });
}

async function eliminarPrestamo({ prestamoId, usuarioId }) {
  await exigirPropiedad(prestamoId, usuarioId);

  const { error } = await supabaseAdmin.rpc('eliminar_prestamo', {
    p_prestamo_id: prestamoId,
    p_actor: usuarioId,
  });
  if (error) throw errorLegible(error, 'No se pudo eliminar el préstamo.');

  realtime.emitir('datos:cambio', { origen: 'prestamo' });
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

  const cuotas = nuevasEnMora || [];
  if (cuotas.length === 0) return;

  // Los clientes de todos los préstamos afectados, en UNA sola consulta. Antes
  // se consultaba el préstamo dentro del bucle: con 500 cuotas entrando en mora
  // eran 500 viajes a la base.
  const prestamoIds = [...new Set(cuotas.map((c) => c.prestamo_id))];
  const { data: prestamos } = await supabaseAdmin
    .from('prestamos')
    .select('id, cliente_id')
    .in('id', prestamoIds);

  const clientePorPrestamo = new Map((prestamos || []).map((p) => [p.id, p.cliente_id]));
  const clientesEnMora = new Set([...clientePorPrestamo.values()].filter(Boolean));

  for (const cuota of cuotas) {
    await auditoria.registrar({
      tipo: 'cuota_mora',
      descripcion: `Cuota #${cuota.numero_cuota} entró en mora (vencía ${cuota.fecha_vencimiento}).`,
      prestamoId: cuota.prestamo_id,
      clienteId: clientePorPrestamo.get(cuota.prestamo_id) || null,
      detalle: {
        cuota_id: cuota.id,
        saldo_cuota: Number(cuota.monto_esperado) - Number(cuota.monto_pagado),
      },
      actorId: null,
    });
  }

  // Recalcular score de cada cliente afectado (fail-soft).
  for (const clienteId of clientesEnMora) {
    await scoreService.recalcularYGuardar(clienteId);
  }

  realtime.emitir('datos:cambio', { origen: 'mora' });
}

module.exports = {
  calcularPlanDeCuotas,
  crearPrestamoConPlan,
  obtenerPrestamoConCuotas,
  editarCuota,
  editarPlan,
  eliminarPrestamo,
  marcarCuotasVencidas,
};
