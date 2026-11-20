// Key shift, practice history, and smooth Spotify clock under network jitter.
// node tests/e2e/key-history-clock.cjs
const path = require('path');
const { test, fakeSpotifyLogin, EXAMPLES } = require('./lib.cjs');
test('key-history-clock', async ({ url, newPage, check }) => {
  const p = await newPage();
  // Spotify mock whose reported position is off by up to ±150 ms on every poll
  const t0 = Date.now();
  let k = 0;
  await p.route('https://api.spotify.com/**', (r) => r.fulfill({ json: { is_playing: true, progress_ms: 2000 + (Date.now() - t0) + (k++ % 2 ? 150 : -150), item: { id: 'trk1', name: 'Test Song', duration_ms: 600000, artists: [{ name: 'A' }], album: { name: 'B', images: [] } } } }));
  await p.route('https://lrclib.net/**', (r) => r.fulfill({ status: 404, json: {} }));
  await p.goto(url);
  await p.evaluate(() => {
    localStorage.clear();
    const old = [0.5, 0.55, 0.6, 0.58, 0.62, 0.6].map((pct, i) => ({ session: i, at: Date.now() - (7 - i) * 864e5, song: 'Old song', pct, notes: 20, bias: -10 }));
    localStorage.setItem('history', JSON.stringify(old));
  });
  await fakeSpotifyLogin(p);
  await p.reload();
  await p.waitForFunction(() => window.__state.track);
  // clock: sample the song position for 6 s; with smoothing, no backward steps and small forward jumps
  const samples = await p.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 120; i++) { const t = window.__state.track; out.push(t.progressMs + performance.now() - t.at); await new Promise((r) => setTimeout(r, 50)); }
    return out;
  });
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i] - samples[i - 1] - 50));
  check('song clock smooth under ±150 ms jitter', worst < 100, `worst step deviation ${worst.toFixed(0)} ms`);
  // key shift
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.waitForFunction(() => window.__state.chart);
  const before = await p.evaluate(() => window.__state.chart.notes[0].midi);
  await p.click('#key-up'); await p.click('#key-up');
  const after = await p.evaluate(() => window.__state.chart.notes[0].midi);
  check('key +2 moves the notes up 2', after === before + 2 && (await p.textContent('#key-v')) === '+2', `${before} -> ${after}`);
  check('key saved for the track', (await p.evaluate(() => localStorage.getItem('key_trk1'))) === '2');
  check('chart saved for the track', !!(await p.evaluate(() => localStorage.getItem('chart_trk1'))));
  await p.keyboard.press('y');
  const s = (await p.textContent('#summary-body')).replace(/\s+/g, ' ');
  check('summary shows recent practice', /Your recent practice/.test(s) && /Old song: 62%/.test(s), s.slice(0, 120));
  check('trend line', /Up \d+ points/.test(s), s.slice(-60));
  // reload: the chart and key come back for the same track
  await p.reload();
  await p.waitForFunction(() => window.__state.chart, null, { timeout: 5000 });
  check('chart and key restored after reload', (await p.evaluate(() => window.__state.chart.notes[0].midi)) === before + 2);
});
