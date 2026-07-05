require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function main() {
  const email = process.argv[2] || process.env.ADMIN_EMAIL;
  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';

  if (!email) {
    console.error('Define ADMIN_EMAIL en tu .env antes de ejecutar este script.');
    process.exit(1);
  }

  // Buscar el usuario en Supabase Auth por email
  const { data: lista, error: errLista } = await supabaseAdmin.auth.admin.listUsers();
  if (errLista) { console.error('Error listando usuarios:', errLista.message); process.exit(1); }

  const usuario = lista.users.find((u) => u.email === email);
  if (!usuario) {
    console.error(`No se encontró ningún usuario con email "${email}" en Supabase Auth.`);
    console.error('Ejecuta scripts/seed-admin.js para crearlo desde cero.');
    process.exit(1);
  }

  console.log(`Usuario encontrado: ${usuario.id}`);

  // Verificar si ya existe el perfil
  const { data: perfilExistente } = await supabaseAdmin
    .from('perfiles').select('id, activo, rol').eq('id', usuario.id).maybeSingle();

  if (perfilExistente) {
    // Existe pero quizás está inactivo
    const { error } = await supabaseAdmin
      .from('perfiles').update({ activo: true, rol: 'admin' }).eq('id', usuario.id);
    if (error) { console.error('Error actualizando perfil:', error.message); process.exit(1); }
    console.log('Perfil existente reparado: activo=true, rol=admin');
  } else {
    // No existe — insertar
    const { error } = await supabaseAdmin.from('perfiles').insert({
      id: usuario.id,
      nombre_completo: nombre,
      rol: 'admin',
      activo: true,
    });
    if (error) { console.error('Error insertando perfil:', error.message); process.exit(1); }
    console.log('Perfil de admin creado correctamente.');
  }

  console.log(`Listo. Puedes iniciar sesión con: ${email}`);
  process.exit(0);
}

main();
