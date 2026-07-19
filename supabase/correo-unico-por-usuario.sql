-- =====================================================================
-- EL CORREO DE CONTACTO PASA A SER ÚNICO POR USUARIO
--
-- Antes se permitía repetirlo (varios empleados compartiendo el correo del
-- jefe), pero eso hacía imposible iniciar sesión con el correo: si dos usuarios
-- tienen el mismo, el sistema no sabe cuál entra. Haciéndolo único, el correo
-- vuelve a identificar a una sola persona y sirve para el login.
--
-- Detalles del índice:
--   · lower(email)      -> "Juan@X.com" y "juan@x.com" cuentan como el mismo.
--   · where email is not null -> el correo sigue siendo OPCIONAL. Varios
--     usuarios pueden no tener correo (NULL); la unicidad solo aplica a los que
--     sí lo tienen. (Un unique normal trataría cada NULL como distinto, pero se
--     deja explícito para que se entienda la intención.)
--
-- SI FALLA: significa que ya hay dos usuarios con el mismo correo. El error dirá
-- cuál está repetido; edita uno de ellos y vuelve a ejecutar.
--
-- Es idempotente. Ejecutar en Supabase → SQL Editor.
-- =====================================================================

create unique index if not exists idx_usuarios_email_unico
  on public.usuarios (lower(email))
  where email is not null;
