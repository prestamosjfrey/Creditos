-- =====================================================================
-- PAGO DE SOLO INTERÉS EN CRÉDITOS TOMADOS
--
-- Igual que en los préstamos normales, permite pagar SOLO el interés de una
-- cuota de un crédito tomado. La lógica vive en Node (creditos-tomados.service),
-- pero el historial de pagos necesita saber de qué tipo fue cada pago y guardar
-- el detalle para poder revertirlo con exactitud.
--
-- Añade a pagos_credito_tomado:
--   · tipo    : 'abono' (normal) | 'interes' (solo interés)
--   · accion  : 'extension' | 'saldo'  (solo aplica cuando tipo = 'interes')
--   · detalle : jsonb con lo necesario para revertir el pago
--
-- Ejecutar una vez en Supabase. Es idempotente.
-- =====================================================================

alter table public.pagos_credito_tomado
  add column if not exists tipo    text not null default 'abono',
  add column if not exists accion  text,
  add column if not exists detalle jsonb;
