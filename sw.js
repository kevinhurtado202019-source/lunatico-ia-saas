// Service worker minimo para que LunaticoIA se pueda instalar como PWA.
// Estrategia: red primero, la cache es solo un respaldo si no hay conexion
// -- nunca se sirve una version vieja de la app teniendo internet, porque
// este proyecto se despliega muy seguido y una cache agresiva dejaria a
// alguien viendo una version atrasada sin darse cuenta.
const CACHE = 'lunaticoia-shell-v1';
const RUTAS_SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (evento) => {
    self.skipWaiting();
    evento.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(RUTAS_SHELL))
    );
});

self.addEventListener('activate', (evento) => {
    evento.waitUntil(
        caches.keys()
            .then((nombres) => Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (evento) => {
    const url = new URL(evento.request.url);

    // La API nunca se cachea: siempre va a la red, con datos reales (saldo,
    // respuestas del chat, etc.) -- cachear esto seria mostrar informacion
    // vieja o de otro usuario.
    if (url.pathname.startsWith('/api/')) return;
    if (evento.request.method !== 'GET') return;

    evento.respondWith(
        fetch(evento.request)
            .then((respuesta) => {
                const copia = respuesta.clone();
                caches.open(CACHE).then((cache) => cache.put(evento.request, copia));
                return respuesta;
            })
            .catch(() => caches.match(evento.request).then((r) => r || caches.match('/')))
    );
});
