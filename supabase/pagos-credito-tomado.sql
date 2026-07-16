-- Historial de pagos de créditos tomados (para el "Historial de abonos" del
-- detalle, con método y cuotas cubiertas). Ejecutar una vez en Supabase.
create table if not exists public.pagos_credito_tomado (
  id uuid primary key default gen_random_uuid(),
  credito_id uuid not null references public.creditos_tomados(id) on delete cascade,
  monto numeric not null,
  metodo text,
  fecha_pago date,
  notas text,
  cuotas jsonb,               -- números de cuota que cubrió este pago
  registrado_por uuid,
  creado_en timestamptz not null default now()
);

create index if not exists idx_pagos_credito_tomado_credito
  on public.pagos_credito_tomado (credito_id, creado_en desc);
