-- =====================================================================
-- CORRIGE bitacora_cliente_id_fkey  (apunta a la tabla equivocada)
--
-- SÍNTOMA:
--   Al crear un préstamo:
--     insert or update on table "bitacora" violates foreign key
--     constraint "bitacora_cliente_id_fkey"
--
-- CAUSA:
--   El FK de bitacora.cliente_id sigue apuntando a `usuarios` (la antigua
--   `perfiles`), no a `clientes`. La migración separar-usuarios-clientes.sql
--   debía re-apuntarlo, pero esa parte no se aplicó. Como el id de un cliente
--   nunca está en `usuarios`, TODA inserción de bitácora con cliente_id falla.
--
--   Prueba: de 87 filas en bitacora, 0 tenían cliente_id — nunca se pudo
--   guardar ninguno. Antes no se notaba porque la auditoría era fail-soft
--   (tragaba el error). El nuevo RPC audita dentro de la transacción, así que
--   el mismo fallo ahora aborta la creación del préstamo.
--
-- ARREGLO:
--   Re-crear el FK apuntando a `clientes(id)`. Con ON DELETE SET NULL, borrar
--   un cliente no borra su historial de auditoría: solo desliga el cliente.
--
-- Es idempotente y no toca ningún dato. Ejecutar en el SQL editor de Supabase.
-- =====================================================================

alter table public.bitacora drop constraint if exists bitacora_cliente_id_fkey;

alter table public.bitacora
  add constraint bitacora_cliente_id_fkey
  foreign key (cliente_id) references public.clientes(id) on delete set null;
