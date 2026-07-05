const callmebot = require('./callmebot.service');

// Programa un envío diario a una hora "HH:MM" (24h). Reprograma solo cada día.
// Si el servidor está apagado a esa hora, ese día no se envía (no hay reintento).
function programarDiario(hhmm, tipo, etiqueta) {
  hhmm = (hhmm || '').trim();
  if (!hhmm) return;

  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) {
    console.warn(`[recordatorios] hora inválida para ${etiqueta} (HH:MM):`, hhmm);
    return;
  }

  function msHastaProximo() {
    const ahora = new Date();
    const objetivo = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), h, m, 0, 0);
    if (objetivo <= ahora) objetivo.setDate(objetivo.getDate() + 1);
    return objetivo - ahora;
  }

  function agendar() {
    setTimeout(async () => {
      try {
        const r = await callmebot.notificarCuotasDeHoy(tipo);
        console.log(`[recordatorios] ${etiqueta}: ${r.cuotas} cuota(s), ${r.enviados}/${r.total} destinos`);
      } catch (e) {
        console.warn(`[recordatorios] error en ${etiqueta}:`, e.message);
      }
      agendar(); // reprogramar para el día siguiente
    }, msHastaProximo());
  }

  agendar();
  console.log(`[recordatorios] ${etiqueta} programado a las ${hhmm}`);
}

// Mediodía: lista de cobros de hoy. Noche: recordatorio de los que aún no pagan.
function programarRecordatorios() {
  if (!callmebot.parseDestinos().length) return;
  programarDiario(process.env.CALLMEBOT_HORA_COBROS, 'cobros', 'cobros del día');
  programarDiario(process.env.CALLMEBOT_HORA_RECORDATORIO, 'recordatorio', 'recordatorio de pagos pendientes');
}

module.exports = { programarRecordatorios, programarDiario };
