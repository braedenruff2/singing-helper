// Built-in exercises: pick one from the list, it starts in 2 s on its own clock; with Spotify connected the
// song's chart, key and offset are left alone and come back when you leave the exercise.
// node tests/e2e/exercise.cjs
const fs = require('fs');
const path = require('path');
const { test, fakeSpotifyLogin, trackJson, EXAMPLES } = require('./lib.cjs');
test('exercise', async ({ url, newPage, check, sleep }) => {
  // 1. without Spotify
  const p = await newPage();
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.selectOption('#exercise', 'examples/arpeggios.txt');
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Arpeggios');
  const pos0 = await p.evaluate(() => performance.now() - window.__state.manualClock - window.__state.chart.notes[0].t);
  check('first note 2 s away', Math.abs(pos0 + 2000) < 200, Math.round(pos0));
  await sleep(2600);
  check('lyrics shown', /ah/.test(await p.textContent('#lyr-cur')), await p.textContent('#lyr-cur'));
  check('status names the exercise', /Arpeggios.*28 notes/.test(await p.textContent('#us-status')), await p.textContent('#us-status'));
  await p.keyboard.press('y');
  await p.keyboard.press('Escape');
  const hist = await p.evaluate(() => JSON.parse(localStorage.getItem('history') || '[]'));
  check('summary saved under the exercise name', hist.length === 1 && hist[0].song === 'Arpeggios', JSON.stringify(hist.map((h) => h.song)));
  await p.selectOption('#exercise', '');
  check('leaving clears it', (await p.evaluate(() => window.__state.chart)) == null && (await p.evaluate(() => window.__state.manualClock)) == null);
  // a chart you loaded comes back after an exercise; the clock button stops the exercise
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'sustain.txt'));
  await p.selectOption('#exercise', 'examples/warmup-scale.txt');
  await p.waitForFunction(() => window.__state.exerciseMode);
  check('clock button offers to stop the exercise', (await p.textContent('#clock')) === 'Stop exercise', await p.textContent('#clock'));
  await p.click('#clock');
  check('stopping the exercise brings your chart back', (await p.evaluate(() => !window.__state.exerciseMode && window.__state.chart && window.__state.chart.title)) === 'Sustain practice' && (await p.textContent('#clock')) === 'Start clock');
  // changing your mind while an exercise loads
  await p.evaluate(() => { const s = document.getElementById('exercise'); s.value = 'examples/arpeggios.txt'; s.dispatchEvent(new Event('change')); s.value = ''; s.dispatchEvent(new Event('change')); });
  await sleep(500);
  check('picking "—" while loading cancels it', (await p.evaluate(() => !!window.__state.exerciseMode)) === false);

  // 2. with Spotify: the song's own chart, key and offset survive an exercise
  const q = await newPage();
  const t0 = Date.now();
  const sp = { id: 'trk1', gap: false };
  await q.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => (sp.gap ? r.fulfill({ status: 204, body: '' }) : r.fulfill({ json: trackJson(sp.id, 'Song ' + sp.id, 5000 + Date.now() - t0) })));
  await q.route('https://api.spotify.com/v1/me/player/seek**', (r) => { check('no Spotify seek during an exercise', false); r.fulfill({ status: 204, body: '' }); });
  await q.route('https://lrclib.net/**', (r) => r.fulfill({ status: 404, json: {} }));
  await q.goto(url);
  const sustain = fs.readFileSync(path.join(EXAMPLES, 'sustain.txt'), 'utf8');
  await q.evaluate((c) => { localStorage.clear(); localStorage.setItem('chart_trk1', c); localStorage.setItem('key_trk1', '2'); localStorage.setItem('offset_trk1', '400'); localStorage.setItem('offset_trk2', '300'); }, sustain);
  await fakeSpotifyLogin(q);
  await q.reload();
  await q.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Sustain practice');
  await q.selectOption('#exercise', 'examples/warmup-scale.txt');
  await q.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Major scale warm-up');
  await sleep(2000); // a few Spotify polls
  const st = await q.evaluate(() => ({ title: window.__state.chart.title, key: window.__state.key, off: window.__state.offset }));
  check('exercise stays loaded while Spotify plays', st.title === 'Major scale warm-up' && st.key === 0 && st.off === 0, JSON.stringify(st));
  await q.click('#key-up');
  await q.$eval('#offset', (el) => { el.value = '250'; el.dispatchEvent(new Event('input')); });
  await q.click('#loop'); await q.click('#loop');
  check("song's saved key and offset untouched", (await q.evaluate(() => [localStorage.getItem('key_trk1'), localStorage.getItem('offset_trk1'), !!localStorage.getItem('chart_trk1') && localStorage.getItem('chart_trk1').includes('Sustain')].join())) === '2,400,true');
  await q.selectOption('#exercise', '');
  await q.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Sustain practice', null, { timeout: 5000 });
  const back = await q.evaluate(() => ({ key: window.__state.key, off: window.__state.offset }));
  check("back to the song: its chart, key +2 and offset 400", back.key === 2 && back.off === 400, JSON.stringify(back));

  // Spotify moves to the next song during an exercise: the exercise carries on untouched
  await q.selectOption('#exercise', 'examples/warmup-scale.txt');
  await q.waitForFunction(() => window.__state.exerciseMode && window.__state.chart.title === 'Major scale warm-up');
  await q.evaluate(() => window.__state.hits.set(0, { good: 3, total: 3, near: 3, sum: 0, sq: 0, trace: [] }));
  sp.id = 'trk2';
  await q.waitForFunction(() => /trk2/.test(document.getElementById('np').textContent), null, { timeout: 5000 });
  await sleep(300);
  const mid = await q.evaluate(() => ({ off: window.__state.offset, hits: window.__state.hits.size, title: window.__state.chart.title }));
  check('song change mid-exercise: offset, score and chart kept', mid.off === 0 && mid.hits === 1 && mid.title === 'Major scale warm-up', JSON.stringify(mid));
  // leave during a Spotify gap: the song's things come back when Spotify does
  sp.id = 'trk1'; await sleep(1700);
  sp.gap = true;
  await q.waitForFunction(() => !window.__state.track, null, { timeout: 5000 });
  await q.selectOption('#exercise', '');
  sp.gap = false;
  await q.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Sustain practice', null, { timeout: 5000 }).catch(() => {});
  const back2 = await q.evaluate(() => ({ t: window.__state.chart && window.__state.chart.title, key: window.__state.key, off: window.__state.offset }));
  check('left during a Spotify gap: song chart, key and offset back when it returns', back2.t === 'Sustain practice' && back2.key === 2 && back2.off === 400, JSON.stringify(back2));
  // loading a chart during an exercise: it gets the song's key and offset
  await q.selectOption('#exercise', 'examples/arpeggios.txt');
  await q.waitForFunction(() => window.__state.exerciseMode);
  await q.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await q.waitForFunction(() => !window.__state.exerciseMode, null, { timeout: 3000 }).catch(() => {});
  const ld = await q.evaluate(() => ({ ex: window.__state.exerciseMode, t: window.__state.chart.title, key: window.__state.key, off: window.__state.offset }));
  check('chart loaded during an exercise uses the song\'s key and offset', !ld.ex && ld.t === 'Major scale warm-up' && ld.key === 2 && ld.off === 400, JSON.stringify(ld));
}, { mic: 'sing.wav' });
