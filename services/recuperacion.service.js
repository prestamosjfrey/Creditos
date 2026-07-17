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

const VIGENCIA_MINUTOS = 10;
const MAX_INTENTOS = 5;
const MAX_ENVIOS_POR_HORA = 3;

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
  if (!usuario.telefono || !usuario.callmebot_apikey) {
    console.warn('[recuperacion] usuario sin WhatsApp configurado:', usuario.usuario);
    return generico;
  }

  // Tope de envíos por hora: evita que alguien use el sistema para bombardear
  // por WhatsApp a un empleado.
  const haceUnaHora = new Date(Date.now() - 3600000).toISOString();
  const { count } = await supabaseAdmin
    .from('codigos_recuperacion')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', usuario.id)
    .gte('creado_en', haceUnaHora);

  if ((count || 0) >= MAX_ENVIOS_POR_HORA) {
    console.warn('[recuperacion] tope de envíos alcanzado para', usuario.usuario);
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
    `Vence en ${VIGENCIA_MINUTOS} minutos y sirve una sola vez.\n` +
    `Si no lo pediste tú, ignora este mensaje y avisa al administrador.`;

  const envio = await callmebot.enviarWhatsApp(usuario.telefono, usuario.callmebot_apikey, texto);
  if (!envio.ok) console.warn('[recuperacion] CallMeBot falló:', envio.cuerpo);

  await auditoria.registrar({
    tipo: 'recuperacion_solicitada',
    descripcion: `Se solicitó un código de recuperación para ${usuario.usuario}.`,
    detalle: { usuario_id: usuario.id, enviado: envio.ok, ip: ip || null },
    actorId: null,
  });

  return generico;
}

// Verifica el código y, si es correcto, cambia la contraseña.
// Los mensajes de error son deliberadamente iguales para "no existe",
// "caducado" y "incorrecto": distinguirlos ayudaría a un atacante.
async function cambiarPasswordConCodigo(identificador, codigo, password) {
  const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });
  const GENERICO = 'El código no es válido o ya venció. Solicita uno nuevo.';

  if (!password || password.length < 8) throw error('La contraseña debe tener al menos 8 caracteres.');

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

  // Código correcto: se marca usado ANTES de cambiar la clave, para que dos
  // peticiones simultáneas no puedan usarlo dos veces.
  const { data: marcado } = await supabaseAdmin
    .from('codigos_recuperacion')
    .update({ usado_en: new Date().toISOString() })
    .eq('id', registro.id)
    .is('usado_en', null)
    .select('id')
    .maybeSingle();
  if (!marcado) throw error(GENERICO); // otra petición se le adelantó

  const { error: errorClave } = await supabaseAdmin.auth.admin.updateUserById(usuario.id, { password });
  if (errorClave) throw error('No se pudo actualizar la contraseña. Intenta de nuevo.');

  await auditoria.registrar({
    tipo: 'recuperacion_completada',
    descripcion: `${usuario.usuario} cambió su contraseña con un código de WhatsApp.`,
    detalle: { usuario_id: usuario.id },
    actorId: usuario.id,
  });

  return { ok: true };
}

module.exports = { solicitarCodigo, cambiarPasswordConCodigo, VIGENCIA_MINUTOS };
