function formatCOP(valor) {
  const numero = Number(valor) || 0;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(numero);
}

// Convierte un valor que puede venir formateado con puntos de miles
// (ej. "1.000.000") a número crudo (1000000). Se queda solo con los dígitos.
function parsearNumero(valor) {
  if (valor === null || valor === undefined) return 0;
  const soloDigitos = String(valor).replace(/[^\d]/g, '');
  return soloDigitos ? Number(soloDigitos) : 0;
}

module.exports = { formatCOP, parsearNumero };
