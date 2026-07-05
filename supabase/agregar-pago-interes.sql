-- Pago de solo interés
-- Distingue un abono normal de un pago de SOLO INTERÉS y deja registrada la
-- decisión tomada: extender el crédito un periodo más ('extension') o dejar el
-- capital como saldo pendiente de renegociación ('saldo').
-- (Las cuotas ya soportan el estado 'parcial', no hace falta tocarlas.)

alter table pagos add column if not exists tipo text not null default 'abono';
alter table pagos add column if not exists accion text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pagos_tipo_check') then
    alter table pagos add constraint pagos_tipo_check check (tipo in ('abono', 'interes'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pagos_accion_check') then
    alter table pagos add constraint pagos_accion_check check (accion is null or accion in ('extension', 'saldo'));
  end if;
end $$;
