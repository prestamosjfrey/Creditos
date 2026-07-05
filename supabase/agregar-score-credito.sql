-- Score crediticio por cliente
-- Guarda el último score calculado (0-1000) y cuándo se actualizó.
-- Se recalcula automáticamente tras cada pago o cada vez que una cuota entra en mora.
alter table public.perfiles add column if not exists score_credito int;
alter table public.perfiles add column if not exists score_actualizado_en timestamptz;
