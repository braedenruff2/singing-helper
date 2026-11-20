// Review fixes of 19 Nov (evening): a chart loaded during a gap in playback belongs to the song still shown (not the
// next one); a chart loaded with nothing shown wins over an older saved chart; paused Spotify stops the guide tone;
// Loop line near 0:00 doesn't put the clock before the start; a hung LRCLIB request falls through to the search;
// Loop line works while the page isn't drawn.
// node tests/e2e/review4.cjs
const { test, fakeSpotifyLogin, trackJson } = require('./lib.cjs');
const CHART = (title) => `#TITLE:${title}\n#BPM:150\n#GAP:0\n: 0 6 0 one\n: 8 6 2 two\n- 20\n: 24 6 4 three\nE\n`;
test('review4', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  // count tone oscillators the page starts (the guide tone makes two)
  await p.addInitScript(() => {
    window.__osc = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
  });
  const sp = { mode: 'play', id: 'trkA', name: 'Song A', pos: 60000, playing: true, seeks: [] };
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => {
    if (sp.mode === 'gap') return r.fulfill({ status: 204, body: '' });
    r.fulfill({ json: trackJson(sp.id, sp.name, sp.pos, { is_playing: sp.playing }) });
  });
  await p.route('https://api.spotify.com/v1/me/player/seek**', (r) => { sp.seeks.push(+new URL(r.request().url()).searchParams.get('position_ms')); r.fulfill({ status: 204, body: '' }); });
  let lrc = 'none';
  await p.route('https://lrclib.net/api/get**', (r) => { if (lrc === 'hang') return; r.fulfill({ status: 404, json: {} }); });
  await p.route('https://lrclib.net/api/search**', (r) => r.fulfill({ json: lrc === 'hang' ? [{ duration: 600, syncedLyrics: '[00:01.00]Found by the search\n[00:05.00]second line' }] : [] }));
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await fakeSpotifyLogin(p);
  await p.reload();
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkA', null, { timeout: 5000 });

  // 1. Song A, a gap (paused a while / ad), a corrected chart is loaded, Song A comes back: saved for A
  sp.mode = 'gap';
  await p.waitForFunction(() => !window.__state.track, null, { timeout: 5000 });
  await p.setInputFiles('#usfile', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from(CHART('ForA')) });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'ForA');
  const s1 = await p.evaluate(() => ({ saved: (localStorage.getItem('chart_trkA') || '').includes('ForA'), st: document.getElementById('us-status').textContent }));
  check('chart loaded during a gap is saved for the song still shown', s1.saved && /saved for this Spotify track/.test(s1.st), JSON.stringify(s1));
  sp.mode = 'play';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkA', null, { timeout: 5000 });
  sp.id = 'trkB'; sp.name = 'Song B';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkB', null, { timeout: 5000 });
  await sleep(200);
  const s2 = await p.evaluate(() => ({ b: localStorage.getItem('chart_trkB'), shown: window.__state.chart && window.__state.chart.title }));
  check('... and not carried over to the next song (old code: saved as Song B\'s chart)', s2.b === null && s2.shown !== 'ForA', JSON.stringify(s2));

  // 2. paused Spotify: the guide tone stops, and doesn't start while paused
  await p.evaluate(() => { localStorage.setItem('chart_trkC', `#TITLE:C\n#BPM:150\n#GAP:0\n: 0 4000 0 long\nE\n`); });
  sp.id = 'trkC'; sp.name = 'Song C'; sp.pos = 1000; sp.playing = false;
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkC' && window.__state.chart, null, { timeout: 5000 });
  const before = await p.evaluate(() => window.__osc);
  await p.check('#guide');
  await sleep(600);
  check('paused: no guide tone (old code: a tone forever)', (await p.evaluate(() => window.__osc)) === before);
  sp.playing = true;
  await p.waitForFunction((b) => window.__osc > b, before, { timeout: 5000 });
  check('playing again: the guide tone starts', true);
  await p.uncheck('#guide');

  // 3. Loop line near 0:00: Spotify is sent 0 and the clock says 0, not a negative position
  await p.evaluate(() => { localStorage.setItem('chart_trkD', `#TITLE:D\n#BPM:150\n#GAP:300\n: 0 4 0 one\n: 4 4 2 two\n- 12\n: 16 4 4 three\nE\n`); });
  sp.id = 'trkD'; sp.name = 'Song D'; sp.pos = 500;
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkD' && window.__state.chart, null, { timeout: 5000 });
  await p.click('#loop');
  await p.waitForFunction(() => window.__state.loop, null, { timeout: 3000 });
  await p.evaluate(() => { const l = window.__state.loop; window.__state.track.progressMs = l.end + 2000; window.__state.track.at = performance.now(); });
  await p.waitForFunction(() => window.__state.track.progressMs < 1000, null, { timeout: 3000 });
  const s3 = await p.evaluate(() => window.__state.track.progressMs);
  check('loop near the start: clock not before 0:00 (old code: negative)', s3 >= 0 && sp.seeks.length > 0 && sp.seeks.every((x) => x >= 0), s3 + ' / ' + sp.seeks);

  // 4. the same while the page isn't drawn (another window in front): the loop still jumps back
  const n = sp.seeks.length;
  await p.evaluate(() => { window.__raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
  await sleep(100);
  await p.evaluate(() => { const l = window.__state.loop; window.__state.track.progressMs = l.end + 2000; window.__state.track.at = performance.now(); });
  await sleep(600);
  check('loop line jumps back with drawing paused (old code: played on)', sp.seeks.length > n, sp.seeks.length + ' vs ' + n);
  await p.evaluate(() => { window.requestAnimationFrame = window.__raf; window.requestAnimationFrame(() => {}); });
  await p.click('#loop');

  // 5. LRCLIB "get" hangs: after the timeout the search finds the lyrics (old code: "Looking up…" forever)
  lrc = 'hang';
  sp.id = 'trkE'; sp.name = 'Song E'; sp.pos = 2000;
  await p.waitForFunction(() => window.__state.lyrics && window.__state.lyrics.length, null, { timeout: 15000 }).catch(() => {});
  check('hung lyrics request falls through to the search', await p.evaluate(() => !!(window.__state.lyrics && window.__state.lyrics.length)));
}, { ignore: /ERR_|aborted|TimeoutError|signal timed out/ });
