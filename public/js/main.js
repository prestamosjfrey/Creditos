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

// Al pulsar "Atrás", el navegador restaura la página desde el bfcache tal cual
// quedó: con el spinner de "Procesando…" aún abierto y el botón de enviar
// deshabilitado. Al restaurar (e.persisted), cerramos el spinner y reactivamos
// los botones para que la vista vuelva a quedar usable.
//
// Además: si ESTA página envió un formulario y el usuario vuelve con "Atrás",
// el navegador la restaura con los datos viejos (el asistente en el último
// paso, un formulario de edición con lo de antes) y permitiría reenviar. Cuando
// el regreso es a la misma URL que envió, se recarga en blanco. Se marca con la
// URL exacta para no recargar OTRAS páginas al volver a ellas.
window.addEventListener('pageshow', function (e) {
  if (!e.persisted) return;

  var envioEn = null;
  try { envioEn = sessionStorage.getItem('form-enviado-en'); } catch (err) {}
  if (envioEn === location.href) {
    try { sessionStorage.removeItem('form-enviado-en'); } catch (err) {}
    window.location.reload();
    return;
  }

  if (window.Swal && Swal.isVisible && Swal.isVisible()) Swal.close();
  document.querySelectorAll('button[type="submit"][disabled], input[type="submit"][disabled]')
    .forEach(function (btn) { btn.disabled = false; });
});

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

  // Se recuerda QUÉ página envió, para recargarla en blanco si el usuario vuelve
  // con "Atrás" (ver el handler de pageshow). Es la URL exacta, así solo se
  // recarga este formulario y no cualquier otra página del historial.
  try { sessionStorage.setItem('form-enviado-en', location.href); } catch (e) {}
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

// Loader entre vistas: muestra el spinner al navegar por enlaces internos (GET).
// Los formularios POST ya muestran su propio spinner (SweetAlert), así que aquí
// solo cubrimos las navegaciones que hoy no mostraban nada.
(function () {
  var overlay = document.getElementById('nav-loader');
  if (!overlay) return;
  var timer = null, fallback = null;

  function mostrar() {
    // Retardo anti-parpadeo: si la página carga rápido, no alcanza a verse.
    timer = setTimeout(function () { overlay.classList.add('nav-loader-visible'); }, 150);
    // Salvavidas: si la navegación no ocurre (enlace JS), se oculta solo.
    fallback = setTimeout(ocultar, 8000);
  }
  function ocultar() {
    clearTimeout(timer); clearTimeout(fallback);
    overlay.classList.remove('nav-loader-visible');
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
    var url;
    try { url = new URL(a.href, window.location.href); } catch (err) { return; }
    if (url.origin !== window.location.origin) return;               // solo mismo sitio
    if (url.pathname === window.location.pathname && url.search === window.location.search) return; // misma vista
    mostrar();
  });

  // Al volver con "atrás" (bfcache) o al cargar, siempre ocultar.
  window.addEventListener('pageshow', ocultar);
})();
