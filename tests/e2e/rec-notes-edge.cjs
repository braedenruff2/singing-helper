// "Make notes from this song", edge cases (review 27 Nov): Finish while Spotify answers "nothing" for a moment (the
// song still shown): the notes show at once and the old offset is cleared; Spotify jumping (a seek elsewhere): the
// pitch written since the last poll at guessed times is dropped.
// node tests/e2e/rec-notes-edge.cjs
const { test, fakeSpotifyLogin, trackJson } = require('./lib.cjs');
test('rec-notes-edge', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  const sp = { id: 'trkR', name: 'Rec Song', t0: Date.now(), none: false };
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => (sp.none ? r.fulfill({ status: 204, body: '' }) : r.fulfill({ json: trackJson(sp.id, sp.name, Date.now() - sp.t0) })));
  await p.route('https://lrclib.net/**', (r) => r.fulfill({ json: [] }));
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await fakeSpotifyLogin(p);
  await p.reload();
  sp.t0 = Date.now();
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkR', null, { timeout: 8000 });
  // the "song": a voice-like melody over bass, as the shared tab
  await p.evaluate(async () => {
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const voice = ac.createOscillator(); voice.type = 'sawtooth';
    const vf = ac.createBiquadFilter(); vf.type = 'lowpass'; vf.frequency.value = 2500; const vg = ac.createGain(); vg.gain.value = 0.25;
    voice.connect(vf).connect(vg).connect(dest);
    const bass = ac.createOscillator(); bass.type = 'triangle'; bass.frequency.value = 55; const bg = ac.createGain(); bg.gain.value = 0.3; bass.connect(bg).connect(dest);
    const melody = [196, 220, 247, 262, 294, 330, 349, 392, 349, 330, 294, 262];
    const t0 = ac.currentTime + 0.05;
    for (let rep = 0; rep < 5; rep++) melody.forEach((f, i) => { const t = t0 + rep * 6 + i * 0.5; voice.frequency.setValueAtTime(f, t); vg.gain.setValueAtTime(0.25, t); vg.gain.setValueAtTime(0.0, t + 0.42); });
    voice.start(); bass.start();
    window.__melodyStream = dest.stream;
    await window.__captureSong(dest.stream);
  });
  await p.evaluate(() => localStorage.setItem('offset_trkR', '700'));
  await p.$eval('#offset', (el) => { el.value = '700'; el.dispatchEvent(new Event('input')); });
  await p.click('#rec-notes');
  await sleep(4000);
  // Spotify jumps 20 s ahead (a seek on another device): at the next poll the frames since the last poll are dropped
  await p.evaluate(() => { window.__sizes = []; window.__sz = setInterval(() => { const r = window.__state.rec, t = window.__state.track; if (r && t) window.__sizes.push([t.progressMs, r.frames.size]); }, 20); });
  sp.t0 -= 20000;
  await p.waitForFunction(() => window.__state.track && window.__sizes.length > 2 && window.__sizes[window.__sizes.length - 1][0] - window.__sizes[0][0] > 15000, null, { timeout: 8000 });
  const sizes = await p.evaluate(() => { clearInterval(window.__sz); return window.__sizes; });
  const j = sizes.findIndex((x, i) => i && x[0] - sizes[i - 1][0] > 15000);
  check('the jump drops the pitch written at guessed times since the last poll', j > 0 && sizes[j][1] < sizes[j - 1][1], JSON.stringify(sizes.slice(Math.max(0, j - 2), j + 2)));
  await sleep(2500);
  // Spotify says "nothing playing" for a moment; the song is still on screen; he presses Finish
  sp.none = true;
  await p.waitForFunction(() => window.__state.track === null, null, { timeout: 8000 });
  await p.click('#rec-notes');
  const st = await p.textContent('#rec-status');
  check('Finish with nothing reported: the notes show now (not "when it plays again")', /Made \d+ notes for “Rec Song”/.test(st) && /show from now on/.test(st) && !!(await p.evaluate(() => window.__state.chart)), st);
  const off = await p.evaluate(() => [window.__state.offset, localStorage.getItem('offset_trkR')]);
  check('the old offset is cleared, also the saved one for this song', off[0] === 0 && off[1] !== '700', JSON.stringify(off));
  sp.none = false;
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkR', null, { timeout: 8000 });
  await sleep(300);
  check('the song back: offset still 0, the chart still shown', (await p.evaluate(() => window.__state.offset)) === 0 && !!(await p.evaluate(() => window.__state.chart)));
}, { mic: 'sing.wav' });
