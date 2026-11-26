// Compiles and runs the phone and TV apps' plain-Java tests (Assets.java, TvFiles.java) on the JVM. Skipped without javac.
const { spawnSync } = require('child_process');
const path = require('path'); const fs = require('fs'); const os = require('os');
const root = path.join(__dirname, '..');
if (spawnSync('javac', ['-version'], { stdio: 'ignore' }).status !== 0) { console.log('java: skipped (no javac)'); process.exit(0); }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shjava-'));
const src = [path.join(root, 'android/src/app/singinghelper/Assets.java'), path.join(__dirname, 'java/AssetsTest.java'),
  path.join(root, 'android-tv/src/app/singinghelper/TvFiles.java'), path.join(__dirname, 'java/TvFilesTest.java')]; // + the TV app's
let r = spawnSync('javac', ['-encoding', 'UTF-8', '-d', out, ...src], { encoding: 'utf8' });
if (r.status !== 0) { console.log(r.stdout + r.stderr); console.log('java: compile FAILED'); process.exit(1); }
let bad = 0;
for (const cls of ['AssetsTest', 'TvFilesTest']) {
  r = spawnSync('java', ['-cp', out, 'app.singinghelper.' + cls], { encoding: 'utf8' });
  process.stdout.write((r.stdout || '') + (r.stderr || '').split('\n').filter((l) => !/Picked up/.test(l)).join('\n'));
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
