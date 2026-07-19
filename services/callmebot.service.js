const { supabaseAdmin } = require('../config/supabase');
const { formatoISO } = require('../utils/fechas');
const { formatCOP } = require('../utils/moneda');

// Destinos de notificación: lista "numero:apikey" separada por comas en la
// variable CALLMEBOT_DESTINOS. Son los teléfonos del prestamista (no de los
// clientes) que recibirán el resumen por WhatsApp.
function parseDestinos() {
  const raw = process.env.CALLMEBOT_DESTINOS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((par) => {
      const i = par.lastIndexOf(':');
      return { telefono: par.slice(0, i).trim(), apikey: par.slice(i + 1).trim() };
    })
    .filter((d) => d.telefono && d.apikey);
}

// Colombia es el único país en uso, así que el indicativo siempre es 57.
// CallMeBot exige el número en formato internacional (573001234567): sin el 57
// el envío falla. Aquí se normaliza para que nadie tenga que acordarse:
//   "300 123 4567"   -> 573001234567
//   "+57 300 1234567"-> 573001234567
//   "573001234567"   -> 573001234567 (ya estaba bien)
const INDICATIVO_CO = '57';

function normalizarTelefono(valor) {
  const digitos = String(valor || '').replace(/\D/g, '');
  if (!digitos) return '';
  // Ya viene con indicativo (57 + 10 dígitos).
  if (digitos.length === 12 && digitos.startsWith(INDICATIVO_CO)) return digitos;
  // Celular colombiano suelto: 10 dígitos que empiezan por 3.
  if (digitos.length === 10) return INDICATIVO_CO + digitos;
  // Cualquier otro caso se deja tal cual: puede ser un fijo o un número de otro
  // país, y forzarle un 57 lo rompería en silencio.
  return digitos;
}

// Busca en CALLMEBOT_DESTINOS la apikey ya configurada para un teléfono.
//
// Evita tener el mismo dato en dos sitios: el teléfono del prestamista suele
// estar ya en esa variable (la usan los avisos de cobros del día), así que si
// coincide con el de un usuario, se reutiliza su apikey en vez de pedirla otra
// vez. Los empleados nuevos, que no están en esa lista, sí necesitan la suya.
function apikeyDeDestinos(telefono) {
  const buscado = normalizarTelefono(telefono);
  if (!buscado) return null;
  const destino = parseDestinos().find((d) => normalizarTelefono(d.telefono) === buscado);
  return destino ? destino.apikey : null;
}

// Resuelve el WhatsApp utilizable de un usuario: su apikey propia si la tiene,
// o la del .env si su teléfono ya estaba configurado ahí.
function resolverWhatsApp(usuario) {
  const telefono = normalizarTelefono(usuario?.telefono);
  if (!telefono) return null;
  const apikey = usuario.callmebot_apikey || apikeyDeDestinos(telefono);
  if (!apikey) return null;
  return { telefono, apikey, origen: usuario.callmebot_apikey ? 'usuario' : 'env' };
}

// Envía un mensaje de WhatsApp por la API gratuita de CallMeBot.
async function enviarWhatsApp(telefono, apikey, texto) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(telefono)}` +
    `&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(apikey)}`;
  const resp = await fetch(url);
  const cuerpo = await resp.text();
  // CallMeBot responde 200 con un texto; si contiene "ERROR" o "APIKey" suele ser fallo.
  const ok = resp.ok && !/error|invalid|apikey not|missing/i.test(cuerpo);
  return { ok, cuerpo: cuerpo.slice(0, 160) };
}

// Cuotas que vencen HOY y siguen pendientes (o parciales), con el cliente.
async function obtenerCuotasDeHoy() {
  const hoy = formatoISO(new Date());
  const { data, error } = await supabaseAdmin
    .from('cuotas')
    .select('numero_cuota, monto_esperado, monto_pagado, prestamo_id, prestamos:prestamo_id(numero, perfiles:clientes(nombre_completo, telefono))')
    .in('estado', ['pendiente', 'parcial'])
    .eq('fecha_vencimiento', hoy)
    .order('numero_cuota', { ascending: true });
  if (error) throw error;
  return data || [];
}

// tipo: 'cobros' (apertura del día, mediodía) | 'recordatorio' (noche, los que
// aún no han registrado pago). En ambos casos `cuotas` son las de hoy que
// siguen pendientes/parciales; por eso de noche solo quedan los que no pagaron.
function construirMensaje(cuotas, tipo = 'cobros') {
  const hoyTxt = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });

  if (!cuotas.length) {
    return tipo === 'recordatorio'
      ? `✅ Cartera — ${hoyTxt}\nTodos los clientes con cuota de hoy ya registraron su pago. 🎉`
      : `📋 Cartera — ${hoyTxt}\nHoy no hay cuotas por cobrar. ✅`;
  }

  let total = 0;
  const lineas = cuotas.map((c, i) => {
    const saldo = Number(c.monto_esperado) - Number(c.monto_pagado);
    total += saldo;
    const nombre = c.prestamos?.perfiles?.nombre_completo || 'Cliente';
    const tel = c.prestamos?.perfiles?.telefono ? ` (${c.prestamos.perfiles.telefono})` : '';
    return `${i + 1}. ${nombre}${tel} — ${formatCOP(saldo)}`;
  });

  if (tipo === 'recordatorio') {
    return `⏰ *Pagos pendientes de hoy* — ${hoyTxt}\nEstos clientes AÚN no han registrado el pago:\n\n` +
      `${lineas.join('\n')}\n\n👥 ${cuotas.length} pendiente(s)\n💰 Falta por cobrar: ${formatCOP(total)}`;
  }
  return `📋 *Cobros de hoy* — ${hoyTxt}\n\n${lineas.join('\n')}\n\n` +
    `👥 ${cuotas.length} cliente(s)\n💰 Total por cobrar hoy: ${formatCOP(total)}`;
}

// Calcula las cuotas de hoy y envía el resumen por WhatsApp a todos los destinos.
async function notificarCuotasDeHoy(tipo = 'cobros') {
  const destinos = parseDestinos();
  if (!destinos.length) {
    return { ok: false, motivo: 'sin_destinos', enviados: 0, total: 0, cuotas: 0, errores: ['No hay destinos configurados (CALLMEBOT_DESTINOS).'] };
  }

  const cuotas = await obtenerCuotasDeHoy();
  const texto = construirMensaje(cuotas, tipo);

  let enviados = 0;
  const errores = [];
  for (const d of destinos) {
    try {
      const r = await enviarWhatsApp(d.telefono, d.apikey, texto);
      if (r.ok) enviados += 1;
      else errores.push(`${d.telefono}: ${r.cuerpo}`);
    } catch (e) {
      errores.push(`${d.telefono}: ${e.message}`);
    }
  }

  return { ok: enviados > 0, enviados, total: destinos.length, cuotas: cuotas.length, errores };
}

module.exports = {
  parseDestinos,
  normalizarTelefono,
  apikeyDeDestinos,
  resolverWhatsApp,
  enviarWhatsApp,
  obtenerCuotasDeHoy,
  construirMensaje,
  notificarCuotasDeHoy,
};
