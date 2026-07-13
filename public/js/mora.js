// Centro de Mora: gráfico, filtros, búsqueda, exportar y actualización en
// tiempo real vía Socket.IO.
(function () {
  var series = window.__MORA_SERIES__ || { labels: [], capital: [], interes: [], creditos: [] };
  var lista = window.__MORA_LISTA__ || [];
  var CIRC = 2 * Math.PI * 40;

  function formatoCOP(v) { return '$ ' + Math.round(v || 0).toLocaleString('es-CO'); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------------- Gráfico ----------------
  var canvas = document.getElementById('chart-mora');
  var chart = null;
  function pintar(metrica) {
    if (!canvas || !window.Chart) return;
    var datos = series[metrica] || [];
    var esMoneda = metrica !== 'creditos';
    if (chart) { chart.data.labels = series.labels; chart.data.datasets[0].data = datos; chart._esMoneda = esMoneda; chart.update(); return; }
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: series.labels, datasets: [{ data: datos, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 2, fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: '#ef4444', pointBorderColor: '#fff', pointBorderWidth: 1.5 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (ctx) { return (metricaActual !== 'creditos') ? formatoCOP(ctx.parsed.y) : ctx.parsed.y + ' crédito(s)'; } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { color: '#94a3b8', font: { size: 11 }, callback: function (v) {
            if (metricaActual === 'creditos') return v;
            if (v >= 1000000) return '$' + (v / 1000000) + 'M';
            if (v >= 1000) return '$' + (v / 1000) + 'k';
            return '$' + v;
          } } },
        },
      },
    });
  }
  var selMetrica = document.getElementById('metrica-mora');
  var metricaActual = 'capital';
  pintar(metricaActual);
  if (selMetrica) selMetrica.addEventListener('change', function () { metricaActual = selMetrica.value; pintar(metricaActual); });

  // ---------------- Filtros por rango + búsqueda ----------------
  var rangoActivo = 'todos';
  var textoBusqueda = '';

  function aplicarFiltros() {
    var filas = document.querySelectorAll('.fila-mora');
    var sinResultados = document.getElementById('mora-sin-resultados');
    var visibles = 0;
    filas.forEach(function (f) {
      var okRango = rangoActivo === 'todos' || f.getAttribute('data-rango') === rangoActivo;
      var okTexto = !textoBusqueda || (f.getAttribute('data-buscar') || '').indexOf(textoBusqueda) !== -1;
      var mostrar = okRango && okTexto;
      f.style.display = mostrar ? '' : 'none';
      if (mostrar) visibles++;
    });
    if (sinResultados) sinResultados.classList.toggle('hidden', visibles !== 0 || filas.length === 0);
  }

  document.querySelectorAll('.chip-mora').forEach(function (chip) {
    chip.addEventListener('click', function () {
      rangoActivo = chip.getAttribute('data-rango');
      document.querySelectorAll('.chip-mora').forEach(function (c) {
        c.classList.remove('bg-red-500', 'text-white', 'shadow-sm');
        c.classList.add('bg-white', 'text-slate-500', 'ring-1', 'ring-slate-200', 'hover:bg-slate-50');
      });
      chip.classList.remove('bg-white', 'text-slate-500', 'ring-1', 'ring-slate-200', 'hover:bg-slate-50');
      chip.classList.add('bg-red-500', 'text-white', 'shadow-sm');
      aplicarFiltros();
    });
  });

  var inputBuscar = document.getElementById('buscar-mora');
  if (inputBuscar) inputBuscar.addEventListener('input', function () { textoBusqueda = inputBuscar.value.toLowerCase(); aplicarFiltros(); });

  // ---------------- Exportar ----------------
  var btnExp = document.getElementById('btn-exportar-mora');
  var menuExp = document.getElementById('menu-exportar-mora');
  if (btnExp && menuExp) {
    btnExp.addEventListener('click', function (e) { e.stopPropagation(); menuExp.classList.toggle('hidden'); });
    document.addEventListener('click', function () { menuExp.classList.add('hidden'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menuExp.classList.add('hidden'); });
  }
  var btnJson = document.getElementById('exportar-mora-json');
  if (btnJson) btnJson.addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(lista, null, 2)], { type: 'application/json;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'mora-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    if (menuExp) menuExp.classList.add('hidden');
  });

  // ---------------- Actualización en tiempo real (Socket.IO) ----------------
  function set(sel, texto) { var el = document.querySelector(sel); if (el) el.textContent = texto; }

  function actualizarStats(st) {
    set('[data-stat="creditosMora"]', st.creditosMora);
    set('[data-stat-sub="creditosMora"]', st.creditosMoraPct + '% del total');
    set('[data-stat="capitalVencido"]', formatoCOP(st.capitalVencido));
    set('[data-stat-sub="capitalVencido"]', st.capitalVencidoPct + '% del total');
    set('[data-stat="interesVencido"]', formatoCOP(st.interesVencido));
    set('[data-stat-sub="interesVencido"]', st.interesVencidoPct + '% del total');
    set('[data-stat="recuperadoMes"]', formatoCOP(st.recuperadoMes));
    set('[data-stat-sub="recuperadoMes"]', st.cambioRecuperado === null ? 'Sin base anterior' : (st.cambioRecuperado >= 0 ? '+' : '') + st.cambioRecuperado + '% vs mes anterior');
    set('[data-stat="clientesMora"]', st.clientesMora);
    set('[data-stat-sub="clientesMora"]', st.clientesMoraPct + '% del total');
  }

  function actualizarSalud(salud, st) {
    var hex = salud.color === 'emerald' ? '#10b981' : (salud.color === 'amber' ? '#f59e0b' : '#ef4444');
    var cls = salud.color === 'emerald' ? 'text-emerald-600' : (salud.color === 'amber' ? 'text-amber-600' : 'text-red-500');
    var circle = document.getElementById('salud-circle');
    if (circle) { circle.setAttribute('stroke', hex); circle.setAttribute('stroke-dashoffset', (CIRC - (salud.pct / 100) * CIRC).toFixed(1)); }
    set('#salud-pct', salud.pct + '%');
    var texto = document.getElementById('salud-texto');
    if (texto) { texto.textContent = salud.texto; texto.className = 'text-lg font-bold ' + cls; }
    set('#salud-desc', salud.desc);
    var badgeTxt = document.querySelector('#salud-badge [data-badge-txt]');
    if (badgeTxt) badgeTxt.textContent = st.creditosMora === 0 ? 'Sin riesgo de mora' : st.creditosMora + ' crédito' + (st.creditosMora === 1 ? '' : 's') + ' en mora';
  }

  function filaHTML(m) {
    var rango = m.diasAtraso <= 30 ? '1-30' : (m.diasAtraso <= 60 ? '31-60' : (m.diasAtraso <= 90 ? '61-90' : '90+'));
    var buscar = (m.cliente + ' ' + m.documento + ' ' + m.numeroPrestamo).toLowerCase().replace(/"/g, '');
    var inicial = (m.cliente || '?').trim().slice(0, 1).toUpperCase();
    return '<div class="fila-mora flex items-center gap-4 py-3" data-rango="' + rango + '" data-buscar="' + esc(buscar) + '">' +
      '<span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500 text-sm font-bold">' + esc(inicial) + '</span>' +
      '<div class="min-w-0 flex-1"><p class="font-medium text-slate-800 truncate">' + esc(m.cliente) + '</p>' +
      '<p class="text-xs text-slate-400">Cédula ' + esc(m.documento) + ' · ' + esc(m.numeroPrestamo) + ' · Cuota #' + esc(m.numeroCuota) + '</p></div>' +
      '<div class="hidden sm:block text-right"><p class="num font-semibold text-slate-800">' + formatoCOP(m.saldo) + '</p>' +
      '<p class="text-xs text-slate-400">vence ' + esc(m.vencimiento) + '</p></div>' +
      '<span class="shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-600 whitespace-nowrap">' + m.diasAtraso + ' día' + (m.diasAtraso === 1 ? '' : 's') + '</span>' +
      '<a href="/admin/prestamos/' + esc(m.prestamoId) + '" class="shrink-0 text-slate-300 transition hover:text-red-500" title="Ver préstamo">' +
      '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></a></div>';
  }

  function actualizarLista(nueva) {
    lista = nueva || [];
    var vacio = document.getElementById('mora-vacio');
    var wrap = document.getElementById('mora-lista-wrap');
    var cont = document.getElementById('lista-mora');
    if (!cont) return;
    if (lista.length === 0) {
      if (vacio) vacio.classList.remove('hidden');
      if (wrap) wrap.classList.add('hidden');
    } else {
      if (vacio) vacio.classList.add('hidden');
      if (wrap) wrap.classList.remove('hidden');
      cont.innerHTML = lista.map(filaHTML).join('');
      aplicarFiltros();
    }
  }

  function actualizarTopClientes(top) {
    var cont = document.getElementById('top-clientes');
    if (!cont) return;
    if (!top || top.length === 0) {
      cont.innerHTML = '<div class="flex items-center gap-3 rounded-2xl bg-rose-50/60 px-4 py-4">' +
        '<span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-400"><svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>' +
        '<div><p class="font-medium text-slate-700">No hay clientes en mora</p><p class="text-xs text-slate-400">Todos tus clientes se encuentran al día.</p></div></div>';
      return;
    }
    cont.innerHTML = '<div class="space-y-2">' + top.map(function (c) {
      var inicial = (c.nombre || '?').trim().slice(0, 1).toUpperCase();
      return '<a href="/admin/clientes/' + esc(c.clienteId) + '" class="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50">' +
        '<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500 text-sm font-bold">' + esc(inicial) + '</span>' +
        '<div class="min-w-0 flex-1"><p class="font-medium text-slate-800 truncate">' + esc(c.nombre) + '</p>' +
        '<p class="text-xs text-slate-400">' + c.cuotas + ' cuota' + (c.cuotas === 1 ? '' : 's') + ' · hasta ' + c.maxDias + ' días</p></div>' +
        '<p class="num text-sm font-semibold text-red-600 whitespace-nowrap">' + formatoCOP(c.monto) + '</p></a>';
    }).join('') + '</div>';
  }

  var cargando = false;
  function refrescar() {
    if (cargando) return;
    cargando = true;
    fetch('/admin/mora/datos', { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (centro) {
        series = centro.series || series;
        actualizarStats(centro.stats);
        actualizarSalud(centro.salud, centro.stats);
        pintar(metricaActual);
        actualizarLista(centro.lista);
        actualizarTopClientes(centro.topClientes);
      })
      .catch(function () { /* silencioso */ })
      .finally(function () { cargando = false; });
  }

  if (window.io) {
    var socket = window.io();
    socket.on('datos:cambio', function () { refrescar(); });
  }
})();
