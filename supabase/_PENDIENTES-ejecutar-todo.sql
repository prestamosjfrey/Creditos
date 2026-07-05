-- =====================================================================
-- MIGRACIONES PENDIENTES — ejecutar TODO este archivo de una sola vez en
-- el SQL editor de Supabase. Es seguro: todo usa "if not exists".
-- Reúne las 3 migraciones que faltan por aplicar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Notas y Documentos de la ficha del cliente
-- ---------------------------------------------------------------------
alter table public.perfiles add column if not exists notas_admin text;

create table if not exists public.documentos_cliente (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.perfiles(id) on delete cascade,
  nombre text not null,
  ruta_storage text not null,
  tipo_mime text,
  tamano_bytes bigint,
  subido_por uuid not null references public.perfiles(id),
  creado_en timestamptz not null default now()
);
create index if not exists idx_documentos_cliente on public.documentos_cliente(cliente_id);
alter table public.documentos_cliente enable row level security;
do $$ begin
  create policy "documentos_cliente_admin_todo" on public.documentos_cliente for all using (public.es_admin());
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2) dias_atraso por cuota (combustible del score de crédito)
-- ---------------------------------------------------------------------
alter table public.cuotas add column if not exists dias_atraso int;

-- ---------------------------------------------------------------------
-- 3) Bitácora de auditoría (append-only)
-- ---------------------------------------------------------------------
create table if not exists public.bitacora (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,
  descripcion text not null,
  prestamo_id uuid references public.prestamos(id) on delete set null,
  cliente_id uuid references public.perfiles(id) on delete set null,
  detalle jsonb,
  actor_id uuid references public.perfiles(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index if not exists idx_bitacora_creado_en on public.bitacora(creado_en desc);
create index if not exists idx_bitacora_prestamo on public.bitacora(prestamo_id);
create index if not exists idx_bitacora_cliente on public.bitacora(cliente_id);
alter table public.bitacora enable row level security;
do $$ begin
  create policy "bitacora_admin_lee" on public.bitacora for select using (public.es_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "bitacora_admin_inserta" on public.bitacora for insert with check (public.es_admin());
exception when duplicate_object then null; end $$;
