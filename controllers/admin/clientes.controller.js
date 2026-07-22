const { supabaseAdmin } = require('../../config/supabase');
const documentosService = require('../../services/documentos.service');
const auditoria = require('../../services/auditoria.service');
const scoreService = require('../../services/score.service');
const { alcanceDe, scope } = require('../../utils/alcance');

// El término de búsqueda se interpola dentro de la expresión `.or()` de
// PostgREST, que tiene su propia sintaxis: las comas separan condiciones, los
// paréntesis agrupan y el punto separa columna/operador/valor. Si se pasa el
// texto crudo, el usuario puede reescribir el filtro (p. ej. cerrar la
// condición e inyectar otra sobre columnas que no le tocan).
//
// Se eliminan los metacaracteres de esa sintaxis y se limita la longitud. Los
// comodines % y _ de ILIKE también se quitan: aquí no aportan y permiten
// construir patrones costosos.
function sanearBusqueda(texto) {
  return texto
    .replace(/[,()."'\\%_*:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function listarClientes(req, res, next) {
  try {
    const busqueda = (req.query.q || '').trim();
    const termino = sanearBusqueda(busqueda);

    let query = supabaseAdmin
      .from('clientes')
      .select('*')
      .order('nombre_completo', { ascending: true });

    if (termino) {
      query = query.or(
        `nombre_completo.ilike.%${termino}%,numero_documento.ilike.%${termino}%,telefono.ilike.%${termino}%`
      );
    }

    const { data: clientes, error } = await query;
    if (error) throw error;

    // Estadísticas globales (no dependen del filtro de búsqueda).
    const { data: todos, error: errorTodos } = await supabaseAdmin
      .from('clientes')
      .select('activo, creado_en');
    if (errorTodos) throw errorTodos;

    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    const stats = {
      total: todos.length,
      activos: todos.filter((c) => c.activo).length,
      nuevosEsteMes: todos.filter((c) => new Date(c.creado_en) >= inicioMes).length,
      etiquetaMes: `Desde el 1 de ${MESES[hoy.getMonth()]}`,
    };

    res.render('admin/clientes/lista', { titulo: 'Clientes', clientes, busqueda, stats });
  } catch (err) {
    next(err);
  }
}

async function mostrarFormularioNuevo(req, res) {
  res.render('admin/clientes/form', { titulo: 'Nuevo cliente', error: null, valores: {} });
}

// Repinta el formulario de alta conservando lo escrito (lo llama el validador).
function renderNuevoConError(req, res, mensaje) {
  res.status(400).render('admin/clientes/form', {
    titulo: 'Nuevo cliente',
    error: mensaje,
    valores: req.body,
  });
}

// Ídem para la edición.
function renderEditarConError(req, res, mensaje) {
  res.status(400).render('admin/clientes/editar', {
    titulo: 'Editar cliente',
    cliente: { id: req.params.id, ...req.body },
    error: mensaje,
  });
}

async function crearCliente(req, res, next) {
  const { email, nombre_completo, numero_documento, telefono, direccion } = req.body;
  try {
    // El cliente es solo un registro que lleva el admin (no inicia sesión),
    // así que se guarda directamente en la tabla clientes.
    const { data: creado, error: errorCliente } = await supabaseAdmin
      .from('clientes')
      .insert({
        nombre_completo,
        numero_documento: numero_documento || null,
        telefono: telefono || null,
        direccion: direccion || null,
        email: email || null,
      })
      .select('id')
      .single();
    if (errorCliente) throw errorCliente;

    await auditoria.registrar({
      tipo: 'cliente_creado',
      descripcion: `Cliente creado: ${nombre_completo}.`,
      clienteId: creado.id,
      detalle: { numero_documento, telefono, email },
      actorId: req.usuario.id,
    });

    res.redirect(`/admin/clientes/${creado.id}?ok=${encodeURIComponent('Cliente creado correctamente.')}`);
  } catch (err) {
    const esDocDuplicado = err.code === '23505' || /duplicate key|numero_documento/i.test(err.message || '');
    res.status(esDocDuplicado ? 409 : 400).render('admin/clientes/form', {
      titulo: 'Nuevo cliente',
      error: esDocDuplicado ? null : (err.message || 'No se pudo crear el cliente.'),
      alerta: esDocDuplicado ? 'Ya existe un cliente registrado con ese número de documento. Usa uno diferente.' : null,
      valores: req.body,
    });
  }
}

async function mostrarFicha(req, res, next) {
  try {
    const { id } = req.params;

    const { data: cliente, error: errorCliente } = await supabaseAdmin
      .from('clientes')
      .select('*')
      .eq('id', id)
      .single();
    if (errorCliente || !cliente) return res.status(404).render('errores/404');

    // El cliente es compartido. Los préstamos/cuotas de su ficha son los del
    // usuario (creado_por), o los de TODOS si es super admin (alcance = null).
    // Los documentos y notas SIGUEN siendo privados de cada usuario (uid), aun
    // para el super admin: son anotaciones personales.
    const uid = req.usuario.id;
    const alcance = alcanceDe(req.usuario);

    const { data: prestamos, error: errorPrestamos } = await scope(
      supabaseAdmin.from('prestamos').select('*').eq('cliente_id', id),
      'creado_por', alcance)
      .order('creado_en', { ascending: false });
    if (errorPrestamos) throw errorPrestamos;

    const { data: cuotas, error: errorCuotas } = await scope(
      supabaseAdmin.from('cuotas').select('*, prestamos!inner(cliente_id, creado_por)')
        .eq('prestamos.cliente_id', id),
      'prestamos.creado_por', alcance);
    if (errorCuotas) throw errorCuotas;

    // Usar el score persistido; si no existe, calcularlo ahora y guardarlo.
    let scoreCredito = cliente.score_credito ?? null;
    let scoreActualizadoEn = cliente.score_actualizado_en ?? null;
    // Siempre calcular el desglose fresco (para el modal de detalle).
    const scoreDetalle = await scoreService.calcularScoreDetallado(id);
    if (scoreDetalle) {
      scoreCredito = scoreDetalle.score;
      if (!cliente.score_credito) {
        await scoreService.recalcularYGuardar(id);
        scoreActualizadoEn = new Date().toISOString();
      }
    }
    const infoScore = scoreCredito !== null ? scoreService.etiquetaScore(scoreCredito) : null;

    // Documentos y nota: PRIVADOS por usuario (aunque el cliente sea compartido).
    const documentos = await documentosService.listarDocumentos(id, uid);
    const { data: nota } = await supabaseAdmin
      .from('notas_cliente').select('texto').eq('cliente_id', id).eq('usuario_id', uid).maybeSingle();

    res.render('admin/clientes/ficha', {
      titulo: cliente.nombre_completo,
      cliente,
      prestamos,
      scoreCredito,
      scoreActualizadoEn,
      infoScore,
      scoreDetalle,
      documentos,
      notaPrivada: nota?.texto || '',
      tab: req.query.tab || 'historial',
    });
  } catch (err) {
    next(err);
  }
}

async function mostrarFormularioEditar(req, res, next) {
  try {
    const { id } = req.params;
    const { data: cliente, error } = await supabaseAdmin
      .from('clientes')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !cliente) return res.status(404).render('errores/404');

    res.render('admin/clientes/editar', { titulo: 'Editar cliente', cliente, error: null });
  } catch (err) {
    next(err);
  }
}

async function editarCliente(req, res, next) {
  const { id } = req.params;
  const { nombre_completo, numero_documento, telefono, direccion, email } = req.body;
  try {
    const { error: errorCliente } = await supabaseAdmin
      .from('clientes')
      .update({
        nombre_completo,
        numero_documento: numero_documento || null,
        telefono: telefono || null,
        direccion: direccion || null,
        email: email || null,
      })
      .eq('id', id);
    if (errorCliente) throw errorCliente;

    await auditoria.registrar({
      tipo: 'cliente_editado',
      descripcion: `Datos del cliente actualizados: ${nombre_completo}.`,
      clienteId: id,
      detalle: { nombre_completo, numero_documento, telefono, direccion, email },
      actorId: req.usuario.id,
    });

    res.redirect(`/admin/clientes/${id}?ok=${encodeURIComponent('Cliente actualizado correctamente.')}`);
  } catch (err) {
    res.status(400).render('admin/clientes/editar', {
      titulo: 'Editar cliente',
      cliente: { id, nombre_completo, numero_documento, telefono, direccion, email },
      error: err.message || 'No se pudo actualizar el cliente.',
    });
  }
}

async function cambiarEstado(req, res, next) {
  const { id } = req.params;
  try {
    const { data: cliente, error: errorLectura } = await supabaseAdmin
      .from('clientes')
      .select('activo')
      .eq('id', id)
      .single();
    if (errorLectura) throw errorLectura;

    const nuevoEstado = !cliente.activo;
    const { error } = await supabaseAdmin.from('clientes').update({ activo: nuevoEstado }).eq('id', id);
    if (error) throw error;

    await auditoria.registrar({
      tipo: nuevoEstado ? 'cliente_activado' : 'cliente_desactivado',
      descripcion: `Cliente ${nuevoEstado ? 'activado' : 'desactivado'}.`,
      clienteId: id,
      actorId: req.usuario.id,
    });

    res.redirect(`/admin/clientes?ok=${encodeURIComponent('Cliente ' + (nuevoEstado ? 'activado' : 'desactivado') + ' correctamente.')}`);
  } catch (err) {
    next(err);
  }
}

async function guardarNotas(req, res, next) {
  const { id } = req.params;
  const { notas_admin } = req.body;
  try {
    // Nota PRIVADA de este usuario sobre el cliente compartido: upsert en
    // notas_cliente por (cliente_id, usuario_id). La columna clientes.notas_admin
    // ya no se usa (era una sola nota compartida por todos).
    const { error } = await supabaseAdmin
      .from('notas_cliente')
      .upsert({
        cliente_id: id,
        usuario_id: req.usuario.id,
        texto: notas_admin || null,
        actualizado_en: new Date().toISOString(),
      }, { onConflict: 'cliente_id,usuario_id' });
    if (error) throw error;

    res.redirect(`/admin/clientes/${id}?tab=notas&ok=${encodeURIComponent('Notas guardadas.')}`);
  } catch (err) {
    next(err);
  }
}

async function subirDocumento(req, res, next) {
  const { id } = req.params;
  try {
    if (!req.file) {
      return res.redirect(`/admin/clientes/${id}?tab=documentos&error=${encodeURIComponent('Selecciona un archivo.')}`);
    }
    await documentosService.subirDocumento({ clienteId: id, archivo: req.file, subidoPor: req.usuario.id });
    await auditoria.registrar({
      tipo: 'documento_subido',
      descripcion: `Documento subido: ${req.file.originalname}.`,
      clienteId: id,
      detalle: { nombre: req.file.originalname, tamano: req.file.size },
      actorId: req.usuario.id,
    });
    res.redirect(`/admin/clientes/${id}?tab=documentos&ok=${encodeURIComponent('Documento subido.')}`);
  } catch (err) {
    res.redirect(`/admin/clientes/${id}?tab=documentos&error=${encodeURIComponent(err.message || 'No se pudo subir el documento.')}`);
  }
}

async function verDocumento(req, res, next) {
  try {
    // Se pasa el id del cliente de la URL: el servicio exige que el documento
    // sea suyo (ver documentos.service.js).
    const url = await documentosService.obtenerUrlFirmada(req.params.docId, req.params.id, req.usuario.id);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

async function eliminarDocumento(req, res, next) {
  const { id, docId } = req.params;
  try {
    await documentosService.eliminarDocumento(docId, id, req.usuario.id);
    await auditoria.registrar({
      tipo: 'documento_eliminado',
      descripcion: 'Documento eliminado del cliente.',
      clienteId: id,
      detalle: { documento_id: docId },
      actorId: req.usuario.id,
    });
    res.redirect(`/admin/clientes/${id}?tab=documentos&ok=${encodeURIComponent('Documento eliminado.')}`);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listarClientes,
  mostrarFormularioNuevo,
  renderNuevoConError,
  renderEditarConError,
  crearCliente,
  mostrarFicha,
  mostrarFormularioEditar,
  editarCliente,
  cambiarEstado,
  guardarNotas,
  subirDocumento,
  verDocumento,
  eliminarDocumento,
};
