const { supabaseAdmin } = require('../config/supabase');

// Saldo disponible para prestar = suma de ingresos - suma de egresos de todo
// el historial. No se guarda un "saldo actual" aparte: siempre se recalcula
// desde el libro de movimientos, así nunca puede desincronizarse.
//
// La suma la hace Postgres (función saldo_caja), no Node. Antes se descargaba
// la tabla ENTERA de movimientos en cada request solo para sumarla: con años de
// operación son cientos de miles de filas viajando por la red para devolver un
// único número, y el formulario de "nuevo préstamo" lo pide en cada carga.
async function obtenerSaldoDisponible() {
  const { data, error } = await supabaseAdmin.rpc('saldo_caja');
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

// Historial completo con saldo corrido (como un extracto bancario), más
// reciente primero.
async function obtenerMovimientos() {
  const { data, error } = await supabaseAdmin
    .from('movimientos_caja')
    .select('*')
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
