/* command-center/sw.js
 * Service Worker for Zoiris Command Center PWA (offline + 24/7 standalone app shell).
 */
const CACHE_NAME = 'zoiris-cc-v2';

function scopeUrl(rel) {
  return new URL(rel, self.registration.scope).href;
}

const CORE_ASSETS = [
  './login/',
  './command-center/',
  './assets/styles.css',
  './assets/local-vault.js',
  './assets/login.js',
  './assets/map.js',
  './assets/viewer.js',
  './assets/app.js',
  './assets/logo-mark.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './assets/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(CORE_ASSETS.map((p) => cache.add(scopeUrl(p)).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  // Navigation requests inside /owner/* -> network first, fallback to cached app shell (prevents 404 on deep routes like /owner/leads/ZJ-...)
  if (req.mode === 'navigate') {
    const isLogin = /\/owner\/login\/?$/.test(url.pathname);
    const fallbackKey = scopeUrl(isLogin ? './login/' : './command-center/');
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }
          return caches.match(fallbackKey).then((m) => m || res);
        })
        .catch(() => caches.match(fallbackKey))
    );
    return;
  }

  // Static /owner/assets/* -> stale-while-revalidate
  if (url.pathname.includes('/owner/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || net;
      })
    );
  }
});
