// Live song pitch with look-ahead: the shared tab is heard through the page 2 s late, so the found pitch is
// drawn 2 s ahead, the needle compares with the note you hear now, and auto-sync allows for the delay.
// node tests/e2e/live-ahead.cjs
const path = require('path');
const { test, EXAMPLES } = require('./lib.cjs');
test('live-ahead', async ({ url, newPage, check }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.check('#ahead'); await p.selectOption('#ahead-s', '2');
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  const r = await p.evaluate(async () => {
    const ac = window.__state.ctx; const dest = ac.createMediaStreamDestination();
    const o = ac.createOscillator(); o.type = 'sawtooth'; const g = ac.createGain(); g.gain.value = 0;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2500;
    o.connect(f).connect(g).connect(dest);
    const melody = [60, 64, 67, 72, 67, 64, 60, 62, 65, 69];
    const T0 = ac.currentTime + 0.3;
    melody.forEach((m, i) => { o.frequency.setValueAtTime(440 * 2 ** ((m - 69) / 12), T0 + i * 0.6); });
    g.gain.setValueAtTime(0.3, T0); g.gain.setValueAtTime(0, T0 + melody.length * 0.6);
    o.start();
    await window.__captureSong(dest.stream);
    // listen to what the page plays (after the delay)
    const an = ac.createAnalyser(); window.__state.refDelay.connect(an);
    const buf = new Float32Array(2048);
    const level = () => { an.getFloatTimeDomainData(buf); let e = 0; for (const v of buf) e += v * v; return Math.sqrt(e / buf.length); };
    const wait = (t) => new Promise((res) => { const id = setInterval(() => { if (ac.currentTime >= t) { clearInterval(id); res(); } }, 5); });
    const out = { delay: window.__state.refDelay.delayTime.value, levels: [], targets: [], ahead: 0 };
    await wait(T0 + 1.0); out.levels.push(level());           // song started 1 s ago: not heard yet
    await wait(T0 + 2.4); out.levels.push(level());           // heard by now
    // what you should sing now = the note that played 2 s ago
    for (const t of [3.0, 3.6, 4.2, 4.8]) {
      await wait(T0 + t);
      out.targets.push([melody[Math.floor((t - 2 - 0.09) / 0.6)], window.__songTarget()]);
    }
    const now = performance.now();
    out.ahead = window.__state.ref.trace.filter((q) => q.wall > now - 2000).length; // drawn right of the now line
    return out;
  });
  check('tab audio delayed by 2 s', Math.abs(r.delay - 2) < 1e-6 && r.levels[0] < 0.01 && r.levels[1] > 0.02, JSON.stringify(r.levels.map((v) => +v.toFixed(3))));
  const ok = r.targets.filter(([want, got]) => got != null && Math.abs(got - want) < 0.75).length;
  check('needle compares with the note heard now (found 2 s earlier)', ok >= 3, JSON.stringify(r.targets));
  check('upcoming song pitch drawn ahead of the now line', r.ahead > 40, r.ahead);
  await p.click('#capture');
  check('stopping clears the delay', (await p.evaluate(() => window.__state.refDelay)) == null);
  check('look-ahead setting remembered', await p.evaluate(() => JSON.parse(localStorage.getItem('prefs') || '{}').ahead === true));

  // auto-sync with look-ahead: the "song" plays the warm-up 700 ms late and you hear it 2 s later still
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.evaluate(async () => {
    const ac = window.__state.ctx; const dest = ac.createMediaStreamDestination();
    const o = ac.createOscillator(); o.type = 'sawtooth'; const g = ac.createGain(); g.gain.value = 0;
    o.connect(g).connect(dest);
    await window.__captureSong(dest.stream);
    const t0 = ac.currentTime; document.getElementById('clock').click();
    const steps = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0];
    let beat = 0;
    for (const base of [0, 2, 4]) {
      for (const st of steps) {
        const t = t0 + 2.0 + 0.7 + beat * 0.125, f = 440 * 2 ** ((60 + base + st - 12 - 69) / 12);
        o.frequency.setValueAtTime(f, t); g.gain.setValueAtTime(0.25, t); g.gain.setValueAtTime(0, t + 0.36);
        beat += 4;
      }
      beat += 8;
    }
    o.start();
  });
  await p.waitForTimeout(11000);
  await p.click('#sync');
  const sync = await p.textContent('#sync-status');
  const so = /offset ([+-]?\d+) ms/.exec(sync);
  check('auto-sync allows for the look-ahead (about -2700 ms)', so && Math.abs(+so[1] + 2700) <= 60, sync);
}, { mic: 'sing.wav' });
