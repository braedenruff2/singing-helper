// Spotify now-playing (mocked) + LRCLIB synced lyrics (mocked): word wipe, next line, countdown dots.
// node tests/e2e/spotify-lyrics.cjs
const { test, fakeSpotifyLogin } = require('./lib.cjs');
test('spotify-lyrics', async ({ url, newPage, check, shot }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  const t0 = Date.now();
  const lrcCalls = [];
  await p.route('https://api.spotify.com/**', (r) => r.fulfill({ json: { is_playing: true, progress_ms: 2000 + (Date.now() - t0), item: { id: 'trk1', name: 'Test Song', duration_ms: 60000, artists: [{ name: 'Test Artist' }], album: { name: 'Test Album', images: [] } } } }));
  await p.route('https://lrclib.net/**', (r) => { lrcCalls.push(r.request().url()); r.fulfill({ json: { syncedLyrics: '[00:01.00] first line here\n[00:03.50] second line is singing now\n[00:06.00] \n[00:10.00] after a long gap\n[00:13.00] last one' } }); });
  await p.goto(url);
  await fakeSpotifyLogin(p);
  await p.reload();
  await p.click('#start');
  const read = () => p.evaluate(() => ({
    np: document.getElementById('np').textContent,
    count: document.getElementById('lyr-count').textContent,
    words: [...document.querySelectorAll('#lyr-cur .w')].map((w) => [w.textContent.trim(), parseFloat(w.style.getPropertyValue('--p'))]),
    next: document.getElementById('lyr-next').textContent,
    pos: window.__state.track.progressMs + performance.now() - window.__state.track.at,
  }));
  // song time = 2 s + wall time since t0; wait until fixed song positions instead of fixed sleeps
  const at = async (ms) => { await p.waitForFunction((m) => { const t = window.__state.track; return t && t.progressMs + performance.now() - t.at >= m; }, ms, { timeout: 20000 }); return read(); };
  let s = await at(3300);
  check('now playing shows the track', /Test Song/.test(s.np) && /Test Artist/.test(s.np), s.np);
  check('first line fully wiped at 3.3 s', s.words.map((w) => w[0]).join(' ') === 'first line here' && s.words.every((w) => w[1] === 100), JSON.stringify(s.words));
  check('next line shown', s.next === 'second line is singing now', s.next);
  s = await at(4300);
  const wiped = s.words.filter((w) => w[1] === 100).length, unwiped = s.words.filter((w) => w[1] === 0).length;
  check('second line part way through at 4.3 s', s.words[0][0] === 'second' && wiped >= 1 && unwiped >= 1, JSON.stringify(s.words));
  s = await at(8200);
  check('countdown dots before a line after a long gap', s.count === '●●', JSON.stringify(s.count));
  check('upcoming line shown (empty gap line skipped)', s.words.map((w) => w[0]).join(' ') === 'after a long gap', JSON.stringify(s.words));
  check('LRCLIB asked with title, artist, album, duration', /track_name=Test\+Song&artist_name=Test\+Artist&album_name=Test\+Album&duration=60/.test(lrcCalls[0] || ''), lrcCalls[0]);
  await shot(p, 'spotify-lyrics.png');
}, { mic: 'sing.wav' });
