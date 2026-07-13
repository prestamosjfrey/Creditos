const { supabaseAdmin } = require('../config/supabase');

// Árbol del archivo de comprobantes, agrupado por cliente. Incluye TODOS los
// préstamos (activos y pagados): el plan de pago queda disponible desde que se
// crea el préstamo; las cuotas pagadas y el paz y salvo aparecen según avance.
// Es una vista virtual: no guarda archivos, solo organiza lo que ya está en BD.
async function obtenerArbol() {
  const { data: prestamos, error } = await supabaseAdmin
    .from('prestamos')
    .select('id, fecha_inicio, monto_total_a_pagar, estado, cliente_id, perfiles:cliente_id(nombre_completo), cuotas(id, numero_cuota), pagos(id, monto, fecha_pago, metodo, tipo, distribucion, creado_en)')
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

    // Mapa cuota_id → número, para saber qué cuotas cubrió cada abono.
    const numeroPorCuota = new Map((p.cuotas || []).map((c) => [c.id, c.numero_cuota]));

    // Un documento por ABONO real (no uno por cuota): así el archivo refleja
    // los pagos que de verdad ocurrieron, incluyendo los que cubren varias
    // cuotas de una sola vez.
    const pagos = (p.pagos || [])
      .slice()
      .sort((a, b) => String(a.fecha_pago || a.creado_en).localeCompare(String(b.fecha_pago || b.creado_en)))
      .map((pago) => {
        const aplic = pago.distribucion && Array.isArray(pago.distribucion.aplicaciones)
          ? pago.distribucion.aplicaciones : [];
        const cuotasCubiertas = [...new Set(aplic.map((a) => numeroPorCuota.get(a.cuota_id)).filter((n) => n != null))]
          .sort((a, b) => a - b);
        return {
          id: pago.id,
          monto: pago.monto,
          fecha: pago.fecha_pago || pago.creado_en,
          metodo: pago.metodo,
          tipo: pago.tipo,
          cuotas: cuotasCubiertas,
        };
      });

    porCliente.get(p.cliente_id).prestamos.push({
      id: p.id,
      fecha_inicio: p.fecha_inicio,
      total: p.monto_total_a_pagar,
      estado: p.estado,
      pagos,
    });
  });

  return Array.from(porCliente.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

module.exports = { obtenerArbol };
