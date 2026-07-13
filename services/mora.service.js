const { supabaseAdmin } = require('../config/supabase');
const { formatoISO } = require('../utils/fechas');

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Reparte el saldo de una cuota en su parte de capital y de interés,
// proporcional al desglose del préstamo.
function partirSaldo(cuota) {
  const pr = cuota.prestamos || {};
  const n = Number(pr.numero_cuotas) || 1;
  const capital = Number(pr.monto_capital) || 0;
  const total = Number(pr.monto_total_a_pagar) || 0;
  const interesTotal = Math.max(0, total - capital);
  const saldo = Number(cuota.monto_esperado) - Number(cuota.monto_pagado);
  const fracInteres = Number(cuota.monto_esperado) > 0 ? (interesTotal / n) / Number(cuota.monto_esperado) : 0;
  const interes = Math.round(saldo * Math.min(1, fracInteres));
  return { saldo, capital: saldo - interes, interes };
}

function saludEtiqueta(pct) {
  if (pct >= 95) return { texto: 'Excelente', desc: 'Tu cartera está en óptimas condiciones.', color: 'emerald' };
  if (pct >= 80) return { texto: 'Buena', desc: 'Tu cartera está sana, con mora controlada.', color: 'emerald' };
  if (pct >= 60) return { texto: 'Regular', desc: 'Hay mora que conviene atender pronto.', color: 'amber' };
  return { texto: 'En riesgo', desc: 'Nivel de mora alto: prioriza la gestión de cobro.', color: 'red' };
}

// Serie de los últimos 30 días en 5 puntos (~semanales) para el mini-gráfico.
function construirSerie(cuotasMora, hoy) {
  const puntos = [];
  for (let i = 4; i >= 0; i--) {
    const fin = new Date(hoy); fin.setDate(hoy.getDate() - i * 7);
    const ini = new Date(fin); ini.setDate(fin.getDate() - 6);
    puntos.push({ ini, fin, label: `${fin.getDate()} ${MESES_CORTOS[fin.getMonth()]}`, capital: 0, interes: 0, creditos: new Set() });
  }
  (cuotasMora || []).forEach((c) => {
    const f = new Date(c.fecha_vencimiento + 'T00:00:00');
    const { capital, interes } = partirSaldo(c);
    for (const p of puntos) {
      if (f >= p.ini && f <= p.fin) { p.capital += capital; p.interes += interes; p.creditos.add(c.prestamo_id); break; }
    }
  });
  return {
    labels: puntos.map((p) => p.label),
    capital: puntos.map((p) => p.capital),
    interes: puntos.map((p) => p.interes),
    creditos: puntos.map((p) => p.creditos.size),
  };
}

async function obtenerCentroMora() {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const hoyISO = formatoISO(hoy);
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioMesAnt = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);

  const [
    { data: cuotasMora, error: e1 },
    { count: totalPrestamos },
    { count: totalClientes },
    { data: activos },
    { data: pagos },
  ] = await Promise.all([
    supabaseAdmin.from('cuotas')
      .select('id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado, prestamo_id, prestamos:prestamo_id(id, numero, numero_cuotas, monto_capital, monto_total_a_pagar, valor_cuota, frecuencia_pago, cliente_id, perfiles:cliente_id(nombre_completo, numero_documento, telefono))')
      .in('estado', ['pendiente', 'parcial', 'vencida'])
      .lt('fecha_vencimiento', hoyISO)
      .order('fecha_vencimiento', { ascending: true }),
    supabaseAdmin.from('prestamos').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('perfiles').select('id', { count: 'exact', head: true }).eq('rol', 'cliente'),
    supabaseAdmin.from('prestamos').select('monto_capital').in('estado', ['activo', 'en_mora']),
    supabaseAdmin.from('pagos').select('monto, fecha_pago').gte('fecha_pago', formatoISO(inicioMesAnt)),
  ]);
  if (e1) throw e1;

  const capitalTotalActivo = (activos || []).reduce((a, p) => a + Number(p.monto_capital), 0);

  // Recuperado este mes vs mes anterior.
  const inicioMesISO = formatoISO(inicioMes);
  let recuperadoMes = 0, recuperadoMesAnt = 0;
  (pagos || []).forEach((p) => {
    if (p.fecha_pago >= inicioMesISO) recuperadoMes += Number(p.monto);
    else recuperadoMesAnt += Number(p.monto);
  });
  const cambioRecuperado = recuperadoMesAnt > 0
    ? Math.round(((recuperadoMes - recuperadoMesAnt) / recuperadoMesAnt) * 1000) / 10
    : null;

  // Procesar cuotas en mora.
  const prestamosEnMora = new Set();
  const clientesEnMora = new Set();
  const porCliente = new Map();
  let capitalVencido = 0, interesVencido = 0;
  const lista = [];

  (cuotasMora || []).forEach((c) => {
    const pr = c.prestamos || {};
    const cli = pr.perfiles || {};
    const { saldo, capital, interes } = partirSaldo(c);
    capitalVencido += capital;
    interesVencido += interes;
    prestamosEnMora.add(c.prestamo_id);
    if (pr.cliente_id) clientesEnMora.add(pr.cliente_id);
    const dias = Math.round((hoy - new Date(c.fecha_vencimiento + 'T00:00:00')) / 86400000);
    const num = pr.numero != null ? `#PR-${String(pr.numero).padStart(5, '0')}` : '—';

    if (pr.cliente_id) {
      const cur = porCliente.get(pr.cliente_id) || {
        nombre: cli.nombre_completo || 'Cliente', documento: cli.numero_documento || '', clienteId: pr.cliente_id,
        monto: 0, cuotas: 0, maxDias: 0,
      };
      cur.monto += saldo; cur.cuotas += 1; cur.maxDias = Math.max(cur.maxDias, dias);
      porCliente.set(pr.cliente_id, cur);
    }

    lista.push({
      id: c.id, clienteId: pr.cliente_id, prestamoId: c.prestamo_id,
      cliente: cli.nombre_completo || 'Cliente', documento: cli.numero_documento || '—', telefono: cli.telefono || '',
      numeroPrestamo: num, numeroCuota: c.numero_cuota, frecuencia: pr.frecuencia_pago || '',
      vencimiento: c.fecha_vencimiento, saldo, diasAtraso: dias,
    });
  });

  const topClientes = [...porCliente.values()].sort((a, b) => b.monto - a.monto).slice(0, 5);
  const moraLoans = prestamosEnMora.size;
  const totalLoans = totalPrestamos || 0;
  const saludPct = totalLoans > 0 ? Math.max(0, Math.round(100 * (1 - moraLoans / totalLoans))) : 100;
  const pct = (parte, tot) => (tot > 0 ? Math.round((parte / tot) * 1000) / 10 : 0);

  return {
    stats: {
      creditosMora: moraLoans,
      creditosMoraPct: pct(moraLoans, totalLoans),
      capitalVencido,
      capitalVencidoPct: pct(capitalVencido, capitalTotalActivo),
      interesVencido,
      interesVencidoPct: pct(interesVencido, capitalTotalActivo),
      recuperadoMes,
      cambioRecuperado,
      clientesMora: clientesEnMora.size,
      clientesMoraPct: pct(clientesEnMora.size, totalClientes || 0),
    },
    salud: { pct: saludPct, ...saludEtiqueta(saludPct) },
    series: construirSerie(cuotasMora, hoy),
    lista,
    topClientes,
  };
}

module.exports = { obtenerCentroMora };
