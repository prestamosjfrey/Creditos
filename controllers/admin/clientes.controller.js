const { supabaseAdmin } = require('../../config/supabase');
const documentosService = require('../../services/documentos.service');
const auditoria = require('../../services/auditoria.service');
const scoreService = require('../../services/score.service');

async function listarClientes(req, res, next) {
  try {
    const busqueda = (req.query.q || '').trim();

    let query = supabaseAdmin
      .from('perfiles')
      .select('*')
      .eq('rol', 'cliente')
      .order('nombre_completo', { ascending: true });

    if (busqueda) {
      query = query.or(
        `nombre_completo.ilike.%${busqueda}%,numero_documento.ilike.%${busqueda}%,telefono.ilike.%${busqueda}%`
      );
    }

    const { data: clientes, error } = await query;
    if (error) throw error;

    // Estadísticas globales (no dependen del filtro de búsqueda).
    const { data: todos, error: errorTodos } = await supabaseAdmin
      .from('perfiles')
      .select('activo, creado_en')
      .eq('rol', 'cliente');
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

async function crearCliente(req, res, next) {
  const { email, nombre_completo, numero_documento, telefono, direccion } = req.body;
  try {
    // El cliente no inicia sesión en el sistema (es solo un registro que
    // lleva el admin), así que se crea sin contraseña.
    const { data: creado, error: errorAuth } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { nombre_completo, rol: 'cliente' },
    });
    if (errorAuth) throw errorAuth;

    const { error: errorPerfil } = await supabaseAdmin
      .from('perfiles')
      .update({ numero_documento, telefono, direccion })
      .eq('id', creado.user.id);
    if (errorPerfil) throw errorPerfil;

    await auditoria.registrar({
      tipo: 'cliente_creado',
      descripcion: `Cliente creado: ${nombre_completo}.`,
      clienteId: creado.user.id,
      detalle: { numero_documento, telefono, email },
      actorId: req.usuario.id,
    });

    res.redirect(`/admin/clientes/${creado.user.id}?ok=${encodeURIComponent('Cliente creado correctamente.')}`);
  } catch (err) {
    res.status(400).render('admin/clientes/form', {
      titulo: 'Nuevo cliente',
      error: err.message || 'No se pudo crear el cliente.',
      valores: req.body,
    });
  }
}

async function mostrarFicha(req, res, next) {
  try {
    const { id } = req.params;

    const { data: cliente, error: errorCliente } = await supabaseAdmin
      .from('perfiles')
      .select('*')
      .eq('id', id)
      .eq('rol', 'cliente')
      .single();
    if (errorCliente || !cliente) return res.status(404).render('errores/404');

    const { data: prestamos, error: errorPrestamos } = await supabaseAdmin
      .from('prestamos')
      .select('*')
      .eq('cliente_id', id)
      .order('creado_en', { ascending: false });
    if (errorPrestamos) throw errorPrestamos;

    const { data: cuotas, error: errorCuotas } = await supabaseAdmin
      .from('cuotas')
      .select('*, prestamos!inner(cliente_id)')
      .eq('prestamos.cliente_id', id);
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

    const documentos = await documentosService.listarDocumentos(id);

    res.render('admin/clientes/ficha', {
      titulo: cliente.nombre_completo,
      cliente,
      prestamos,
      scoreCredito,
      scoreActualizadoEn,
      infoScore,
      scoreDetalle,
      documentos,
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
      .from('perfiles')
      .select('*')
      .eq('id', id)
      .eq('rol', 'cliente')
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
    // El correo es el identificador en auth, así que se actualiza ahí también.
    const { error: errorAuth } = await supabaseAdmin.auth.admin.updateUserById(id, {
      email,
      user_metadata: { nombre_completo, rol: 'cliente' },
    });
    if (errorAuth) throw errorAuth;

    const { error: errorPerfil } = await supabaseAdmin
      .from('perfiles')
      .update({ nombre_completo, numero_documento, telefono, direccion, email })
      .eq('id', id);
    if (errorPerfil) throw errorPerfil;

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
      .from('perfiles')
      .select('activo')
      .eq('id', id)
      .single();
    if (errorLectura) throw errorLectura;

    const nuevoEstado = !cliente.activo;
    const { error } = await supabaseAdmin.from('perfiles').update({ activo: nuevoEstado }).eq('id', id);
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
    const { error } = await supabaseAdmin
      .from('perfiles')
      .update({ notas_admin: notas_admin || null })
      .eq('id', id);
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
    const url = await documentosService.obtenerUrlFirmada(req.params.docId);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

async function eliminarDocumento(req, res, next) {
  const { id, docId } = req.params;
  try {
    await documentosService.eliminarDocumento(docId);
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
