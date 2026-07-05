-- =====================================================================
-- Número de préstamo CONSECUTIVO, guardado y único.
-- Cada préstamo recibe un número secuencial (1, 2, 3...) al crearse, y los
-- préstamos existentes se numeran por orden de creación.
-- Ejecutar en el SQL editor de Supabase.
-- =====================================================================

alter table public.prestamos add column if not exists numero bigint;

create sequence if not exists public.prestamos_numero_seq;

-- Numerar los préstamos existentes en orden de creación.
with ordenados as (
  select id, row_number() over (order by creado_en) as rn
  from public.prestamos
  where numero is null
)
update public.prestamos p
set numero = o.rn
from ordenados o
where p.id = o.id;

-- Avanzar la secuencia más allá de los números ya usados.
select setval(
  'public.prestamos_numero_seq',
  coalesce((select max(numero) from public.prestamos), 0) + 1,
  false
);

-- Los nuevos préstamos toman el siguiente número automáticamente.
alter table public.prestamos alter column numero set default nextval('public.prestamos_numero_seq');

create unique index if not exists idx_prestamos_numero on public.prestamos(numero);
