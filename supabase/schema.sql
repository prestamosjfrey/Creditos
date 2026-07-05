-- =====================================================================
-- Esquema inicial: Sistema de gestión de préstamos personales
-- Ejecutar completo en el SQL editor de Supabase (proyecto nuevo, vacío).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PERFILES (extiende auth.users)
-- ---------------------------------------------------------------------
create table public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  rol text not null check (rol in ('admin', 'cliente')) default 'cliente',
  nombre_completo text not null default '',
  numero_documento text unique,
  telefono text,
  direccion text,
  email text,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.perfiles (id, email, nombre_completo, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nombre_completo', ''),
    coalesce(new.raw_user_meta_data->>'rol', 'cliente')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2. PRESTAMOS
-- ---------------------------------------------------------------------
create table public.prestamos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.perfiles(id) on delete restrict,
  creado_por uuid not null references public.perfiles(id),
  monto_capital numeric(14,2) not null check (monto_capital > 0),
  tipo_interes text not null check (tipo_interes in ('fijo_total', 'porcentaje_periodico', 'cuota_manual')),
  valor_interes numeric(14,2),
  tasa_interes numeric(6,3),
  monto_total_a_pagar numeric(14,2) not null check (monto_total_a_pagar > 0),
  numero_cuotas int not null check (numero_cuotas > 0),
  valor_cuota numeric(14,2) not null check (valor_cuota > 0),
  frecuencia_pago text not null check (frecuencia_pago in ('diario','semanal','quincenal','mensual')),
  fecha_inicio date not null,
  fecha_primer_pago date not null,
  estado text not null default 'activo' check (estado in ('activo','pagado','en_mora','cancelado')),
  notas text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index idx_prestamos_cliente on public.prestamos(cliente_id);
create index idx_prestamos_estado on public.prestamos(estado);

-- ---------------------------------------------------------------------
-- 3. CUOTAS (plan de pagos esperado)
-- ---------------------------------------------------------------------
create table public.cuotas (
  id uuid primary key default gen_random_uuid(),
  prestamo_id uuid not null references public.prestamos(id) on delete cascade,
  numero_cuota int not null,
  fecha_vencimiento date not null,
  monto_esperado numeric(14,2) not null check (monto_esperado > 0),
  monto_pagado numeric(14,2) not null default 0,
  estado text not null default 'pendiente' check (estado in ('pendiente','pagada','parcial','vencida')),
  unique (prestamo_id, numero_cuota)
);

create index idx_cuotas_prestamo on public.cuotas(prestamo_id);
create index idx_cuotas_estado_fecha on public.cuotas(estado, fecha_vencimiento);

-- ---------------------------------------------------------------------
-- 4. PAGOS (abonos reales registrados por el admin)
-- ---------------------------------------------------------------------
create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  prestamo_id uuid not null references public.prestamos(id) on delete restrict,
  cuota_id uuid references public.cuotas(id) on delete set null,
  registrado_por uuid not null references public.perfiles(id),
  monto numeric(14,2) not null check (monto > 0),
  fecha_pago date not null default current_date,
  metodo text check (metodo in ('efectivo','transferencia','nequi','daviplata','otro')),
  notas text,
  creado_en timestamptz not null default now()
);

create index idx_pagos_prestamo on public.pagos(prestamo_id);
create index idx_pagos_cuota on public.pagos(cuota_id);

-- ---------------------------------------------------------------------
-- 5. VISTA DE CARTERA (KPIs del dashboard)
-- ---------------------------------------------------------------------
create view public.vista_cartera as
select
  p.id as prestamo_id,
  p.cliente_id,
  p.estado,
  p.monto_capital,
  p.monto_total_a_pagar,
  coalesce(sum(pg.monto), 0) as total_pagado,
  p.monto_total_a_pagar - coalesce(sum(pg.monto), 0) as saldo_pendiente
from public.prestamos p
left join public.pagos pg on pg.prestamo_id = p.id
group by p.id;

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.perfiles enable row level security;
alter table public.prestamos enable row level security;
alter table public.cuotas enable row level security;
alter table public.pagos enable row level security;

create or replace function public.es_admin()
returns boolean
language sql security definer stable
as $$
  select exists (
    select 1 from public.perfiles where id = auth.uid() and rol = 'admin'
  );
$$;

-- perfiles
create policy "perfiles_select_propio_o_admin" on public.perfiles
  for select using (id = auth.uid() or public.es_admin());
create policy "perfiles_admin_todo" on public.perfiles
  for all using (public.es_admin());

-- prestamos
create policy "prestamos_select_propio_o_admin" on public.prestamos
  for select using (cliente_id = auth.uid() or public.es_admin());
create policy "prestamos_admin_inserta" on public.prestamos
  for insert with check (public.es_admin());
create policy "prestamos_admin_actualiza" on public.prestamos
  for update using (public.es_admin());

-- cuotas
create policy "cuotas_select_propio_o_admin" on public.cuotas
  for select using (
    public.es_admin() or
    exists (select 1 from public.prestamos pr where pr.id = cuotas.prestamo_id and pr.cliente_id = auth.uid())
  );
create policy "cuotas_admin_escribe" on public.cuotas
  for all using (public.es_admin());

-- pagos
create policy "pagos_select_propio_o_admin" on public.pagos
  for select using (
    public.es_admin() or
    exists (select 1 from public.prestamos pr where pr.id = pagos.prestamo_id and pr.cliente_id = auth.uid())
  );
create policy "pagos_admin_escribe" on public.pagos
  for all using (public.es_admin());
