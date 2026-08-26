// Service worker for the IBC staff app. Network-first with a cache fallback:
// online users always get fresh data (the schedule changes), offline users get
// the last-seen version. Bump CACHE on any shell change to evict old assets.
const CACHE = 'ibc-staff-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/schedule.js',
  '/js/time-utils.js',
  '/js/coverage.js',
  '/events/ibc-2026.json',
  '/images/adobe-logo.svg',
  '/images/ibc-logo-white.png',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  // Only handle same-origin GETs; never cache admin/auth/writes.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/admin')) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html'))),
  );
});
