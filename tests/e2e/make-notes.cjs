// "Make notes from audio": needs tools/server.py and its Python packages (CREPE etc.).
// Start it first:  python tools/server.py --port 8124 --no-separate --crepe-model tiny
// then:            node tests/e2e/make-notes.cjs [fixtures/vocal.wav]
// (tests/run-all.cjs runs this only when MAKE_NOTES=1.)
const { chromium } = require('playwright');
const { fixture } = require('./lib.cjs');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  let ok = false;
  try {
    await p.goto('http://127.0.0.1:' + (process.env.CHART_PORT || 8124) + '/');
    await p.waitForSelector('#gen:not([hidden])', { timeout: 5000 });
    await p.setInputFiles('#genfile', fixture('vocal.wav'));
    await p.waitForFunction(() => /Made|Could not/.test(document.getElementById('gen-status').textContent), null, { timeout: 120000 });
    const st = await p.textContent('#gen-status');
    ok = /^Made \d+ notes/.test(st) && /Loaded/.test(await p.textContent('#us-status'));
    console.log(`${ok ? 'ok  ' : 'FAIL'} chart made from audio  (${st})`);
  } catch (e) { console.log('FAIL make-notes:', e.message); }
  await b.close();
  console.log('make-notes: ' + (ok ? 'passed' : '1 check(s) FAILED'));
  process.exitCode = ok ? 0 : 1;
})();
