// Detalle del préstamo: dona de composición, cálculo en vivo del abono y chips
// de "aplicar a cuota".
(function () {
  var fmt = function (v) { return '$ ' + Math.round(Number(v) || 0).toLocaleString('es-CO'); };
  function set(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }

  // ---- Dona: composición capital / interés ----
  var el = document.getElementById('dona-credito');
  if (el && window.Chart) {
    var cap = Number(el.dataset.capital) || 0;
    var intr = Number(el.dataset.interes) || 0;
    new Chart(el.getContext('2d'), {
      type: 'doughnut',
      data: { labels: ['Capital', 'Interés'], datasets: [{ data: [cap, intr], backgroundColor: ['#10b981', '#8b5cf6'], borderWidth: 0 }] },
      options: { cutout: '74%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    });
  }

  // ---- Menú de "más acciones" (⋮) ----
  var btnMas = document.getElementById('btn-mas-acciones');
  var menuMas = document.getElementById('menu-mas-acciones');
  if (btnMas && menuMas) {
    btnMas.addEventListener('click', function (e) { e.stopPropagation(); menuMas.classList.toggle('hidden'); });
    document.addEventListener('click', function () { menuMas.classList.add('hidden'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menuMas.classList.add('hidden'); });
  }

  // ---- Formulario de abono ----
  var form = document.getElementById('form-abono');
  if (!form) return;
  var inputMonto = document.getElementById('abono-monto');
  var inputCuota = document.getElementById('abono-cuota-id');
  var chips = form.querySelectorAll('.chip-cuota-abono');
  var selMas = document.getElementById('abono-cuota-mas');
  var ratioCapital = Number(form.dataset.ratioCapital) || 0;
  var saldoActual = Number(form.dataset.saldo) || 0;
  var interesCuota = Number(form.dataset.interesCuota) || 0;
  var tipoSel = document.getElementById('abono-tipo');
  var bloqueInteres = document.getElementById('bloque-interes');
  var lblMonto = document.getElementById('abono-monto-label');

  var leer = function () { return window.parseMoneda ? window.parseMoneda(inputMonto.value) : (Number(inputMonto.value) || 0); };
  var esInteres = function () { return tipoSel && tipoSel.value === 'interes'; };

  function actualizarResumen() {
    var monto = leer();
    var cap, intr;
    if (esInteres()) {
      // Pago de solo interés: todo va a interés, el capital no se aplica.
      cap = 0;
      intr = monto;
    } else {
      var aplicado = Math.min(monto, saldoActual);
      cap = Math.round(aplicado * ratioCapital);
      intr = aplicado - cap;
    }
    set('abono-cap', fmt(cap));
    set('abono-int', fmt(intr));
    set('abono-saldo', fmt(Math.max(0, saldoActual - monto)));
  }
  if (inputMonto) inputMonto.addEventListener('input', actualizarResumen);

  // Tipo de pago: mostrar/ocultar el bloque de solo interés y prellenar el monto.
  if (tipoSel) {
    tipoSel.addEventListener('change', function () {
      var interes = esInteres();
      if (bloqueInteres) bloqueInteres.classList.toggle('hidden', !interes);
      if (lblMonto) lblMonto.textContent = interes ? 'Interés a pagar' : 'Monto del abono';
      if (interes && (!inputMonto.value || inputMonto.value.trim() === '') && interesCuota > 0) {
        inputMonto.value = window.formatearMoneda ? window.formatearMoneda(interesCuota) : String(interesCuota);
      }
      actualizarResumen();
    });
  }

  function marcar(cuotaId) {
    if (inputCuota) inputCuota.value = cuotaId || '';
    chips.forEach(function (c) {
      c.classList.toggle('chip-abono-activo', c.getAttribute('data-cuota') === String(cuotaId || ''));
    });
  }
  chips.forEach(function (c) {
    c.addEventListener('click', function () { marcar(c.getAttribute('data-cuota')); if (selMas) selMas.value = ''; });
  });
  if (selMas) selMas.addEventListener('change', function () { if (selMas.value) marcar(selMas.value); });

  actualizarResumen();
})();
