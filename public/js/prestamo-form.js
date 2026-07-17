// Formulario de nuevo préstamo en 3 pasos (Detalles / Plan de pago / Confirmación).
// Es un solo <form> real: los pasos solo se muestran/ocultan con CSS, así que
// el envío final sigue siendo el mismo POST a /admin/prestamos de siempre.
(function () {
  // Sirve tanto para "Nuevo préstamo" como para "Nuevo crédito tomado":
  // ambos usan el mismo wizard (marcado con data-wizard).
  const form = document.querySelector('form[data-wizard]');
  if (!form) return;

  // En una carga real de la página (GET nuevo o re-render tras error de envío)
  // partimos de cero: descartamos cualquier marca de "envío" previa. En una
  // restauración desde bfcache este script NO se re-ejecuta, así que la marca
  // sobrevive y la usa el handler de pageshow para recargar en blanco.
  try { sessionStorage.removeItem('prestamo-enviado'); } catch (e) {}

  const FRECUENCIA_ETIQUETA = { diario: 'Diario', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };

  const formatoMoneda = (valor) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(valor || 0);

  // Los campos de pesos muestran puntos de miles (1.000.000); estos helpers los
  // leen como número y los escriben ya formateados.
  const leerMoneda = (el) => (window.parseMoneda ? window.parseMoneda(el.value) : Number(el.value) || 0);
  const escribirMoneda = (el, n) => {
    el.value = window.formatearMoneda ? window.formatearMoneda(n) : String(Math.round(Number(n) || 0));
  };

  const tipoInteres = form.querySelector('#tipo_interes');
  const campoValorInteres = document.getElementById('campo-valor-interes');
  const campoTasaInteres = document.getElementById('campo-tasa-interes');
  const clienteId = form.querySelector('#cliente_id');
  const acreedorInput = form.querySelector('#acreedor');
  const montoCapital = form.querySelector('#monto_capital');
  const valorInteres = form.querySelector('#valor_interes');
  const tasaInteres = form.querySelector('#tasa_interes');
  const numeroCuotas = form.querySelector('#numero_cuotas');
  const valorCuota = form.querySelector('#valor_cuota');
  const montoTotalAPagar = form.querySelector('#monto_total_a_pagar');
  const frecuenciaPago = form.querySelector('#frecuencia_pago');
  const fechaInicio = form.querySelector('#fecha_inicio');
  const fechaPrimerPago = form.querySelector('#fecha_primer_pago');
  const notas = form.querySelector('#notas');
  const contadorNotas = document.getElementById('contador-notas');
  const saldoDisponible = Number(window.__SALDO_DISPONIBLE__) || 0;
  const alertaSaldo = document.getElementById('alerta-saldo-insuficiente');
  // El crédito tomado NO gasta la caja (la aumenta), así que no revisa saldo.
  const chequearSaldo = form.hasAttribute('data-check-saldo');
  const entidadLabel = form.getAttribute('data-entidad-label') || 'Cliente';

  // --- Tipo de interés: visibilidad de campos + sugerencia de cuota ---
  function actualizarVisibilidadCampos() {
    const tipo = tipoInteres.value;
    campoValorInteres.classList.toggle('hidden', tipo !== 'fijo_total');
    campoTasaInteres.classList.toggle('hidden', tipo !== 'porcentaje_periodico');
  }

  // --- Advertencia de saldo insuficiente en caja (no bloquea, solo avisa) ---
  function actualizarAlertaSaldo() {
    if (!alertaSaldo) return;
    const capital = leerMoneda(montoCapital);
    alertaSaldo.classList.toggle('hidden', capital <= saldoDisponible);
  }
  montoCapital.addEventListener('input', actualizarAlertaSaldo);

  function sugerirCuota() {
    const capital = leerMoneda(montoCapital);
    const cuotas = Number(numeroCuotas.value) || 0;
    if (capital <= 0 || cuotas <= 0) return;

    let totalAPagar;
    const tipo = tipoInteres.value;

    if (tipo === 'fijo_total') {
      totalAPagar = capital + leerMoneda(valorInteres);
    } else if (tipo === 'porcentaje_periodico') {
      const interesTotal = capital * ((Number(tasaInteres.value) || 0) / 100) * cuotas;
      totalAPagar = capital + interesTotal;
    } else {
      totalAPagar = capital;
    }

    escribirMoneda(montoTotalAPagar, Math.round(totalAPagar));
    escribirMoneda(valorCuota, Math.round(totalAPagar / cuotas));
    actualizarResumen();
    generarTablaCuotas();
  }

  tipoInteres.addEventListener('change', () => {
    actualizarVisibilidadCampos();
    sugerirCuota();
  });

  [montoCapital, valorInteres, tasaInteres, numeroCuotas].forEach((campo) => {
    campo.addEventListener('input', sugerirCuota);
  });

  // --- Contador de notas ---
  function actualizarContadorNotas() {
    contadorNotas.textContent = notas.value.length;
  }
  notas.addEventListener('input', actualizarContadorNotas);

  // --- Autoguardado de borrador (sobrevive a recargas de la página) ---
  const DRAFT_KEY = form.getAttribute('data-draft-key') || 'borrador-prestamo';
  const camposDraft = [clienteId, acreedorInput, montoCapital, tipoInteres, valorInteres, tasaInteres,
    numeroCuotas, valorCuota, montoTotalAPagar, frecuenciaPago, fechaInicio, fechaPrimerPago, notas].filter(Boolean);

  function guardarBorrador() {
    const data = {};
    camposDraft.forEach((el) => { data[el.id] = el.value; });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) {}
  }
  function limpiarBorrador() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }
  function restaurarBorrador() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) {}
    if (!data) return;
    const clientePreseleccionado = clienteId && clienteId.value !== '';
    camposDraft.forEach((el) => {
      if (data[el.id] === undefined) return;
      // Respetar el cliente que venga preseleccionado por URL o por el servidor.
      if (el === clienteId && clientePreseleccionado) return;
      el.value = data[el.id];
    });
  }

  // Si el servidor ya trae datos (reintento tras un error de envío), esos mandan
  // y solo sincronizamos el borrador. Si la página está limpia, lo restauramos.
  const hayValoresServidor = [montoCapital, numeroCuotas, valorCuota, montoTotalAPagar]
    .some((el) => el.value.trim() !== '');
  if (hayValoresServidor) guardarBorrador();
  else restaurarBorrador();

  // Fecha de inicio: si quedó vacía (formulario nuevo, sin borrador ni datos del
  // servidor), se precarga con el día de hoy (fecha local del navegador).
  if (fechaInicio && !fechaInicio.value) {
    const hoy = new Date();
    fechaInicio.value = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
  }

  form.addEventListener('input', guardarBorrador);
  form.addEventListener('change', guardarBorrador);

  // --- TomSelect para el selector de cliente ---
  if (window.TomSelect && clienteId) {
    new TomSelect('#cliente_id', { create: false, placeholder: 'Busca un cliente por nombre o cédula...' });
  }

  // --- Plan de cuotas (mismo algoritmo que services/prestamos.service.js) ---

  // Fecha de la cuota `indice` (base 0), SIEMPRE calculada desde el primer pago.
  // Debe coincidir EXACTAMENTE con fechaDeCuota() de utils/fechas.js — si las
  // dos se separan, la vista previa mentiría sobre lo que se va a guardar.
  //
  // Una quincena son 15 días, igual que una semana son 7: aritmética de
  // calendario pura. Ej.: 10/02 → 25/02 → 12/03.
  const DIAS_POR_PERIODO = { diario: 1, semanal: 7, quincenal: 15 };

  function fechaDeCuota(primerPago, frecuencia, indice) {
    const dias = DIAS_POR_PERIODO[frecuencia];
    if (dias) {
      const f = new Date(primerPago);
      f.setDate(f.getDate() + indice * dias);
      return f;
    }
    if (frecuencia === 'mensual') {
      // Anclado al día original: un préstamo del día 31 se recorta al 28 en
      // febrero, pero en marzo vuelve al 31 (no se queda en el 28).
      const base = new Date(primerPago.getFullYear(), primerPago.getMonth() + indice, 1);
      const ultimoDia = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      base.setDate(Math.min(primerPago.getDate(), ultimoDia));
      return base;
    }
    return new Date(primerPago);
  }

  function calcularPlanDeCuotas() {
    const cuotas = Number(numeroCuotas.value) || 0;
    const valorCuotaNum = leerMoneda(valorCuota);
    const totalAPagar = leerMoneda(montoTotalAPagar);
    const capitalTotal = leerMoneda(montoCapital);
    const interesTotal = Math.max(0, totalAPagar - capitalTotal);
    const frecuencia = frecuenciaPago.value;
    const primerPago = fechaPrimerPago.value;
    if (!cuotas || !primerPago) return [];

    // La tabla usa el "Valor de cada cuota" del formulario (que se autosugiere
    // como total ÷ n → cuotas iguales, pero es editable). La última cuota
    // absorbe la diferencia. Interés parejo por cuota.
    const interesRegular = Math.round(interesTotal / cuotas);

    const plan = [];
    const fechaPrimera = new Date(`${primerPago}T00:00:00`);
    let acumuladoMonto = 0;
    let acumuladoInteres = 0;

    for (let i = 1; i <= cuotas; i++) {
      const esUltima = i === cuotas;
      const monto = esUltima ? Math.round(totalAPagar - acumuladoMonto) : Math.round(valorCuotaNum);
      const interes = esUltima ? Math.round(interesTotal - acumuladoInteres) : interesRegular;
      const capital = Math.round(monto - interes);
      plan.push({ numero: i, fecha: fechaDeCuota(fechaPrimera, frecuencia, i - 1), monto, interes, capital });
      acumuladoMonto += monto;
      acumuladoInteres += interes;
    }
    return plan;
  }

  function formatoFecha(fecha) {
    return fecha.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function generarTablaCuotas() {
    const tbody = document.getElementById('tabla-cuotas-preview');
    if (!tbody) return;
    const plan = calcularPlanDeCuotas();
    if (plan.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-slate-400 py-4">Completa el monto, las cuotas y la fecha del primer pago.</td></tr>';
      return;
    }
    tbody.innerHTML = plan
      .map((c) => `<tr><td>${c.numero}</td><td>${formatoFecha(c.fecha)}</td><td class="text-right num">${formatoMoneda(c.capital)}</td><td class="text-right num text-amber-600">${formatoMoneda(c.interes)}</td><td class="text-right num font-medium">${formatoMoneda(c.monto)}</td></tr>`)
      .join('');
  }

  // --- Vista de calendario del cronograma ---
  //
  // Las mismas cuotas de la tabla, pintadas sobre los meses que abarcan. Sirve
  // para ver de un golpe cómo quedan repartidos los cobros y, sobre todo, para
  // detectar los que caen en domingo antes de cerrar el préstamo.

  const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const CABECERA_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  // Rejilla de un mes con las cuotas marcadas. La semana empieza en lunes, así
  // que el domingo (getDay() === 0) queda en la última columna.
  function calendarioDeMes(anio, mes, cuotasDelMes) {
    const ultimoDia = new Date(anio, mes + 1, 0).getDate();
    // getDay(): 0=domingo … 6=sábado. Se rota para que 0=lunes.
    const huecoInicial = (new Date(anio, mes, 1).getDay() + 6) % 7;
    const porDia = new Map(cuotasDelMes.map((c) => [c.fecha.getDate(), c]));

    let celdas = '';
    for (let i = 0; i < huecoInicial; i++) celdas += '<div></div>';

    for (let dia = 1; dia <= ultimoDia; dia++) {
      const cuota = porDia.get(dia);
      const esDomingo = new Date(anio, mes, dia).getDay() === 0;

      if (cuota) {
        // El aviso de domingo se pinta en ámbar; el resto en verde.
        const color = esDomingo ? 'bg-amber-500' : 'bg-blue-600';
        celdas +=
          '<div class="relative flex h-9 items-center justify-center">' +
            `<span class="flex h-8 w-8 items-center justify-center rounded-full ${color} text-xs font-semibold text-white" ` +
              `title="Cuota ${cuota.numero} — ${formatoMoneda(cuota.monto)}${esDomingo ? ' (domingo)' : ''}">${dia}</span>` +
            `<span class="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-slate-800 px-1 text-[9px] font-bold text-white">${cuota.numero}</span>` +
          '</div>';
      } else {
        const tono = esDomingo ? 'text-slate-300' : 'text-slate-500';
        celdas += `<div class="flex h-9 items-center justify-center text-xs ${tono}">${dia}</div>`;
      }
    }

    return (
      '<div class="rounded-xl border border-slate-100 p-3">' +
        `<p class="mb-2 text-center text-sm font-semibold capitalize text-slate-700">${MESES_LARGO[mes]} ${anio}</p>` +
        '<div class="grid grid-cols-7 gap-0.5">' +
          CABECERA_SEMANA.map((d) => `<div class="pb-1 text-center text-[10px] font-semibold uppercase text-slate-400">${d}</div>`).join('') +
          celdas +
        '</div>' +
      '</div>'
    );
  }

  function mostrarCalendarioDePagos() {
    const plan = calcularPlanDeCuotas();

    if (plan.length === 0) {
      Swal.fire({
        icon: 'info',
        title: 'Aún no hay cronograma',
        text: 'Completa el monto, el número de cuotas y la fecha del primer pago para ver el calendario.',
        confirmButtonColor: '#16a34a',
      });
      return;
    }

    // Agrupar por mes conservando el orden cronológico del plan.
    const meses = new Map();
    plan.forEach((c) => {
      const clave = `${c.fecha.getFullYear()}-${c.fecha.getMonth()}`;
      if (!meses.has(clave)) {
        meses.set(clave, { anio: c.fecha.getFullYear(), mes: c.fecha.getMonth(), cuotas: [] });
      }
      meses.get(clave).cuotas.push(c);
    });

    const enDomingo = plan.filter((c) => c.fecha.getDay() === 0);
    const total = plan.reduce((a, c) => a + c.monto, 0);

    const avisoDomingo = enDomingo.length
      ? '<div class="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-left text-xs text-amber-800">' +
          '<svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
            '<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>' +
          `<span><strong>${enDomingo.length} cuota${enDomingo.length > 1 ? 's caen' : ' cae'} en domingo</strong> ` +
          `(${enDomingo.map((c) => '#' + c.numero).join(', ')}). Si no cobras ese día, considera mover la fecha del primer pago.</span>` +
        '</div>'
      : '';

    const html =
      '<div class="text-left">' +
        '<div class="grid gap-3 sm:grid-cols-2">' +
          Array.from(meses.values()).map((m) => calendarioDeMes(m.anio, m.mes, m.cuotas)).join('') +
        '</div>' +
        '<div class="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500">' +
          '<span class="inline-flex items-center gap-1.5"><span class="h-3 w-3 rounded-full bg-blue-600"></span>Día de cobro</span>' +
          '<span class="inline-flex items-center gap-1.5"><span class="h-3 w-3 rounded-full bg-amber-500"></span>Cae en domingo</span>' +
          `<span>${plan.length} cuota${plan.length > 1 ? 's' : ''} · ${formatoMoneda(total)}</span>` +
        '</div>' +
        avisoDomingo +
      '</div>';

    Swal.fire({
      title: 'Calendario de pagos',
      html,
      width: meses.size > 1 ? 720 : 420,
      showConfirmButton: true,
      confirmButtonText: 'Cerrar',
      confirmButtonColor: '#16a34a',
      background: '#FFFFFF',
      color: '#1e293b',
    });
  }

  const btnCalendario = document.getElementById('btn-ver-calendario');
  if (btnCalendario) btnCalendario.addEventListener('click', mostrarCalendarioDePagos);

  // --- Duración total legible (de fecha_inicio a la última cuota) ---
  function formatoDuracion() {
    const plan = calcularPlanDeCuotas();
    if (plan.length === 0 || !fechaInicio.value) return '—';
    const inicio = new Date(`${fechaInicio.value}T00:00:00`);
    const fin = plan[plan.length - 1].fecha;
    const dias = Math.round((fin - inicio) / (1000 * 60 * 60 * 24));
    if (dias <= 0) return '—';
    if (dias < 14) return `${dias} día${dias === 1 ? '' : 's'}`;
    if (dias < 60) return `${Math.round(dias / 7)} semanas`;
    if (dias < 365) return `${Math.round(dias / 30)} meses`;
    return `${Math.round(dias / 365)} años`;
  }

  // --- Resumen lateral (persiste durante los 3 pasos) ---
  function actualizarResumen() {
    const capital = leerMoneda(montoCapital);
    const total = leerMoneda(montoTotalAPagar);
    const interes = total - capital;

    document.getElementById('resumen-total-pagar').textContent = formatoMoneda(total);
    document.getElementById('resumen-capital').textContent = formatoMoneda(capital);
    document.getElementById('resumen-interes').textContent = formatoMoneda(interes > 0 ? interes : 0);
    document.getElementById('resumen-cuotas').textContent = numeroCuotas.value || '—';
    document.getElementById('resumen-valor-cuota').textContent = formatoMoneda(leerMoneda(valorCuota));
    const nCuotas = Number(numeroCuotas.value) || 0;
    document.getElementById('resumen-interes-cuota').textContent = formatoMoneda(nCuotas > 0 && interes > 0 ? interes / nCuotas : 0);
    document.getElementById('resumen-frecuencia').textContent = FRECUENCIA_ETIQUETA[frecuenciaPago.value] || '—';
    document.getElementById('resumen-duracion').textContent = formatoDuracion();
  }

  [numeroCuotas, valorCuota, montoTotalAPagar, frecuenciaPago, fechaInicio, fechaPrimerPago].forEach((campo) => {
    campo.addEventListener('input', () => {
      actualizarResumen();
      generarTablaCuotas();
    });
    campo.addEventListener('change', () => {
      actualizarResumen();
      generarTablaCuotas();
    });
  });

  // --- Confirmación (paso 3): resumen de solo lectura ---
  function generarResumenConfirmacion() {
    const contenedor = document.getElementById('resumen-confirmacion');
    if (!contenedor) return;

    const nombreCliente = clienteId
      ? (clienteId.options[clienteId.selectedIndex]?.text.trim() || '—')
      : (acreedorInput ? (acreedorInput.value.trim() || '—') : '—');
    const plan = calcularPlanDeCuotas();
    const filas = [
      [entidadLabel, nombreCliente],
      ['Capital a prestar', formatoMoneda(leerMoneda(montoCapital))],
      ['Total a pagar', formatoMoneda(leerMoneda(montoTotalAPagar))],
      ['Número de cuotas', numeroCuotas.value || '—'],
      ['Valor de cada cuota', formatoMoneda(leerMoneda(valorCuota))],
      ['Frecuencia de pago', FRECUENCIA_ETIQUETA[frecuenciaPago.value] || '—'],
      ['Fecha de inicio', fechaInicio.value || '—'],
      ['Fecha del primer pago', fechaPrimerPago.value || '—'],
    ];

    let html = filas
      .map(([etiqueta, valor]) => `
        <div class="py-2.5 flex justify-between text-sm">
          <span class="text-slate-400">${etiqueta}</span>
          <span class="font-medium text-slate-700">${valor}</span>
        </div>
      `)
      .join('');

    if (plan.length > 0) {
      html += `
        <div class="py-3">
          <p class="text-sm text-slate-400 mb-2">Cronograma (${plan.length} cuotas)</p>
          <div class="rounded-xl border border-slate-100 max-h-56 overflow-y-auto">
            <table class="table-base w-full">
              <thead class="sticky top-0 bg-slate-50"><tr><th>#</th><th>Fecha</th><th class="text-right">Capital</th><th class="text-right">Interés</th><th class="text-right">Cuota</th></tr></thead>
              <tbody>${plan.map((c) => `<tr><td>${c.numero}</td><td>${formatoFecha(c.fecha)}</td><td class="text-right num">${formatoMoneda(c.capital)}</td><td class="text-right num text-amber-600">${formatoMoneda(c.interes)}</td><td class="text-right num font-medium">${formatoMoneda(c.monto)}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    contenedor.innerHTML = html;
  }

  // --- Navegación entre pasos ---
  const pasos = [1, 2, 3];
  let pasoActual = 1;

  const btnSiguiente = document.getElementById('btn-siguiente');
  const btnAtras = document.getElementById('btn-atras');
  const btnCrear = document.getElementById('btn-crear');

  function mostrarPaso(numero) {
    pasoActual = numero;
    pasos.forEach((p) => {
      const seccion = form.querySelector(`[data-paso="${p}"]`);
      if (seccion) seccion.classList.toggle('hidden', p !== numero);

      const indicador = document.querySelector(`[data-indicador="${p}"] .step-circle`);
      const etiqueta = document.querySelector(`[data-indicador="${p}"] span:last-child`);
      if (indicador) {
        indicador.classList.remove('step-circle-activo', 'step-circle-completo');
        if (p < numero) indicador.classList.add('step-circle-completo');
        else if (p === numero) indicador.classList.add('step-circle-activo');
        indicador.textContent = p < numero ? '✓' : p;
      }
      if (etiqueta) etiqueta.classList.toggle('text-blue-600', p === numero);
      if (etiqueta) etiqueta.classList.toggle('text-slate-400', p !== numero);

      const linea = document.querySelector(`[data-linea="${p}"]`);
      if (linea) linea.classList.toggle('step-line-activa', p < numero);
    });

    btnAtras.classList.toggle('hidden', numero === 1);
    btnSiguiente.classList.toggle('hidden', numero === 3);
    btnCrear.classList.toggle('hidden', numero !== 3);

    if (numero === 2) {
      var eco = document.getElementById('eco-frecuencia');
      if (eco) eco.textContent = (FRECUENCIA_ETIQUETA[frecuenciaPago.value] || 'Mensual').toLowerCase();
      generarTablaCuotas();
    }
    if (numero === 3) generarResumenConfirmacion();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Valida solo los campos del paso actual (no todo el formulario), porque los
  // pasos siguientes tienen campos requeridos aún vacíos y ocultos.
  function pasoEsValido(numero) {
    const panel = form.querySelector(`[data-paso="${numero}"]`);
    if (!panel) return true;
    const campos = panel.querySelectorAll('input, select, textarea');
    for (const campo of campos) {
      if (!campo.checkValidity()) {
        campo.reportValidity();
        return false;
      }
    }
    return true;
  }

  btnSiguiente.addEventListener('click', () => {
    if (!pasoEsValido(pasoActual)) return;
    if (pasoActual < 3) mostrarPaso(pasoActual + 1);
  });

  btnAtras.addEventListener('click', () => {
    if (pasoActual > 1) mostrarPaso(pasoActual - 1);
  });

  // Si el préstamo ya se creó y el usuario vuelve con el botón "Atrás" del
  // navegador, la página se restaura desde el bfcache con los datos aún
  // cargados (riesgo de crear un duplicado). Al detectar ese regreso,
  // recargamos el formulario en blanco para empezar de cero.
  window.addEventListener('pageshow', (e) => {
    let enviado = false;
    try { enviado = sessionStorage.getItem('prestamo-enviado') === '1'; } catch (err) {}
    if (e.persisted && enviado) {
      try { sessionStorage.removeItem('prestamo-enviado'); } catch (err) {}
      limpiarBorrador();
      // Volver de una vez al paso 1 para que no se vea el paso 2 ni un instante,
      // y recargar el formulario en blanco.
      mostrarPaso(1);
      window.location.reload();
    }
  });

  // --- Confirmación final si la caja queda en negativo (advierte, no bloquea) ---
  let confirmadoSaldoNegativo = false;
  form.addEventListener('submit', (e) => {
    const capital = leerMoneda(montoCapital);
    if (!chequearSaldo || capital <= saldoDisponible || confirmadoSaldoNegativo || !window.Swal) {
      // El formulario se va a enviar de verdad: descartamos el borrador para
      // que el próximo "Nuevo préstamo" empiece en blanco, y marcamos el envío
      // para limpiar la vista si el usuario vuelve con "Atrás" (ver pageshow).
      limpiarBorrador();
      try { sessionStorage.setItem('prestamo-enviado', '1'); } catch (e) {}
      return;
    }

    e.preventDefault();
    Swal.fire({
      icon: 'warning',
      title: 'Saldo insuficiente en caja',
      text: `Tu caja disponible es ${formatoMoneda(saldoDisponible)} y este préstamo necesita ${formatoMoneda(capital)}. Tu caja quedará en negativo. ¿Deseas continuar?`,
      showCancelButton: true,
      confirmButtonText: 'Sí, crear préstamo',
      cancelButtonText: 'Cancelar',
    }).then((resultado) => {
      if (resultado.isConfirmed) {
        confirmadoSaldoNegativo = true;
        form.requestSubmit(btnCrear);
      }
    });
  });

  // --- Botón "Limpiar": deja el formulario en blanco (con confirmación) ---
  function reiniciarFormulario() {
    form.reset();
    if (clienteId && clienteId.tomselect) clienteId.tomselect.clear(true);
    limpiarBorrador();
    // Volver a precargar la fecha de inicio con el día de hoy.
    if (fechaInicio) {
      const hoy = new Date();
      fechaInicio.value = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
    }
    confirmadoSaldoNegativo = false;
    actualizarVisibilidadCampos();
    actualizarContadorNotas();
    actualizarResumen();
    actualizarAlertaSaldo();
    generarTablaCuotas();
    mostrarPaso(1);
  }

  const btnLimpiar = document.getElementById('btn-limpiar');
  if (btnLimpiar) {
    btnLimpiar.addEventListener('click', () => {
      if (!window.Swal) { reiniciarFormulario(); return; }
      Swal.fire({
        icon: 'question',
        title: '¿Limpiar el formulario?',
        text: 'Se borrarán todos los datos que ingresaste.',
        showCancelButton: true,
        confirmButtonText: 'Sí, limpiar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#16a34a',
      }).then((r) => { if (r.isConfirmed) reiniciarFormulario(); });
    });
  }

  actualizarVisibilidadCampos();
  actualizarContadorNotas();
  actualizarResumen();
  actualizarAlertaSaldo();
  mostrarPaso(1);
})();
