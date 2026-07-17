const { supabaseAnon, supabaseAdmin } = require('../config/supabase');
const { setSessionCookies, clearSessionCookies } = require('../middlewares/auth');
const usuariosService = require('../services/usuarios.service');
const recuperacionService = require('../services/recuperacion.service');

function mostrarLogin(req, res) {
  res.render('auth/login', { error: null, layout: false });
}

// El login NO usa el correo real: varios empleados comparten el correo del jefe
// y Supabase Auth exige que sea único. Se entra con el nombre de usuario, que
// se traduce al correo interno (usuario@cartera.local) antes de autenticar.
//
// También se acepta el correo directamente: así las cuentas creadas antes de
// que existiera el campo `usuario` siguen entrando igual que siempre.
async function procesarLogin(req, res) {
  const { usuario, email, password } = req.body;
  const identificador = (usuario || email || '').trim();

  const fallo = () =>
    res.status(401).render('auth/login', {
      error: 'Usuario o contraseña incorrectos.',
      layout: false,
    });

  if (!identificador || !password) return fallo();

  const perfil = await usuariosService.buscarPorIdentificador(identificador);
  // Mensaje idéntico si el usuario no existe o si la clave está mal: distinguirlos
  // permitiría averiguar qué usuarios existen.
  if (!perfil || !perfil.email_auth) return fallo();

  const { data, error } = await supabaseAnon.auth.signInWithPassword({
    email: perfil.email_auth,
    password,
  });
  if (error || !data.session) return fallo();

  if (!perfil.activo) {
    return res.status(403).render('auth/login', {
      error: 'Esta cuenta no está activa. Contacta al administrador.',
      layout: false,
    });
  }

  setSessionCookies(res, data.session);
  return res.redirect('/admin/dashboard');
}

// --- Recuperación de contraseña (solo staff, que son los que tienen cuenta de Auth) ---

// --- Recuperación de contraseña por WhatsApp ---
//
// El correo ya no sirve como identificador: varios empleados comparten el del
// jefe. Se pide el NOMBRE DE USUARIO y se manda un código de 6 dígitos al
// WhatsApp que tenga registrado (ver services/recuperacion.service.js).

function mostrarRecuperar(req, res) {
  res.render('auth/recuperar', { error: null, exito: null, valores: {}, layout: false });
}

async function procesarRecuperar(req, res) {
  const identificador = (req.body.usuario || req.body.email || '').trim();

  try {
    if (identificador) {
      await recuperacionService.solicitarCodigo(identificador, { ip: req.ip });
    }
  } catch (err) {
    // Nunca se propaga el motivo: la respuesta es siempre la misma.
    console.warn('[recuperar] excepción:', err.message);
  }

  // Respuesta genérica pase lo que pase (usuario inexistente, sin WhatsApp,
  // fallo de CallMeBot): así nadie puede averiguar qué usuarios existen.
  res.render('auth/nueva-clave', {
    error: null,
    exito: `Si el usuario existe y tiene WhatsApp registrado, le enviamos un código. Vence en ${recuperacionService.VIGENCIA_MINUTOS} minutos.`,
    usuario: identificador,
    layout: false,
  });
}

// Pantalla donde se pega el código recibido por WhatsApp y se elige la clave.
function mostrarNuevaClave(req, res) {
  res.render('auth/nueva-clave', {
    error: null,
    exito: null,
    usuario: (req.query.usuario || '').trim(),
    layout: false,
  });
}

async function procesarNuevaClave(req, res) {
  const { usuario, codigo, password, password2 } = req.body;

  const renderError = (mensaje) =>
    res.status(400).render('auth/nueva-clave', {
      error: mensaje,
      exito: null,
      usuario: (usuario || '').trim(),
      layout: false,
    });

  if (!usuario || !codigo) return renderError('Escribe tu usuario y el código que recibiste.');
  if (!password || password.length < 8) return renderError('La contraseña debe tener al menos 8 caracteres.');
  if (password !== password2) return renderError('Las contraseñas no coinciden.');

  try {
    await recuperacionService.cambiarPasswordConCodigo(usuario.trim(), String(codigo).trim(), password);
    return res.redirect(`/auth/login?ok=${encodeURIComponent('Contraseña actualizada. Ya puedes iniciar sesión.')}`);
  } catch (err) {
    // El servicio ya devuelve mensajes pensados para el usuario final y que no
    // distinguen entre "código malo", "caducado" o "usuario inexistente".
    return renderError(err.status === 400 ? err.message : 'No se pudo actualizar la contraseña. Intenta de nuevo.');
  }
}

async function procesarLogout(req, res) {
  const accessToken = req.cookies['sb-access-token'];

  // Antes se llamaba a supabaseAnon.auth.signOut() sin más. Ese cliente se creó
  // con persistSession:false y es compartido por todo el proceso: no tiene la
  // sesión de ESTE usuario, así que la llamada no revocaba nada. Se borraban las
  // cookies y el refresh token seguía vivo en Supabase — quien lo hubiera
  // copiado podía seguir emitiendo access tokens tras el "cierre de sesión".
  //
  // Con el id del usuario se revocan sus sesiones de verdad, vía service role.
  if (accessToken) {
    try {
      const { data } = await supabaseAnon.auth.getUser(accessToken);
      if (data?.user) await supabaseAdmin.auth.admin.signOut(accessToken, 'global');
    } catch (err) {
      // Si el token ya expiró no hay nada que revocar: se sigue al borrado.
      console.warn('[logout] no se pudo revocar la sesión:', err.message);
    }
  }

  clearSessionCookies(res);
  res.redirect('/auth/login');
}

module.exports = {
  mostrarLogin,
  procesarLogin,
  procesarLogout,
  mostrarRecuperar,
  procesarRecuperar,
  mostrarNuevaClave,
  procesarNuevaClave,
};
