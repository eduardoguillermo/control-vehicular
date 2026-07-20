const CACHE = 'control-vehicular-v0.28';
const ASSETS = [
  '/control-vehicular/',
  '/control-vehicular/index.html',
  '/control-vehicular/app.js',
  '/control-vehicular/drive-sync.js',
  '/control-vehicular/style.css',
  '/control-vehicular/manifest.json',
  '/control-vehicular/instructivo.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, {cache:'no-store'}).then(res => {
      if(res && res.status === 200){
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
