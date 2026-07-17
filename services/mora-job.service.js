const prestamosService = require('./prestamos.service');

// Marcado de cuotas vencidas.
//
// Antes esto se disparaba al abrir el dashboard: si nadie entraba, la mora y los
// scores quedaban desactualizados, y un simple GET terminaba escribiendo en la
// base. Ahora corre solo, una vez al arrancar y luego cada hora.
//
// Es idempotente: `marcarCuotasVencidas` solo toca cuotas que siguen
// pendientes/parciales y ya vencieron, así que repetirlo no duplica nada.
//
// NOTA para despliegue con varias instancias: si algún día se escala a más de
// un proceso, mover esto a pg_cron (o a un job externo) para que no corra en
// paralelo. Hoy Render ejecuta una sola instancia.

const UNA_HORA = 1000 * 60 * 60;

async function ejecutar() {
  try {
    await prestamosService.marcarCuotasVencidas();
  } catch (err) {
    // Nunca debe tumbar el proceso: se reintenta en la siguiente pasada.
    console.warn('[mora-job] error al marcar cuotas vencidas:', err.message);
  }
}

function programarMarcadoDeMora() {
  ejecutar();
  const t = setInterval(ejecutar, UNA_HORA);
  t.unref?.(); // no mantiene el proceso vivo por sí solo
  console.log('[mora-job] marcado de cuotas vencidas programado (cada hora)');
}

module.exports = { programarMarcadoDeMora, ejecutar };
