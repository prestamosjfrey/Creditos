function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(500).render('errores/500', { mensaje: err.message });
}

module.exports = errorHandler;
