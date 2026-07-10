const auditoria = require('../../services/auditoria.service');

const CATEGORIAS = auditoria.CATEGORIAS;

async function mostrarAuditoria(req, res, next) {
  try {
    const cat = CATEGORIAS[req.query.cat] ? req.query.cat : 'todos';
    const tipos = CATEGORIAS[cat] || null;
    const [eventos, conteos] = await Promise.all([
      auditoria.listar({ limite: 300, tipos }),
      auditoria.contarPorCategoria(),
    ]);
    res.render('admin/auditoria/index', { titulo: 'Auditoría', eventos, cat, conteos });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarAuditoria };
