const { supabaseAdmin } = require('../config/supabase');
const { scope } = require('../utils/alcance');

// Saldo disponible para prestar = suma de ingresos - suma de egresos.
//
// Cada usuario tiene SU propia caja: sus préstamos salen de su saldo y sus
// abonos entran a su saldo. `usuarioId` es el ALCANCE: el id del usuario, o null
// si es super admin (= caja global, la suma de todas). La función saldo_caja ya
// trata null como "todos", así que null funciona directo.
//
// La suma la hace Postgres, no Node, para no descargar toda la tabla.
async function obtenerSaldoDisponible(usuarioId) {
  const { data, error } = await supabaseAdmin.rpc('saldo_caja', { p_usuario: usuarioId || null });
  if (error) throw error;
  return Number(data) || 0;
}

async function registrarMovimiento({ tipo, monto, concepto, origen, referenciaId = null, registradoPor }) {
  const { error } = await supabaseAdmin.from('movimientos_caja').insert({
    tipo,
    monto,
    concepto,
    origen,
    referencia_id: referenciaId,
    registrado_por: registradoPor,
  });
  if (error) throw error;
}

// Historial con saldo corrido (como un extracto bancario), más reciente
// primero. Solo los movimientos del usuario: es su propia caja.
async function obtenerMovimientos(usuarioId) {
  const { data, error } = await scope(
    supabaseAdmin.from('movimientos_caja').select('*'), 'registrado_por', usuarioId)
    .order('creado_en', { ascending: true });
  if (error) throw error;

  let saldo = 0;
  const conSaldo = data.map((m) => {
    saldo += m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto);
    return { ...m, saldoResultante: saldo };
  });

  return conSaldo.reverse();
}

module.exports = { obtenerSaldoDisponible, registrarMovimiento, obtenerMovimientos };
