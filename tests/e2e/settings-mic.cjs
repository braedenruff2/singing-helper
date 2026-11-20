// Settings are remembered after a reload; a disconnected mic can be started again; audio the browser
// pauses (sleep, phone call) is reported and resumes on the next click.
// node tests/e2e/settings-mic.cjs
const { test } = require('./lib.cjs');
test('settings-mic', async ({ url, newPage, check }) => {
  const p = await newPage();
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.uncheck('#fold'); await p.check('#smooth'); await p.check('#guide');
  await p.selectOption('#drone-note', '60');
  await p.$eval('#gate', (el) => { el.value = '0.02'; el.dispatchEvent(new Event('change')); });
  await p.reload();
  const v = await p.evaluate(() => ({ fold: fold.checked, smooth: smooth.checked, guide: guide.checked, drone: document.getElementById('drone-note').value, gate: gate.value }));
  check('settings restored after reload', !v.fold && v.smooth && v.guide && v.drone === '60' && v.gate === '0.02', JSON.stringify(v));
  // the restored gate reaches the detector
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  check('mic started', /Mic on/.test(await p.textContent('#start')));
  // mic unplugged
  await p.evaluate(() => window.__state.micStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await p.waitForFunction(() => !window.__state.node);
  check('unplugged mic: Start mic usable again', !(await p.isDisabled('#start')) && /disconnected/.test(await p.textContent('#lat')), await p.textContent('#lat'));
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 });
  await p.waitForFunction(() => window.__state.pitch, null, { timeout: 5000 }).catch(() => {});
  check('mic works again after restarting', !!(await p.evaluate(() => window.__state.pitch)));
  // browser pauses audio
  await p.evaluate(() => window.__state.ctx.suspend());
  await p.waitForFunction(() => /paused/.test(document.getElementById('lat').textContent), null, { timeout: 3000 }).catch(() => {});
  check('paused audio is reported', /paused/.test(await p.textContent('#lat')), await p.textContent('#lat'));
  await p.mouse.click(5, 300);
  await p.waitForFunction(() => window.__state.ctx.state === 'running', null, { timeout: 3000 }).catch(() => {});
  check('a click resumes it', (await p.evaluate(() => window.__state.ctx.state)) === 'running' && /kHz/.test(await p.textContent('#lat')), await p.textContent('#lat'));
  // paused audio, then the mic is unplugged: after resuming, the "disconnected" notice stays
  await p.evaluate(() => window.__state.ctx.suspend());
  await p.waitForFunction(() => /paused/.test(document.getElementById('lat').textContent), null, { timeout: 3000 }).catch(() => {});
  await p.evaluate(() => window.__state.micStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await p.mouse.click(5, 300);
  await p.waitForFunction(() => window.__state.ctx.state === 'running', null, { timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(200);
  check('unplug while paused: notice not replaced by old text', /disconnected/.test(await p.textContent('#lat')), await p.textContent('#lat'));
}, { mic: 'sing.wav' });
