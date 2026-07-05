// Dropdown del avatar (mostrar/ocultar) y cambio de periodo del gráfico de
// ingresos. Los 4 periodos ya vienen calculados desde el servidor en
// window.__SERIES_INGRESOS__ — aquí solo se alterna cuál se muestra.
document.addEventListener('DOMContentLoaded', () => {
  const btnAvatar = document.getElementById('btn-avatar-menu');
  const menuAvatar = document.getElementById('menu-avatar');
  if (btnAvatar && menuAvatar) {
    btnAvatar.addEventListener('click', (e) => {
      e.stopPropagation();
      menuAvatar.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menuAvatar.classList.add('hidden'));
  }

  const canvas = document.getElementById('chart-ingresos');
  const series = window.__SERIES_INGRESOS__;
  if (!canvas || !series) return;

  const formatoMoneda = (valor) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(valor);

  let periodoActual = '30d';
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: series[periodoActual].labels,
      datasets: [
        {
          label: 'Ingresos',
          data: series[periodoActual].valores,
          borderColor: '#2563EB',
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: 'Total prestado',
          data: series[periodoActual].valoresCapitalPrestado,
          borderColor: '#F97316',
          backgroundColor: 'transparent',
          borderDash: [6, 4],
          fill: false,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: 'Total prestado + ganancia',
          data: series[periodoActual].valoresTotalConGanancia,
          borderColor: '#7C3AED',
          backgroundColor: 'transparent',
          borderDash: [2, 3],
          fill: false,
          tension: 0.35,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 18 } },
        tooltip: {
          callbacks: {
            title: (items) => series[periodoActual].tooltips[items[0].dataIndex],
            label: (item) => `${item.dataset.label}: ${formatoMoneda(item.raw)}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => '$' + v.toLocaleString('es-CO') } },
      },
    },
  });

  function actualizarMiniStats() {
    const stats = series[periodoActual].estadisticas;
    document.getElementById('stat-total').textContent = formatoMoneda(stats.total);
    document.getElementById('stat-promedio').textContent = formatoMoneda(stats.promedioDiario);
    document.getElementById('stat-dias').textContent = `${stats.diasConIngresos} de ${stats.diasTotales}`;
  }

  document.querySelectorAll('.periodo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      periodoActual = btn.dataset.periodo;
      document.querySelectorAll('.periodo-btn').forEach((b) => b.classList.remove('periodo-btn-activo'));
      btn.classList.add('periodo-btn-activo');

      chart.data.labels = series[periodoActual].labels;
      chart.data.datasets[0].data = series[periodoActual].valores;
      chart.data.datasets[1].data = series[periodoActual].valoresCapitalPrestado;
      chart.data.datasets[2].data = series[periodoActual].valoresTotalConGanancia;
      chart.update();
      actualizarMiniStats();
    });
  });
});
