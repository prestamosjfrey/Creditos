const { formatoISO } = require('./fechas');

// Rangos de fechas para los filtros de la aplicación.
//
// Esta lógica estaba copiada en prestamos.controller.js y en pagos.controller.js
// (cada una con sus pequeñas diferencias). Al vivir en un solo sitio, "este mes"
// significa exactamente lo mismo en todas las pantallas y en los reportes.

const PERIODOS = [
  { clave: 'hoy', etiqueta: 'Hoy' },
  { clave: 'ayer', etiqueta: 'Ayer' },
  { clave: 'esta_semana', etiqueta: 'Esta semana' },
  { clave: 'este_mes', etiqueta: 'Este mes' },
  { clave: 'mes_pasado', etiqueta: 'Mes pasado' },
  { clave: 'ultimos_30', etiqueta: 'Últimos 30 días' },
  { clave: 'este_anio', etiqueta: 'Este año' },
  { clave: 'todo', etiqueta: 'Todo el histórico' },
  { clave: 'personalizado', etiqueta: 'Personalizado' },
];

const CLAVES = PERIODOS.map((p) => p.clave);

// Lunes de la semana de `fecha` (la semana laboral aquí empieza en lunes).
function lunesDe(fecha) {
  const x = new Date(fecha);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// Convierte un periodo a { desde, hasta } en formato YYYY-MM-DD.
// 'todo' devuelve null en ambos extremos: sin filtro.
function rangoDe(periodo, query = {}) {
  const hoy = new Date();
  const iso = formatoISO;

  switch (periodo) {
    case 'hoy':
      return { desde: iso(hoy), hasta: iso(hoy) };
    case 'ayer': {
      const a = new Date(hoy);
      a.setDate(a.getDate() - 1);
      return { desde: iso(a), hasta: iso(a) };
    }
    case 'esta_semana': {
      const ini = lunesDe(hoy);
      const fin = new Date(ini);
      fin.setDate(ini.getDate() + 6);
      return { desde: iso(ini), hasta: iso(fin) };
    }
    case 'este_mes':
      return {
        desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)),
        hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)),
      };
    case 'mes_pasado':
      return {
        desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)),
        hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)),
      };
    case 'ultimos_30': {
      const ini = new Date(hoy);
      ini.setDate(ini.getDate() - 29);
      return { desde: iso(ini), hasta: iso(hoy) };
    }
    case 'este_anio':
      return {
        desde: iso(new Date(hoy.getFullYear(), 0, 1)),
        hasta: iso(new Date(hoy.getFullYear(), 11, 31)),
      };
    case 'personalizado':
      return { desde: query.desde || null, hasta: query.hasta || null };
    case 'todo':
    default:
      return { desde: null, hasta: null };
  }
}

// Lee el periodo del query string, con validación. Si llegan fechas sueltas sin
// periodo, se asume 'personalizado'. Nunca confía en el valor recibido: si no
// está en el catálogo, cae al valor por defecto.
function resolverRango(query = {}, porDefecto = 'este_mes') {
  let periodo = query.periodo;
  if (!periodo) periodo = query.desde || query.hasta ? 'personalizado' : porDefecto;
  if (!CLAVES.includes(periodo)) periodo = porDefecto;

  const { desde, hasta } = rangoDe(periodo, query);

  // Un rango personalizado al revés (desde > hasta) no devolvería nada y parece
  // un error de la app; se corrige dando la vuelta a los extremos.
  if (desde && hasta && desde > hasta) {
    return { periodo, desde: hasta, hasta: desde };
  }
  return { periodo, desde, hasta };
}

// Etiqueta legible del rango, para títulos y para el nombre de los CSV.
function etiquetaRango({ periodo, desde, hasta }) {
  if (periodo === 'todo' || (!desde && !hasta)) return 'Todo el histórico';
  const conocido = PERIODOS.find((p) => p.clave === periodo);
  if (conocido && periodo !== 'personalizado') return conocido.etiqueta;
  if (desde && hasta) return `${desde} a ${hasta}`;
  if (desde) return `Desde ${desde}`;
  return `Hasta ${hasta}`;
}

// Rango inmediatamente anterior y del mismo largo, para comparar "vs periodo
// anterior". Devuelve null si el rango no tiene ambos extremos.
function rangoAnterior({ desde, hasta }) {
  if (!desde || !hasta) return null;
  const ini = new Date(`${desde}T00:00:00`);
  const fin = new Date(`${hasta}T00:00:00`);
  const dias = Math.round((fin - ini) / 86400000) + 1;

  const finPrev = new Date(ini);
  finPrev.setDate(finPrev.getDate() - 1);
  const iniPrev = new Date(finPrev);
  iniPrev.setDate(iniPrev.getDate() - (dias - 1));

  return { desde: formatoISO(iniPrev), hasta: formatoISO(finPrev) };
}

module.exports = { PERIODOS, rangoDe, resolverRango, etiquetaRango, rangoAnterior };
