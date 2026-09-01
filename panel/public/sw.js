/* Claude Remote — service worker minimo.
 * Existe p/ o painel ser instalavel (PWA) no celular. NAO faz cache de API/terminal/SSE:
 * tudo passa direto pra rede (o painel so faz sentido online). */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* passthrough */ })
