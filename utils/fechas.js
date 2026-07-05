const { addDays, addMonths, differenceInCalendarDays, format } = require('date-fns');

const SUMAR_POR_FRECUENCIA = {
  diario: (fecha) => addDays(fecha, 1),
  semanal: (fecha) => addDays(fecha, 7),
  quincenal: (fecha) => addDays(fecha, 15),
  mensual: (fecha) => addMonths(fecha, 1),
};

function siguienteFecha(fecha, frecuenciaPago) {
  const sumar = SUMAR_POR_FRECUENCIA[frecuenciaPago];
  if (!sumar) throw new Error(`Frecuencia de pago desconocida: ${frecuenciaPago}`);
  return sumar(fecha);
}

function diasDeAtraso(fechaVencimiento, hoy = new Date()) {
  return Math.max(0, differenceInCalendarDays(hoy, fechaVencimiento));
}

function formatoISO(fecha) {
  return format(fecha, 'yyyy-MM-dd');
}

// "Vence hoy" / "Vence mañana" / "Vence en N días" para una fecha futura (o ya pasada).
function formatoRelativoDias(fechaVencimiento, hoy = new Date()) {
  const dias = differenceInCalendarDays(fechaVencimiento, hoy);
  if (dias < 0) return `Venció hace ${Math.abs(dias)} día${Math.abs(dias) === 1 ? '' : 's'}`;
  if (dias === 0) return 'Vence hoy';
  if (dias === 1) return 'Vence mañana';
  return `Vence en ${dias} días`;
}

module.exports = { siguienteFecha, diasDeAtraso, formatoISO, formatoRelativoDias };
