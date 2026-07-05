-- =====================================================================
-- LIMPIEZA DE DATOS TRANSACCIONALES (para volver a probar desde cero).
--
-- Borra TODO lo relacionado con préstamos/movimientos, pero CONSERVA:
--   - los usuarios (auth.users)
--   - los clientes y el admin (public.perfiles), con sus notas y documentos
--
-- Tablas que vacía: préstamos, cuotas, pagos, movimientos de caja y bitácora.
-- Ejecutar en el SQL editor de Supabase cuando quieras reiniciar las pruebas.
-- (Es destructivo e irreversible: solo para entorno de pruebas.)
-- =====================================================================

truncate table
  public.bitacora,
  public.movimientos_caja,
  public.pagos,
  public.cuotas,
  public.prestamos
restart identity cascade;

-- NOTA: esto NO toca public.perfiles (clientes/admin) ni los documentos
-- (public.documentos_cliente) ni las notas (perfiles.notas_admin).
-- Si además quisieras borrar los documentos subidos de los clientes,
-- descomenta la siguiente línea (los archivos en Storage se borran aparte):
-- truncate table public.documentos_cliente restart identity cascade;
