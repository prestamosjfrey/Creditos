-- =====================================================================
-- AISLAMIENTO DE DATOS POR USUARIO
--
-- Cada usuario (staff) ve SOLO lo suyo: sus préstamos, pagos, caja, créditos
-- tomados, documentos y notas. Lo ÚNICO compartido entre usuarios es la lista
-- de CLIENTES (una sola cartera de clientes para todos).
--
-- El aislamiento se aplica en la aplicación (que usa service_role y saltea RLS):
-- cada consulta filtra por el usuario dueño. Este archivo prepara la base para
-- que ese filtrado sea correcto y rápido:
--   1. tabla de notas privadas por usuario (la columna clientes.notas_admin era
--      una sola, no servía para notas distintas por usuario);
--   2. índices sobre las columnas de "dueño" (creado_por / registrado_por /
--      subido_por / actor_id) para que filtrar por usuario sea barato;
--   3. la vista de cartera expone creado_por para poder filtrarla;
--   4. saldo_caja y conteo_bitacora aceptan un usuario opcional.
--
-- Es idempotente. Ejecutar en Supabase → SQL Editor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) NOTAS privadas por usuario sobre un cliente compartido.
--    (cliente_id, usuario_id) es único: una nota por usuario y cliente.
-- ---------------------------------------------------------------------
create table if not exists public.notas_cliente (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  texto text,
  actualizado_en timestamptz not null default now(),
  unique (cliente_id, usuario_id)
);
create index if not exists idx_notas_cliente on public.notas_cliente(cliente_id, usuario_id);

alter table public.notas_cliente enable row level security;
-- Sin políticas: solo el backend (service role) accede.

-- ---------------------------------------------------------------------
-- 2) Índices sobre las columnas de dueño (para filtrar por usuario rápido).
-- ---------------------------------------------------------------------
create index if not exists idx_prestamos_creado_por on public.prestamos(creado_por);
create index if not exists idx_movimientos_caja_registrado_por on public.movimientos_caja(registrado_por);
create index if not exists idx_creditos_tomados_creado_por on public.creditos_tomados(creado_por);
create index if not exists idx_documentos_cliente_subido_por on public.documentos_cliente(subido_por);
create index if not exists idx_bitacora_actor on public.bitacora(actor_id);
create index if not exists idx_pagos_credito_tomado_registrado_por on public.pagos_credito_tomado(registrado_por);

-- ---------------------------------------------------------------------
-- 3) La vista de cartera expone creado_por, para poder filtrar por dueño.
--    (p.id es PK, así que Postgres permite listar las demás columnas de p.)
--
--    Se BORRA y recrea (no "create or replace"): añadir creado_por en medio de
--    las columnas existentes haría que Postgres crea que se renombra otra
--    columna, y "create or replace view" no permite reordenar. La vista no
--    guarda datos, así que borrarla no pierde nada.
-- ---------------------------------------------------------------------
drop view if exists public.vista_cartera;
create view public.vista_cartera as
select
  p.id as prestamo_id,
  p.cliente_id,
  p.creado_por,
  p.estado,
  p.monto_capital,
  p.monto_total_a_pagar,
  coalesce(sum(pg.monto), 0) as total_pagado,
  p.monto_total_a_pagar - coalesce(sum(pg.monto), 0) as saldo_pendiente
from public.prestamos p
left join public.pagos pg on pg.prestamo_id = p.id
group by p.id;

-- ---------------------------------------------------------------------
-- 4) saldo_caja ahora acepta un usuario opcional: null = todo (compatibilidad),
--    o el id de un usuario para ver solo SU caja.
-- ---------------------------------------------------------------------
create or replace function public.saldo_caja(p_usuario uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
  from movimientos_caja
  where p_usuario is null or registrado_por = p_usuario;
$$;

-- Conteo de bitácora por tipo, opcionalmente de un solo actor.
create or replace function public.conteo_bitacora_por_tipo(p_actor uuid default null)
returns table (tipo text, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  select tipo, count(*) as total
  from bitacora
  where p_actor is null or actor_id = p_actor
  group by tipo;
$$;

revoke all on function public.saldo_caja(uuid) from public, anon, authenticated;
revoke all on function public.conteo_bitacora_por_tipo(uuid) from public, anon, authenticated;
