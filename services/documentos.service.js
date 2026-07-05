const { supabaseAdmin } = require('../config/supabase');

const BUCKET = 'documentos-clientes';

async function listarDocumentos(clienteId) {
  const { data, error } = await supabaseAdmin
    .from('documentos_cliente')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('creado_en', { ascending: false });
  if (error) throw error;
  return data;
}

async function subirDocumento({ clienteId, archivo, subidoPor }) {
  // archivo = objeto de multer (memoryStorage): { originalname, buffer, mimetype, size }
  const limpio = archivo.originalname.replace(/[^\w.\-]+/g, '_');
  const ruta = `${clienteId}/${Date.now()}-${limpio}`;

  const { error: errorUpload } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(ruta, archivo.buffer, { contentType: archivo.mimetype, upsert: false });
  if (errorUpload) throw errorUpload;

  const { error: errorInsert } = await supabaseAdmin.from('documentos_cliente').insert({
    cliente_id: clienteId,
    nombre: archivo.originalname,
    ruta_storage: ruta,
    tipo_mime: archivo.mimetype,
    tamano_bytes: archivo.size,
    subido_por: subidoPor,
  });
  if (errorInsert) {
    // Si falla el registro, no dejar el archivo huérfano en Storage.
    await supabaseAdmin.storage.from(BUCKET).remove([ruta]);
    throw errorInsert;
  }
}

// URL firmada temporal para ver/descargar el archivo privado (válida 60s).
async function obtenerUrlFirmada(documentoId) {
  const { data: doc, error } = await supabaseAdmin
    .from('documentos_cliente')
    .select('ruta_storage')
    .eq('id', documentoId)
    .single();
  if (error) throw error;

  const { data, error: errorUrl } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(doc.ruta_storage, 60);
  if (errorUrl) throw errorUrl;

  return data.signedUrl;
}

async function eliminarDocumento(documentoId) {
  const { data: doc, error } = await supabaseAdmin
    .from('documentos_cliente')
    .select('ruta_storage')
    .eq('id', documentoId)
    .single();
  if (error) throw error;

  await supabaseAdmin.storage.from(BUCKET).remove([doc.ruta_storage]);

  const { error: errorDelete } = await supabaseAdmin
    .from('documentos_cliente')
    .delete()
    .eq('id', documentoId);
  if (errorDelete) throw errorDelete;
}

module.exports = { listarDocumentos, subirDocumento, obtenerUrlFirmada, eliminarDocumento };
