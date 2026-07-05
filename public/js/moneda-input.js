// Formatea en vivo los campos de pesos (.input-moneda): solo permite dígitos
// y los muestra con puntos de miles (1.000.000). El servidor recibe el valor
// con puntos y lo interpreta quitándolos (utils/moneda.parsearNumero), así que
// no hace falta limpiar nada al enviar.
(function () {
  function soloDigitos(str) {
    return String(str == null ? '' : str).replace(/\D/g, '');
  }

  function formatear(digitos) {
    if (!digitos) return '';
    return Number(digitos).toLocaleString('es-CO'); // es-CO usa punto como separador de miles
  }

  // Helpers globales para que otros scripts (ej. el wizard de préstamo) lean y
  // escriban estos campos de forma consistente.
  window.parseMoneda = function (valor) {
    return Number(soloDigitos(valor)) || 0;
  };
  window.formatearMoneda = function (numero) {
    if (numero === '' || numero === null || numero === undefined || isNaN(numero)) return '';
    return Math.round(Number(numero)).toLocaleString('es-CO');
  };

  function enlazar(input) {
    if (input.value) input.value = formatear(soloDigitos(input.value));
    input.addEventListener('input', function () {
      input.value = formatear(soloDigitos(input.value));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.input-moneda').forEach(enlazar);
  });
})();
