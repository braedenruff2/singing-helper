// Runs the benchmark, the unit tests and every browser test; a failing browser test is retried once
// (the fake mic isn't synced to the app clock, so timing-based scores can miss under load).
//   node tests/run-all.cjs            (add MAKE_NOTES=1 with tools/server.py running on 8124 for make-notes,
//                                      MELODY_REAL=1 for Live song pitch on real singers, ~5 min, needs Vocadito)
// Needs Node and the `playwright` package with Chromium (npm i playwright && npx playwright install chromium).
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const here = __dirname;
const only = process.argv.slice(2);
const run = (file, args = []) => spawnSync(process.execPath, [path.join(here, file), ...args], { stdio: 'pipe', encoding: 'utf8', env: process.env });
const results = [];
function step(name, file, retry) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  let r = run(file), tries = 1;
  if (r.status !== 0 && retry) { process.stdout.write(r.stdout + r.stderr + `(retrying ${name} once)\n`); r = run(file); tries++; }
  process.stdout.write(r.stdout + r.stderr);
  results.push({ name, ok: r.status === 0, tries });
}
step('unit', 'unit.mjs', false);
step('bench', 'bench.cjs', false);
step('java', 'java.cjs', false); // the phone app's plain-Java helpers
step('real-voice', 'real-voice.cjs', false); // real singers (Vocadito, CC BY 4.0); skips unless VOCADITO points at the data
step('melody', 'melody.mjs', false);
if (process.env.MELODY_REAL) step('melody-real', 'melody-real.mjs', false); // real singers over a synthetic band, ~5 min
// chart-maker tests (Python + numpy); skipped when Python or numpy is missing
{
  const py = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0);
  if (py && (!only.length || only.some((o) => 'make_chart'.includes(o)))) {
    for (const t of ['test_make_chart.py', 'test_server.py']) {
      const r = spawnSync(py, [path.join(here, '..', 'tools', t)], { encoding: 'utf8' });
      process.stdout.write(r.stdout + r.stderr.split('\n').filter((l) => !/^127\.0\.0\.1 - -/.test(l)).join('\n'));
      results.push({ name: t.replace(/^test_|\.py$/g, ''), ok: r.status === 0, tries: 1 });
    }
  } else if (!py) console.log('(make_chart tests skipped: no Python with numpy)');
}
for (const f of fs.readdirSync(path.join(here, 'e2e')).filter((f) => f.endsWith('.cjs') && f !== 'lib.cjs').sort()) {
  if (f === 'make-notes.cjs' && !process.env.MAKE_NOTES) continue;
  if (f === 'lyrics-live.cjs' && !process.env.LIVE) continue; // needs internet
  step(f.replace('.cjs', ''), path.join('e2e', f), true);
}
console.log('\n==== summary');
for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.tries > 1 ? ' (after a retry)' : ''}`);
const bad = results.filter((r) => !r.ok).length;
console.log(bad ? `${bad} FAILED` : `all ${results.length} passed`);
process.exitCode = bad ? 1 : 0;
