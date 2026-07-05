require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';

  if (!email || !password) {
    console.error('Define ADMIN_EMAIL y ADMIN_PASSWORD en tu .env antes de ejecutar este script.');
    process.exit(1);
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nombre_completo: nombre, rol: 'admin' },
  });

  if (error) {
    console.error('No se pudo crear el usuario admin:', error.message);
    process.exit(1);
  }

  // El trigger on_auth_user_created ya inserta la fila en perfiles con rol admin
  // (leído desde user_metadata.rol). Confirmamos por si acaso.
  await supabaseAdmin.from('perfiles').update({ rol: 'admin' }).eq('id', data.user.id);

  console.log(`Usuario admin creado: ${email} (id: ${data.user.id})`);
  process.exit(0);
}

main();
