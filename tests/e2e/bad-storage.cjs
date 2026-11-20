// Damaged saved data and a failed mic start must not break the app:
// history that isn't a list, non-numeric offset / speaker delay / per-song offset and key, and the detector
// module failing to load the first time (the mic must be released, and Start mic must work afterwards).
// node tests/e2e/bad-storage.cjs
const path = require('path');
const { test, fakeSpotifyLogin, trackJson, EXAMPLES } = require('./lib.cjs');

test('bad-storage', async ({ url, newPage, check }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => r.fulfill({ json: trackJson('trkA', 'Song A', 5000) }));
  await p.route('https://lrclib.net/**', (r) => r.fulfill({ status: 404, json: {} }));
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  // the detector module fails to load once: the mic is released and Start mic works on the next try
  await p.evaluate(() => {
    window.__streams = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__streams.push(s); return s; };
  });
  // (page.route doesn't see worklet module requests, so fail the first addModule call itself)
  await p.evaluate(() => {
    const add = AudioWorklet.prototype.addModule; let fail = true;
    AudioWorklet.prototype.addModule = function (u, o) { if (fail) { fail = false; return Promise.reject(new DOMException('network error', 'AbortError')); } return add.call(this, u, o); };
  });
  await p.click('#start');
  await p.waitForFunction(() => /Mic error/.test(document.getElementById('lat').textContent), null, { timeout: 5000 }).catch(() => {});
  const rel = await p.evaluate(() => window.__streams.length && window.__streams[0].getAudioTracks().every((t) => t.readyState === 'ended'));
  check('failed start: error shown and the mic released', /Mic error/.test(await p.textContent('#lat')) && rel, await p.textContent('#lat'));
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 }).catch(() => {});
  check('Start mic works after the failure', await p.evaluate(() => !!window.__state.node), await p.textContent('#lat'));
  // the mic is unplugged in the middle of the speaker-delay test: a clear message, not "Cannot read properties of null"
  await p.click('#cal-mic');
  await p.waitForTimeout(1000);
  await p.evaluate(() => window.__state.micStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await p.waitForFunction(() => !/Listening/.test(document.getElementById('cal-status').textContent), null, { timeout: 10000 }).catch(() => {});
  check('mic unplugged during calibration: clear message', /Mic disconnected during the test/.test(await p.textContent('#cal-status')), await p.textContent('#cal-status'));

  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('history', '{"old":"format"}');
    localStorage.setItem('outDelay', 'abc');
    localStorage.setItem('offset', 'abc');
    localStorage.setItem('offset_trkA', 'NaN');
    localStorage.setItem('key_trkA', 'up');
  });
  await fakeSpotifyLogin(p);
  await p.reload();
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkA');
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.waitForFunction(() => window.__state.chart);
  const st = await p.evaluate(() => ({ off: window.__state.offset, od: window.__state.outDelay, key: window.__state.key, midi: window.__state.chart.notes[0].midi, saved: localStorage.getItem('offset_trkA') }));
  check('bad numbers fall back to 0 (offset, speaker delay, key)', st.off === 0 && st.od === 0 && st.key === 0 && Number.isFinite(st.midi), JSON.stringify(st));
  check('a bad saved offset is not written back as "NaN"', st.saved !== 'NaN', st.saved);
  // history saved in an old/odd format: the summary still opens
  await p.evaluate(() => { window.__state.hits.set(0, { good: 5, total: 5, near: 5, sum: 0, sq: 0, trace: [] }); });
  await p.click('#summary-btn');
  check('summary opens with damaged history', await p.evaluate(() => document.getElementById('summary').open));
  await p.click('#summary button');

}, { mic: 'sing.wav', ignore: /pitch-worklet|ERR_FAILED|AbortError|Unable to load a worklet/ });
