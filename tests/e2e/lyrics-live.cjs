// Real LRCLIB (needs internet), with Spotify mocked to report real songs the way Spotify names them
// ("- Remastered 2011", "(with ...)", album editions). Prints only line counts, not lyrics.
// node tests/e2e/lyrics-live.cjs        (tests/run-all.cjs runs it only when LIVE=1)
const { test, fakeSpotifyLogin } = require('./lib.cjs');
const SONGS = [
  { id: 'live1', name: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen', album: 'A Night At The Opera (2011 Remaster)', ms: 354320 },
  { id: 'live2', name: 'Someone Like You', artist: 'Adele', album: '21', ms: 285240 },
  { id: 'live3', name: 'STAY (with Justin Bieber)', artist: 'The Kid LAROI', album: 'F*CK LOVE 3: OVER YOU', ms: 141805 },
];
test('lyrics-live', async ({ url, newPage, check }) => {
  const p = await newPage();
  let cur = SONGS[0];
  const t0 = Date.now();
  await p.route('https://api.spotify.com/**', (r) => r.fulfill({ json: { is_playing: true, progress_ms: 60000 + (Date.now() - t0), item: { id: cur.id, name: cur.name, duration_ms: cur.ms, artists: [{ name: cur.artist }], album: { name: cur.album, images: [] } } } }));
  await p.goto(url);
  await fakeSpotifyLogin(p);
  await p.reload();
  for (const s of SONGS) {
    cur = s;
    await p.waitForFunction((id) => window.__state.track && window.__state.track.id === id, s.id, { timeout: 10000 });
    await p.waitForFunction(() => /Synced lyrics found|No synced lyrics|failed/.test(document.getElementById('us-status').textContent), null, { timeout: 20000 });
    const r = await p.evaluate(() => ({ n: window.__state.lyrics ? window.__state.lyrics.length : 0, cur: document.getElementById('lyr-cur').textContent.length, last: window.__state.lyrics ? window.__state.lyrics[window.__state.lyrics.length - 1].t : 0 }));
    check(`${s.artist}: synced lyrics found and shown`, r.n >= 10 && r.cur > 0 && r.last < s.ms, `${r.n} lines`);
  }
});
