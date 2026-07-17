function formatCOP(valor) {
  const numero = Number(valor) || 0;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(numero);
}

// Convierte un valor que puede venir formateado con puntos de miles
// (ej. "1.000.000") a número crudo (1000000).
//
// Los montos de la app son pesos colombianos enteros: el formulario no pide
// centavos y la interfaz los muestra sin decimales. Aun así, quedarse solo con
// los dígitos era peligroso — "1.000,50" se convertía en 100050, es decir, cien
// mil pesos de más y sin avisar. Aquí se descarta explícitamente la parte
// decimal en lugar de concatenarla.
//
// Devuelve 0 cuando no hay ningún dígito (campo vacío). Los validadores de
// entrada (middlewares/validar.js) son los que rechazan un 0 donde no toca.
function parsearNumero(valor) {
  if (valor === null || valor === undefined) return 0;

  // Se quita todo salvo dígitos y separadores; luego se descarta la parte
  // decimal (último separador seguido de 1 o 2 cifras) en vez de pegarla.
  const limpio = String(valor).replace(/[^\d.,]/g, '');
  const entero = limpio.replace(/[.,](\d{1,2})$/, '').replace(/[^\d]/g, '');

  return entero ? Number(entero) : 0;
}

module.exports = { formatCOP, parsearNumero };
