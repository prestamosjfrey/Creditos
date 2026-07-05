const dashboardService = require('../../services/dashboard.service');

function mostrarIndice(req, res) {
  res.render('admin/reportes/index', { titulo: 'Reportes' });
}

async function mostrarCapitalPrestado(req, res, next) {
  try {
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;

    const { meses, total, cantidad } = await dashboardService.obtenerCapitalPrestadoPorMes({ desde, hasta });

    res.render('admin/reportes/capital-prestado', {
      titulo: 'Capital prestado',
      meses,
      total,
      cantidad,
      desde,
      hasta,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarIndice, mostrarCapitalPrestado };
