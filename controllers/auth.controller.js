const { supabaseAnon, supabaseAdmin } = require('../config/supabase');
const { setSessionCookies, clearSessionCookies } = require('../middlewares/auth');

function mostrarLogin(req, res) {
  res.render('auth/login', { error: null, layout: false });
}

async function procesarLogin(req, res) {
  const { email, password } = req.body;

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    return res.status(401).render('auth/login', {
      error: 'Correo o contraseña incorrectos.',
      layout: false,
    });
  }

  const { data: perfil } = await supabaseAdmin
    .from('usuarios')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (!perfil || !perfil.activo) {
    return res.status(403).render('auth/login', {
      error: 'Esta cuenta no está activa. Contacta al administrador.',
      layout: false,
    });
  }

  setSessionCookies(res, data.session);

  if (perfil.rol === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/cliente/panel');
}

// --- Recuperación de contraseña (solo staff, que son los que tienen cuenta de Auth) ---

function mostrarRecuperar(req, res) {
  res.render('auth/recuperar', { error: null, exito: null, valores: {}, layout: false });
}

async function procesarRecuperar(req, res) {
  const email = (req.body.email || '').trim();

  // La URL a la que Supabase redirige tras verificar el enlace del correo.
  // Debe estar en la lista de "Redirect URLs" del proyecto Supabase.
  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const redirectTo = `${baseUrl}/auth/nueva-clave`;

  try {
    if (email) {
      const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, { redirectTo });
      // No revelamos si el error viene de un correo inexistente: solo lo dejamos
      // en el log para diagnóstico. El usuario siempre ve el mismo mensaje.
      if (error) console.warn('[recuperar] resetPasswordForEmail:', error.message);
    }
  } catch (err) {
    console.warn('[recuperar] excepción:', err.message);
  }

  // Respuesta genérica: evita revelar qué correos existen (enumeración).
  res.render('auth/recuperar', {
    error: null,
    exito: 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja de entrada (y spam).',
    valores: {},
    layout: false,
  });
}

function mostrarNuevaClave(req, res) {
  // Los tokens del enlace llegan en el fragmento (#) de la URL, que solo ve el
  // navegador: un script en la vista los lee y los pone en el formulario.
  res.render('auth/nueva-clave', { error: null, access_token: '', layout: false });
}

async function procesarNuevaClave(req, res) {
  const { access_token, password, password2 } = req.body;

  // Se devuelve el token al re-renderizar para que el formulario no lo pierda
  // si hay un error de validación (el # ya no está disponible en ese punto).
  const renderError = (mensaje) =>
    res.status(400).render('auth/nueva-clave', { error: mensaje, access_token: access_token || '', layout: false });

  if (!access_token) {
    return renderError('El enlace es inválido o expiró. Solicita uno nuevo.');
  }
  if (!password || password.length < 8) {
    return renderError('La contraseña debe tener al menos 8 caracteres.');
  }
  if (password !== password2) {
    return renderError('Las contraseñas no coinciden.');
  }

  try {
    // Validamos el token de recuperación obteniendo el usuario dueño de la sesión.
    const { data, error } = await supabaseAnon.auth.getUser(access_token);
    if (error || !data?.user) {
      return renderError('El enlace es inválido o expiró. Solicita uno nuevo.');
    }

    // Con el id confirmado, actualizamos la contraseña vía service role.
    const { error: errorUpd } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password });
    if (errorUpd) throw errorUpd;

    return res.redirect(`/auth/login?ok=${encodeURIComponent('Contraseña actualizada. Ya puedes iniciar sesión.')}`);
  } catch (err) {
    console.warn('[nueva-clave] error:', err.message);
    return renderError('No se pudo actualizar la contraseña. Intenta de nuevo.');
  }
}

async function procesarLogout(req, res) {
  const accessToken = req.cookies['sb-access-token'];
  if (accessToken) {
    await supabaseAnon.auth.signOut();
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
