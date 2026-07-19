const { supabaseAdmin } = require('../config/supabase');

// Categorías de la bitácora -> tipos de evento que agrupan. Fuente única de
// verdad, usada por el filtro y por el conteo de tarjetas.
const CATEGORIAS = {
  prestamos: ['prestamo_creado', 'prestamo_pagado'],
  pagos: ['abono_registrado', 'cuota_pagada', 'pago_interes'],
  mora: ['cuota_mora'],
  caja: ['caja_ingreso', 'caja_egreso'],
  clientes: ['cliente_creado', 'cliente_editado', 'cliente_activado', 'cliente_desactivado', 'documento_subido', 'documento_eliminado'],
};

// Registra un evento en la bitácora. FAIL-SOFT a propósito: la auditoría
// nunca debe tumbar la operación de negocio (registrar un pago no puede
// fallar porque el log falló). Si algo sale mal, solo se advierte en consola.
async function registrar({ tipo, descripcion, prestamoId = null, clienteId = null, detalle = null, actorId = null }) {
  try {
    const { error } = await supabaseAdmin.from('bitacora').insert({
      tipo,
      descripcion,
      prestamo_id: prestamoId,
      cliente_id: clienteId,
      detalle,
      actor_id: actorId,
    });
    if (error) console.warn('[auditoria] no se registró evento', tipo, '-', error.message);
  } catch (err) {
    console.warn('[auditoria] excepción al registrar', tipo, '-', err.message);
  }
}

async function listar({ prestamoId, clienteId, tipos, actorId, limite = 300 } = {}) {
  let query = supabaseAdmin
    .from('bitacora')
    .select('*, actor:actor_id(nombre_completo), cliente:cliente_id(nombre_completo, numero_documento), prestamo:prestamo_id(perfiles:clientes(nombre_completo, numero_documento))')
    .order('creado_en', { ascending: false })
    .limit(limite);
  if (prestamoId) query = query.eq('prestamo_id', prestamoId);
  if (clienteId) query = query.eq('cliente_id', clienteId);
  // Cada usuario ve solo SU actividad (los eventos que él generó).
  if (actorId) query = query.eq('actor_id', actorId);
  if (tipos && tipos.length) query = query.in('tipo', tipos);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Conteo de eventos por categoría (todos los registros, no solo la página).
//
// El conteo lo hace Postgres y devuelve una fila por tipo (~15 filas). Antes se
// descargaba la bitácora COMPLETA solo para contarla en memoria: como es una
// tabla append-only que solo crece, esa consulta se degradaba para siempre.
async function contarPorCategoria(actorId) {
  const { data, error } = await supabaseAdmin.rpc('conteo_bitacora_por_tipo', { p_actor: actorId || null });
  if (error) throw error;

  const tipoACat = {};
  Object.keys(CATEGORIAS).forEach((c) => CATEGORIAS[c].forEach((t) => { tipoACat[t] = c; }));

  const conteos = { total: 0, prestamos: 0, pagos: 0, mora: 0, caja: 0, clientes: 0 };
  (data || []).forEach((r) => {
    const n = Number(r.total) || 0;
    conteos.total += n;
    const c = tipoACat[r.tipo];
    if (c) conteos[c] += n;
  });
  return conteos;
}

module.exports = { registrar, listar, contarPorCategoria, CATEGORIAS };
