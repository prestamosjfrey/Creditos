-- =====================================================================
-- Caja / "Disponible para préstamo": fondo real de efectivo disponible
-- para prestar. Es distinto de "Cartera activa" (que es lo que los
-- clientes te deben). Este es un libro de movimientos (como caja menor):
-- cada préstamo nuevo genera un egreso automático, cada abono recibido
-- genera un ingreso automático, y el admin puede registrar movimientos
-- manuales (ej. meter capital propio, retirar ganancias).
-- Ejecutar en el SQL editor de Supabase.
-- =====================================================================

create table public.movimientos_caja (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso', 'egreso')),
  monto numeric(14,2) not null check (monto > 0),
  concepto text not null,
  origen text not null check (origen in ('prestamo', 'pago', 'manual')),
  referencia_id uuid,
  registrado_por uuid not null references public.perfiles(id),
  creado_en timestamptz not null default now()
);

create index idx_movimientos_caja_creado_en on public.movimientos_caja(creado_en);

alter table public.movimientos_caja enable row level security;

create policy "movimientos_caja_admin_todo" on public.movimientos_caja
  for all using (public.es_admin());
