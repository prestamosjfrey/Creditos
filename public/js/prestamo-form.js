// Formulario de nuevo préstamo en 3 pasos (Detalles / Plan de pago / Confirmación).
// Es un solo <form> real: los pasos solo se muestran/ocultan con CSS, así que
// el envío final sigue siendo el mismo POST a /admin/prestamos de siempre.
(function () {
  const form = document.getElementById('form-prestamo');
  if (!form) return;

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
  const DRAFT_KEY = 'borrador-prestamo';
  const camposDraft = [clienteId, montoCapital, tipoInteres, valorInteres, tasaInteres,
    numeroCuotas, valorCuota, montoTotalAPagar, frecuenciaPago, fechaInicio, fechaPrimerPago, notas];

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
    const clientePreseleccionado = clienteId.value !== '';
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

  form.addEventListener('input', guardarBorrador);
  form.addEventListener('change', guardarBorrador);

  // --- TomSelect para el selector de cliente ---
  if (window.TomSelect) {
    new TomSelect('#cliente_id', { create: false, placeholder: 'Busca un cliente por nombre o cédula...' });
  }

  // --- Plan de cuotas (mismo algoritmo que services/prestamos.service.js) ---
  function siguienteFecha(fecha, frecuencia) {
    const f = new Date(fecha);
    if (frecuencia === 'diario') f.setDate(f.getDate() + 1);
    else if (frecuencia === 'semanal') f.setDate(f.getDate() + 7);
    else if (frecuencia === 'quincenal') f.setDate(f.getDate() + 15);
    else if (frecuencia === 'mensual') f.setMonth(f.getMonth() + 1);
    return f;
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

    // Interés parejo por cuota (la última absorbe el redondeo). El capital de
    // cada cuota es lo que queda del monto tras descontar su interés.
    const interesRegular = Math.round(interesTotal / cuotas);

    const plan = [];
    let fecha = new Date(`${primerPago}T00:00:00`);
    let acumuladoMonto = 0;
    let acumuladoInteres = 0;

    for (let i = 1; i <= cuotas; i++) {
      const esUltima = i === cuotas;
      const monto = esUltima ? Math.round(totalAPagar - acumuladoMonto) : Math.round(valorCuotaNum);
      const interes = esUltima ? Math.round(interesTotal - acumuladoInteres) : interesRegular;
      const capital = Math.round(monto - interes);
      plan.push({ numero: i, fecha: new Date(fecha), monto, interes, capital });
      acumuladoMonto += monto;
      acumuladoInteres += interes;
      fecha = siguienteFecha(fecha, frecuencia);
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

    const nombreCliente = clienteId.options[clienteId.selectedIndex]?.text.trim() || '—';
    const plan = calcularPlanDeCuotas();
    const filas = [
      ['Cliente', nombreCliente],
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

  // --- Confirmación final si la caja queda en negativo (advierte, no bloquea) ---
  let confirmadoSaldoNegativo = false;
  form.addEventListener('submit', (e) => {
    const capital = leerMoneda(montoCapital);
    if (capital <= saldoDisponible || confirmadoSaldoNegativo || !window.Swal) {
      // El formulario se va a enviar de verdad: descartamos el borrador para
      // que el próximo "Nuevo préstamo" empiece en blanco.
      limpiarBorrador();
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

  actualizarVisibilidadCampos();
  actualizarContadorNotas();
  actualizarResumen();
  actualizarAlertaSaldo();
  mostrarPaso(1);
})();
