// Service worker for the staff scheduler. Network-first with a cache fallback:
// online users always get fresh data (the schedule changes), offline users get
// the last-seen version. Event-agnostic — per-event JSON/logos are cached at
// runtime on first fetch, not precached, so one SW serves every event (IBC, MAX).
// Bump CACHE on any shell change to evict old assets.
const CACHE = 'scheduler-v14';
// Small cache holding this device's push role ('staff' | 'admin'), written by
// the page on subscribe and read by the push handler. Kept across activations.
const META_CACHE = 'push-meta';
const PUSH_ICON = self.location.hostname.startsWith('max.') ? '/icons/max-192.png' : '/icons/icon-192.png';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/schedule.js',
  '/js/time-utils.js',
  '/js/coverage.js',
  '/js/event-config.js',
  '/vendor/spectrum.js',
  '/images/adobe-logo.svg',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== META_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Payload-less push: the worker signs a VAPID tickle; text is chosen here from
// this device's stored role (staff device = "you were asked"; admin = queue).
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let role = 'admin';
    try {
      const m = await caches.open(META_CACHE).then((c) => c.match('/__push_role'));
      if (m) role = (await m.text()) || 'admin';
    } catch { /* default admin */ }
    const staff = role === 'staff';
    await self.registration.showNotification(staff ? 'Shift cover request' : 'Shift schedule update', {
      body: staff ? 'Someone asked you to cover a shift — tap to open.' : 'A shift change needs you or was just made — tap to open.',
      icon: PUSH_ICON,
      badge: PUSH_ICON,
      tag: 'shift-request',
      data: { url: staff ? '/' : '/admin.html' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url.includes(url) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
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
