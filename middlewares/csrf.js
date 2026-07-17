const crypto = require('crypto');

// Protección CSRF por "double submit cookie".
//
//   1. Se emite una cookie `csrf-token` (httpOnly y FIRMADA con
//      SESSION_COOKIE_SECRET, que hasta ahora estaba declarado en .env sin usar).
//   2. Cada formulario manda el mismo valor en un campo oculto `_csrf`, que el
//      servidor incrusta al renderizar la vista (res.locals.csrfToken).
//   3. En cada POST se exige que ambos coincidan.
//
// Un sitio atacante puede forzar al navegador a ENVIAR la cookie, pero no puede
// leerla ni deducir su valor, así que no puede rellenar el campo oculto. Esto
// complementa a SameSite=Lax: si algún día una cookie pasa a SameSite=None, o el
// navegador no respeta Lax, la protección sigue en pie.
//
// La cookie va httpOnly porque ningún JavaScript de la app necesita leerla: los
// formularios reciben el token ya renderizado desde el servidor. Si en el futuro
// se añade un POST por fetch(), debe mandar el token en la cabecera X-CSRF-Token
// tomándolo del DOM (no de la cookie).

const COOKIE = 'csrf-token';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

function nuevoToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Comparación en tiempo constante: evita filtrar el token carácter a carácter
// midiendo cuánto tarda la respuesta.
function iguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function csrfProteccion(req, res, next) {
  // Cookie firmada: si alguien la manipula, cookie-parser la descarta y aquí
  // llega undefined, con lo que se emite una nueva y el POST se rechaza.
  let token = req.signedCookies?.[COOKIE];

  if (!token) {
    token = nuevoToken();
    res.cookie(COOKIE, token, {
      signed: true,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });
  }

  // Disponible para las vistas: <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  res.locals.csrfToken = token;

  if (METODOS_SEGUROS.has(req.method)) return next();

  const enviado =
    (req.body && req.body._csrf) ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token');

  if (!iguales(enviado, token)) {
    const err = new Error('Token CSRF inválido o ausente.');
    err.status = 403;
    err.codigo = 'CSRF';
    return next(err);
  }

  next();
}

module.exports = { csrfProteccion };
