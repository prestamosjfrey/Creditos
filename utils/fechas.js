const { addDays, addMonths, differenceInCalendarDays, format, lastDayOfMonth, setDate } = require('date-fns');

// Coloca `dia` dentro del mes de `fecha`, recortando al último día si ese mes
// no llega (pedir el 30 en febrero → 28, o 29 en bisiesto).
function diaEnMes(fecha, dia) {
  const ultimoDia = lastDayOfMonth(fecha).getDate();
  return setDate(fecha, Math.min(dia, ultimoDia));
}

// Días que dura un periodo, para las frecuencias que son aritmética de
// calendario pura. Una quincena son 15 días, igual que una semana son 7: no hay
// "días fijos del mes" ni rejilla 15/30.
//
// Ejemplo (validado con el prestamista): primer pago el 10 de febrero →
//   10/02  +15→  25/02  +15→  12/03   (quedan 3 días de febrero + 12 de marzo)
//
// Consecuencia buscada: el periodo SIEMPRE dura 15 días, así que el interés de
// cada cuota cubre exactamente el mismo tiempo. A cambio, el día del mes se va
// corriendo (20, 4, 19, 3…) en vez de repetirse.
const DIAS_POR_PERIODO = { diario: 1, semanal: 7, quincenal: 15 };

// Fecha de la cuota número `indice` (empezando en 0), calculada SIEMPRE desde la
// fecha del primer pago, nunca encadenando desde la cuota anterior.
//
// Para diario/semanal/quincenal da igual (sumar es asociativo), pero en MENSUAL
// importa: encadenando, un préstamo del día 31 se recortaría al 28 en febrero y
// se quedaría en el 28 para siempre. Anclando al día original, febrero recorta
// solo esa cuota y en marzo se vuelve al 31.
function fechaDeCuota(fechaPrimerPago, frecuenciaPago, indice) {
  const dias = DIAS_POR_PERIODO[frecuenciaPago];
  if (dias) return addDays(fechaPrimerPago, indice * dias);

  if (frecuenciaPago === 'mensual') {
    return diaEnMes(addMonths(fechaPrimerPago, indice), fechaPrimerPago.getDate());
  }

  throw new Error(`Frecuencia de pago desconocida: ${frecuenciaPago}`);
}

// Un solo periodo hacia adelante desde `fecha`.
//
// Úsala solo para saltos sueltos (p. ej. deducir el primer pago a partir de la
// fecha de desembolso). Para generar un plan de cuotas usa fechaDeCuota(), que
// ancla cada fecha al primer pago y no arrastra los recortes de los meses cortos.
function siguienteFecha(fecha, frecuenciaPago) {
  return fechaDeCuota(fecha, frecuenciaPago, 1);
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

module.exports = { fechaDeCuota, siguienteFecha, diasDeAtraso, formatoISO, formatoRelativoDias };
