const archivoService = require('../../services/archivo.service');

async function mostrarArchivo(req, res, next) {
  try {
    const arbol = await archivoService.obtenerArbol();
    res.render('admin/archivo/index', { titulo: 'Comprobantes', arbol });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarArchivo };
