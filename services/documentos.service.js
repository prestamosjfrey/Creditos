const { supabaseAdmin } = require('../config/supabase');

const BUCKET = 'documentos-clientes';

// El `mimetype` que llega de multer lo declara el navegador: un atacante puede
// renombrar un .html o un .exe y anunciarlo como "image/png". La única
// comprobación fiable es mirar los primeros bytes del archivo (su firma real).
const FIRMAS = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },              // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },                   // RIFF....WEBP
];

function tipoRealValido(buffer) {
  if (!buffer || buffer.length < 12) return false;
  return FIRMAS.some(({ mime, bytes }) => {
    const coincide = bytes.every((b, i) => buffer[i] === b);
    // WEBP es un contenedor RIFF: hay que confirmar la marca en el offset 8.
    if (coincide && mime === 'image/webp') return buffer.slice(8, 12).toString('ascii') === 'WEBP';
    return coincide;
  });
}

// Documentos PRIVADOS por usuario: aunque el cliente sea compartido, cada quien
// ve solo los que él subió (subido_por).
async function listarDocumentos(clienteId, usuarioId) {
  const { data, error } = await supabaseAdmin
    .from('documentos_cliente')
    .select('*')
    .eq('cliente_id', clienteId)
    .eq('subido_por', usuarioId)
    .order('creado_en', { ascending: false });
  if (error) throw error;
  return data;
}

async function subirDocumento({ clienteId, archivo, subidoPor }) {
  // archivo = objeto de multer (memoryStorage): { originalname, buffer, mimetype, size }
  if (!tipoRealValido(archivo.buffer)) {
    const err = new Error('El archivo no es un PDF ni una imagen válida.');
    err.status = 400;
    throw err;
  }

  // El nombre original nunca toca el sistema de archivos directamente: se
  // normaliza (fuera separadores y ..) y se antepone un timestamp, así dos
  // archivos con el mismo nombre no se pisan.
  const limpio = archivo.originalname.replace(/[^\w.\-]+/g, '_').replace(/\.{2,}/g, '.').slice(0, 100);
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

// Busca un documento EXIGIENDO que sea del cliente indicado Y del usuario que
// lo pide (subido_por). Así un usuario no puede ver ni borrar el documento que
// otro subió sobre el mismo cliente compartido, ni mezclar expedientes por id.
async function obtenerDocumentoDeCliente(documentoId, clienteId, usuarioId) {
  let q = supabaseAdmin
    .from('documentos_cliente')
    .select('id, ruta_storage, cliente_id, subido_por')
    .eq('id', documentoId)
    .eq('cliente_id', clienteId);
  if (usuarioId) q = q.eq('subido_por', usuarioId);

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('El documento no existe o no es tuyo.');
    err.status = 404;
    throw err;
  }
  return data;
}

// URL firmada temporal para ver/descargar el archivo privado (válida 60s).
async function obtenerUrlFirmada(documentoId, clienteId, usuarioId) {
  const doc = await obtenerDocumentoDeCliente(documentoId, clienteId, usuarioId);

  const { data, error: errorUrl } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(doc.ruta_storage, 60);
  if (errorUrl) throw errorUrl;

  return data.signedUrl;
}

async function eliminarDocumento(documentoId, clienteId, usuarioId) {
  const doc = await obtenerDocumentoDeCliente(documentoId, clienteId, usuarioId);

  await supabaseAdmin.storage.from(BUCKET).remove([doc.ruta_storage]);

  const { error: errorDelete } = await supabaseAdmin
    .from('documentos_cliente')
    .delete()
    .eq('id', documentoId);
  if (errorDelete) throw errorDelete;
}

module.exports = { listarDocumentos, subirDocumento, obtenerUrlFirmada, eliminarDocumento };
