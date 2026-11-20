// Review fixes of 19 Nov: a chart made without lyrics still shows the song's lyrics; loading a chart resets the score
// readout; a dropdown lets go of focus after a pick (so shortcut letters don't pick another option); duet part picker.
// node tests/e2e/chart-edge-cases.cjs
const { test } = require('./lib.cjs');
test('chart-edge-cases', async ({ url, newPage, check }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  // a chart like make_chart writes with no lyrics found: every syllable "~", no line breaks
  const chart = '#TITLE:No words\n#BPM:150\n#GAP:0\n' + Array.from({ length: 40 }, (_, i) => `: ${i * 8} 6 ${i % 5} ~`).join('\n') + '\nE\n';
  await p.evaluate(() => {
    window.__state.lyrics = [{ t: 0, end: 60000, text: 'the real words of the song' }];
    window.__state.hits.set(0, { good: 1, total: 1 });
  });
  // pretend an old score is showing
  await p.evaluate(() => { document.getElementById('score').textContent = '88% (8/9 notes)'; });
  await p.setInputFiles('#usfile', { name: 'nowords.txt', mimeType: 'text/plain', buffer: Buffer.from(chart) });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'No words');
  await p.click('#clock');
  await p.waitForTimeout(600);
  const lyr = await p.textContent('#lyr-cur');
  check('chart without lyrics: the song\'s lyrics are shown', /real words/.test(lyr), JSON.stringify(lyr));
  check('a new chart resets the score readout', (await p.textContent('#score')).trim() === '–', await p.textContent('#score'));
  await p.click('#loop');
  const lp = await p.evaluate(() => window.__state.loop);
  check('Loop line uses that lyric line, not the whole song', lp && lp.start === 0 && lp.end < 10000, JSON.stringify(lp));
  await p.click('#loop');
  await p.click('#clock');
  // dropdown: after picking, focus is released so "l" is a shortcut again, not "Long held notes"
  await p.focus('#exercise');
  await p.keyboard.press('ArrowDown'); // picks the warm-up with the list focused, as a mouse pick leaves it
  await p.waitForFunction(() => window.__state.exerciseMode);
  const focused = await p.evaluate(() => document.activeElement && document.activeElement.tagName);
  check('the exercise list lets go of focus after a pick', focused !== 'SELECT', focused);
  const picked = await p.inputValue('#exercise');
  await p.keyboard.press('l');
  check('L then works as the loop shortcut, the exercise stays', picked && (await p.inputValue('#exercise')) === picked, picked + ' -> ' + await p.inputValue('#exercise'));
  // duet charts: pick whose part to sing
  await p.selectOption('#exercise', '');
  await p.waitForFunction(() => !window.__state.exerciseMode);
  check('no part picker for a one-singer chart', await p.isHidden('#part-row'));
  const duet = '#TITLE:Duet\n#BPM:150\n#GAP:0\n#DUETSINGERP1:Ann\n#DUETSINGERP2:Bo\nP1\n: 0 4 0 a\n: 8 4 2 b\nP2\n: 4 4 9 X\n: 12 4 9 Y\n: 20 4 9 Z\nE\n';
  await p.setInputFiles('#usfile', { name: 'duet.txt', mimeType: 'text/plain', buffer: Buffer.from(duet) });
  await p.waitForFunction(() => window.__state.chart && window.__state.chart.title === 'Duet');
  check('duet: the part picker shows both singers', await p.isVisible('#part-row') &&
    (await p.$$eval('#part option', (o) => o.map((x) => x.textContent).join('|'))) === 'Ann|Bo');
  await p.click('#key-up');
  await p.selectOption('#part', '2');
  const c2 = await p.evaluate(() => ({ t: window.__state.chart.notes.map((n) => n.text).join(''), m: window.__state.chart.notes[0].midi }));
  check('duet: picking Bo shows Bo\'s notes, in the shifted key', c2.t === 'XYZ' && c2.m === 70, JSON.stringify(c2));
  const fo = await p.evaluate(() => document.activeElement && document.activeElement.tagName);
  check('the part picker lets go of focus', fo !== 'SELECT', fo);
  await p.selectOption('#exercise', { index: 1 });
  await p.waitForFunction(() => window.__state.exerciseMode);
  check('no part picker during an exercise', await p.isHidden('#part-row'));
});
