const { alcanceDe } = require("../../utils/alcance");
const archivoService = require('../../services/archivo.service');

async function mostrarArchivo(req, res, next) {
  try {
    const arbol = await archivoService.obtenerArbol(alcanceDe(req.usuario));
    res.render('admin/archivo/index', { titulo: 'Comprobantes', arbol });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarArchivo };
