// "Make notes from this song": with Spotify playing and the song's tab shared, the singer's notes are written down
// as it plays (with the synced lyrics), and saved as the song's chart on Finish or when the song changes; nothing
// heard -> a plain message, no chart; no Spotify -> it says to play a song first.
// node tests/e2e/rec-notes.cjs
const { test, fakeSpotifyLogin, trackJson } = require('./lib.cjs');
test('rec-notes', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  const sp = { id: 'trkR', name: 'Rec Song', t0: Date.now() };
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => r.fulfill({ json: trackJson(sp.id, sp.name, Date.now() - sp.t0) }));
  // synced lyrics covering the first 20 s
  const lrc = '[00:00.00]la la la la\n[00:04.00]sing it once again\n[00:08.00]and one more time\n[00:20.00]';
  await p.route('https://lrclib.net/**', (r) => r.fulfill({ json: [{ trackName: 'Rec Song', artistName: 'A', duration: 600, syncedLyrics: lrc }] }));
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  // no Spotify: a plain hint
  await p.reload();
  await p.click('#rec-notes');
  check('no song playing: says to play one first', /Play the song on Spotify first/.test(await p.textContent('#rec-status')), await p.textContent('#rec-status'));
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
  check('recording: Finish button and progress', /Finish notes/.test(await p.textContent('#rec-notes')) && /Writing down “Rec Song”/.test(await p.textContent('#rec-status')), await p.textContent('#rec-status'));
  await sleep(6500);
  await p.click('#rec-notes');
  const st = await p.textContent('#rec-status');
  check('an old offset for this song is cleared (the notes sit at the song\'s own times)', (await p.evaluate(() => [window.__state.offset, localStorage.getItem('offset_trkR')])).join() === '0,0');
  check('Finish: notes made with the lyrics', /Made \d+ notes for “Rec Song” with the lyrics/.test(st), st);
  const res = await p.evaluate(() => ({ saved: localStorage.getItem('chart_trkR'), notes: window.__state.chart && window.__state.chart.notes.map((n) => n.midi), lines: window.__state.chart && window.__state.chart.lines.filter((l) => l.text).length }));
  check('saved as the song\'s chart and shown now', !!res.saved && res.notes && res.notes.length >= 8, JSON.stringify(res.notes));
  const want = [55, 57, 59, 60, 62, 64, 65, 67, 65, 64, 62, 60]; // G3 A3 B3 C4 D4 E4 F4 G4 ...
  const hit = want.filter((m) => res.notes.some((n) => n % 12 === m % 12)).length;
  check('the melody\'s notes are in it', hit >= 10, `${hit}/12: ${res.notes.join(',')}`);
  check('the lyrics are on the notes', res.lines >= 1 && /la/.test(res.saved), res.saved.split('\n').slice(5, 9).join(' / '));
  check('only notes are kept: nothing like audio in storage', Object.keys(await p.evaluate(() => ({ ...localStorage }))).every((k) => !/audio|wav|rec_/.test(k)));
  // again, and the song changes mid-way: the notes are written for the song that was playing
  await p.click('#rec-notes');
  await sleep(4000);
  sp.id = 'trkS'; sp.name = 'Next Song'; sp.t0 = Date.now();
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkS', null, { timeout: 8000 });
  await sleep(300);
  const st2 = await p.textContent('#rec-status');
  check('the song changed: its notes are saved for it, recording ends', /for “Rec Song”.*load when it plays again/.test(st2) && /Make notes from this song/.test(await p.textContent('#rec-notes')), st2);
  // stopping the tab share with almost nothing heard: no chart, a plain message
  await p.click('#rec-notes'); await sleep(300);
  await p.click('#capture'); // "Stop song pitch"
  const st3 = await p.textContent('#rec-status');
  check('stopped at once: too little heard, nothing saved', /Too little singing heard in “Next Song”/.test(st3) && !(await p.evaluate(() => localStorage.getItem('chart_trkS'))), st3);
}, { mic: 'sing.wav' });
