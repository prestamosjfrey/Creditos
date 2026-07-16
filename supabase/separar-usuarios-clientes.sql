-- =====================================================================
-- Separar USUARIOS (staff que inicia sesión) de CLIENTES (prestatarios).
--   perfiles  ->  usuarios   (solo staff, atados a Supabase Auth)
--   clientes  ->  tabla NUEVA (datos puros, SIN cuenta de Auth)
-- Migra los clientes actuales conservando su id (los préstamos NO se tocan).
-- Ejecutar COMPLETO en el SQL editor de Supabase.
-- =====================================================================

begin;

-- 1) Tabla de clientes (prestatarios). auth_user_id queda reservado para un
--    futuro portal de cliente (null por ahora).
create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre_completo text not null default '',
  numero_documento text unique,
  telefono text,
  direccion text,
  email text,
  activo boolean not null default true,
  notas_admin text,
  score_credito int,
  score_actualizado_en timestamptz,
  auth_user_id uuid,
  creado_en timestamptz not null default now()
);

-- 2) Migrar los clientes existentes CONSERVANDO su id (para no romper FKs).
insert into public.clientes (id, nombre_completo, numero_documento, telefono, direccion, email, activo, notas_admin, score_credito, score_actualizado_en, creado_en)
select id, nombre_completo, numero_documento, telefono, direccion, email, coalesce(activo, true), notas_admin, score_credito, score_actualizado_en, coalesce(creado_en, now())
from public.perfiles
where rol = 'cliente'
on conflict (id) do nothing;

-- 3) Re-apuntar las FK de cliente (prestamos y documentos) hacia clientes.
alter table public.prestamos drop constraint if exists prestamos_cliente_id_fkey;
alter table public.prestamos add constraint prestamos_cliente_id_fkey
  foreign key (cliente_id) references public.clientes(id) on delete restrict;

alter table public.documentos_cliente drop constraint if exists documentos_cliente_cliente_id_fkey;
alter table public.documentos_cliente add constraint documentos_cliente_cliente_id_fkey
  foreign key (cliente_id) references public.clientes(id) on delete cascade;

-- La bitácora también guarda cliente_id (id de cliente). actor_id se queda
-- apuntando a usuarios (es staff), así que ese FK no se toca.
alter table public.bitacora drop constraint if exists bitacora_cliente_id_fkey;
alter table public.bitacora add constraint bitacora_cliente_id_fkey
  foreign key (cliente_id) references public.clientes(id) on delete set null;

-- 4) Borrar los clientes de perfiles y sus cuentas de Auth (limpieza).
delete from public.perfiles where rol = 'cliente';
delete from auth.users where id in (select id from public.clientes);

-- 5) Renombrar perfiles -> usuarios (solo staff) y ajustar el check de rol.
alter table public.perfiles rename to usuarios;
alter table public.usuarios drop constraint if exists perfiles_rol_check;
alter table public.usuarios add constraint usuarios_rol_check check (rol in ('admin','cobrador'));
alter table public.usuarios alter column rol set default 'admin';

-- 6) Actualizar la función es_admin() y el trigger de Auth (usaban 'perfiles').
create or replace function public.es_admin()
returns boolean language sql security definer stable as $$
  select exists (select 1 from public.usuarios where id = auth.uid() and rol = 'admin');
$$;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.usuarios (id, email, nombre_completo, rol)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'nombre_completo', ''),
    coalesce(new.raw_user_meta_data->>'rol', 'admin')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 7) RLS de clientes (solo admin; la app igual usa service role).
alter table public.clientes enable row level security;
create policy "clientes_admin_todo" on public.clientes for all using (public.es_admin());

commit;
