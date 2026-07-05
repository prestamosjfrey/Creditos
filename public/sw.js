// Service Worker mínimo — solo se necesita para que el navegador
// habilite el botón "Instalar app". No hace caché offline porque
// la app requiere conexión a Supabase de todas formas.
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
