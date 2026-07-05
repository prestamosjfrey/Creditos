// Interactividad global.

// Muestra un SweetAlert de carga (spinner) bloqueante. Reutilizable desde
// cualquier flujo (envío de formularios, confirmaciones, etc.).
function mostrarCargando(titulo) {
  if (!window.Swal) return;
  Swal.fire({
    title: titulo || 'Procesando…',
    html: 'Un momento por favor…',
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    didOpen: function () { Swal.showLoading(); },
  });
}
window.mostrarCargando = mostrarCargando;

// Feedback inmediato + anti-doble-clic en TODA acción (formularios POST):
// al enviar, se muestra el spinner de una vez para que se vea que la acción
// ya está en curso, y se deshabilita el botón para evitar envíos duplicados.
//
// Los formularios que confirman primero (p. ej. eliminar) hacen preventDefault
// y disparan la carga ellos mismos tras confirmar; por eso aquí se respeta
// `defaultPrevented` y no se pisan. Para excluir un formulario: data-no-loading.
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form || form.tagName !== 'FORM') return;
  if (e.defaultPrevented) return;
  if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
  if (form.hasAttribute('data-no-loading')) return;

  mostrarCargando(form.getAttribute('data-loading-title') || 'Procesando…');

  // Deshabilitar el botón en el siguiente tick: no cancela el envío en curso,
  // pero bloquea un segundo clic.
  var btn = form.querySelector('button[type="submit"], input[type="submit"]');
  if (btn) setTimeout(function () { btn.disabled = true; }, 0);
});

// Sidebar desplegable (hamburguesa).
//  - Escritorio: colapsa/expande y recuerda la preferencia en localStorage.
//  - Móvil: abre/cierra como cajón con fondo oscuro.
(function () {
  var html = document.documentElement;
  var btnAbrir = document.getElementById('btn-abrir-sidebar');
  var btnCerrar = document.getElementById('btn-cerrar-sidebar');
  var backdrop = document.getElementById('sidebar-backdrop');
  if (!btnAbrir || !btnCerrar) return;

  var esEscritorio = function () { return window.matchMedia('(min-width: 1024px)').matches; };

  function abrir() {
    if (esEscritorio()) {
      html.classList.remove('sidebar-collapsed');
      try { localStorage.setItem('sidebar-collapsed', '0'); } catch (e) {}
    } else {
      html.classList.add('sidebar-mobile-open');
    }
  }
  function cerrar() {
    if (esEscritorio()) {
      html.classList.add('sidebar-collapsed');
      try { localStorage.setItem('sidebar-collapsed', '1'); } catch (e) {}
    } else {
      html.classList.remove('sidebar-mobile-open');
    }
  }

  btnAbrir.addEventListener('click', abrir);
  btnCerrar.addEventListener('click', cerrar);
  if (backdrop) backdrop.addEventListener('click', cerrar);
  // Al pasar a escritorio se descarta el estado de cajón móvil.
  window.matchMedia('(min-width: 1024px)').addEventListener('change', function () {
    html.classList.remove('sidebar-mobile-open');
  });
})();
