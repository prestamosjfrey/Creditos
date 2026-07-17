const { CATALOGO, buscarReporte } = require('../../services/reportes.service');
const { PERIODOS, resolverRango, etiquetaRango } = require('../../utils/rangos');

function mostrarIndice(req, res) {
  // El índice conserva el rango elegido para que al entrar a un reporte ya venga
  // aplicado, y al volver no se pierda.
  const rango = resolverRango(req.query, 'este_mes');
  res.render('admin/reportes/index', {
    titulo: 'Reportes',
    reportes: CATALOGO.map(({ clave, titulo, descripcion, icono, sinRango }) => ({ clave, titulo, descripcion, icono, sinRango })),
    periodos: PERIODOS,
    rango,
  });
}

async function mostrarReporte(req, res, next) {
  try {
    const reporte = buscarReporte(req.params.clave);
    if (!reporte) return res.status(404).render('errores/404');

    const rango = resolverRango(req.query, 'este_mes');
    const datos = await reporte.calcular(rango);

    res.render('admin/reportes/ver', {
      titulo: reporte.titulo,
      reporte: { clave: reporte.clave, titulo: reporte.titulo, descripcion: reporte.descripcion, sinRango: !!reporte.sinRango },
      datos,
      periodos: PERIODOS,
      rango,
      etiqueta: etiquetaRango(rango),
    });
  } catch (err) {
    next(err);
  }
}

// Exportación a CSV. Sirve para cualquier reporte porque todos comparten la
// forma { columnas, filas }: no hay un exportador por reporte.
async function exportarReporte(req, res, next) {
  try {
    const reporte = buscarReporte(req.params.clave);
    if (!reporte) return res.status(404).render('errores/404');

    const rango = resolverRango(req.query, 'este_mes');
    const { columnas, filas } = await reporte.calcular(rango);

    // Excel y LibreOffice ejecutan como fórmula cualquier celda que empiece por
    // = + - @ (o tabulador/retorno). Un nombre de cliente como =HYPERLINK(...)
    // se ejecutaría al abrir el archivo, así que se rompe ese arranque con una
    // comilla simple. Mismo criterio que la exportación de préstamos.
    const esc = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };

    const cabecera = columnas.map((c) => esc(c.titulo)).join(',');
    const cuerpo = filas.map((f) => columnas.map((c) => esc(f[c.clave])).join(','));
    // El BOM inicial hace que Excel abra el archivo como UTF-8 y no parta los
    // acentos ni la ñ.
    const csv = '﻿' + [cabecera, ...cuerpo].join('\r\n');

    const nombre = `${reporte.clave}-${etiquetaRango(rango).replace(/[^\w]+/g, '-').toLowerCase()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = { mostrarIndice, mostrarReporte, exportarReporte };
