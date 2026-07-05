-- =====================================================================
-- Bitácora de auditoría (append-only) — trazabilidad total de la cartera.
--
-- Una fila por cada acción relevante: préstamo creado, abono registrado,
-- cuota pagada, cuota en mora, préstamo pagado/cancelado, cliente
-- creado/editado/activado/desactivado, documento subido/eliminado, etc.
--
-- Diseño append-only: la app SOLO inserta (nunca update/delete sobre el
-- historial). Por eso solo damos políticas de SELECT e INSERT — no de
-- UPDATE ni DELETE.
--
-- `detalle` (jsonb) guarda el contexto del evento (montos, antes/después...).
-- `actor_id` es quién lo hizo (null = acción automática del sistema, ej. mora).
-- Ejecutar en el SQL editor de Supabase.
-- =====================================================================

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

-- Solo lectura e inserción para el admin. Sin update/delete = inmutable.
create policy "bitacora_admin_lee" on public.bitacora
  for select using (public.es_admin());
create policy "bitacora_admin_inserta" on public.bitacora
  for insert with check (public.es_admin());
