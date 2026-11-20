// Phone layout: no sideways scrolling at 390 px wide while the karaoke view runs.
// node tests/e2e/phone.cjs [fixtures/sing.wav]
const path = require('path');
const { test, EXAMPLES } = require('./lib.cjs');
test('phone', async ({ url, newPage, check, shot }) => {
  const p = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.goto(url);
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.click('#clock');
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.waitForTimeout(3000);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  check('no sideways scroll at 390 px', sw <= 390, 'scrollWidth ' + sw);
  const roll = await p.evaluate(() => { const r = document.getElementById('roll').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  check('piano roll visible', roll.w > 300 && roll.h > 100, JSON.stringify(roll));
  await shot(p, 'phone.png');
}, { mic: 'sing.wav' });
