// Service Worker mínimo — solo se necesita para que el navegador
// habilite el botón "Instalar app". No hace caché offline porque
// la app requiere conexión a Supabase de todas formas.
const VERSION = 'v2';
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Pasarela a la red que NUNCA se rechaza sin capturar. Si la red falla
// (arranque en frío de Render, 503 momentáneo, reconexión), devolvemos una
// respuesta controlada en vez de dejar un "Uncaught TypeError: Failed to fetch".
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return; // el navegador maneja POST/PUT normalmente
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response('Servicio temporalmente no disponible. Reintenta en unos segundos.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    )
  );
});
