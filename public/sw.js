// Net Logger Service Worker — v2
const CACHE = 'netlogger-v2';

// App shell: always precache these on install
const PRECACHE = [
  '/',
  '/index.html',
  '/status-board.html',
  '/ics309.html',
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle GET requests — writes are handled by the app's queue
  if (request.method !== 'GET') return;

  // Skip auth endpoints — never serve stale auth responses
  if (url.pathname.startsWith('/api/auth/')) return;

  // API GET calls: network-first, fall back to cache (show last-known state)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request)
        .then(r => {
          if (r.ok) {
            caches.open(CACHE).then(c => c.put(request, r.clone()));
          }
          return r;
        })
        .catch(() => caches.match(request)
          .then(cached => cached || new Response(
            JSON.stringify({ error: 'offline', cached: false }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          ))
        )
    );
    return;
  }

  // CDN and static assets: stale-while-revalidate
  // Serve cached immediately, update cache in background
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const cached = await c.match(request);
      const networkFetch = fetch(request)
        .then(r => {
          if (r.ok || r.type === 'opaque') c.put(request, r.clone());
          return r;
        })
        .catch(() => null);
      // Return cached immediately if available; otherwise wait for network
      return cached || networkFetch;
    })
  );
});

// ─── BACKGROUND SYNC (if supported) ──────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'netlogger-sync') {
    // Notify all clients to run their sync
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(client => client.postMessage({ type: 'SYNC_NOW' }))
      )
    );
  }
});
