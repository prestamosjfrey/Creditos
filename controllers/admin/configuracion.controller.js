const cajaService = require('../../services/caja.service');
const usuariosService = require('../../services/usuarios.service');

async function mostrarConfiguracion(req, res, next) {
  try {
    const [saldoDisponible, perfil] = await Promise.all([
      cajaService.obtenerSaldoDisponible(req.usuario.id),
      usuariosService.obtenerUsuario(req.usuario.id),
    ]);

    // Solo un administrador gestiona usuarios: para el resto, esa sección ni se
    // pinta (además de que las rutas ya están cerradas por requireAdmin).
    const esAdmin = req.usuario.rol === 'admin';
    const usuarios = esAdmin ? await usuariosService.listarUsuarios() : [];

    res.render('admin/configuracion', {
      titulo: 'Configuración',
      saldoDisponible,
      perfil,
      esAdmin,
      usuarios,
      // La vista nunca recibe la apikey; solo si está puesta o no.
      tieneApikey: !!perfil?.callmebot_apikey,
      error: null,
      tab: req.query.tab || 'cuenta',
    });
  } catch (err) {
    next(err);
  }
}

async function editarMiPerfil(req, res, next) {
  try {
    await usuariosService.editarPerfilPropio(req.usuario.id, req.body);
    res.redirect(`/admin/configuracion?ok=${encodeURIComponent('Tus datos se actualizaron.')}`);
  } catch (err) {
    // 409 = el correo ya lo tiene otro usuario (debe ser único).
    if (err.status === 400 || err.status === 409) {
      return res.redirect(`/admin/configuracion?error=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
}

async function cambiarMiClave(req, res, next) {
  const { password_actual, password, password2 } = req.body;
  const volver = (clave, mensaje) =>
    res.redirect(`/admin/configuracion?tab=seguridad&${clave}=${encodeURIComponent(mensaje)}`);

  try {
    if (password !== password2) return volver('error', 'Las contraseñas nuevas no coinciden.');

    await usuariosService.cambiarPasswordPropia(req.usuario.id, password_actual, password);
    return volver('ok', 'Tu contraseña se actualizó correctamente.');
  } catch (err) {
    // El servicio ya devuelve mensajes pensados para el usuario final.
    if (err.status === 400) return volver('error', err.message);
    next(err);
  }
}

module.exports = { mostrarConfiguracion, editarMiPerfil, cambiarMiClave };
