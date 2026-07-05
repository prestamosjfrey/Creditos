const auditoria = require('../../services/auditoria.service');

// Categorías de la bitácora -> tipos de evento que agrupan, para el filtro.
const CATEGORIAS = {
  prestamos: ['prestamo_creado', 'prestamo_pagado'],
  pagos: ['abono_registrado', 'cuota_pagada', 'pago_interes'],
  mora: ['cuota_mora'],
  caja: ['caja_ingreso', 'caja_egreso'],
  clientes: ['cliente_creado', 'cliente_editado', 'cliente_activado', 'cliente_desactivado', 'documento_subido', 'documento_eliminado'],
};

async function mostrarAuditoria(req, res, next) {
  try {
    const cat = CATEGORIAS[req.query.cat] ? req.query.cat : 'todos';
    const tipos = CATEGORIAS[cat] || null;
    const eventos = await auditoria.listar({ limite: 300, tipos });
    res.render('admin/auditoria/index', { titulo: 'Auditoría', eventos, cat });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarAuditoria };
