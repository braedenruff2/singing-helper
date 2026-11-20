// Compiles and runs the phone app's plain-Java tests (android/src/.../Assets.java) on the JVM. Skipped without javac.
const { spawnSync } = require('child_process');
const path = require('path'); const fs = require('fs'); const os = require('os');
const root = path.join(__dirname, '..');
if (spawnSync('javac', ['-version'], { stdio: 'ignore' }).status !== 0) { console.log('java: skipped (no javac)'); process.exit(0); }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shjava-'));
const src = [path.join(root, 'android/src/app/singinghelper/Assets.java'), path.join(__dirname, 'java/AssetsTest.java')];
let r = spawnSync('javac', ['-encoding', 'UTF-8', '-d', out, ...src], { encoding: 'utf8' });
if (r.status !== 0) { console.log(r.stdout + r.stderr); console.log('java: compile FAILED'); process.exit(1); }
r = spawnSync('java', ['-cp', out, 'app.singinghelper.AssetsTest'], { encoding: 'utf8' });
process.stdout.write((r.stdout || '') + (r.stderr || '').split('\n').filter((l) => !/Picked up/.test(l)).join('\n'));
process.exit(r.status === 0 ? 0 : 1);
