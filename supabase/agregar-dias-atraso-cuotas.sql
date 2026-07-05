-- =====================================================================
-- dias_atraso por cuota — el "combustible" del futuro score de crédito.
--
-- Se guarda SOLO en el momento en que una cuota queda totalmente PAGADA:
-- registra con cuántos días de atraso se cerró (0 = a tiempo o antes).
--
-- Las cuotas aún abiertas/vencidas NO se guardan aquí: su atraso es "vivo"
-- (se calcula contra la fecha de hoy) y pertenece a la capa de mora activa.
--
-- Guardamos los DÍAS crudos, no una categoría. Así podemos re-afinar los
-- escalones de puntualidad del score sin perder el dato original.
--
-- IMPORTANTE: ejecutar en el SQL editor de Supabase ANTES de registrar
-- nuevos abonos (el flujo de pago ya escribe esta columna).
-- =====================================================================

alter table public.cuotas add column if not exists dias_atraso int;
