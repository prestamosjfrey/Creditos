// Validación de configuración al arrancar.
//
// Antes, si faltaba una variable el proceso arrancaba igual y fallaba más tarde
// de formas confusas: config/supabase.js solo imprimía un console.warn y seguía,
// así que el servidor quedaba "vivo" pero incapaz de leer la base — y las
// cookies firmadas fallaban en el primer request. Es preferible no arrancar.

const REQUERIDAS = [
  ['SUPABASE_URL', 'URL del proyecto Supabase'],
  ['SUPABASE_ANON_KEY', 'Llave pública (anon) de Supabase'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Llave de servicio de Supabase (solo servidor)'],
  ['SESSION_COOKIE_SECRET', 'Secreto para firmar cookies (mínimo 32 caracteres)'],
];

function validarEntorno() {
  const faltantes = REQUERIDAS.filter(([clave]) => !process.env[clave]);

  if (faltantes.length) {
    console.error('\n[config] Faltan variables de entorno obligatorias:\n');
    faltantes.forEach(([clave, desc]) => console.error(`  · ${clave} — ${desc}`));
    console.error('\nRevisa tu archivo .env (usa .env.example como plantilla).\n');
    process.exit(1);
  }

  // Un secreto corto hace que la firma de las cookies sea trivial de romper.
  if (process.env.SESSION_COOKIE_SECRET.length < 32) {
    console.error('\n[config] SESSION_COOKIE_SECRET es demasiado corto (mínimo 32 caracteres).');
    console.error('Genera uno con:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    process.exit(1);
  }

  // En producción las cookies viajan con `secure`, que exige HTTPS. Si NODE_ENV
  // no está en 'production', las cookies de sesión saldrían sin esa marca.
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[config] NODE_ENV no es "production": las cookies NO llevarán el flag Secure.');
  }
}

module.exports = { validarEntorno };
