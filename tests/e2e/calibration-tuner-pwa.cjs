// Output-delay calibration (mic loopback through a 120 ms delay, and the tap test with taps
// 150 ms after each click), the drone, and the installable-app pieces.
// node tests/e2e/calibration-tuner-pwa.cjs [fixtures/sing.wav]
const { test } = require('./lib.cjs');
test('calibration-tuner-pwa', async ({ url, newPage, check }) => {
  const p = await newPage();
  await p.goto(url);
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  // fake loopback: clicks -> 120 ms delay -> "mic"
  await p.evaluate(() => {
    const s = window.__state, ctx = s.ctx;
    const out = ctx.createGain(), dl = ctx.createDelay(1); dl.delayTime.value = 0.12;
    const mic = ctx.createGain();
    out.connect(dl).connect(mic);
    s.clickOut = out; s.micSrc = mic; s.micLatency = 0;
  });
  await p.click('#cal-mic');
  await p.waitForFunction(() => /set to|Couldn't/.test(document.getElementById('cal-status').textContent), null, { timeout: 15000 });
  const mic = await p.textContent('#cal-status');
  const mm = /set to (\d+) ms/.exec(mic);
  check('speaker measurement ~120 ms', mm && Math.abs(+mm[1] - 120) <= 10, mic);
  await p.evaluate(() => { window.__state.clickOut = null; });
  // tap test: press Space 150 ms after each click
  await p.click('#cal-tap');
  await p.waitForFunction(() => window.__state.tapClicks);
  await p.evaluate(async () => {
    const ctx = window.__state.ctx, { t0, gap, n } = window.__state.tapClicks;
    for (let i = 0; i < n; i++) {
      while (ctx.currentTime < t0 + i * gap + 0.15) await new Promise((r) => setTimeout(r, 2));
      dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    }
  });
  await p.waitForFunction(() => /set to|Not enough/.test(document.getElementById('cal-status').textContent), null, { timeout: 15000 });
  const tap = await p.textContent('#cal-status');
  const tm = /set to (\d+) ms/.exec(tap);
  check('tap test ~150 ms', tm && Math.abs(+tm[1] - 150) <= 15, tap);
  check('output delay remembered', (await p.evaluate(() => localStorage.getItem('outDelay'))) === (tm && tm[1]));
  await p.keyboard.press('d');
  await p.waitForTimeout(300);
  check('D turns the drone on', (await p.evaluate(() => window.__state.drone)) === 57 && /Stop/.test(await p.textContent('#drone')));
  await p.keyboard.press('d');
  await p.waitForTimeout(100);
  check('D again turns it off', (await p.evaluate(() => window.__state.drone)) == null);
  const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  check('service worker active', sw);
  const mf = await p.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).name);
  check('manifest readable', mf === 'Singing Helper', mf);
  // offline: the page still opens, even with a Spotify-style ?query in the address, and pages are cached once
  // (not once per login query)
  await p.goto(url + '?error=access_denied&state=x'); // like Spotify's redirect (a ?code= would start a real login)
  await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(500);
  const keys = await p.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return (await c.keys()).map((r) => r.url).filter((u) => u.includes('?')); });
  check('pages cached without their ?query', keys.length === 0, JSON.stringify(keys));
  await p.context().setOffline(true);
  let offlineOk = false;
  try { await p.goto(url + '?error=again', { timeout: 5000 }); offlineOk = !!(await p.$('#start')); } catch (_) { /* offline page failed */ }
  await p.context().setOffline(false);
  check('opens offline (from the cache)', offlineOk);
  // double-clicking Drone before the audio has started must not leave a second drone playing
  const p2 = await newPage();
  await p2.addInitScript(() => { const o = AudioContext.prototype.createOscillator; window.__osc = 0; AudioContext.prototype.createOscillator = function () { window.__osc++; return o.call(this); }; });
  await p2.goto(url);
  await p2.evaluate(() => { document.getElementById('drone').click(); document.getElementById('drone').click(); });
  await p2.waitForFunction(() => window.__state.drone != null, null, { timeout: 5000 });
  await p2.waitForTimeout(300);
  check('double-click Drone starts one drone', (await p2.evaluate(() => window.__osc)) === 2, (await p2.evaluate(() => window.__osc)) + ' oscillators (one drone = 2)');
}, { mic: 'sing.wav', ignore: /ERR_INTERNET_DISCONNECTED/ });
