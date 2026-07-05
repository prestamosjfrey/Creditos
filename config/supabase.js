const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  console.warn(
    '[supabase] Faltan variables de entorno (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY). ' +
    'Configura tu archivo .env antes de usar el sistema.'
  );
}

// Cliente con anon key: solo para el flujo de login (signInWithPassword / getUser).
const supabaseAnon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Cliente con service role key: usado por todos los controladores para las
// queries de negocio. Bypassa RLS — el control de acceso real vive en los
// middlewares y controladores, no en la base de datos.
const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAnon, supabaseAdmin };
