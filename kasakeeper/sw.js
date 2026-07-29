const CACHE = 'kasakeeper-v96';
const ASSETS = [
  './', './index.html', './styles.css',
  './data.js', './store.js', './ha.js', './research.js', './catalog.js', './eye-scene.js', './app.js',
  './guide.html', './manifest.webmanifest', './instrument-sans.woff2',
  './icon-192.png', './icon-512.png', './icon-180.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache Home Assistant / API calls — always go to network.
  if (e.request.method !== 'GET' || url.port === '8123' || url.pathname.startsWith('/api')) return;
  // ignoreSearch: pages request app.js?v=N but the precache stores bare paths — an
  // exact match misses every asset, so the first offline load after a deploy hung on
  // the splash. Safe because the cache NAME is versioned: one cache, one version.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })))
  );
});
