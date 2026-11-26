// Offline support: network first (so updates show up immediately), cached copy when offline.
const CACHE = 'singing-helper-v4';
const SHELL = ['./', 'index.html', 'app.js', 'spotify.js', 'lyrics.js', 'karaoke.js', 'tv.html', 'tv.js', 'melody.js', 'pitch-worklet.js', 'manifest.webmanifest', 'icon.svg',
  'examples/warmup-scale.txt', 'examples/sustain.txt', 'examples/arpeggios.txt', 'examples/echo.txt', 'examples/echo-intervals.txt'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
// drop caches from older versions of this file
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  .then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        // cache pages without their query (?code=… after each Spotify login would otherwise add an entry every time)
        const key = e.request.mode === 'navigate' ? u.origin + u.pathname : e.request;
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
