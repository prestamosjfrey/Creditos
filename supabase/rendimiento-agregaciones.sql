-- =====================================================================
-- AGREGACIONES EN LA BASE  (corrige el hallazgo M3 de la auditoría)
--
-- Varias pantallas descargaban tablas completas a Node solo para sumarlas:
--   · obtenerSaldoDisponible() traía TODA movimientos_caja para un solo número.
--   · contarPorCategoria() traía TODA la bitácora para contar por tipo.
-- Con miles de préstamos y años de historial eso es cientos de miles de filas
-- por request. Postgres suma y cuenta mucho mejor, y devuelve solo el resultado.
--
-- Ejecutar COMPLETO en el SQL editor de Supabase.
-- =====================================================================

-- Saldo disponible para prestar = ingresos − egresos de todo el histórico.
create or replace function public.saldo_caja()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
  from movimientos_caja;
$$;

-- Conteo de eventos de la bitácora por tipo. El agrupado en categorías se hace
-- en Node (services/auditoria.service.js), que es donde vive ese catálogo.
create or replace function public.conteo_bitacora_por_tipo()
returns table (tipo text, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  select tipo, count(*) as total
  from bitacora
  group by tipo;
$$;

revoke all on function public.saldo_caja() from public, anon, authenticated;
revoke all on function public.conteo_bitacora_por_tipo() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- COLUMNAS QUE FALTAN EN `clientes` (desincronización de esquema)
--
-- El código escribe clientes.score_credito y clientes.score_actualizado_en
-- (services/score.service.js), pero esas columnas NO existen en la base: la
-- migración separar-usuarios-clientes.sql las declara dentro de un
-- `create table if not exists`, así que si la tabla ya existía, la creación se
-- saltó entera y las columnas nunca se añadieron.
--
-- Consecuencia observada: cada abono registrado intenta guardar el score, falla,
-- y score.service.js se traga el error (es fail-soft a propósito). El score se
-- recalcula al vuelo en cada visita a la ficha del cliente, pero NUNCA se
-- persiste — y nadie se entera.
-- ---------------------------------------------------------------------
alter table public.clientes add column if not exists score_credito int;
alter table public.clientes add column if not exists score_actualizado_en timestamptz;

-- Índices que faltaban para los filtros más usados de la aplicación.
create index if not exists idx_pagos_fecha_pago on public.pagos(fecha_pago);
create index if not exists idx_cuotas_vencimiento on public.cuotas(fecha_vencimiento);
create index if not exists idx_prestamos_fecha_inicio on public.prestamos(fecha_inicio);
create index if not exists idx_bitacora_creado_en on public.bitacora(creado_en desc);
create index if not exists idx_bitacora_tipo on public.bitacora(tipo);
create index if not exists idx_movimientos_caja_origen_ref on public.movimientos_caja(origen, referencia_id);
