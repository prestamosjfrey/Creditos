-- Origen de la cuota
-- Marca las cuotas que NACIERON de una extensión por pago de solo interés,
-- para distinguirlas visualmente en el plan de cuotas.
-- ('normal' = cuota original del plan; 'extension' = cuota agregada al extender)

alter table cuotas add column if not exists origen text not null default 'normal';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cuotas_origen_check') then
    alter table cuotas add constraint cuotas_origen_check check (origen in ('normal', 'extension'));
  end if;
end $$;
