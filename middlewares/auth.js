const { supabaseAnon, supabaseAdmin } = require('../config/supabase');
const { esSuperAdmin } = require('../utils/alcance');

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
};

function setSessionCookies(res, session) {
  res.cookie('sb-access-token', session.access_token, COOKIE_OPTS);
  res.cookie('sb-refresh-token', session.refresh_token, COOKIE_OPTS);
}

function clearSessionCookies(res) {
  res.clearCookie('sb-access-token');
  res.clearCookie('sb-refresh-token');
}

// ¿El error es de red/conectividad (no de autenticación)? En ese caso NO se
// debe cerrar la sesión: es un corte temporal, no un token inválido.
function esErrorDeRed(err) {
  const code = err && (err.cause?.code || err.code || '');
  const msg = (err && err.message) || '';
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(String(code) + ' ' + msg);
}

// Resuelve el perfil de staff a partir de un access token, o null si el token
// no es válido / el usuario está inactivo. Sin efectos secundarios: lo usa
// tanto requireAuth como el handshake de Socket.IO.
async function usuarioDesdeToken(accessToken) {
  if (!accessToken) return null;
  const { data, error } = await supabaseAnon.auth.getUser(accessToken);
  if (error || !data?.user) return null;

  const { data: perfil, error: perfilError } = await supabaseAdmin
    .from('usuarios')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (perfilError || !perfil || !perfil.activo) return null;
  return perfil;
}

async function requireAuth(req, res, next) {
  const accessToken = req.cookies['sb-access-token'];
  if (!accessToken) return res.redirect('/auth/login');

  try {
    let { data, error } = await supabaseAnon.auth.getUser(accessToken);

    if (error || !data.user) {
      // Token expirado: intentar refrescar con el refresh token antes de cerrar sesión.
      const refreshToken = req.cookies['sb-refresh-token'];
      if (!refreshToken) {
        clearSessionCookies(res);
        return res.redirect('/auth/login');
      }
      const { data: refreshed, error: refreshError } = await supabaseAnon.auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (refreshError || !refreshed.session) {
        clearSessionCookies(res);
        return res.redirect('/auth/login');
      }
      setSessionCookies(res, refreshed.session);
      data = { user: refreshed.user };
    }

    const { data: perfil, error: perfilError } = await supabaseAdmin
      .from('usuarios')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (perfilError || !perfil || !perfil.activo) {
      clearSessionCookies(res);
      return res.redirect('/auth/login');
    }

    req.usuario = perfil;
    res.locals.usuario = perfil;
    // El super admin ve todo; se expone a las vistas para el indicador visual.
    req.esSuperAdmin = esSuperAdmin(perfil);
    res.locals.esSuperAdmin = req.esSuperAdmin;
    next();
  } catch (err) {
    // Corte de red hacia Supabase: mostrar aviso amable SIN cerrar sesión.
    if (esErrorDeRed(err)) {
      console.warn('[auth] sin conexión con Supabase:', err.cause?.code || err.message);
      return res.status(503).render('errores/503');
    }
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).render('errores/403');
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  usuarioDesdeToken,
  setSessionCookies,
  clearSessionCookies,
};
