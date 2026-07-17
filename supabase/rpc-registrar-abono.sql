-- =====================================================================
-- ABONOS ATÓMICOS  (corrige los hallazgos C2 y C3 de la auditoría)
--
-- PROBLEMA QUE RESUELVE
-- ---------------------
-- Registrar un abono tocaba 6+ tablas mediante llamadas HTTP sueltas desde
-- Node: insert en pagos → update de cada cuota → update de la distribución →
-- update del préstamo → insert en movimientos_caja → insert en bitacora.
--
--   C2 (atomicidad): si el proceso moría, la red fallaba o Supabase rechazaba
--   una llamada intermedia, el sistema quedaba a medias — cuotas marcadas como
--   pagadas SIN el ingreso en caja, o un pago sin distribución (comprobante
--   roto). Imposible de cuadrar contablemente.
--
--   C3 (concurrencia): el reparto leía monto_pagado, calculaba en JS y escribía.
--   Dos abonos simultáneos sobre el mismo préstamo (doble clic, dos pestañas,
--   un reintento) leían el MISMO saldo y ambos lo aplicaban: sobrepago silencioso
--   y doble ingreso en caja.
--
-- CÓMO LO RESUELVE
-- ----------------
-- Toda la operación vive dentro de esta función. En Postgres cada función es
-- una transacción: o se confirma todo, o no queda nada (C2).
-- Y el `select ... for update` sobre el préstamo serializa los abonos del mismo
-- préstamo: el segundo espera al primero y lee saldos ya actualizados (C3).
--
-- Además los cálculos se hacen en `numeric`, no en float de JavaScript, así que
-- desaparecen los errores de redondeo (hallazgo M2).
--
-- Ejecutar COMPLETO en el SQL editor de Supabase.
-- =====================================================================

-- Formatea un monto al estilo colombiano ("$ 1.500.000") para los textos de
-- la bitácora y de los movimientos de caja.
create or replace function public.formato_cop(monto numeric)
returns text language sql immutable as $$
  select '$ ' || replace(to_char(round(monto), 'FM999,999,999,999'), ',', '.');
$$;


-- Fecha de la cuota número p_indice (base 0), calculada SIEMPRE desde la fecha
-- del primer pago.
--
-- DEBE COINCIDIR EXACTAMENTE con fechaDeCuota() de utils/fechas.js y con su
-- espejo en public/js/prestamo-form.js. La regla del calendario vive en esos
-- tres sitios: servidor, vista previa del navegador y aquí (que la necesita al
-- diferir una cuota en el pago de solo interés).
--
-- Una quincena son 15 días, igual que una semana son 7: aritmética de calendario
-- pura, sin días fijos del mes ni rejilla 15/30. Ej.: 10/02 → 25/02 → 12/03.
--
-- Mensual va anclado al día original: un préstamo del día 31 se recorta al 28 en
-- febrero, pero en marzo vuelve al 31 (encadenando se quedaría en el 28).
create or replace function public.fecha_de_cuota(
  p_primer_pago date,
  p_frecuencia  text,
  p_indice      int
)
returns date
language plpgsql
immutable
as $$
declare
  v_mes date;
  v_ultimo int;
begin
  if p_frecuencia = 'diario'    then return p_primer_pago + p_indice; end if;
  if p_frecuencia = 'semanal'   then return p_primer_pago + (p_indice * 7); end if;
  if p_frecuencia = 'quincenal' then return p_primer_pago + (p_indice * 15); end if;

  if p_frecuencia = 'mensual' then
    v_mes    := (date_trunc('month', p_primer_pago) + (p_indice || ' months')::interval)::date;
    v_ultimo := extract(day from (v_mes + interval '1 month - 1 day'));
    return v_mes + (least(extract(day from p_primer_pago)::int, v_ultimo) - 1);
  end if;

  raise exception 'Frecuencia de pago desconocida: %', p_frecuencia;
end $$;


create or replace function public.registrar_abono(
  p_prestamo_id   uuid,
  p_monto         numeric,
  p_fecha_pago    date,
  p_registrado_por uuid,
  p_cuota_id      uuid    default null,
  p_metodo        text    default null,
  p_notas         text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pago_id        uuid;
  v_restante       numeric := p_monto;
  v_cuota          record;
  v_saldo_cuota    numeric;
  v_aplicado       numeric;
  v_nuevo_pagado   numeric;
  v_nuevo_estado   text;
  v_dias_atraso    int;
  v_aplicaciones   jsonb := '[]'::jsonb;
  v_excedente      numeric;
  v_cliente_id     uuid;
  v_cliente_nombre text;
  v_estado_prestamo text;
  v_todas_pagadas  boolean;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto del abono debe ser mayor que cero.';
  end if;

  -- CERROJO: bloquea la fila del préstamo. Cualquier otro abono sobre este
  -- mismo préstamo espera aquí hasta que esta transacción termine. Es lo que
  -- hace imposible la carrera del hallazgo C3.
  select p.cliente_id, p.estado into v_cliente_id, v_estado_prestamo
  from prestamos p
  where p.id = p_prestamo_id
  for update;

  if not found then
    raise exception 'El préstamo no existe.';
  end if;

  select c.nombre_completo into v_cliente_nombre from clientes c where c.id = v_cliente_id;
  v_cliente_nombre := coalesce(v_cliente_nombre, 'cliente');

  -- 1) Registrar el pago.
  insert into pagos (prestamo_id, cuota_id, registrado_por, monto, fecha_pago, metodo, notas, tipo)
  values (p_prestamo_id, p_cuota_id, p_registrado_por, p_monto, p_fecha_pago, p_metodo, p_notas, 'abono')
  returning id into v_pago_id;

  -- 2) Repartir el abono entre las cuotas (FIFO).
  --    Si se eligió una cuota concreta va primero; el excedente sigue por las
  --    demás pendientes en orden. Se bloquean todas las candidatas.
  for v_cuota in
    select * from cuotas
    where prestamo_id = p_prestamo_id
      and (id = p_cuota_id or estado in ('pendiente', 'parcial', 'vencida'))
    order by (id = p_cuota_id) desc nulls last, numero_cuota asc
    for update
  loop
    exit when v_restante <= 0;

    v_saldo_cuota := v_cuota.monto_esperado - v_cuota.monto_pagado;
    continue when v_saldo_cuota <= 0;   -- ya saldada (p. ej. la cuota elegida)

    v_aplicado     := least(v_restante, v_saldo_cuota);
    v_nuevo_pagado := round(v_cuota.monto_pagado + v_aplicado, 2);
    v_nuevo_estado := case when v_nuevo_pagado >= v_cuota.monto_esperado then 'pagada' else 'parcial' end;

    -- Al cerrar la cuota se congela con cuántos días de atraso quedó pagada
    -- (0 = a tiempo o antes). Es el dato base del score de crédito.
    if v_nuevo_estado = 'pagada' then
      v_dias_atraso := greatest(0, p_fecha_pago - v_cuota.fecha_vencimiento);
      update cuotas
         set monto_pagado = v_nuevo_pagado, estado = v_nuevo_estado, dias_atraso = v_dias_atraso
       where id = v_cuota.id;

      insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
      values (
        'cuota_pagada',
        'Cuota #' || v_cuota.numero_cuota || ' pagada' ||
          case when v_dias_atraso > 0 then ' con ' || v_dias_atraso || ' día(s) de atraso.' else ' a tiempo.' end,
        p_prestamo_id,
        v_cliente_id,
        jsonb_build_object('cuota_id', v_cuota.id, 'dias_atraso', v_dias_atraso, 'monto_esperado', v_cuota.monto_esperado),
        p_registrado_por
      );
    else
      update cuotas
         set monto_pagado = v_nuevo_pagado, estado = v_nuevo_estado
       where id = v_cuota.id;
    end if;

    v_aplicaciones := v_aplicaciones || jsonb_build_object(
      'cuota_id',         v_cuota.id,
      'cuota_numero',     v_cuota.numero_cuota,
      'monto_aplicado',   v_aplicado,
      'saldo_cuota',      round(v_cuota.monto_esperado - v_nuevo_pagado, 2),
      'estado_resultante', v_nuevo_estado
    );

    v_restante := v_restante - v_aplicado;
  end loop;

  -- 3) Excedente: dinero que no cupo en ninguna cuota (el préstamo ya estaba
  --    saldado). Queda a favor del cliente y se refleja en el comprobante.
  v_excedente := round(v_restante, 2);

  update pagos
     set distribucion = jsonb_build_object('aplicaciones', v_aplicaciones, 'excedente', v_excedente)
   where id = v_pago_id;

  -- 4) ¿Quedó el préstamo completamente pagado?
  select bool_and(estado = 'pagada') into v_todas_pagadas
  from cuotas where prestamo_id = p_prestamo_id;

  if coalesce(v_todas_pagadas, false) and v_estado_prestamo <> 'pagado' then
    update prestamos set estado = 'pagado' where id = p_prestamo_id;

    insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, actor_id)
    values ('prestamo_pagado',
            'Préstamo pagado por completo (' || v_cliente_nombre || ').',
            p_prestamo_id, v_cliente_id, p_registrado_por);
  end if;

  -- 5) El abono es efectivo real recibido → entra a la caja disponible.
  insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
  values ('ingreso', p_monto, 'Abono recibido de ' || v_cliente_nombre, 'pago', v_pago_id, p_registrado_por);

  -- 6) Bitácora del abono.
  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'abono_registrado',
    'Abono de ' || formato_cop(p_monto) || ' recibido de ' || v_cliente_nombre || '.',
    p_prestamo_id,
    v_cliente_id,
    jsonb_build_object('monto', p_monto, 'metodo', p_metodo, 'fecha_pago', p_fecha_pago, 'pago_id', v_pago_id),
    p_registrado_por
  );

  return v_pago_id;
end $$;


-- =====================================================================
-- PAGO DE SOLO INTERÉS (mismas garantías de atomicidad y bloqueo)
--
--  'extension': la cuota se da por saldada con lo pagado y su capital restante
--               se difiere a una cuota nueva al final, sumando un interés por
--               cuota al total del préstamo.
--  'saldo'    : la cuota queda parcial; el capital pendiente se cobra después
--               (renegociación), sin interés extra.
-- =====================================================================
create or replace function public.registrar_pago_interes(
  p_prestamo_id    uuid,
  p_monto          numeric,
  p_fecha_pago     date,
  p_registrado_por uuid,
  p_accion         text,
  p_cuota_id       uuid default null,
  p_metodo         text default null,
  p_notas          text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pago_id          uuid;
  v_prestamo         record;
  v_cuota            record;
  v_cliente_nombre   text;
  v_aplicado         numeric;
  v_nuevo_pagado     numeric;
  v_saldo_capital    numeric;
  v_nuevo_estado     text;
  v_interes_total    numeric;
  v_interes_x_cuota  numeric;
  v_ult_numero       int;
  v_ult_fecha        date;
  v_nueva_fecha      date;
  v_nuevo_esperado   numeric;
  v_total_nuevo      numeric;
  v_interes_nuevo    numeric;
  v_detalle          jsonb;
  v_descripcion      text;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto debe ser mayor que cero.';
  end if;
  if p_accion not in ('extension', 'saldo') then
    raise exception 'Acción inválida para un pago de interés.';
  end if;

  -- Mismo cerrojo que en registrar_abono.
  select * into v_prestamo from prestamos where id = p_prestamo_id for update;
  if not found then
    raise exception 'El préstamo no existe.';
  end if;

  select nombre_completo into v_cliente_nombre from clientes where id = v_prestamo.cliente_id;
  v_cliente_nombre := coalesce(v_cliente_nombre, 'cliente');

  -- Cuota objetivo: la elegida, o la pendiente más antigua.
  -- Se comprueba con NOT FOUND, no con "v_cuota is null": sobre un record,
  -- IS NULL solo es cierto si TODOS los campos son null, así que no sirve para
  -- saber si la consulta devolvió fila.
  if p_cuota_id is not null then
    select * into v_cuota from cuotas where id = p_cuota_id and prestamo_id = p_prestamo_id for update;
  else
    select * into v_cuota from cuotas
     where prestamo_id = p_prestamo_id and estado in ('pendiente', 'parcial', 'vencida')
     order by numero_cuota asc limit 1 for update;
  end if;

  if not found then
    raise exception 'No hay cuotas pendientes para registrar el pago de interés.';
  end if;

  insert into pagos (prestamo_id, cuota_id, registrado_por, monto, fecha_pago, metodo, notas, tipo, accion)
  values (p_prestamo_id, v_cuota.id, p_registrado_por, p_monto, p_fecha_pago, p_metodo, p_notas, 'interes', p_accion)
  returning id into v_pago_id;

  v_aplicado      := least(p_monto, v_cuota.monto_esperado - v_cuota.monto_pagado);
  v_nuevo_pagado  := round(v_cuota.monto_pagado + v_aplicado, 2);
  v_saldo_capital := round(v_cuota.monto_esperado - v_nuevo_pagado, 2);

  if p_accion = 'extension' then
    -- La cuota se salda con lo pagado: su esperado baja a lo efectivamente
    -- recibido y el capital restante viaja a una cuota nueva al final.
    update cuotas
       set monto_pagado = v_nuevo_pagado, monto_esperado = v_nuevo_pagado, estado = 'pagada'
     where id = v_cuota.id;

    v_interes_total   := v_prestamo.monto_total_a_pagar - v_prestamo.monto_capital;
    v_interes_x_cuota := round(v_interes_total / v_prestamo.numero_cuotas);

    select numero_cuota, fecha_vencimiento into v_ult_numero, v_ult_fecha
    from cuotas where prestamo_id = p_prestamo_id
    order by numero_cuota desc limit 1;

    -- La cuota nueva va después de la última: su índice (base 0) es el número de
    -- la última. Se calcula desde fecha_primer_pago, no desde la última fecha,
    -- para respetar la rejilla original del préstamo.
    v_nueva_fecha := fecha_de_cuota(v_prestamo.fecha_primer_pago, v_prestamo.frecuencia_pago, v_ult_numero);

    v_nuevo_esperado := round(v_saldo_capital + v_interes_x_cuota, 2);

    insert into cuotas (prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado, origen)
    values (p_prestamo_id, v_ult_numero + 1, v_nueva_fecha, v_nuevo_esperado, 0, 'pendiente', 'extension');

    v_total_nuevo   := round(v_prestamo.monto_total_a_pagar + v_interes_x_cuota, 2);
    v_interes_nuevo := round(coalesce(v_prestamo.valor_interes, v_interes_total) + v_interes_x_cuota, 2);

    update prestamos
       set numero_cuotas = v_prestamo.numero_cuotas + 1,
           monto_total_a_pagar = v_total_nuevo,
           valor_interes = v_interes_nuevo
     where id = p_prestamo_id;

    v_detalle := jsonb_build_object(
      'interes_agregado', v_interes_x_cuota,
      'capital_diferido', v_saldo_capital,
      'nueva_cuota_numero', v_ult_numero + 1,
      'nueva_cuota_monto', v_nuevo_esperado,
      'total_anterior', v_prestamo.monto_total_a_pagar,
      'total_nuevo', v_total_nuevo
    );

    v_descripcion := 'Pago de solo interés ' || formato_cop(p_monto) || ' de ' || v_cliente_nombre ||
      '. Se extendió el crédito un periodo: interés +' || formato_cop(v_interes_x_cuota) ||
      ', nueva cuota #' || (v_ult_numero + 1) || ' por ' || formato_cop(v_nuevo_esperado) ||
      ' (total a pagar ahora ' || formato_cop(v_total_nuevo) || ').';

    v_nuevo_estado := 'pagada';
  else
    v_nuevo_estado := case when v_nuevo_pagado >= v_cuota.monto_esperado then 'pagada' else 'parcial' end;
    update cuotas set monto_pagado = v_nuevo_pagado, estado = v_nuevo_estado where id = v_cuota.id;

    v_detalle := '{}'::jsonb;
    v_descripcion := 'Pago de solo interés ' || formato_cop(p_monto) || ' de ' || v_cliente_nombre ||
      '. Capital ' || formato_cop(v_saldo_capital) || ' queda pendiente para renegociación (cuota #' ||
      v_cuota.numero_cuota || ').';
  end if;

  update pagos
     set distribucion = jsonb_build_object(
       'aplicaciones', jsonb_build_array(jsonb_build_object(
         'cuota_id',          v_cuota.id,
         'cuota_numero',      v_cuota.numero_cuota,
         'monto_aplicado',    v_aplicado,
         'saldo_cuota',       case when p_accion = 'extension' then 0 else v_saldo_capital end,
         'estado_resultante', v_nuevo_estado
       )),
       'excedente', 0,
       'tipo', 'interes'
     )
   where id = v_pago_id;

  -- El interés recibido es efectivo real → entra a la caja disponible.
  insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
  values ('ingreso', p_monto, 'Pago de interés de ' || v_cliente_nombre, 'pago', v_pago_id, p_registrado_por);

  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values ('pago_interes', v_descripcion, p_prestamo_id, v_prestamo.cliente_id,
          v_detalle || jsonb_build_object('monto', p_monto, 'metodo', p_metodo, 'fecha_pago', p_fecha_pago,
                                          'pago_id', v_pago_id, 'cuota_id', v_cuota.id, 'accion', p_accion),
          p_registrado_por);

  return v_pago_id;
end $$;


-- =====================================================================
-- CREAR PRÉSTAMO + PLAN DE CUOTAS (atómico)
-- Antes: insert del préstamo → insert de cuotas → egreso de caja → bitácora,
-- todo por separado. Si fallaba en medio quedaba un préstamo SIN cuotas o sin
-- el egreso registrado. Ahora es una sola transacción.
--
-- El plan de cuotas se sigue calculando en Node (`calcularPlanDeCuotas`), que ya
-- resuelve las fechas por frecuencia; aquí llega listo como jsonb.
-- =====================================================================
create or replace function public.crear_prestamo_con_plan(
  p_prestamo jsonb,
  p_cuotas   jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prestamo_id  uuid;
  v_cliente_nombre text;
  v_capital      numeric;
  v_creado_por   uuid;
begin
  insert into prestamos (
    cliente_id, creado_por, monto_capital, tipo_interes, valor_interes, tasa_interes,
    monto_total_a_pagar, numero_cuotas, valor_cuota, frecuencia_pago,
    fecha_inicio, fecha_primer_pago, notas
  )
  select
    (p_prestamo->>'cliente_id')::uuid,
    (p_prestamo->>'creado_por')::uuid,
    (p_prestamo->>'monto_capital')::numeric,
    p_prestamo->>'tipo_interes',
    nullif(p_prestamo->>'valor_interes', '')::numeric,
    nullif(p_prestamo->>'tasa_interes', '')::numeric,
    (p_prestamo->>'monto_total_a_pagar')::numeric,
    (p_prestamo->>'numero_cuotas')::int,
    (p_prestamo->>'valor_cuota')::numeric,
    p_prestamo->>'frecuencia_pago',
    (p_prestamo->>'fecha_inicio')::date,
    (p_prestamo->>'fecha_primer_pago')::date,
    nullif(p_prestamo->>'notas', '')
  returning id, monto_capital, creado_por into v_prestamo_id, v_capital, v_creado_por;

  insert into cuotas (prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado)
  select
    v_prestamo_id,
    (c->>'numero_cuota')::int,
    (c->>'fecha_vencimiento')::date,
    (c->>'monto_esperado')::numeric,
    0,
    'pendiente'
  from jsonb_array_elements(p_cuotas) as c;

  select nombre_completo into v_cliente_nombre
  from clientes where id = (p_prestamo->>'cliente_id')::uuid;
  v_cliente_nombre := coalesce(v_cliente_nombre, 'cliente');

  -- El capital prestado sale de la caja disponible.
  insert into movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por)
  values ('egreso', v_capital, 'Capital prestado a ' || v_cliente_nombre, 'prestamo', v_prestamo_id, v_creado_por);

  insert into bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id)
  values (
    'prestamo_creado',
    'Préstamo creado a ' || v_cliente_nombre || ': capital ' || formato_cop(v_capital) ||
      ' en ' || (p_prestamo->>'numero_cuotas') || ' cuotas (' || (p_prestamo->>'frecuencia_pago') || ').',
    v_prestamo_id,
    (p_prestamo->>'cliente_id')::uuid,
    jsonb_build_object(
      'monto_capital', v_capital,
      'monto_total_a_pagar', (p_prestamo->>'monto_total_a_pagar')::numeric,
      'numero_cuotas', (p_prestamo->>'numero_cuotas')::int,
      'frecuencia_pago', p_prestamo->>'frecuencia_pago'
    ),
    v_creado_por
  );

  return v_prestamo_id;
end $$;


-- Estas funciones solo deben poder invocarse desde el backend (service role),
-- nunca desde un cliente con anon key.
revoke all on function public.registrar_abono(uuid, numeric, date, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.registrar_pago_interes(uuid, numeric, date, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.crear_prestamo_con_plan(jsonb, jsonb) from public, anon, authenticated;

-- Índice para el bloqueo/orden del reparto FIFO.
create index if not exists idx_cuotas_prestamo_numero on public.cuotas(prestamo_id, numero_cuota);
