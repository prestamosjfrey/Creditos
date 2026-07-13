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
  // El servidor entrega UNA sola serie según el filtro de periodo aplicado
  // (Hoy / Esta semana / Este mes / Este año / rango). El cambio de periodo
  // recarga la página vía los enlaces del filtro, no se alterna en el cliente.
  const serie = window.__SERIES_INGRESOS__;
  if (!canvas || !serie) return;

  const formatoMoneda = (valor) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(valor);

  new Chart(canvas, {
    type: 'line',
    data: {
      labels: serie.labels,
      datasets: [
        {
          label: 'Ingresos',
          data: serie.valores,
          borderColor: '#2563EB',
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: 'Total prestado',
          data: serie.valoresCapitalPrestado,
          borderColor: '#F97316',
          backgroundColor: 'transparent',
          borderDash: [6, 4],
          fill: false,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: 'Total prestado + ganancia',
          data: serie.valoresTotalConGanancia,
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
            title: (items) => serie.tooltips[items[0].dataIndex],
            label: (item) => `${item.dataset.label}: ${formatoMoneda(item.raw)}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => '$' + v.toLocaleString('es-CO') } },
      },
    },
  });
});
