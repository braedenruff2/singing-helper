// Sing the sustain exercise with 5.5 Hz / ±40¢ vibrato; the summary should report it.
// node tests/e2e/vibrato-summary.cjs [fixtures/sustain-vibrato.wav]
const path = require('path');
const { test, EXAMPLES } = require('./lib.cjs');
test('vibrato-summary', async ({ url, newPage, check }) => {
  const p = await newPage();
  await p.goto(url);
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.click('#clock');
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'sustain.txt'));
  await p.waitForTimeout(9000);
  await p.click('#summary-btn');
  const s = (await p.textContent('#summary-body')).replace(/\s+/g, ' ');
  const v = /about ([\d.]+) wobbles per second, ±(\d+)¢/.exec(s);
  check('vibrato found', !!v, s.slice(0, 200));
  if (v) {
    check('vibrato rate ~5.5 Hz', Math.abs(+v[1] - 5.5) <= 0.6, v[1]);
    check('vibrato depth ~40¢', Math.abs(+v[2] - 40) <= 10, v[2]);
  }
  // Loop-style jump back over the notes: vibrato must be measured per pass, not over all passes together
  await p.keyboard.press('Escape');
  await p.evaluate(() => { window.__state.manualClock += 9000; }); // song time back 9 s
  await p.waitForTimeout(8000);
  await p.click('#summary-btn');
  const s2 = (await p.textContent('#summary-body')).replace(/\s+/g, ' ');
  const v2 = /about ([\d.]+) wobbles per second/.exec(s2);
  check('vibrato still ~5.5 Hz after singing the notes again', v2 && Math.abs(+v2[1] - 5.5) <= 0.8, (v2 && v2[1]) || s2.slice(0, 160));
  check('notes on pitch', /(\d+)% of \d+ notes/.test(s) && +/(\d+)% of/.exec(s)[1] >= 66, s.slice(0, 40));
}, { mic: 'sustain-vibrato.wav' });
