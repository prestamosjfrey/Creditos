-- =====================================================================
-- GESTIÓN DE USUARIOS (staff) + RECUPERACIÓN POR WHATSAPP
--
-- Ejecutar COMPLETO en el SQL editor de Supabase. Es idempotente.
--
-- QUÉ RESUELVE
-- ------------
-- 1) El correo debe poder REPETIRSE entre empleados (varios cobradores
--    comparten el correo del jefe). Supabase Auth exige correo único, así que
--    la identidad de login se separa del correo de contacto:
--
--      · usuarios.usuario     -> el identificador de login. ÚNICO.
--      · usuarios.email_auth  -> el correo (sintético) que ve Supabase. ÚNICO.
--      · usuarios.email       -> el correo REAL de contacto. Puede repetirse.
--
--    Para un empleado nuevo, email_auth se genera como usuario@cartera.local:
--    nunca se le escribe, solo existe para satisfacer a Supabase Auth.
--
-- 2) Recuperación de contraseña por WhatsApp (CallMeBot). Cada empleado tiene
--    SU propia apikey de CallMeBot (el servicio solo deja enviar a quien te
--    autorizó expresamente), guardada en usuarios.callmebot_apikey.
--
--    Se envía un CÓDIGO de 6 dígitos, no un enlace: un enlace de recuperación
--    es una credencial de acceso total y viajaría por un tercero gratuito. El
--    código caduca en 10 minutos, es de un solo uso y tiene tope de intentos.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Columnas nuevas en usuarios
-- ---------------------------------------------------------------------
alter table public.usuarios add column if not exists usuario text;
alter table public.usuarios add column if not exists email_auth text;
alter table public.usuarios add column if not exists callmebot_apikey text;

-- ---------------------------------------------------------------------
-- 2) Backfill de los usuarios que YA existen.
--    email_auth sale de su cuenta real de Auth; el usuario, de la parte
--    izquierda del correo. Así nadie se queda fuera al cambiar el login.
-- ---------------------------------------------------------------------
update public.usuarios u
   set email_auth = a.email
  from auth.users a
 where a.id = u.id
   and u.email_auth is null;

update public.usuarios u
   set usuario = lower(split_part(u.email_auth, '@', 1))
 where u.usuario is null
   and u.email_auth is not null;

-- El correo de contacto también se rellena con el de Auth si estaba vacío.
update public.usuarios u
   set email = u.email_auth
 where u.email is null;

-- ---------------------------------------------------------------------
-- 3) Unicidad SOLO donde toca.
--    `usuario` y `email_auth` son identificadores: únicos.
--    `email` (contacto real) NO lleva unique: debe poder repetirse.
-- ---------------------------------------------------------------------
create unique index if not exists idx_usuarios_usuario on public.usuarios(lower(usuario));
create unique index if not exists idx_usuarios_email_auth on public.usuarios(lower(email_auth));

-- ---------------------------------------------------------------------
-- 4) Limpieza: columnas de CLIENTE que quedaron en `usuarios`.
--    Vienen del rename perfiles -> usuarios: el score y las notas del cliente
--    se arrastraron a la tabla del staff, donde no significan nada. Es el
--    origen del bug de score_credito que faltaba en `clientes`.
--    Se borran solo si están vacías, para no perder nada por accidente.
--
--    OJO con la idempotencia: este bloque BORRA las columnas que consulta, así
--    que en una segunda pasada ya no existen. plpgsql analiza el SQL de un IF
--    al ejecutarlo — aunque la condición previa fuera falsa, mencionar una
--    columna inexistente revienta con "column does not exist". Por eso la
--    consulta va dentro de un EXECUTE (texto), que solo se analiza si de
--    verdad se llega a ejecutar.
-- ---------------------------------------------------------------------
do $$
declare
  v_tiene_datos boolean;
begin
  -- score_credito / score_actualizado_en
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'usuarios' and column_name = 'score_credito'
  ) then
    execute 'select exists (select 1 from public.usuarios where score_credito is not null)'
       into v_tiene_datos;
    if not v_tiene_datos then
      execute 'alter table public.usuarios drop column if exists score_credito';
      execute 'alter table public.usuarios drop column if exists score_actualizado_en';
      raise notice 'usuarios: columnas de score eliminadas (estaban vacías).';
    else
      raise notice 'usuarios.score_credito tiene datos: NO se elimina. Revísalo a mano.';
    end if;
  end if;

  -- notas_admin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'usuarios' and column_name = 'notas_admin'
  ) then
    execute 'select exists (select 1 from public.usuarios where notas_admin is not null)'
       into v_tiene_datos;
    if not v_tiene_datos then
      execute 'alter table public.usuarios drop column if exists notas_admin';
      raise notice 'usuarios: columna notas_admin eliminada (estaba vacía).';
    else
      raise notice 'usuarios.notas_admin tiene datos: NO se elimina. Revísalo a mano.';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5) Códigos de recuperación (OTP de un solo uso)
--
-- Nunca se guarda el código en claro: se guarda un HMAC. Si alguien leyera la
-- tabla, no podría deducir el código sin el secreto del servidor.
-- ---------------------------------------------------------------------
create table if not exists public.codigos_recuperacion (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  codigo_hash text not null,
  expira_en timestamptz not null,
  usado_en timestamptz,
  intentos int not null default 0,
  creado_en timestamptz not null default now()
);

create index if not exists idx_codigos_usuario on public.codigos_recuperacion(usuario_id, creado_en desc);

alter table public.codigos_recuperacion enable row level security;
-- Sin políticas: nadie llega por la API pública. Solo el backend (service role).

-- ---------------------------------------------------------------------
-- 6) El check de rol admite 'cobrador' (ya venía de la migración anterior),
--    y el rol por defecto de un usuario nuevo es cobrador, no admin: dar
--    permisos totales por omisión es justo lo contrario de lo que se quiere.
-- ---------------------------------------------------------------------
alter table public.usuarios alter column rol set default 'cobrador';

commit;
