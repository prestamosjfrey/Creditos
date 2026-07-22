-- =====================================================================
-- EDICIÓN Y ELIMINACIÓN DE PRÉSTAMOS
--
-- Permite corregir un crédito ya creado: cambiar el valor o la fecha de una
-- cuota pendiente, cambiar el total a pagar / número de cuotas, o eliminar el
-- crédito por completo devolviendo el dinero a la caja.
--
-- Todo ocurre dentro de funciones (= una transacción cada una) y todo queda
-- registrado en la bitácora. Las cuotas YA PAGADAS nunca se tocan: representan
-- dinero recibido y un comprobante ya entregado al cliente.
--
-- Ejecutar en Supabase → SQL Editor. Es idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) La bitácora debe SOBREVIVIR al borrado del préstamo.
--
--    bitacora.prestamo_id referencia a prestamos SIN "on delete", que en
--    Postgres equivale a NO ACTION: la base impediría borrar cualquier préstamo
--    que tenga historial... es decir, todos. Con ON DELETE SET NULL la fila de
--    auditoría se conserva (su descripción ya dice qué pasó) y solo pierde el
--    enlace al préstamo que dejó de existir.
-- ---------------------------------------------------------------------
alter table public.bitacora drop constraint if exists bitacora_prestamo_id_fkey;
alter table public.bitacora
  add constraint bitacora_prestamo_id_fkey
  foreign key (prestamo_id) references public.prestamos(id) on delete set null;


-- ---------------------------------------------------------------------
-- 1) EDITAR UNA CUOTA (valor y/o fecha de vencimiento)
--
-- Solo cuotas NO pagadas. Al cambiar el valor, el total del préstamo se ajusta
-- por la diferencia, para que "total a pagar" siga siendo la suma de las cuotas.
-- ---------------------------------------------------------------------
create or replace function public.editar_cuota(
  p_cuota_id uuid,
  p_monto    numeric,
  p_fecha    date,
  p_actor    uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuota    record;
  v_prestamo record;
  v_delta    numeric;
  v_estado   text;
begin
  select * into v_cuota from cuotas where id = p_cuota_id;
  if not found then
    raise exception 'La cuota no existe.';
  end if;

  -- Cerrojo sobre el préstamo: evita que un abono simultáneo y esta edición se
  -- pisen (el abono también bloquea el préstamo).
  select * into v_prestamo from prestamos where id = v_cuota.prestamo_id for update;

  if v_cuota.estado = 'pagada' then
    raise exception 'No se puede editar una cuota que ya está pagada.';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'El valor de la cuota debe ser mayor que cero.';
  end if;
  -- Si ya recibió abonos parciales, el nuevo valor no puede ser menor: dejaría
  -- la cuota "pagada de más".
  if p_monto < v_cuota.monto_pagado then
    raise exception 'El valor no puede ser menor a lo ya abonado en esa cuota (%).', v_cuota.monto_pagado;
  end if;

  v_delta  := p_monto - v_cuota.monto_esperado;
  v_estado := case when v_cuota.monto_pagado >= p_monto then 'pagada'
                   when v_cuota.monto_pagado > 0        then 'parcial'
                   when p_fecha < current_date          then 'vencida'
                   else 'pendiente' end;

  update cuotas
     set monto_esperado = p_monto,
         fecha_vencimiento = p_fecha,
         estado = v_estado
   where id = p_cuota_id;

  -- El total del préstamo sigue a la suma de sus cuotas.
  update prestamos
     set monto_total_a_pagar = monto_total_a_pagar + v_delta,
         actualizado_en = now()
   where id = v_cuota.prestamo_id;

  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'prestamo_editado',
    'Cuota #' || v_cuota.numero_cuota || ' modificada: valor ' ||
      formato_cop(v_cuota.monto_esperado) || ' → ' || formato_cop(p_monto) ||
      ', vence ' || v_cuota.fecha_vencimiento || ' → ' || p_fecha || '.',
    v_cuota.prestamo_id,
    v_prestamo.cliente_id,
    jsonb_build_object(
      'cuota_id', p_cuota_id,
      'numero_cuota', v_cuota.numero_cuota,
      'monto_anterior', v_cuota.monto_esperado, 'monto_nuevo', p_monto,
      'fecha_anterior', v_cuota.fecha_vencimiento, 'fecha_nueva', p_fecha,
      'total_anterior', v_prestamo.monto_total_a_pagar,
      'total_nuevo', v_prestamo.monto_total_a_pagar + v_delta
    ),
    p_actor
  );
end $$;


-- ---------------------------------------------------------------------
-- 2) EDITAR EL PLAN (total a pagar y/o número de cuotas)
--
-- Las cuotas pagadas se conservan intactas. Las pendientes se regeneran: el
-- saldo que falta se reparte entre ellas y las fechas siguen la rejilla original
-- del préstamo (fecha_de_cuota).
-- ---------------------------------------------------------------------
create or replace function public.editar_plan_prestamo(
  p_prestamo_id   uuid,
  p_total         numeric,
  p_numero_cuotas int,
  p_actor         uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prestamo       record;
  v_pagadas        int;
  v_suma_pagadas   numeric;
  v_restantes      int;
  v_saldo          numeric;
  v_valor          numeric;
  v_acumulado      numeric := 0;
  v_monto          numeric;
  i                int;
begin
  select * into v_prestamo from prestamos where id = p_prestamo_id for update;
  if not found then
    raise exception 'El préstamo no existe.';
  end if;

  select count(*), coalesce(sum(monto_esperado), 0)
    into v_pagadas, v_suma_pagadas
    from cuotas where prestamo_id = p_prestamo_id and estado = 'pagada';

  if p_numero_cuotas < v_pagadas then
    raise exception 'No puede haber menos cuotas (%) que las ya pagadas (%).', p_numero_cuotas, v_pagadas;
  end if;
  if p_numero_cuotas = v_pagadas then
    raise exception 'Todas las cuotas quedarían pagadas: usa un número mayor a %.', v_pagadas;
  end if;
  if p_total <= v_suma_pagadas then
    raise exception 'El total (%) debe ser mayor a lo ya cobrado (%).', p_total, v_suma_pagadas;
  end if;

  v_restantes := p_numero_cuotas - v_pagadas;
  v_saldo     := p_total - v_suma_pagadas;
  v_valor     := round(v_saldo / v_restantes);

  -- Fuera las pendientes: se van a regenerar. Los abonos que apuntaban a ellas
  -- quedan con cuota_id NULL (la FK es ON DELETE SET NULL) sin perder el pago.
  delete from cuotas where prestamo_id = p_prestamo_id and estado <> 'pagada';

  for i in 1..v_restantes loop
    -- La última absorbe el redondeo para que la suma cuadre exacto.
    v_monto := case when i = v_restantes then v_saldo - v_acumulado else v_valor end;
    v_acumulado := v_acumulado + v_monto;

    insert into cuotas (prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado)
    values (
      p_prestamo_id,
      v_pagadas + i,
      fecha_de_cuota(v_prestamo.fecha_primer_pago, v_prestamo.frecuencia_pago, v_pagadas + i - 1),
      v_monto,
      0,
      case when fecha_de_cuota(v_prestamo.fecha_primer_pago, v_prestamo.frecuencia_pago, v_pagadas + i - 1) < current_date
           then 'vencida' else 'pendiente' end
    );
  end loop;

  update prestamos
     set monto_total_a_pagar = p_total,
         numero_cuotas = p_numero_cuotas,
         valor_cuota = v_valor,
         estado = case when estado = 'pagado' then 'activo' else estado end,
         actualizado_en = now()
   where id = p_prestamo_id;

  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'prestamo_editado',
    'Plan del préstamo modificado: total ' || formato_cop(v_prestamo.monto_total_a_pagar) ||
      ' → ' || formato_cop(p_total) || ', cuotas ' || v_prestamo.numero_cuotas ||
      ' → ' || p_numero_cuotas || ' (' || v_pagadas || ' ya pagadas se conservaron).',
    p_prestamo_id,
    v_prestamo.cliente_id,
    jsonb_build_object(
      'total_anterior', v_prestamo.monto_total_a_pagar, 'total_nuevo', p_total,
      'cuotas_anterior', v_prestamo.numero_cuotas,      'cuotas_nuevo', p_numero_cuotas,
      'cuotas_pagadas_conservadas', v_pagadas,
      'cuotas_regeneradas', v_restantes
    ),
    p_actor
  );
end $$;


-- ---------------------------------------------------------------------
-- 3) ELIMINAR UN PRÉSTAMO (borra todo y devuelve el dinero a la caja)
--
-- Borra cuotas y pagos, y corrige la caja con movimientos de AJUSTE en vez de
-- borrar los originales: el libro de caja es un histórico y no se le quitan
-- líneas. El neto queda igual que si el préstamo nunca hubiera existido:
--   + capital prestado  (vuelve a estar disponible)
--   − abonos recibidos  (ese dinero ya no está cobrado)
-- ---------------------------------------------------------------------
create or replace function public.eliminar_prestamo(
  p_prestamo_id uuid,
  p_actor       uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prestamo  record;
  v_cliente   text;
  v_abonado   numeric;
  v_num_pagos int;
  v_ref       text;
begin
  select * into v_prestamo from prestamos where id = p_prestamo_id for update;
  if not found then
    raise exception 'El préstamo no existe.';
  end if;

  select coalesce(sum(monto), 0), count(*) into v_abonado, v_num_pagos
    from pagos where prestamo_id = p_prestamo_id;

  select nombre_completo into v_cliente from clientes where id = v_prestamo.cliente_id;
  v_cliente := coalesce(v_cliente, 'cliente');
  v_ref := coalesce('#PR-' || lpad(v_prestamo.numero::text, 5, '0'), 'sin número');

  -- La auditoría se escribe ANTES de borrar, con todo el detalle: es el único
  -- rastro que quedará del préstamo.
  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'prestamo_eliminado',
    'Préstamo ' || v_ref || ' de ' || v_cliente || ' ELIMINADO. Capital ' ||
      formato_cop(v_prestamo.monto_capital) || ', se habían abonado ' ||
      formato_cop(v_abonado) || ' en ' || v_num_pagos || ' pago(s). La caja se ajustó.',
    p_prestamo_id,
    v_prestamo.cliente_id,
    jsonb_build_object(
      'numero', v_prestamo.numero,
      'cliente', v_cliente,
      'monto_capital', v_prestamo.monto_capital,
      'monto_total_a_pagar', v_prestamo.monto_total_a_pagar,
      'abonado', v_abonado,
      'numero_pagos', v_num_pagos,
      'fecha_inicio', v_prestamo.fecha_inicio
    ),
    p_actor
  );

  -- Ajustes de caja (compensan los movimientos originales, que se conservan).
  insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
  values ('ingreso', v_prestamo.monto_capital,
          'Ajuste: devolución del capital por eliminar el préstamo ' || v_ref || ' de ' || v_cliente,
          'ajuste', p_prestamo_id, p_actor);

  if v_abonado > 0 then
    insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
    values ('egreso', v_abonado,
            'Ajuste: se revierten los abonos del préstamo eliminado ' || v_ref || ' de ' || v_cliente,
            'ajuste', p_prestamo_id, p_actor);
  end if;

  -- Orden obligatorio: pagos primero (su FK a prestamos es ON DELETE RESTRICT).
  delete from pagos  where prestamo_id = p_prestamo_id;
  delete from cuotas where prestamo_id = p_prestamo_id;
  delete from prestamos where id = p_prestamo_id;
end $$;


revoke all on function public.editar_cuota(uuid, numeric, date, uuid) from public, anon, authenticated;
revoke all on function public.editar_plan_prestamo(uuid, numeric, int, uuid) from public, anon, authenticated;
revoke all on function public.eliminar_prestamo(uuid, uuid) from public, anon, authenticated;
