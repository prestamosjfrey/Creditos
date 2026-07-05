-- =====================================================================
-- Pestañas "Notas" y "Documentos" de la ficha del cliente.
-- - notas_admin: texto libre que el admin guarda sobre el cliente.
-- - documentos_cliente: metadatos de archivos subidos (el archivo en sí
--   vive en Supabase Storage, bucket privado 'documentos-clientes').
-- Ejecutar en el SQL editor de Supabase.
-- =====================================================================

alter table public.perfiles add column if not exists notas_admin text;

create table if not exists public.documentos_cliente (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.perfiles(id) on delete cascade,
  nombre text not null,
  ruta_storage text not null,
  tipo_mime text,
  tamano_bytes bigint,
  subido_por uuid not null references public.perfiles(id),
  creado_en timestamptz not null default now()
);

create index if not exists idx_documentos_cliente on public.documentos_cliente(cliente_id);

alter table public.documentos_cliente enable row level security;

create policy "documentos_cliente_admin_todo" on public.documentos_cliente
  for all using (public.es_admin());
