const crypto = require('crypto');

// Manejador central de errores.
//
// Regla: el detalle técnico va al LOG, nunca a la pantalla. Antes se hacía
// render con `err.message`, lo que mostraba al usuario mensajes crudos de
// Postgres/PostgREST (nombres de tablas, columnas y constraints) — un mapa
// gratis de la base para un atacante.
//
// En su lugar se genera un identificador corto y se muestra solo ese: el
// usuario puede reportarlo y el detalle completo se busca en el log.
function errorHandler(err, req, res, next) {
  const ref = crypto.randomBytes(4).toString('hex');
  const status = err.status || 500;

  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, {
    mensaje: err.message,
    codigo: err.codigo || err.code || null,
    usuario: req.usuario?.id || null,
    stack: err.stack,
  });

  if (res.headersSent) return next(err);

  // El token CSRF caduca junto con la sesión; lo normal es que el usuario
  // tuviera la pestaña abierta demasiado tiempo. Se le explica sin tecnicismos.
  if (err.codigo === 'CSRF') {
    return res.status(403).render('errores/403', {
      mensaje: 'Tu sesión expiró o el formulario ya no era válido. Vuelve a cargar la página e inténtalo de nuevo.',
    });
  }

  if (status === 403) return res.status(403).render('errores/403', { mensaje: null });
  if (status === 404) return res.status(404).render('errores/404');

  res.status(500).render('errores/500', {
    mensaje: `Ocurrió un error inesperado. Si vuelve a pasar, reporta este código: ${ref}`,
  });
}

module.exports = errorHandler;
