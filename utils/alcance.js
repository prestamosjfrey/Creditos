// Alcance de visibilidad de datos por usuario.
//
// Regla general: cada usuario ve SOLO lo suyo (aislamiento por creado_por /
// registrado_por / etc.). EXCEPCIÓN: el super admin ve TODO junto, como si fuera
// una sola operación.
//
// Cómo se marca al super admin: por nombre de usuario, fijo en el código (fue la
// decisión tomada). Para pasarlo a otro, se edita esta lista y se redespliega.
const SUPER_ADMINS = ['deiver'];

function esSuperAdmin(usuario) {
  if (!usuario) return false;
  return SUPER_ADMINS.indexOf(String(usuario.usuario || '').toLowerCase()) !== -1;
}

// "Alcance" que se pasa a las consultas de LECTURA:
//   · usuario normal -> su propio id (ve solo lo suyo)
//   · super admin    -> null  (= TODOS: sin filtro)
//
// OJO: esto es solo para LEER. Al escribir (crear préstamo, registrar abono…) se
// sigue guardando el id real del usuario (req.usuario.id), nunca este alcance.
function alcanceDe(usuario) {
  return esSuperAdmin(usuario) ? null : (usuario && usuario.id) || null;
}

// Aplica el filtro por dueño a una consulta de Supabase, SALVO que el alcance
// sea null (super admin = ve todo). `campo` puede ser una columna directa
// ('creado_por') o una embebida con !inner ('prestamos.creado_por').
//
// Devuelve el query builder para poder seguir encadenando (.order, .gte…).
function scope(query, campo, alcance) {
  return alcance ? query.eq(campo, alcance) : query;
}

module.exports = { esSuperAdmin, alcanceDe, scope, SUPER_ADMINS };
