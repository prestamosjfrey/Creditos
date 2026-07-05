-- =====================================================================
-- SOLO PARA DESARROLLO/PRUEBAS. No ejecutar en producción.
-- Crea un usuario cliente de prueba: correo@correo.com / password
-- El trigger on_auth_user_created (definido en schema.sql) crea
-- automáticamente la fila correspondiente en public.perfiles.
-- =====================================================================

create extension if not exists pgcrypto;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'correo@correo.com',
  crypt('password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"nombre_completo":"Cliente de Prueba","rol":"cliente"}',
  now(), now(), '', ''
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  id,
  id::text,
  jsonb_build_object('sub', id::text, 'email', email),
  'email',
  now(), now(), now()
from auth.users
where email = 'correo@correo.com';

-- Completar cédula/teléfono de prueba (opcional, el trigger ya creó la fila base):
update public.perfiles
set numero_documento = '1000000000', telefono = '3000000000'
where email = 'correo@correo.com';
