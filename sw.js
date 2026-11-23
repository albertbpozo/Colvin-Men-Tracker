// Service worker: permite instalar la web como app y abrirla sin conexión.
// Los datos los guarda Firestore en su propia caché; aquí solo se guardan los
// archivos de la app y el SDK de Firebase.
const CACHE = 'menu-semanal-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function fromCacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
    // Fuera las versiones anteriores del mismo archivo (app.js?v=17 al guardar app.js?v=18).
    const url = new URL(request.url);
    if (url.searchParams.has('v')) {
      for (const old of await cache.keys()) {
        const oldUrl = new URL(old.url);
        if (oldUrl.pathname === url.pathname && oldUrl.search !== url.search) await cache.delete(old);
      }
    }
  }
  return response;
}

async function fromNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (err) {
    // Sin conexión: lo último guardado (la página se guarda sin «?tab=…»).
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./');
    throw err;
  }
}

self.addEventListener('fetch', ev => {
  const { request } = ev;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const firebaseSdk = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  if (!sameOrigin && !firebaseSdk) return; // Firestore, inicio de sesión, etc.: siempre a la red

  // Lo que lleva versión en la URL (?v=…, o el SDK) no cambia nunca: primero la caché.
  // El resto (la página, el manifiesto, los iconos) primero de la red, por si hay cambios.
  ev.respondWith(firebaseSdk || url.searchParams.has('v') ? fromCacheFirst(request) : fromNetworkFirst(request));
});
