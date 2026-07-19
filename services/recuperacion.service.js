const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const callmebot = require('./callmebot.service');
const auditoria = require('./auditoria.service');

// Recuperación de contraseña por WhatsApp (CallMeBot).
//
// POR QUÉ UN CÓDIGO Y NO UN ENLACE
// --------------------------------
// Un enlace de recuperación es una credencial al portador: quien lo tenga entra
// a la cuenta, y en esta app una cuenta ve toda la cartera. CallMeBot es un
// servicio gratuito de terceros, sin SLA, cuyos servidores ven el contenido del
// mensaje. Mandar el enlace por ahí sería poner el acceso total del sistema en
// manos de un intermediario.
//
// En su lugar se manda un código de 6 dígitos que:
//   · caduca a los 10 minutos,
//   · sirve UNA sola vez,
//   · admite como mucho 5 intentos de verificación,
//   · se limita a 3 envíos por usuario y hora.
// Si el código se filtrara, a los 10 minutos ya no vale nada.
//
// En la base nunca se guarda el código: se guarda su HMAC con el secreto del
// servidor. Ni siquiera con acceso a la tabla se puede deducir (6 dígitos son
// solo un millón de combinaciones: un hash simple sería trivial de romper).

// El código sirve 2 minutos: suficiente para copiarlo del WhatsApp y escribirlo,
// pero lo bastante corto para que casi no haya margen a interceptarlo.
const VIGENCIA_MINUTOS = 2;
const MAX_INTENTOS = 5;

// Entre un envío y el siguiente deben pasar 2 minutos (mismo tiempo que dura el
// código). Así, justo cuando el código vence, ya se puede pedir otro; y no se
// puede bombardear a un empleado con mensajes. Sustituye al viejo tope de "3 por
// hora", que en la práctica dejaba de reenviar tras unos pocos intentos.
const COOLDOWN_MINUTOS = 2;

// Una vez validado el código, se abre una ventana aparte para escribir la
// contraseña nueva. Si la contraseña se pidiera dentro del mismo minuto, al
// usuario se le vencería el código mientras la escribe.
const VIGENCIA_TICKET_MINUTOS = 10;

function hashCodigo(codigo) {
  return crypto
    .createHmac('sha256', process.env.SESSION_COOKIE_SECRET)
    .update(String(codigo))
    .digest('hex');
}

// randomInt es criptográficamente seguro; Math.random() no lo es y sería
// predecible para quien conozca el estado del generador.
function generarCodigo() {
  return String(crypto.randomInt(100000, 1000000));
}

function iguales(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Envía un código al WhatsApp del usuario.
//
// Devuelve SIEMPRE la misma forma pase lo que pase (usuario inexistente, sin
// WhatsApp configurado, fallo de CallMeBot): quien pide el código no debe poder
// averiguar qué usuarios existen. El motivo real solo va al log.
async function solicitarCodigo(identificador, { ip } = {}) {
  const generico = { ok: true };

  const usuariosService = require('./usuarios.service');
  const usuario = await usuariosService.buscarPorIdentificador(identificador);

  if (!usuario || !usuario.activo) {
    console.warn('[recuperacion] usuario inexistente o inactivo:', identificador);
    return generico;
  }
  // Teléfono normalizado (+57) y apikey propia o heredada de CALLMEBOT_DESTINOS.
  const wa = callmebot.resolverWhatsApp(usuario);
  if (!wa) {
    console.warn('[recuperacion] usuario sin WhatsApp configurado:', usuario.usuario);
    return generico;
  }

  // Cooldown: si ya se envió un código hace menos de COOLDOWN_MINUTOS, no se
  // manda otro. Evita bombardear al empleado y limita la fuerza bruta.
  const desdeCooldown = new Date(Date.now() - COOLDOWN_MINUTOS * 60000).toISOString();
  const { count } = await supabaseAdmin
    .from('codigos_recuperacion')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', usuario.id)
    .gte('creado_en', desdeCooldown);

  if ((count || 0) > 0) {
    console.warn('[recuperacion] en cooldown, no se reenvía a', usuario.usuario);
    return generico;
  }

  // Los códigos anteriores dejan de servir: solo el último vale.
  await supabaseAdmin
    .from('codigos_recuperacion')
    .update({ usado_en: new Date().toISOString() })
    .eq('usuario_id', usuario.id)
    .is('usado_en', null);

  const codigo = generarCodigo();
  const expira = new Date(Date.now() + VIGENCIA_MINUTOS * 60000);

  const { error } = await supabaseAdmin.from('codigos_recuperacion').insert({
    usuario_id: usuario.id,
    codigo_hash: hashCodigo(codigo),
    expira_en: expira.toISOString(),
  });
  if (error) {
    console.warn('[recuperacion] no se pudo guardar el código:', error.message);
    return generico;
  }

  const texto =
    `🔑 *Cash R&R* — Recuperar contraseña\n\n` +
    `Tu código es: *${codigo}*\n\n` +
    `⏱ Vence en ${VIGENCIA_MINUTOS} minutos y sirve una sola vez.\n` +
    `Si no lo pediste tú, ignora este mensaje y avisa al administrador.`;

  const envio = await callmebot.enviarWhatsApp(wa.telefono, wa.apikey, texto);
  if (!envio.ok) console.warn('[recuperacion] CallMeBot falló:', envio.cuerpo);

  await auditoria.registrar({
    tipo: 'recuperacion_solicitada',
    descripcion: `Se solicitó un código de recuperación para ${usuario.usuario}.`,
    detalle: { usuario_id: usuario.id, enviado: envio.ok, ip: ip || null },
    actorId: null,
  });

  return generico;
}

// PASO 1: comprueba el código y lo consume. No cambia la contraseña todavía;
// devuelve el usuario para que el controlador abra la ventana del paso 2.
//
// Los mensajes de error son deliberadamente iguales para "no existe",
// "caducado" e "incorrecto": distinguirlos ayudaría a un atacante.
async function verificarCodigo(identificador, codigo) {
  const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });
  const GENERICO = 'El código no es válido o ya venció. Solicita uno nuevo.';

  const usuariosService = require('./usuarios.service');
  const usuario = await usuariosService.buscarPorIdentificador(identificador);
  if (!usuario || !usuario.activo) throw error(GENERICO);

  const { data: registro } = await supabaseAdmin
    .from('codigos_recuperacion')
    .select('*')
    .eq('usuario_id', usuario.id)
    .is('usado_en', null)
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!registro) throw error(GENERICO);
  if (new Date(registro.expira_en) < new Date()) throw error(GENERICO);

  if (registro.intentos >= MAX_INTENTOS) {
    // Quemado por demasiados intentos: se invalida para que no siga vivo.
    await supabaseAdmin.from('codigos_recuperacion')
      .update({ usado_en: new Date().toISOString() }).eq('id', registro.id);
    throw error('Demasiados intentos fallidos. Solicita un código nuevo.');
  }

  if (!iguales(hashCodigo(codigo), registro.codigo_hash)) {
    await supabaseAdmin.from('codigos_recuperacion')
      .update({ intentos: registro.intentos + 1 }).eq('id', registro.id);
    throw error(GENERICO);
  }

  // Código correcto: se CONSUME de inmediato (un solo uso). Una segunda
  // petición simultánea con el mismo código ya no lo encuentra libre.
  const { data: marcado } = await supabaseAdmin
    .from('codigos_recuperacion')
    .update({ usado_en: new Date().toISOString() })
    .eq('id', registro.id)
    .is('usado_en', null)
    .select('id')
    .maybeSingle();
  if (!marcado) throw error(GENERICO); // otra petición se le adelantó

  await auditoria.registrar({
    tipo: 'recuperacion_verificada',
    descripcion: `${usuario.usuario} validó su código de recuperación.`,
    detalle: { usuario_id: usuario.id },
    actorId: null,
  });

  return { usuarioId: usuario.id, usuario: usuario.usuario };
}

// PASO 2: cambia la contraseña. Solo se llega aquí con un ticket válido, que el
// controlador emite (firmado) al superar el paso 1: el código ya se consumió.
async function cambiarPassword(usuarioId, password) {
  const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });
  if (!password || password.length < 8) throw error('La contraseña debe tener al menos 8 caracteres.');

  const { data: usuario } = await supabaseAdmin
    .from('usuarios').select('usuario, activo').eq('id', usuarioId).maybeSingle();
  if (!usuario || !usuario.activo) throw error('No se pudo actualizar la contraseña.');

  const { error: errorClave } = await supabaseAdmin.auth.admin.updateUserById(usuarioId, { password });
  if (errorClave) throw error('No se pudo actualizar la contraseña. Intenta de nuevo.');

  await auditoria.registrar({
    tipo: 'recuperacion_completada',
    descripcion: `${usuario.usuario} cambió su contraseña con un código de WhatsApp.`,
    detalle: { usuario_id: usuarioId },
    actorId: usuarioId,
  });

  return { ok: true };
}

module.exports = {
  solicitarCodigo,
  verificarCodigo,
  cambiarPassword,
  VIGENCIA_MINUTOS,
  VIGENCIA_TICKET_MINUTOS,
  COOLDOWN_MINUTOS,
};
