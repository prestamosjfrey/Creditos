const usuariosService = require('../../services/usuarios.service');
const callmebot = require('../../services/callmebot.service');

async function listar(req, res, next) {
  try {
    const usuarios = await usuariosService.listarUsuarios();
    res.render('admin/usuarios/lista', {
      titulo: 'Usuarios',
      usuarios,
      // Se resalta la fila propia y se impide desactivarse a uno mismo.
      yoId: req.usuario.id,
      claveNueva: null,
      usuarioClave: null,
    });
  } catch (err) { next(err); }
}

async function mostrarFormularioNuevo(req, res) {
  res.render('admin/usuarios/form', {
    titulo: 'Nuevo usuario',
    usuario: null,
    error: null,
    valores: { rol: 'cobrador' },
  });
}

async function crear(req, res, next) {
  const { usuario, nombre_completo, email, telefono, rol, password, callmebot_apikey } = req.body;
  try {
    const creado = await usuariosService.crearUsuario({
      usuario, nombre_completo, email, telefono, rol, password, callmebot_apikey,
      actorId: req.usuario.id,
    });
    res.redirect(`/admin/usuarios?ok=${encodeURIComponent(`Usuario "${creado.usuario}" creado.`)}`);
  } catch (err) {
    if (err.status === 400 || err.status === 409) {
      return res.status(err.status).render('admin/usuarios/form', {
        titulo: 'Nuevo usuario',
        usuario: null,
        error: err.message,
        valores: req.body,
      });
    }
    next(err);
  }
}

async function mostrarFormularioEditar(req, res, next) {
  try {
    const usuario = await usuariosService.obtenerUsuario(req.params.id);
    if (!usuario) return res.status(404).render('errores/404');
    res.render('admin/usuarios/form', {
      titulo: 'Editar usuario',
      usuario,
      error: null,
      valores: { ...usuario, callmebot_apikey: '' },
    });
  } catch (err) { next(err); }
}

async function editar(req, res, next) {
  try {
    await usuariosService.editarUsuario(req.params.id, req.body, req.usuario.id);
    res.redirect(`/admin/usuarios?ok=${encodeURIComponent('Usuario actualizado.')}`);
  } catch (err) {
    // 409 = el correo ya lo tiene otro usuario (debe ser único).
    if (err.status === 400 || err.status === 409) {
      const usuario = await usuariosService.obtenerUsuario(req.params.id);
      return res.status(err.status).render('admin/usuarios/form', {
        titulo: 'Editar usuario', usuario, error: err.message, valores: req.body,
      });
    }
    next(err);
  }
}

async function cambiarEstado(req, res, next) {
  try {
    // Desactivarse a uno mismo dejaría el panel sin nadie dentro en el acto.
    if (req.params.id === req.usuario.id) {
      return res.redirect(`/admin/usuarios?error=${encodeURIComponent('No puedes desactivar tu propia cuenta.')}`);
    }
    const activo = await usuariosService.cambiarEstado(req.params.id, req.usuario.id);
    res.redirect(`/admin/usuarios?ok=${encodeURIComponent(`Usuario ${activo ? 'activado' : 'desactivado'}.`)}`);
  } catch (err) { next(err); }
}

// Genera una clave temporal y la muestra UNA sola vez, para dictársela al
// empleado.
//
// Se RENDERIZA la lista directamente en vez de redirigir con la clave en la
// URL: un query string queda grabado en los logs de acceso del servidor, en el
// historial del navegador y en la cabecera Referer de cualquier recurso que
// cargue la página. Una contraseña no puede vivir en una URL.
async function restablecerClave(req, res, next) {
  try {
    const usuario = await usuariosService.obtenerUsuario(req.params.id);
    if (!usuario) return res.status(404).render('errores/404');

    const temporal = usuariosService.generarPasswordTemporal();
    await usuariosService.establecerPassword(req.params.id, temporal, req.usuario.id);

    const usuarios = await usuariosService.listarUsuarios();
    res.render('admin/usuarios/lista', {
      titulo: 'Usuarios',
      usuarios,
      yoId: req.usuario.id,
      claveNueva: temporal,
      usuarioClave: usuario.usuario,
    });
  } catch (err) { next(err); }
}

// Envía un WhatsApp de PRUEBA al usuario, para comprobar que su teléfono y su
// apikey de CallMeBot están bien antes de depender de ellos el día que de
// verdad necesite recuperar la contraseña.
//
// A diferencia del flujo real de recuperación (que responde siempre lo mismo
// para no revelar qué usuarios existen), aquí SÍ se muestra el error concreto:
// quien lo usa es un administrador autenticado diagnosticando su propia cuenta,
// y sin el motivo real la prueba no sirve de nada.
async function probarWhatsApp(req, res, next) {
  const volver = (clave, mensaje) =>
    res.redirect(`/admin/usuarios?${clave}=${encodeURIComponent(mensaje)}`);

  try {
    const usuario = await usuariosService.obtenerUsuario(req.params.id);
    if (!usuario) return res.status(404).render('errores/404');

    // Resuelve teléfono normalizado (+57) y apikey, propia o heredada del .env.
    const wa = callmebot.resolverWhatsApp(usuario);
    if (!wa) {
      const faltan = [];
      if (!usuario.telefono) faltan.push('teléfono');
      if (!usuario.callmebot_apikey) faltan.push('apikey de CallMeBot');
      return volver('error', `A ${usuario.usuario} le falta: ${faltan.join(' y ')}. Edítalo para agregarlo.`);
    }

    const texto =
      `✅ *Cash R&R* — Mensaje de prueba\n\n` +
      `Tu WhatsApp quedó bien configurado, ${usuario.nombre_completo || usuario.usuario}.\n` +
      `Si olvidas tu contraseña, el código de recuperación llegará por aquí.\n\n` +
      `No necesitas hacer nada con este mensaje.`;

    const envio = await callmebot.enviarWhatsApp(wa.telefono, wa.apikey, texto);

    if (envio.ok) {
      const fuente = wa.origen === 'env' ? ' (usando la apikey de CALLMEBOT_DESTINOS)' : '';
      return volver('ok', `Mensaje de prueba enviado al ${wa.telefono}${fuente}. Revisa el WhatsApp de ${usuario.usuario}.`);
    }
    // El cuerpo que devuelve CallMeBot suele decir qué pasó (apikey inválida,
    // teléfono no autorizado…). Se muestra tal cual para poder corregirlo.
    return volver('error', `CallMeBot no pudo enviarlo: ${envio.cuerpo || 'sin detalle'}`);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listar,
  mostrarFormularioNuevo,
  crear,
  mostrarFormularioEditar,
  editar,
  cambiarEstado,
  restablecerClave,
  probarWhatsApp,
};
