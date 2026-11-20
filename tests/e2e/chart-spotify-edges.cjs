// Review fixes of 19 Nov (afternoon): a chart loaded while Spotify plays nothing is kept for the next song; "Make
// notes" finishing after the song changed saves the chart for the song it was made for; the same chart file can be
// picked twice; ANSI (Windows-1252) charts keep their accents; another window refreshing the Spotify token first
// doesn't log this one out.
// node tests/e2e/chart-spotify-edges.cjs
const { test, fakeSpotifyLogin, trackJson } = require('./lib.cjs');
const CHART = (title, lyric) => `#TITLE:${title}\n#BPM:150\n#GAP:0\n: 0 6 0 ${lyric}\n: 8 6 2 two\n- 20\n: 24 6 4 three\nE\n`;
test('chart-spotify-edges', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  const sp = { mode: 'gap', id: 'trkA', name: 'Song A', tokenMode: 'ok' };
  let release = null;
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => {
    if (sp.mode === 'gap') return r.fulfill({ status: 204, body: '' });
    if (sp.mode === 'hang') { sp.hung = (sp.hung || 0) + 1; return; } // never answers (flaky Wi-Fi)
    r.fulfill({ json: trackJson(sp.id, sp.name, 5000) });
  });
  await p.route('https://lrclib.net/**', (r) => r.fulfill({ status: 404, json: {} }));
  await p.route('https://accounts.spotify.com/api/token', async (r) => {
    if (sp.tokenMode === 'race') {
      // the other window got there first: new tokens are already in storage, ours is refused
      await p.evaluate(() => { localStorage.setItem('sp_refresh', 'r-new'); localStorage.setItem('sp_access', 'a-new'); localStorage.setItem('sp_expires', String(Date.now() + 3600e3)); });
      return r.fulfill({ status: 400, json: { error: 'invalid_grant' } });
    }
    r.fulfill({ json: { access_token: 'a2', expires_in: 3600 } });
  });
  await p.route('**/api/health', (r) => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/chart**', async (r) => { await new Promise((res) => { release = res; }); r.fulfill({ json: { chart: CHART('Made', 'one'), notes: 3, lyrics: true } }); });
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await fakeSpotifyLogin(p);
  await p.reload();
  await sleep(1800); // a poll or two: nothing playing

  // 1. loaded with nothing playing, then the song starts: kept and saved for it (old code: thrown away)
  await p.setInputFiles('#usfile', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from(CHART('Pending', 'one')) });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Pending');
  check('file input cleared (the same file can be picked again)', (await p.inputValue('#usfile')) === '');
  sp.mode = 'play';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkA', null, { timeout: 5000 });
  await sleep(300);
  const a = await p.evaluate(() => ({ title: window.__state.chart && window.__state.chart.title, saved: !!localStorage.getItem('chart_trkA') }));
  check('chart loaded with nothing playing is kept for the song that starts', a.title === 'Pending' && a.saved, JSON.stringify(a));

  // 2. the same file again still loads (after the chart was changed meanwhile)
  await p.evaluate(() => { window.__state.chart = null; });
  await p.setInputFiles('#usfile', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from(CHART('Pending', 'one')) });
  await p.waitForFunction(() => window.__state.chart, null, { timeout: 3000 });
  check('same file picked again loads', true);

  // 3. ANSI chart: ä stays ä
  const ansi = Buffer.from(CHART('Lied', 'Mädchen'), 'latin1');
  await p.setInputFiles('#usfile', { name: 'lied.txt', mimeType: 'text/plain', buffer: ansi });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Lied');
  const syl = await p.evaluate(() => window.__state.chart.notes[0].text);
  check('Windows-1252 chart keeps its accents', syl.trim() === 'Mädchen', JSON.stringify(syl));
  await p.setInputFiles('#usfile', { name: 'u.txt', mimeType: 'text/plain', buffer: Buffer.from(CHART('Utf', 'café'), 'utf8') });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Utf');
  check('UTF-8 chart still read as UTF-8', (await p.evaluate(() => window.__state.chart.notes[0].text)).trim() === 'café');

  // 4. Make notes for Song A; Song B starts before it's done: saved for A, not shown on B
  await p.waitForSelector('#gen:not([hidden])');
  await p.setInputFiles('#genfile', { name: 'songA.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(1000, 1) });
  await p.waitForFunction(() => !!document.getElementById('genfile').disabled);
  sp.id = 'trkB'; sp.name = 'Song B';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkB', null, { timeout: 5000 });
  release();
  await p.waitForFunction(() => /Made|Could not/.test(document.getElementById('gen-status').textContent), null, { timeout: 5000 });
  const g = await p.evaluate(() => ({ a: (localStorage.getItem('chart_trkA') || '').includes('#TITLE:Made'), b: localStorage.getItem('chart_trkB'), shown: window.__state.chart && window.__state.chart.title, st: document.getElementById('us-status').textContent }));
  check('chart made for Song A is saved for Song A', g.a, JSON.stringify(g));
  check('... and not shown or saved on Song B', g.b === null && g.shown !== 'Made' && /Song A/.test(g.st), JSON.stringify(g));

  // 5. another window refreshed the token first: stay logged in with its tokens
  sp.tokenMode = 'race';
  await p.evaluate(() => localStorage.setItem('sp_expires', '0'));
  await sleep(2500);
  const tk = await p.evaluate(() => ({ refresh: localStorage.getItem('sp_refresh'), access: localStorage.getItem('sp_access') }));
  check('token refreshed by another window: still logged in', tk.refresh === 'r-new' && tk.access === 'a-new', JSON.stringify(tk));
  check('... and still following the song', /Song B/.test(await p.textContent('#np')));

  // 6. a request that never answers: gives up after ~5 s with a readable note, then polling carries on
  sp.tokenMode = 'ok';
  sp.mode = 'hang';
  await p.waitForFunction(() => /slow to answer/.test(document.getElementById('sp-status').textContent), null, { timeout: 9000 });
  sp.mode = 'play'; sp.id = 'trkC'; sp.name = 'Song C';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkC', null, { timeout: 5000 });
  check('a hung request no longer stops polling for good', sp.hung >= 1, sp.hung);
}, { ignore: /status of 400/ }); // the refused token request (step 5) is logged by the browser
