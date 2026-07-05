const { supabaseAnon, supabaseAdmin } = require('../config/supabase');

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

async function requireAuth(req, res, next) {
  const accessToken = req.cookies['sb-access-token'];
  if (!accessToken) return res.redirect('/auth/login');

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
    .from('perfiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (perfilError || !perfil || !perfil.activo) {
    clearSessionCookies(res);
    return res.redirect('/auth/login');
  }

  req.usuario = perfil;
  res.locals.usuario = perfil;
  next();
}

function requireAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).render('errores/403');
  }
  next();
}

function requireCliente(req, res, next) {
  if (req.usuario.rol !== 'cliente') {
    return res.status(403).render('errores/403');
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireCliente,
  setSessionCookies,
  clearSessionCookies,
};
