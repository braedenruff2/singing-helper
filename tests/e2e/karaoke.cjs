// Warm-up chart with the manual clock: the chart loads, lyrics show and the sung scale scores.
// node tests/e2e/karaoke.cjs [fixtures/sing.wav]
const path = require('path');
const { test, EXAMPLES } = require('./lib.cjs');
test('karaoke', async ({ url, newPage, check, shot }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url);
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.click('#clock');
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.waitForTimeout(4200);
  const st = await p.textContent('#us-status'), lyr = await p.textContent('#lyr-cur'), score = await p.textContent('#score');
  check('chart loaded', /Loaded .*45 notes/.test(st), st);
  check('lyrics line shown', /la/.test(lyr), lyr.slice(0, 40));
  const m = /(\d+)%\s+\((\d+)\/(\d+)/.exec(score);
  check('sung notes scored mostly on pitch', m && +m[3] >= 3 && +m[1] >= 80, score);
  const cents = await p.evaluate(() => new Promise((res) => { const id = setInterval(() => { if (window.__state.pitch) { requestAnimationFrame(() => requestAnimationFrame(() => { clearInterval(id); res(document.getElementById('cents').textContent); })); } }, 10); }));
  check('needle compares with the chart note', /^([+-]?\d+¢|\d+ semitones? (low|high)) vs [A-G]/.test(cents), cents);
  await p.evaluate(() => window.__state.ctx.suspend()); // silence: no stale reading
  await p.waitForTimeout(300);
  await p.evaluate(() => { window.__state.pitch = null; });
  await p.waitForTimeout(100);
  check('not singing: says which note to sing', /^(sing [A-G]♯?|)$/.test(await p.textContent('#cents')), await p.textContent('#cents'));
  const lay = await p.evaluate(() => ({ lyr: document.querySelector('.lyrics').getBoundingClientRect().bottom, h: innerHeight, roll: document.getElementById('roll').clientHeight }));
  check('roll, lyrics and buttons fit in the window (no scrolling to see the lyrics)', lay.lyr <= lay.h + 1 && lay.roll >= 300, JSON.stringify(lay));
  await p.keyboard.press('s'); await p.waitForTimeout(200);
  const sv = await p.evaluate(() => ({ lyr: document.querySelector('.lyrics').getBoundingClientRect().bottom, h: innerHeight, w: document.getElementById('roll').clientWidth }));
  check('stage view: full width, lyrics still in the window', sv.lyr <= sv.h + 1 && sv.w >= 1200, JSON.stringify(sv));
  check('stage button offers the way back', (await p.textContent('#stage')) === 'Show settings');
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  check('Escape leaves stage view', !(await p.evaluate(() => document.body.classList.contains('stage'))) && (await p.textContent('#stage')) === 'Stage view');
  await shot(p, 'karaoke.png');
}, { mic: 'sing.wav' });
