// Choosing the mic (a Bluetooth headset, an external mic): the list fills with the mics' names once the mic is allowed,
// a pick is used at once (the mic restarts on it) and on every later Start mic, it survives a reload, a mic that isn't
// there any more falls back to the default and says so, and a Bluetooth mic gets a note about its delay.
// node tests/e2e/mic-pick.cjs
const { test } = require('./lib.cjs');
test('mic-pick', async ({ url, newPage, check }) => {
  const p = await newPage();
  await p.goto(url);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  const opts = () => p.$$eval('#mic-pick option', (o) => o.map((x) => [x.value, x.textContent]));
  check('before the mic is allowed: the default is there', (await opts())[0][1] === 'Phone / computer default');
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.waitForFunction(() => document.querySelectorAll('#mic-pick option').length > 1, null, { timeout: 5000 }).catch(() => {});
  const list = await opts();
  check('after Start mic: every mic by name', list.length > 1 && list.slice(1).every(([v, t]) => v && t && !/^Mic \d/.test(t)), JSON.stringify(list));
  const [id, label] = list[list.length - 1];
  // record which device each getUserMedia asks for
  await p.evaluate(() => {
    window.__asked = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__asked.push(c.audio && c.audio.deviceId ? c.audio.deviceId.exact : ''); return gum(c); };
  });
  await p.selectOption('#mic-pick', id);
  await p.waitForFunction(() => window.__state.node && window.__asked.length, null, { timeout: 5000 }).catch(() => {});
  check('picking a mic restarts the mic on it', (await p.evaluate(() => window.__asked)).join() === id && !!(await p.evaluate(() => window.__state.node)), JSON.stringify(await p.evaluate(() => window.__asked)));
  check('the readout names the mic', (await p.textContent('#lat')).includes(label), await p.textContent('#lat'));
  check('saved', (await p.evaluate(() => JSON.parse(localStorage.getItem('mic')))).id === id);
  await p.reload();
  await p.waitForTimeout(300);
  // (a browser may give the same mic a new id: it's found again by its name)
  check('after a reload the pick is kept', (await p.$eval('#mic-pick', (s) => s.selectedOptions[0].textContent)) === label, JSON.stringify(await opts()));
  const id2 = await p.$eval('#mic-pick', (s) => s.value);
  await p.evaluate(() => {
    window.__asked = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__asked.push(c.audio && c.audio.deviceId ? c.audio.deviceId.exact : ''); return gum(c); };
  });
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 }).catch(() => {});
  check('… and Start mic opens that mic', (await p.evaluate(() => window.__asked)).join() === id2 && (await p.textContent('#lat')).includes(label), await p.textContent('#lat'));
  check('… listed once, not also as "not connected"', (await opts()).filter(([, t]) => t.startsWith(label)).length === 1, JSON.stringify(await opts()));
  // a new id and the names not known yet (first Start mic of a visit): found by its name after all
  await p.evaluate((label) => localStorage.setItem('mic', JSON.stringify({ id: 'old-id-999', label })), label);
  await p.reload();
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 }).catch(() => {});
  check('an old id: the same mic found by name', (await p.textContent('#lat')).startsWith(label) && (await p.evaluate(() => JSON.parse(localStorage.getItem('mic')).id)) !== 'old-id-999', await p.textContent('#lat'));
  // a mic that has gone (unplugged headset): the default, with a note; the choice stays on the list
  await p.evaluate(() => localStorage.setItem('mic', JSON.stringify({ id: 'gone-123', label: 'My USB mic' })));
  await p.reload();
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 }).catch(() => {});
  check('a missing mic: the default is used, and it says so', !!(await p.evaluate(() => window.__state.node)) && /My USB mic isn’t connected: using the default mic/.test(await p.textContent('#lat')), await p.textContent('#lat'));
  check('… the choice is still on the list', (await opts()).some(([v, t]) => v === 'gone-123' && /My USB mic \(not connected\)/.test(t)));
  // back to the default
  await p.selectOption('#mic-pick', '');
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 }).catch(() => {});
  check('"default" clears the choice', (await p.evaluate(() => localStorage.getItem('mic'))) === null && !!(await p.evaluate(() => window.__state.node)));
  // a Bluetooth headset (stubbed list): the delay note
  await p.evaluate(() => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => (await real()).concat([{ kind: 'audioinput', deviceId: 'bt-1', label: 'Bluetooth headset', groupId: 'g' }]);
  });
  await p.click('#mic-refresh');
  await p.waitForFunction(() => Array.from(document.querySelectorAll('#mic-pick option')).some((o) => o.value === 'bt-1'), null, { timeout: 3000 }).catch(() => {});
  await p.evaluate(() => { const s = document.getElementById('mic-pick'); s.value = 'bt-1'; window.__state.node = null; }); // set without restarting the fake device
  await p.$eval('#mic-pick', (s) => s.dispatchEvent(new Event('change')));
  await p.waitForTimeout(300);
  check('Bluetooth: a note about its delay', /Bluetooth mics add delay/.test(await p.textContent('#mic-hint')), await p.textContent('#mic-hint'));
});
