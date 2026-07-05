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
    .from('perfiles')
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

async function procesarLogout(req, res) {
  const accessToken = req.cookies['sb-access-token'];
  if (accessToken) {
    await supabaseAnon.auth.signOut();
  }
  clearSessionCookies(res);
  res.redirect('/auth/login');
}

module.exports = { mostrarLogin, procesarLogin, procesarLogout };
