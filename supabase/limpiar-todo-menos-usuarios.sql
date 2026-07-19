-- =====================================================================
-- ⚠️  LIMPIEZA TOTAL — deja SOLO los usuarios (staff que inicia sesión)
--
-- BORRA de forma IRREVERSIBLE todo lo demás:
--   clientes, prestamos, cuotas, pagos, movimientos_caja, bitacora,
--   documentos_cliente, creditos_tomados, cuotas_credito_tomado,
--   codigos_recuperacion... y cualquier otra tabla de `public`.
--
-- CONSERVA:
--   · public.usuarios  → tus cuentas de login (para poder seguir entrando)
--
-- NO SE PUEDE DESHACER. Si tienes datos que quieras guardar, expórtalos antes
-- (Supabase → Table Editor → Export como CSV).
--
-- Recorre todas las tablas de `public` salvo `usuarios` y las vacía. Al ir por
-- toda la lista, no se escapa ninguna tabla aunque el esquema cambie más
-- adelante. RESTART IDENTITY reinicia los contadores (p. ej. el número de
-- préstamo vuelve a empezar). CASCADE resuelve el orden de las llaves foráneas.
--
-- NOTA sobre archivos: si subiste documentos de clientes, los ARCHIVOS viven en
-- Supabase Storage (bucket "documentos-clientes"), NO en estas tablas. Este
-- script vacía la tabla de referencias, pero los archivos hay que borrarlos
-- aparte desde Supabase → Storage. (Hoy documentos_cliente está vacía, así que
-- lo normal es que no haya archivos huérfanos.)
--
-- Ejecutar en Supabase → SQL Editor.
-- =====================================================================

do $$
declare
  r record;
begin
  for r in
    select tablename
      from pg_tables
     where schemaname = 'public'
       and tablename <> 'usuarios'      -- <- lo único que se conserva
  loop
    execute format('truncate table public.%I restart identity cascade', r.tablename);
    raise notice 'Vaciada: %', r.tablename;
  end loop;
end $$; 
