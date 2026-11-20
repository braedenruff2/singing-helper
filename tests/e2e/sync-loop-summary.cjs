// Auto-sync, loop a line and the practice summary, using the warm-up chart and the manual clock.
// The fake "song" plays the warm-up melody 700 ms late, so auto-sync should find about -700 ms.
// node tests/e2e/sync-loop-summary.cjs [fixtures/sing.wav]
const path = require('path');
const { test, EXAMPLES } = require('./lib.cjs');
test('sync-loop-summary', async ({ url, newPage, check, shot }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.evaluate(async () => {
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const o = ac.createOscillator(); o.type = 'sawtooth'; const g = ac.createGain(); g.gain.value = 0;
    o.connect(g).connect(dest);
    const bass = ac.createOscillator(); bass.frequency.value = 55; const bg = ac.createGain(); bg.gain.value = 0.3; bass.connect(bg).connect(dest);
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
    o.start(); bass.start();
  });
  await p.waitForTimeout(11000);
  await p.click('#sync');
  const sync = await p.textContent('#sync-status');
  const so = /offset ([+-]?\d+) ms/.exec(sync);
  check('auto-sync finds about -700 ms', so && Math.abs(+so[1] + 700) <= 60, sync);
  // with the chart moved down 3 semitones the singer is still in the song's key: same answer
  // (done in one step so no notes get scored against the shifted chart)
  const sync2 = await p.evaluate(() => {
    const c = (id) => document.getElementById(id).click();
    c('key-down'); c('key-down'); c('key-down'); c('sync');
    const t = document.getElementById('sync-status').textContent;
    c('key-up'); c('key-up'); c('key-up');
    return t;
  });
  const so2 = /offset ([+-]?\d+) ms/.exec(sync2);
  check('auto-sync works with a key shift', so2 && Math.abs(+so2[1] + 700) <= 60, sync2);
  // loop: the clock should jump back to just before the looped line, then keep repeating it
  const pos = () => p.evaluate(() => performance.now() - window.__state.manualClock + window.__state.offset);
  await p.click('#loop');
  const lp = await p.evaluate(() => window.__state.loop);
  check('loop set on a line', lp && lp.end > lp.start, JSON.stringify(lp));
  const seen = [];
  for (let i = 0; i < 24 && lp; i++) { seen.push(Math.round(await pos())); await p.waitForTimeout(500); }
  const jumps = seen.filter((v, i) => i && v < seen[i - 1] - 1000).length;
  check('loop jumps back and stays inside the line', jumps >= 1 && seen.every((v) => v <= lp.end + 1200), seen.join(','));
  await p.click('#loop');
  check('Stop loop clears it', (await p.evaluate(() => window.__state.loop)) == null);
  await p.click('#summary-btn');
  const s = (await p.textContent('#summary-body')).replace(/\s+/g, ' ');
  const m = /(\d+)% of (\d+) notes on pitch/.exec(s);
  check('summary scores the sung notes', m && +m[2] >= 5 && +m[1] >= 70, s.slice(0, 120));
  check('session saved to history', (await p.evaluate(() => JSON.parse(localStorage.getItem('history') || '[]').length)) === 1);
  await shot(p, 'summary.png');
}, { mic: 'sing.wav' });
