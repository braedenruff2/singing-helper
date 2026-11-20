// "Hear it, sing it back" (examples/echo.txt, #ECHO:yes): the page plays each listen note, then is quiet while you
// sing it back (guide tone on or off); listen notes are drawn but never scored.
// node tests/e2e/echo.cjs
const { test } = require('./lib.cjs');
test('echo', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  // remember the last tone level the page asked for (guide/drone: 0.12 on, 0 off)
  await p.addInitScript(() => {
    window.__g = 0;
    const orig = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function (v, t, c) { if (v === 0.12 || v === 0) window.__g = v; return orig.call(this, v, t, c); };
  });
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  for (const guideOn of [false, true]) {
    if (guideOn) await p.check('#guide'); else await p.uncheck('#guide');
    await p.selectOption('#exercise', '');
    await p.selectOption('#exercise', 'examples/echo.txt');
    await p.waitForFunction(() => window.__state.chart && window.__state.chart.echo && window.__state.exerciseMode);
    const info = await p.evaluate(() => {
      const ns = window.__state.chart.notes;
      return { n: ns.length, listen: ns.filter((x) => x.listen).length, pairs: ns.every((x, i) => (i % 2 === 0) === !!x.listen && (i % 2 === 0 || x.midi === ns[i - 1].midi)) };
    });
    check('12 listen notes, each followed by the same note to sing', info.n === 24 && info.listen === 12 && info.pairs, JSON.stringify(info));
    // sample the tone level against the exercise clock for the first three pairs (~9 s)
    const samples = await p.evaluate(() => new Promise((res) => {
      const out = [], t0 = performance.now();
      const iv = setInterval(() => {
        const st = window.__state, song = performance.now() - st.manualClock + st.offset;
        out.push([song, window.__g]);
        if (performance.now() - t0 > 9500) { clearInterval(iv); res(out); }
      }, 40);
    }));
    const notes = await p.evaluate(() => window.__state.chart.notes.slice(0, 6).map((n) => ({ t: n.t, dur: n.dur, listen: !!n.listen })));
    let onInListen = 0, inListen = 0, onInSing = 0, inSing = 0;
    for (const [s, g] of samples) for (const n of notes) {
      // the middle of each note (the tone fades in and out over ~50 ms)
      if (s < n.t + 120 || s > n.t + n.dur - 120) continue;
      if (n.listen) { inListen++; if (g === 0.12) onInListen++; } else { inSing++; if (g === 0.12) onInSing++; }
    }
    check(`guide ${guideOn ? 'on' : 'off'}: the tone plays during listen notes`, inListen > 20 && onInListen / inListen > 0.9, onInListen + '/' + inListen);
    check(`guide ${guideOn ? 'on' : 'off'}: quiet while you sing it back`, inSing > 20 && onInSing === 0, onInSing + '/' + inSing);
    const hitIdx = await p.evaluate(() => [...window.__state.hits.keys()].filter((k) => window.__state.chart.notes[k].listen));
    check('listen notes are never scored', hitIdx.length === 0, JSON.stringify(hitIdx));
    check('status says listen, then sing it back', /outlined note, then sing it back/.test(await p.textContent('#us-status')), await p.textContent('#us-status'));
    check('lyrics say what to do', /listen|now you/.test(await p.textContent('#lyr-cur')), await p.textContent('#lyr-cur'));
  }
  // the summary reports pitch matching: notes found, how fast, and which to work on
  await p.evaluate(() => {
    const st = window.__state, ns = st.chart.notes, mk = (n, from, c) => {
      const h = { good: 0, total: 0, near: 0, sum: 0, sq: 0, trace: [] };
      for (let t = n.t; t < n.t + n.dur; t += 3) { const x = t < n.t + from ? 300 : c; h.trace.push(t, x); h.total++; if (Math.abs(x) < 50) h.good++; if (Math.abs(x) < 150) { h.near++; h.sum += x; h.sq += x * x; } }
      return h;
    };
    st.hits.clear();
    st.hits.set(1, mk(ns[1], 200, 5)); st.hits.set(3, mk(ns[3], 900, -10)); st.hits.set(5, mk(ns[5], 0, -80));
    // a glide through note 7's pitch (100 ms within 50¢ on the way), then held a semitone sharp
    const g = { good: 0, total: 0, near: 0, sum: 0, sq: 0, trace: [] }, n7 = ns[7];
    for (let t = n7.t; t < n7.t + n7.dur; t += 3) { const x = t < n7.t + 300 ? -400 : t < n7.t + 400 ? 0 : 100; g.trace.push(t, x); g.total++; if (Math.abs(x) < 50) g.good++; if (Math.abs(x) < 150) { g.near++; g.sum += x; g.sq += x * x; } }
    st.hits.set(7, g);
    // the clock: notes 1-9 are past (note 9 not sung at all)
    st.manualClock = performance.now() - (ns[10].t + 100) + st.offset;
  });
  await p.click('#summary-btn');
  const sum = await p.textContent('#summary-body');
  check('summary: unsung and glided-through notes count as not found (2 of 5)', /found 2 of 5 notes/.test(sum), sum.slice(0, 400));
  check('summary: the slow one and the flat one are named', /D3: found it after 0\.9 s/.test(sum) && /E3: mostly flat by 80¢/.test(sum) && !/C3:/.test(sum), sum);
  check('summary: the glide is "sharp", the silent one "not sung"', /F3: mostly sharp by \d+¢/.test(sum) && /G3: not sung/.test(sum), sum);
  check('summary: no "lines to work on" for echo', !/Lines to work on/.test(sum));
  await p.keyboard.press('Escape');
  // the key you set for exercises is kept for the next exercise (and isn't a song's key)
  await p.selectOption('#exercise', 'examples/echo.txt'); await p.waitForFunction(() => window.__state.exerciseMode);
  await p.click('#key-up'); await p.click('#key-up');
  await p.selectOption('#exercise', ''); await sleep(200);
  check('leaving an exercise: key back to 0 (no song)', (await p.evaluate(() => window.__state.key)) === 0);
  await p.selectOption('#exercise', 'examples/warmup-scale.txt'); await p.waitForFunction(() => window.__state.chart && /scale/.test(window.__state.chart.title));
  check('next exercise starts in the key you chose (+2)', (await p.evaluate(() => window.__state.key)) === 2);
  await p.click('#key-down'); await p.click('#key-down');
  await p.selectOption('#exercise', 'examples/echo-intervals.txt');
  await p.waitForFunction(() => window.__state.chart && /two notes/.test(window.__state.chart.title) && window.__state.chart.echo);
  await sleep(2400); // first listen note starts 2 s in
  check('intervals: the first listen note plays', (await p.evaluate(() => window.__g)) === 0.12);
  await p.selectOption('#exercise', '');
  await sleep(300);
  check('leaving the exercise stops the tone (guide on, no chart)', (await p.evaluate(() => window.__g)) === 0);
});
