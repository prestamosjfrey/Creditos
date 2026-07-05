-- Corrige columnas de tokens internos de auth.users que quedaron en NULL
-- (causa del error "Database error querying schema" al iniciar sesión).
-- Necesario porque el INSERT manual de seed-test-user.sql no las definió.
update auth.users
set
  confirmation_token = coalesce(confirmation_token, ''),
  recovery_token = coalesce(recovery_token, ''),
  email_change_token_new = coalesce(email_change_token_new, ''),
  email_change = coalesce(email_change, ''),
  phone_change = coalesce(phone_change, ''),
  phone_change_token = coalesce(phone_change_token, ''),
  reauthentication_token = coalesce(reauthentication_token, '')
where email = 'correo@correo.com';
