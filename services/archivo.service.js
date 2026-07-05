const { supabaseAdmin } = require('../config/supabase');

// Árbol del archivo de comprobantes, agrupado por cliente. Incluye TODOS los
// préstamos (activos y pagados): el plan de pago queda disponible desde que se
// crea el préstamo; las cuotas pagadas y el paz y salvo aparecen según avance.
// Es una vista virtual: no guarda archivos, solo organiza lo que ya está en BD.
async function obtenerArbol() {
  const { data: prestamos, error } = await supabaseAdmin
    .from('prestamos')
    .select('id, fecha_inicio, monto_total_a_pagar, estado, cliente_id, perfiles:cliente_id(nombre_completo), cuotas(id, numero_cuota, estado)')
    .order('fecha_inicio', { ascending: false });
  if (error) throw error;

  const porCliente = new Map();
  (prestamos || []).forEach((p) => {
    if (!porCliente.has(p.cliente_id)) {
      porCliente.set(p.cliente_id, {
        id: p.cliente_id,
        nombre: p.perfiles?.nombre_completo || 'Cliente',
        prestamos: [],
      });
    }
    const cuotas = (p.cuotas || []).slice().sort((a, b) => a.numero_cuota - b.numero_cuota);
    porCliente.get(p.cliente_id).prestamos.push({
      id: p.id,
      fecha_inicio: p.fecha_inicio,
      total: p.monto_total_a_pagar,
      estado: p.estado,
      cuotas,
    });
  });

  return Array.from(porCliente.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

module.exports = { obtenerArbol };
