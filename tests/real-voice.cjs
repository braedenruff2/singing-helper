// Real singing through the real detector: the Vocadito dataset (40 solo singers, CC BY 4.0,
// https://zenodo.org/records/5578807) with hand-checked f0. Measures what the readout would show on a real voice.
// Run: VOCADITO=/path/to/vocadito node tests/real-voice.cjs   (skips if the data isn't there)
// Limits are set a little under today's results so a change that makes the readout worse fails.
const fs = require('fs');
const path = require('path');
const DIR = process.env.VOCADITO || '/home/claude/data';
if (!fs.existsSync(path.join(DIR, 'Annotations', 'F0'))) { console.log('real-voice: skipped (no Vocadito data at ' + DIR + ')'); process.exit(0); }

function loadProcessor(sampleRate) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pitch-worklet.js'), 'utf8');
  const out = [];
  const env = { sampleRate, currentTime: 0 };
  const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'env',
    'let sampleRate = env.sampleRate; let currentTime = 0;\n' +
    src.replace(/currentTime;/, 'env.currentTime;') + '\nreturn PitchProcessor;');
  class AWP { constructor() { this.port = { postMessage: (m) => out.push(m) }; } }
  const Cls = fn(AWP, () => {}, env);
  return { make: (o) => new Cls({ processorOptions: o || {} }), out, env };
}

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('unsupported wav ' + file);
  const n = data.length / 2 / fmt.ch, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { sr: fmt.sr, x };
}

function readF0(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map(Number));
}

const opts = JSON.parse(process.argv[2] || "{}");
const OFFSET = +(process.env.RV_OFFSET || 0.01);
const MINCONF = +(process.env.RV_MINCONF || 0); // experiment: treat less confident readings as "no pitch"
const files = fs.readdirSync(path.join(DIR, 'Audio')).filter((f) => /^vocadito_\d+\.wav$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
let T = { voiced: 0, good: 0, octave: 0, up: 0, missed: 0, unvoiced: 0, falseAlarm: 0, farSilence: 0, farAlarm: 0 };
const worst = [];
for (const f of files) {
  const id = f.match(/\d+/)[0];
  const { sr, x } = readWav(path.join(DIR, 'Audio', f));
  const truth = readF0(path.join(DIR, 'Annotations', 'F0', 'vocadito_' + id + '_f0.csv'));
  const hop = truth[1][0] - truth[0][0];
  const { make, out, env } = loadProcessor(sr);
  const p = make(opts);
  for (let i = 0; i + 128 <= x.length; i += 128) { env.currentTime = (i + 128) / sr; p.process([[x.subarray(i, i + 128)]]); }
  const t = { voiced: 0, good: 0, octave: 0, up: 0, missed: 0, unvoiced: 0, falseAlarm: 0, farSilence: 0, farAlarm: 0 };
  // frames more than FAR s from any sung label: real breaths/silence, not the fuzzy edges of a note's label
  const FAR = 0.12, farK = Math.round(FAR / hop), far = new Uint8Array(truth.length);
  for (let i = 0, last = -1e9; i < truth.length; i++) { if (truth[i][1] > 0) last = i; far[i] = i - last > farK ? 1 : 0; }
  for (let i = truth.length - 1, next = 1e9; i >= 0; i--) { if (truth[i][1] > 0) next = i; if (next - i <= farK) far[i] = 0; }
  for (const m0 of out) {
    const m = MINCONF && m0.f && m0.conf < MINCONF ? { t: m0.t, f: 0 } : m0;
    // the detector's estimate describes the window ending at m.t; compare with the label ~half a window earlier
    const k = Math.round((m.t - OFFSET) / hop);
    if (k < 2 || k >= truth.length - 2) continue;
    const f0 = truth[k][1], near = [truth[k - 2][1], truth[k + 2][1]];
    if (f0 > 0 && near.every((v) => v > 0)) {
      t.voiced++;
      if (!m.f) t.missed++;
      else {
        const c = Math.abs(1200 * Math.log2(m.f / f0));
        if (c < 50) t.good++; else if (Math.abs(c - 1200) < 100 || Math.abs(c - 1902) < 100) { t.octave++; if (m.f > f0) t.up++; }
      }
    } else if (f0 === 0 && near.every((v) => v === 0)) {
      t.unvoiced++;
      if (m.f) t.falseAlarm++;
      if (far[k]) { t.farSilence++; if (m.f) t.farAlarm++; }
    }
  }
  for (const k in T) T[k] += t[k];
  worst.push({ id, acc: t.good / Math.max(1, t.voiced - t.missed), miss: t.missed / Math.max(1, t.voiced), oct: t.octave / Math.max(1, t.voiced) });
}
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';
const sung = T.voiced - T.missed;
console.log(`tracks ${files.length}  voiced frames ${T.voiced}`);
console.log(`  right note (within 50 cents) when it shows a pitch: ${pct(T.good, sung)}`);
console.log(`  octave/fifth errors: ${pct(T.octave, sung)} (${pct(T.up, T.octave)} of them too high)`);
console.log(`  singing shown as "no pitch": ${pct(T.missed, T.voiced)}`);
console.log(`  pitch shown in silence/breaths: ${pct(T.falseAlarm, T.unvoiced)} (${pct(T.farAlarm, T.farSilence)} more than 120 ms from any singing; the rest are note edges)`);
worst.sort((a, b) => a.acc - b.acc);
console.log('  hardest tracks: ' + worst.slice(0, 5).map((w) => `#${w.id} ${(w.acc * 100).toFixed(0)}% (oct ${(w.oct * 100).toFixed(0)}%, miss ${(w.miss * 100).toFixed(0)}%)`).join(', '));
// 18 Nov 2026, offset 10 ms: 96.0% right, 2.5% octave, 2.4% missed, 11.4% shown in breaths; with maxD 0.25: 96.2 / 2.5 / 2.9 / 7.6.
// With octave continuity (cont, 18 Nov): 97.4 / 1.2 / 2.9 / 7.6. Threshold 0.15 -> 0.1 (19 Nov): 97.7 / 1.1 / 2.9 / 7.6.
// Tried 19 Nov and rejected: winPeriods 2 (98.1% here, but +3 ms latency and 15% octave errors on bench leaps), contDown 0.5.
const LIM = { acc: 0.97, octave: 0.015, missed: 0.035, falseAlarm: 0.09, farAlarm: 0.02 };
let failed = 0;
if (!process.argv[2]) {
  if (T.good / sung < LIM.acc) { failed++; console.log('FAIL accuracy below ' + LIM.acc); }
  if (T.octave / sung > LIM.octave) { failed++; console.log('FAIL octave errors above ' + LIM.octave); }
  if (T.missed / T.voiced > LIM.missed) { failed++; console.log('FAIL missed above ' + LIM.missed); }
  if (T.falseAlarm / T.unvoiced > LIM.falseAlarm) { failed++; console.log('FAIL false alarms above ' + LIM.falseAlarm); }
  if (T.farAlarm / T.farSilence > LIM.farAlarm) { failed++; console.log('FAIL pitch shown far from singing above ' + LIM.farAlarm); }
}
console.log(failed ? 'real-voice: FAILED' : 'real-voice: passed');
process.exitCode = failed ? 1 : 0;
