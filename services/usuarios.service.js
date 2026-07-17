const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const auditoria = require('./auditoria.service');

// Gestión del staff que inicia sesión.
//
// IDENTIDAD: Supabase Auth exige correo único, pero aquí varios empleados
// comparten el correo del jefe. Por eso el login NO usa el correo real:
//
//   · usuario     -> identificador de login, único (ej. "juan.cobrador")
//   · email_auth  -> correo sintético que ve Supabase (juan.cobrador@cartera.local)
//   · email       -> correo REAL de contacto, puede repetirse
//
// email_auth es un detalle de implementación: nunca se le muestra al usuario.

const DOMINIO_INTERNO = 'cartera.local';
const ROLES = ['admin', 'cobrador'];

// El usuario va en la parte izquierda de un correo, así que se limita a lo que
// es válido ahí y además se normaliza a minúsculas (el índice único es sobre
// lower(usuario), así que "Juan" y "juan" son el mismo).
function normalizarUsuario(valor) {
  return String(valor || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function correoInterno(usuario) {
  return `${usuario}@${DOMINIO_INTERNO}`;
}

async function listarUsuarios() {
  const { data, error } = await supabaseAdmin
    .from('usuarios')
    .select('id, usuario, nombre_completo, email, telefono, rol, activo, callmebot_apikey, creado_en')
    .order('creado_en', { ascending: true });
  if (error) throw error;

  // Nunca se devuelve la apikey a la vista: solo si está puesta o no.
  return (data || []).map((u) => ({
    ...u,
    tieneWhatsApp: !!(u.telefono && u.callmebot_apikey),
    callmebot_apikey: undefined,
  }));
}

async function obtenerUsuario(id) {
  const { data, error } = await supabaseAdmin
    .from('usuarios')
    .select('id, usuario, nombre_completo, email, telefono, rol, activo, callmebot_apikey, creado_en')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Busca por identificador de login: acepta el usuario o el correo de Auth.
// Aceptar el correo evita dejar fuera a las cuentas creadas antes de que
// existiera el campo `usuario`.
//
// El identificador viene del formulario de login, así que NO se interpola crudo
// en un filtro .or(): las comas y paréntesis son sintaxis de PostgREST y
// permitirían reescribir la condición. Se limita a los caracteres válidos de un
// usuario o un correo, y las dos búsquedas van por separado.
async function buscarPorIdentificador(identificador) {
  const id = String(identificador || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@+-]/g, '')
    .slice(0, 120);
  if (!id) return null;

  const columnas = 'id, usuario, email_auth, nombre_completo, telefono, rol, activo, callmebot_apikey';

  const { data: porUsuario } = await supabaseAdmin
    .from('usuarios').select(columnas).eq('usuario', id).maybeSingle();
  if (porUsuario) return porUsuario;

  const { data: porCorreo } = await supabaseAdmin
    .from('usuarios').select(columnas).eq('email_auth', id).maybeSingle();
  return porCorreo || null;
}

async function crearUsuario({ usuario, nombre_completo, email, telefono, rol, password, callmebot_apikey, actorId }) {
  const user = normalizarUsuario(usuario);
  if (!user) throw Object.assign(new Error('El nombre de usuario no es válido.'), { status: 400 });
  if (!ROLES.includes(rol)) throw Object.assign(new Error('Rol inválido.'), { status: 400 });
  if (!password || password.length < 8) {
    throw Object.assign(new Error('La contraseña debe tener al menos 8 caracteres.'), { status: 400 });
  }

  const { data: existe } = await supabaseAdmin
    .from('usuarios').select('id').eq('usuario', user).maybeSingle();
  if (existe) throw Object.assign(new Error(`El usuario "${user}" ya existe. Elige otro.`), { status: 409 });

  const emailAuth = correoInterno(user);

  // 1) Cuenta de Auth con el correo sintético. email_confirm evita que Supabase
  //    intente mandar un correo de verificación a un dominio que no existe.
  const { data: creado, error: errorAuth } = await supabaseAdmin.auth.admin.createUser({
    email: emailAuth,
    password,
    email_confirm: true,
    user_metadata: { nombre_completo, rol },
  });
  if (errorAuth) throw Object.assign(new Error(`No se pudo crear la cuenta: ${errorAuth.message}`), { status: 400 });

  // 2) Fila en usuarios. El trigger handle_new_user ya pudo crear una fila
  //    básica, así que se hace upsert en vez de insert.
  const { error: errorPerfil } = await supabaseAdmin
    .from('usuarios')
    .upsert({
      id: creado.user.id,
      usuario: user,
      email_auth: emailAuth,
      nombre_completo: (nombre_completo || '').trim(),
      email: (email || '').trim() || null,     // correo REAL, puede repetirse
      telefono: (telefono || '').trim() || null,
      callmebot_apikey: (callmebot_apikey || '').trim() || null,
      rol,
      activo: true,
    }, { onConflict: 'id' });

  if (errorPerfil) {
    // Si el perfil falla, no dejar una cuenta de Auth huérfana que nadie podría
    // usar (el middleware exige fila en usuarios para dejar entrar).
    await supabaseAdmin.auth.admin.deleteUser(creado.user.id).catch(() => {});
    throw errorPerfil;
  }

  await auditoria.registrar({
    tipo: 'usuario_creado',
    descripcion: `Usuario creado: ${user} (${rol}).`,
    detalle: { usuario: user, rol, nombre_completo },
    actorId,
  });

  return { id: creado.user.id, usuario: user };
}

async function editarUsuario(id, { nombre_completo, email, telefono, rol, callmebot_apikey }, actorId) {
  if (rol && !ROLES.includes(rol)) throw Object.assign(new Error('Rol inválido.'), { status: 400 });

  const cambios = {
    nombre_completo: (nombre_completo || '').trim(),
    email: (email || '').trim() || null,
    telefono: (telefono || '').trim() || null,
  };
  if (rol) cambios.rol = rol;
  // Una apikey vacía no borra la que ya había: para quitarla se manda '-'.
  if (callmebot_apikey !== undefined && callmebot_apikey !== '') {
    cambios.callmebot_apikey = callmebot_apikey === '-' ? null : callmebot_apikey.trim();
  }

  const { error } = await supabaseAdmin.from('usuarios').update(cambios).eq('id', id);
  if (error) throw error;

  await auditoria.registrar({
    tipo: 'usuario_editado',
    descripcion: `Datos de usuario actualizados: ${nombre_completo || id}.`,
    detalle: { usuario_id: id, ...cambios, callmebot_apikey: undefined },
    actorId,
  });
}

// Activa o desactiva. Un usuario inactivo no pasa requireAuth aunque su
// contraseña siga siendo válida.
async function cambiarEstado(id, actorId) {
  const { data: u, error: e1 } = await supabaseAdmin
    .from('usuarios').select('activo, usuario').eq('id', id).single();
  if (e1) throw e1;

  const nuevo = !u.activo;
  const { error } = await supabaseAdmin.from('usuarios').update({ activo: nuevo }).eq('id', id);
  if (error) throw error;

  await auditoria.registrar({
    tipo: nuevo ? 'usuario_activado' : 'usuario_desactivado',
    descripcion: `Usuario ${u.usuario} ${nuevo ? 'activado' : 'desactivado'}.`,
    detalle: { usuario_id: id },
    actorId,
  });

  return nuevo;
}

// Restablece la contraseña desde el panel de administración.
async function establecerPassword(id, password, actorId) {
  if (!password || password.length < 8) {
    throw Object.assign(new Error('La contraseña debe tener al menos 8 caracteres.'), { status: 400 });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
  if (error) throw error;

  // Cualquier código de recuperación pendiente deja de servir.
  await supabaseAdmin.from('codigos_recuperacion')
    .update({ usado_en: new Date().toISOString() })
    .eq('usuario_id', id).is('usado_en', null);

  await auditoria.registrar({
    tipo: 'usuario_clave_restablecida',
    descripcion: 'Contraseña restablecida por un administrador.',
    detalle: { usuario_id: id },
    actorId,
  });
}

// --- Cuenta propia (lo que cada usuario puede hacer sobre sí mismo) ---

// Edita los datos de uno mismo.
//
// NO acepta `rol` ni `activo` a propósito: si llegaran desde el formulario, un
// usuario podría ascenderse a administrador editando su propio perfil. Los
// permisos solo se cambian desde la gestión de usuarios, que es admin-only.
async function editarPerfilPropio(id, { nombre_completo, email, telefono, numero_documento, callmebot_apikey }) {
  const cambios = {
    nombre_completo: (nombre_completo || '').trim(),
    email: (email || '').trim() || null,
    telefono: (telefono || '').trim() || null,
    numero_documento: (numero_documento || '').trim() || null,
  };
  // Vacío = no tocar la apikey que ya hubiera; '-' = borrarla.
  if (callmebot_apikey !== undefined && callmebot_apikey !== '') {
    cambios.callmebot_apikey = callmebot_apikey === '-' ? null : callmebot_apikey.trim();
  }

  const { error } = await supabaseAdmin.from('usuarios').update(cambios).eq('id', id);
  if (error) throw error;

  await auditoria.registrar({
    tipo: 'usuario_editado',
    descripcion: 'Un usuario actualizó sus propios datos.',
    detalle: { usuario_id: id, ...cambios, callmebot_apikey: undefined },
    actorId: id,
  });
}

// Cambia la contraseña propia EXIGIENDO la actual.
//
// Pedir la contraseña actual no es burocracia: sin ella, a quien robe una sesión
// (una cookie, un equipo desbloqueado) le bastaría con cambiar la clave para
// quedarse con la cuenta y dejar fuera al dueño. Con ella, necesita además saber
// la contraseña.
async function cambiarPasswordPropia(id, passwordActual, passwordNueva) {
  const error = (m) => Object.assign(new Error(m), { status: 400 });

  if (!passwordNueva || passwordNueva.length < 8) {
    throw error('La contraseña nueva debe tener al menos 8 caracteres.');
  }
  if (passwordActual === passwordNueva) {
    throw error('La contraseña nueva debe ser distinta de la actual.');
  }

  const { data: perfil, error: e1 } = await supabaseAdmin
    .from('usuarios').select('email_auth, usuario').eq('id', id).single();
  if (e1 || !perfil?.email_auth) throw error('No se pudo verificar tu cuenta.');

  // La única forma de comprobar la contraseña actual es intentar autenticarse
  // con ella. Se usa el cliente anon: signInWithPassword no existe en el admin.
  const { supabaseAnon } = require('../config/supabase');
  const { error: errorLogin } = await supabaseAnon.auth.signInWithPassword({
    email: perfil.email_auth,
    password: passwordActual || '',
  });
  if (errorLogin) throw error('La contraseña actual no es correcta.');

  const { error: e2 } = await supabaseAdmin.auth.admin.updateUserById(id, { password: passwordNueva });
  if (e2) throw error('No se pudo actualizar la contraseña. Intenta de nuevo.');

  // Cualquier código de recuperación pendiente deja de tener sentido.
  await supabaseAdmin.from('codigos_recuperacion')
    .update({ usado_en: new Date().toISOString() })
    .eq('usuario_id', id).is('usado_en', null);

  await auditoria.registrar({
    tipo: 'usuario_clave_cambiada',
    descripcion: `${perfil.usuario} cambió su propia contraseña.`,
    detalle: { usuario_id: id },
    actorId: id,
  });
}

// Contraseña temporal legible: se le dicta al empleado de viva voz.
// Se evitan caracteres ambiguos (0/O, 1/l/I) para que no haya errores al
// dictarla por teléfono.
function generarPasswordTemporal() {
  const abc = 'abcdefghijkmnpqrstuvwxyz';
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const num = '23456789';
  const pick = (s) => s[crypto.randomInt(s.length)];
  let out = [pick(ABC), pick(abc), pick(abc), pick(abc), pick(num), pick(num), pick(abc), pick(num)];
  return out.join('');
}

module.exports = {
  ROLES,
  normalizarUsuario,
  correoInterno,
  listarUsuarios,
  obtenerUsuario,
  buscarPorIdentificador,
  crearUsuario,
  editarUsuario,
  cambiarEstado,
  establecerPassword,
  editarPerfilPropio,
  cambiarPasswordPropia,
  generarPasswordTemporal,
};
