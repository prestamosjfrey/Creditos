const { addDays, addMonths, differenceInCalendarDays, format, lastDayOfMonth, setDate } = require('date-fns');

// Quincenal fijo: los pagos caen siempre el día 15 y el último día del mes
// (15 → fin de mes → 15 del mes siguiente → …), sin arrastrar días de calendario.
function siguienteQuincenaFija(fecha) {
  const dia = fecha.getDate();
  if (dia < 15) return setDate(fecha, 15);
  if (dia === 15) return lastDayOfMonth(fecha);
  return setDate(addMonths(fecha, 1), 15);
}

const SUMAR_POR_FRECUENCIA = {
  diario: (fecha) => addDays(fecha, 1),
  semanal: (fecha) => addDays(fecha, 7),
  quincenal: siguienteQuincenaFija,
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
