-- =====================================================================
-- REVERTIR UN PAGO (abono o pago de solo interés) DE UN PRÉSTAMO
--
-- Deshace por completo un pago mal registrado, DESDE EL HISTORIAL DE ABONOS:
--   · las cuotas que cubrió vuelven a "por pagar" (se recalcula su estado),
--   · el dinero sale de la caja con un movimiento de AJUSTE (no se borra el
--     ingreso original: el libro de caja es histórico),
--   · si era una EXTENSIÓN (renegociación que añadió una cuota al final), se
--     borra esa cuota y se baja el total del préstamo,
--   · si el préstamo estaba "pagado", vuelve a "activo",
--   · queda un evento 'abono_revertido' en la bitácora con todo el detalle,
--   · y por último se borra el pago.
--
-- Todo dentro de una función = una transacción: o se revierte todo, o nada
-- (misma garantía de atomicidad que registrar_abono). El `for update` sobre el
-- préstamo serializa con abonos y otras reversiones simultáneas.
--
-- GUARDARRAÍL: los pagos se revierten del más nuevo al más viejo. Si intentas
-- revertir una extensión cuya cuota nueva ya tiene pagos (o se volvió a
-- extender), la función se niega y pide revertir primero lo posterior — así los
-- saldos nunca quedan descuadrados.
--
-- Ejecutar COMPLETO en el SQL editor de Supabase. Es idempotente.
-- =====================================================================

create or replace function public.revertir_pago(
  p_pago_id uuid,
  p_actor   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pago            record;
  v_prestamo        record;
  v_cliente_id      uuid;
  v_cliente         text;
  v_aplic           jsonb;
  v_ap              jsonb;
  v_cuota           record;
  v_aplicado        numeric;
  v_nuevo_pagado    numeric;
  v_nuevo_estado    text;
  v_bit             record;
  v_interes_agregado numeric;
  v_capital_diferido numeric;
  v_nueva_num       int;
  v_ext_cuota       record;
  v_ultimo          record;
  v_cuotas_txt      text;
  i                 int;
begin
  select * into v_pago from pagos where id = p_pago_id;
  if not found then
    raise exception 'El pago no existe.';
  end if;

  -- Cerrojo del préstamo (serializa con abonos y otras reversiones).
  select * into v_prestamo from prestamos where id = v_pago.prestamo_id for update;
  if not found then
    raise exception 'El préstamo no existe.';
  end if;

  v_cliente_id := v_prestamo.cliente_id;
  select nombre_completo into v_cliente from clientes where id = v_cliente_id;
  v_cliente := coalesce(v_cliente, 'cliente');

  -- GUARDARRAÍL DE ORDEN: solo se puede revertir el pago MÁS RECIENTE del
  -- préstamo. Si hay pagos posteriores, hay que revertirlos primero — así nunca
  -- queda un estado raro (p. ej. la cuota 4 pendiente con la 5 pagada) ni se
  -- descuadra la caja.
  select * into v_ultimo from pagos
   where prestamo_id = v_pago.prestamo_id
   order by creado_en desc, id desc
   limit 1;
  if v_ultimo.id <> p_pago_id then
    select string_agg(a ->> 'cuota_numero', ', ' order by (a ->> 'cuota_numero')::int)
      into v_cuotas_txt
      from jsonb_array_elements(coalesce(v_ultimo.distribucion -> 'aplicaciones', '[]'::jsonb)) as a;
    raise exception
      'Para no descuadrar, revierte los pagos del más reciente al más antiguo. Primero va el pago de la(s) cuota(s) % (del % por %).',
      coalesce(v_cuotas_txt, '—'), v_ultimo.fecha_pago, formato_cop(v_ultimo.monto);
  end if;

  v_aplic := coalesce(v_pago.distribucion -> 'aplicaciones', '[]'::jsonb);

  -- ------------------------------------------------------------------
  -- CASO EXTENSIÓN: además de revertir la cuota, deshace la cuota nueva
  -- y baja el total del préstamo.
  -- ------------------------------------------------------------------
  if v_pago.tipo = 'interes' and v_pago.accion = 'extension' then
    -- Datos de la extensión (se guardaron en la bitácora del pago).
    select * into v_bit from bitacora
     where tipo = 'pago_interes' and (detalle ->> 'pago_id') = p_pago_id::text
     order by creado_en desc limit 1;
    if not found then
      raise exception 'No se encuentra el registro de la extensión; no se puede revertir con seguridad.';
    end if;

    v_interes_agregado := coalesce((v_bit.detalle ->> 'interes_agregado')::numeric, 0);
    v_capital_diferido := coalesce((v_bit.detalle ->> 'capital_diferido')::numeric, 0);
    v_nueva_num        := (v_bit.detalle ->> 'nueva_cuota_numero')::int;

    -- La cuota nueva de la extensión debe seguir intacta (sin pagos). Si ya se
    -- pagó o se volvió a extender, hay que revertir primero lo posterior.
    select * into v_ext_cuota from cuotas
     where prestamo_id = v_prestamo.id and numero_cuota = v_nueva_num
     order by id desc limit 1
     for update;
    if not found then
      raise exception 'La cuota generada por la extensión ya no existe; revierte primero los pagos posteriores.';
    end if;
    if v_ext_cuota.monto_pagado > 0 or v_ext_cuota.estado = 'pagada' then
      raise exception 'La cuota #% de la extensión ya tiene pagos; revierte primero los pagos posteriores.', v_nueva_num;
    end if;

    -- Borrar la cuota nueva y bajar el préstamo.
    delete from cuotas where id = v_ext_cuota.id;

    update prestamos
       set numero_cuotas       = numero_cuotas - 1,
           monto_total_a_pagar = monto_total_a_pagar - v_interes_agregado,
           valor_interes       = coalesce(valor_interes, 0) - v_interes_agregado,
           estado              = case when estado = 'pagado' then 'activo' else estado end,
           actualizado_en      = now()
     where id = v_prestamo.id;

    -- Restaurar la cuota original: su esperado había bajado a lo pagado; se le
    -- devuelve el capital diferido y se le quita lo aplicado por este pago.
    v_ap := v_aplic -> 0;
    if v_ap is not null then
      v_aplicado := coalesce((v_ap ->> 'monto_aplicado')::numeric, 0);
      select * into v_cuota from cuotas where id = (v_ap ->> 'cuota_id')::uuid for update;
      if found then
        v_nuevo_pagado := round(greatest(0, v_cuota.monto_pagado - v_aplicado), 2);
        update cuotas
           set monto_esperado = round(v_cuota.monto_esperado + v_capital_diferido, 2),
               monto_pagado   = v_nuevo_pagado,
               dias_atraso    = null,
               estado         = case
                                  when v_nuevo_pagado <= 0 then
                                    (case when v_cuota.fecha_vencimiento < current_date then 'vencida' else 'pendiente' end)
                                  when v_nuevo_pagado >= round(v_cuota.monto_esperado + v_capital_diferido, 2) then 'pagada'
                                  else 'parcial'
                                end
         where id = v_cuota.id;
      end if;
    end if;

  else
    -- ----------------------------------------------------------------
    -- CASO ABONO NORMAL o INTERÉS 'saldo': deshace cada aplicación.
    -- ----------------------------------------------------------------
    for i in 0 .. coalesce(jsonb_array_length(v_aplic), 1) - 1 loop
      v_ap := v_aplic -> i;
      continue when v_ap is null;

      select * into v_cuota from cuotas where id = (v_ap ->> 'cuota_id')::uuid for update;
      continue when not found;

      v_aplicado     := coalesce((v_ap ->> 'monto_aplicado')::numeric, 0);
      v_nuevo_pagado := round(greatest(0, v_cuota.monto_pagado - v_aplicado), 2);
      v_nuevo_estado := case
                          when v_nuevo_pagado <= 0 then
                            (case when v_cuota.fecha_vencimiento < current_date then 'vencida' else 'pendiente' end)
                          when v_nuevo_pagado >= v_cuota.monto_esperado then 'pagada'
                          else 'parcial'
                        end;

      update cuotas
         set monto_pagado = v_nuevo_pagado,
             estado       = v_nuevo_estado,
             dias_atraso  = case when v_nuevo_estado = 'pagada' then dias_atraso else null end
       where id = v_cuota.id;
    end loop;

    -- Si estaba pagado por completo, reabrir.
    update prestamos
       set estado = case when estado = 'pagado' then 'activo' else estado end,
           actualizado_en = now()
     where id = v_prestamo.id;
  end if;

  -- ------------------------------------------------------------------
  -- Ajuste de caja: el dinero que había entrado con este pago sale de la
  -- caja (se compensa el ingreso original, que se conserva).
  -- ------------------------------------------------------------------
  insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
  values (
    'egreso', v_pago.monto,
    'Ajuste: reversión de un ' ||
      case when v_pago.tipo = 'interes' then 'pago de solo interés' else 'abono' end ||
      ' de ' || v_cliente || ' (' || formato_cop(v_pago.monto) || ')',
    'ajuste', v_prestamo.id, p_actor
  );

  -- Auditoría ANTES de borrar el pago (único rastro que quedará).
  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'abono_revertido',
    'Se revirtió un ' ||
      case when v_pago.tipo = 'interes' then 'pago de solo interés' else 'abono' end ||
      ' de ' || formato_cop(v_pago.monto) || ' de ' || v_cliente ||
      '. La caja se ajustó y las cuotas volvieron a por pagar.',
    v_prestamo.id, v_cliente_id,
    jsonb_build_object(
      'pago_id', p_pago_id, 'monto', v_pago.monto, 'tipo', v_pago.tipo,
      'accion', v_pago.accion, 'fecha_pago', v_pago.fecha_pago,
      'metodo', v_pago.metodo, 'distribucion', v_pago.distribucion
    ),
    p_actor
  );

  -- Borrar el pago (queda el rastro completo en la bitácora).
  delete from pagos where id = p_pago_id;
end $$;

revoke all on function public.revertir_pago(uuid, uuid) from public, anon, authenticated;
