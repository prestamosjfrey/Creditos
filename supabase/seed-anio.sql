-- =====================================================================
-- SEED de ~1 año de datos consistentes (SOLO DESARROLLO/PRUEBAS).
-- Corre en segundos, todo del lado del servidor.
--
-- Crea clientes + un préstamo por cada día del último año, paga las cuotas
-- ya vencidas (cada pago en su fecha, para repartir ingresos en el tiempo) y
-- deja N préstamos EN MORA. Genera cuotas, pagos, movimientos de caja y
-- bitácora coherentes con la app.
--
-- ANTES DE CORRER:
--   1) (Recomendado) parte de base limpia:
--        truncate table public.bitacora, public.movimientos_caja,
--          public.pagos, public.cuotas, public.prestamos restart identity cascade;
--      (los clientes de prueba se acumulan si lo corres varias veces; para
--       borrarlos ver el bloque comentado al final).
--   2) La columna pagos.distribucion debe existir:
--        alter table public.pagos add column if not exists distribucion jsonb;
--   3) Debe existir un usuario admin.
--
-- Ajusta los parámetros en la sección CONFIG del bloque.
-- =====================================================================

create extension if not exists pgcrypto;

do $$
declare
  -- ----------------------------- CONFIG -----------------------------
  c_dias      int := 365;   -- un préstamo por día hacia atrás
  c_clientes  int := 40;    -- pool de clientes reutilizados
  c_mora      int := 30;    -- préstamos que quedan en mora
  -- ------------------------------------------------------------------

  v_admin uuid;
  v_clientes uuid[] := '{}';
  v_cid uuid;
  v_meta jsonb;
  v_nombre text;

  v_nombres   text[] := array['Juan','María','Carlos','Ana','Luis','Laura','Pedro','Sofía','Andrés','Diana','Jorge','Paula','Miguel','Camila','Fernando','Valentina','Ricardo','Daniela','Óscar','Natalia'];
  v_apellidos text[] := array['Gómez','Rodríguez','Martínez','López','Hernández','Díaz','Torres','Ramírez','Rojas','Vargas','Castro','Ruiz','Moreno','Jiménez','Ortiz','Suárez','Mendoza','Cárdenas','Ríos','Peña'];
  v_capitales numeric[] := array[200000,300000,500000,700000,1000000,1500000,2000000];
  v_pcts      numeric[] := array[0.10,0.15,0.20,0.25];
  v_ncuotas   int[]     := array[4,5,6,8,10,12];
  v_frecs     text[]    := array['semanal','quincenal','mensual'];
  v_metodos   text[]    := array['efectivo','transferencia','nequi','daviplata'];

  k int; j int; i int;
  v_pid uuid; v_cuota_id uuid; v_pago_id uuid;
  v_fInicio date; v_frec text; v_period interval;
  v_capital numeric; v_pct numeric; v_ncuot int;
  v_total numeric; v_valcuota numeric; v_monto_esp numeric; v_venc date;
  v_es_mora boolean;
  v_mora_count int := 0; v_pagos int := 0; v_prestamos int := 0;
begin
  select id into v_admin from public.perfiles where rol = 'admin' limit 1;
  if v_admin is null then
    raise exception 'No hay usuario admin. Crea uno antes de correr el seed.';
  end if;

  -- Capital inicial para que el saldo en caja no quede negativo.
  insert into public.movimientos_caja (tipo, monto, concepto, origen, registrado_por, creado_en)
  values ('ingreso', 500000000, 'Capital inicial de operación (seed)', 'manual', v_admin, now() - make_interval(days => c_dias + 1));

  -- ------------------------- CLIENTES -------------------------
  for i in 0 .. (c_clientes - 1) loop
    v_cid := gen_random_uuid();
    v_nombre := v_nombres[(1 + floor(random()*array_length(v_nombres,1)))::int]
             || ' ' || v_apellidos[(1 + floor(random()*array_length(v_apellidos,1)))::int]
             || ' ' || v_apellidos[(1 + floor(random()*array_length(v_apellidos,1)))::int];
    v_meta := jsonb_build_object('nombre_completo', v_nombre, 'rol', 'cliente');

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_cid, 'authenticated', 'authenticated',
      'seed_' || replace(v_cid::text, '-', '') || '@ejemplo.test', null, now(),
      '{"provider":"email","providers":["email"]}', v_meta, now(), now(),
      '', '', '', '', '', '', ''
    );

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_cid, v_cid::text,
            jsonb_build_object('sub', v_cid::text, 'email', 'seed_' || replace(v_cid::text,'-','') || '@ejemplo.test'),
            'email', now(), now(), now());

    -- El trigger on_auth_user_created ya creó el perfil; completamos datos.
    update public.perfiles
       set numero_documento = (30000000 + i*1000 + floor(random()*999))::text,
           telefono = '30' || (10000000 + floor(random()*89999999))::text,
           direccion = 'Calle ' || (1 + floor(random()*120))::int || ' # ' || (1 + floor(random()*90))::int || '-' || (1 + floor(random()*99))::int
     where id = v_cid;

    v_clientes := array_append(v_clientes, v_cid);
  end loop;

  -- ------------------------- PRÉSTAMOS + CUOTAS + PAGOS -------------------------
  for k in reverse c_dias .. 1 loop
    v_fInicio := current_date - k;
    v_frec := v_frecs[(1 + floor(random()*array_length(v_frecs,1)))::int];
    v_period := case v_frec when 'semanal' then interval '7 days'
                            when 'quincenal' then interval '15 days'
                            else interval '1 month' end;
    v_capital := v_capitales[(1 + floor(random()*array_length(v_capitales,1)))::int];
    v_pct := v_pcts[(1 + floor(random()*array_length(v_pcts,1)))::int];
    v_ncuot := v_ncuotas[(1 + floor(random()*array_length(v_ncuotas,1)))::int];
    v_total := round(v_capital * (1 + v_pct));
    v_valcuota := round(v_total / v_ncuot);
    v_cid := v_clientes[(1 + floor(random()*array_length(v_clientes,1)))::int];

    -- ¿este préstamo va a mora? (los primeros c_mora que caen en 40–160 días)
    v_es_mora := (k between 40 and 160) and (v_mora_count < c_mora);

    insert into public.prestamos (
      cliente_id, creado_por, monto_capital, tipo_interes, valor_interes,
      monto_total_a_pagar, numero_cuotas, valor_cuota, frecuencia_pago,
      fecha_inicio, fecha_primer_pago, estado, notas, creado_en
    ) values (
      v_cid, v_admin, v_capital, 'fijo_total', v_total - v_capital,
      v_total, v_ncuot, v_valcuota, v_frec,
      v_fInicio, (v_fInicio + v_period)::date,
      case when v_es_mora then 'en_mora' else 'activo' end, 'seed', v_fInicio::timestamptz
    ) returning id into v_pid;
    v_prestamos := v_prestamos + 1;

    -- Egreso de caja por el capital prestado.
    insert into public.movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por, creado_en)
    values ('egreso', v_capital, 'Capital prestado (seed)', 'prestamo', v_pid, v_admin, v_fInicio::timestamptz);

    -- Bitácora: préstamo creado.
    insert into public.bitacora (tipo, descripcion, prestamo_id, cliente_id, actor_id, creado_en)
    values ('prestamo_creado', 'Préstamo creado (seed).', v_pid, v_cid, v_admin, v_fInicio::timestamptz);

    -- Cuotas.
    for j in 1 .. v_ncuot loop
      v_venc := (v_fInicio + (j * v_period))::date;
      v_monto_esp := case when j = v_ncuot then v_total - v_valcuota*(v_ncuot-1) else v_valcuota end;

      if (not v_es_mora) and v_venc <= current_date then
        -- Cuota pagada + su pago + ingreso de caja + bitácora.
        insert into public.cuotas (prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado, dias_atraso)
        values (v_pid, j, v_venc, v_monto_esp, v_monto_esp, 'pagada', 0)
        returning id into v_cuota_id;

        insert into public.pagos (prestamo_id, cuota_id, registrado_por, monto, fecha_pago, metodo, distribucion, creado_en)
        values (v_pid, v_cuota_id, v_admin, v_monto_esp, v_venc,
                v_metodos[(1 + floor(random()*array_length(v_metodos,1)))::int],
                jsonb_build_object(
                  'aplicaciones', jsonb_build_array(jsonb_build_object(
                    'cuota_id', v_cuota_id, 'cuota_numero', j,
                    'monto_aplicado', v_monto_esp, 'saldo_cuota', 0, 'estado_resultante', 'pagada')),
                  'excedente', 0),
                v_venc::timestamptz)
        returning id into v_pago_id;

        insert into public.movimientos_caja (tipo, monto, concepto, origen, referencia_id, registrado_por, creado_en)
        values ('ingreso', v_monto_esp, 'Abono recibido (seed)', 'pago', v_pago_id, v_admin, v_venc::timestamptz);

        insert into public.bitacora (tipo, descripcion, prestamo_id, cliente_id, actor_id, creado_en)
        values ('abono_registrado', 'Abono de ' || v_monto_esp || ' (seed).', v_pid, v_cid, v_admin, v_venc::timestamptz);

        insert into public.bitacora (tipo, descripcion, prestamo_id, cliente_id, actor_id, creado_en)
        values ('cuota_pagada', 'Cuota #' || j || ' pagada a tiempo (seed).', v_pid, v_cid, v_admin, v_venc::timestamptz);

        v_pagos := v_pagos + 1;
      else
        -- Cuota pendiente; si es de mora y ya venció, queda 'vencida' + bitácora.
        insert into public.cuotas (prestamo_id, numero_cuota, fecha_vencimiento, monto_esperado, monto_pagado, estado)
        values (v_pid, j, v_venc, v_monto_esp, 0,
                case when v_es_mora and v_venc < current_date then 'vencida' else 'pendiente' end)
        returning id into v_cuota_id;

        if v_es_mora and v_venc < current_date then
          insert into public.bitacora (tipo, descripcion, prestamo_id, cliente_id, detalle, actor_id, creado_en)
          values ('cuota_mora', 'Cuota #' || j || ' en mora (seed).', v_pid, v_cid,
                  jsonb_build_object('cuota_id', v_cuota_id, 'saldo_cuota', v_monto_esp), v_admin, v_venc::timestamptz);
        end if;
      end if;
    end loop;

    -- Préstamo totalmente pagado (todas sus cuotas ya vencieron y se pagaron).
    if (not v_es_mora) and (v_fInicio + (v_ncuot * v_period))::date <= current_date then
      update public.prestamos set estado = 'pagado' where id = v_pid;
    end if;

    if v_es_mora then
      v_mora_count := v_mora_count + 1;
    end if;
  end loop;

  raise notice 'SEED OK -> clientes: %, prestamos: %, pagos: %, en mora: %',
    array_length(v_clientes,1), v_prestamos, v_pagos, v_mora_count;
end $$;

-- ---------------------------------------------------------------------
-- Para borrar SOLO los clientes de prueba de este seed (opcional):
--   delete from auth.users where email like 'seed_%@ejemplo.test';
--   (borra en cascada perfiles/identities; primero trunca prestamos si hace falta)
-- ---------------------------------------------------------------------
