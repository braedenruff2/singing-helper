// The phone app (android/) shows this same page with window.SHAndroid: tab-audio features hidden, app updates in the
// side panel (check, allow, install), no service worker, and the mic let go in the background.
// node tests/e2e/app-mode.cjs
const { test } = require('./lib.cjs');
test('app-mode', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 412, height: 915 } });
  await p.addInitScript(() => {
    const st = { version: '0.1.1', code: 1, ready: false, readyName: '', allowed: false, busy: false, checked: 0, error: '', from: '' };
    window.__calls = [];
    window.SHAndroid = {
      isApp: () => true,
      updateStatus: () => JSON.stringify(st),
      updateCheck: () => { window.__calls.push('check'); st.busy = true; setTimeout(() => { st.busy = false; st.ready = true; st.readyName = '0.1.2'; st.checked = Date.now(); window.SHUpdateState(); }, 50); },
      updateAllow: () => { window.__calls.push('allow'); st.allowed = true; setTimeout(() => window.SHUpdateState(), 10); },
      updateInstall: () => window.__calls.push('install'),
    };
  });
  await p.goto(url);
  check('Live song pitch hidden (phones can\'t share app audio)', await p.isHidden('#capture') && await p.isHidden('#ahead') && await p.isHidden('#sync'));
  check('exercises and charts still there', await p.isVisible('#exercise') && await p.isVisible('#usfile'));
  check('app updates in the side panel', /Version 0\.1\.1/.test(await p.textContent('#updates')) && /Allow updates/.test(await p.textContent('#updates')));
  await p.click('#upd-allow');
  await p.waitForFunction(() => !document.getElementById('upd-allow'));
  await p.click('#upd-check');
  await p.waitForSelector('#upd-install');
  check('a downloaded update offers "Update now"', /0\.1\.2 is downloaded/.test(await p.textContent('#updates')));
  await p.click('#upd-install');
  check('calls go to Android', (await p.evaluate(() => window.__calls.join())) === 'allow,check,install', await p.evaluate(() => window.__calls.join()));
  await sleep(300);
  check('no service worker in the app', (await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0);
  await p.click('#start');
  await p.waitForFunction(() => window.__state.node);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('mic let go in the background', (await p.evaluate(() => window.__state.node)) == null && /background/.test(await p.textContent('#lat')));
  // the PC page is unchanged
  const q = await newPage();
  await q.goto(url);
  check('PC page: Live song pitch and no update panel', await q.isVisible('#capture') && !(await q.$('#updates')));
});
