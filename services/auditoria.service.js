const { supabaseAdmin } = require('../config/supabase');

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

async function listar({ prestamoId, clienteId, tipos, limite = 300 } = {}) {
  let query = supabaseAdmin
    .from('bitacora')
    .select('*, actor:actor_id(nombre_completo), cliente:cliente_id(nombre_completo, numero_documento), prestamo:prestamo_id(perfiles:cliente_id(nombre_completo, numero_documento))')
    .order('creado_en', { ascending: false })
    .limit(limite);
  if (prestamoId) query = query.eq('prestamo_id', prestamoId);
  if (clienteId) query = query.eq('cliente_id', clienteId);
  if (tipos && tipos.length) query = query.in('tipo', tipos);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

module.exports = { registrar, listar };
