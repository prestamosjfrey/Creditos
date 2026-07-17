const { supabaseAdmin } = require('../config/supabase');
const scoreService = require('./score.service');
const realtime = require('./realtime');

// Registro de abonos.
//
// IMPORTANTE: todo el trabajo con dinero (insertar el pago, repartirlo entre las
// cuotas, cerrar el préstamo, mover la caja y escribir la bitácora) ocurre dentro
// de una ÚNICA función de Postgres — ver supabase/rpc-registrar-abono.sql.
//
// Antes esto eran seis llamadas HTTP sueltas desde aquí. Si una fallaba a mitad,
// quedaban cuotas pagadas sin ingreso en caja o pagos sin distribución; y dos
// abonos simultáneos podían aplicarse sobre el mismo saldo y duplicarse.
// La función RPC es transaccional y bloquea el préstamo, así que ambas cosas son
// imposibles ahora. No devolver esta lógica a JavaScript.
//
// Lo que SÍ se queda aquí es lo que no afecta al dinero y puede fallar sin
// arrastrar la operación: recalcular el score y avisar por realtime.

async function registrarAbono({ prestamoId, cuotaId, monto, fechaPago, metodo, notas, registradoPor, tipo, accion }) {
  const esInteres = tipo === 'interes';

  const { data: pagoId, error } = esInteres
    ? await supabaseAdmin.rpc('registrar_pago_interes', {
        p_prestamo_id: prestamoId,
        p_monto: monto,
        p_fecha_pago: fechaPago,
        p_registrado_por: registradoPor,
        p_accion: accion === 'extension' ? 'extension' : 'saldo',
        p_cuota_id: cuotaId || null,
        p_metodo: metodo || null,
        p_notas: notas || null,
      })
    : await supabaseAdmin.rpc('registrar_abono', {
        p_prestamo_id: prestamoId,
        p_monto: monto,
        p_fecha_pago: fechaPago,
        p_registrado_por: registradoPor,
        p_cuota_id: cuotaId || null,
        p_metodo: metodo || null,
        p_notas: notas || null,
      });

  if (error) throw error;

  // A partir de aquí el dinero ya está confirmado en la base. Lo que sigue es
  // accesorio: si falla, se registra pero NO se deshace el pago.
  const { data: pago } = await supabaseAdmin.from('pagos').select('*').eq('id', pagoId).single();

  const { data: prestamo } = await supabaseAdmin
    .from('prestamos')
    .select('cliente_id')
    .eq('id', prestamoId)
    .single();

  // Recalcular score crediticio del cliente (fail-soft).
  await scoreService.recalcularYGuardar(prestamo?.cliente_id || null);

  // Avisar a los paneles en tiempo real (mora, dashboard, etc.).
  realtime.emitir('datos:cambio', { origen: 'pago' });

  return pago;
}

// Si no se indica una cuota específica, el abono se aplica a la cuota pendiente
// más antigua del préstamo (FIFO), repartiendo el excedente a las siguientes.
// (El reparto real vive en el RPC; esto solo lo consulta quien necesite listar.)
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

module.exports = { registrarAbono, obtenerCuotasPendientesOrdenadas };
