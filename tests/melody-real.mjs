// Live song pitch (melody.js) on REAL singing over a synthetic band: the 40 Vocadito solo singers (CC BY 4.0,
// https://zenodo.org/records/5578807, hand-checked f0) mixed with tests/melody.mjs's chords + bass + drums
// in the singer's key. Unlike the all-synthetic mixes, the singer breathes and stops, so this also measures
// how often the band's pitch is shown while nobody sings (the "voicing" problem).
//   VOCADITO=/path node tests/melody-real.mjs [--verbose] ['{"voice":0.5}']   (skips without the data)
import fs from 'fs';
import path from 'path';
import { melodyPitch, resetMelody, PARAMS } from '../melody.js';
import { synth, fftFrames } from './melody.mjs';

const DIR = process.env.VOCADITO || '/home/claude/data';
if (!fs.existsSync(path.join(DIR, 'Annotations', 'F0'))) { console.log('melody-real: skipped (no Vocadito data at ' + DIR + ')'); process.exit(0); }
const SR = 48000;
const verbose = process.argv.includes('--verbose');
const opt = JSON.parse(process.argv.find((a) => a.startsWith('{')) || '{}');
const LEVEL = opt.voice || 1; // voice RMS relative to the band's
Object.assign(PARAMS, opt.params || {});

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len & 1);
  }
  const n = data.length / 2 / fmt.ch, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { sr: fmt.sr, x };
}
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const toMidi = (f) => 69 + 12 * Math.log2(f / 440);

const files = fs.readdirSync(path.join(DIR, 'Audio')).filter((f) => /^vocadito_\d+\.wav$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
if (process.env.MR_N) files.splice(+process.env.MR_N);
const T = { sung: 0, right: 0, octave: 0, missing: 0, rest: 0, bandShown: 0 };
const per = [];
for (const f of files) {
  const id = f.match(/\d+/)[0];
  const w = readWav(path.join(DIR, 'Audio', f));
  const truth = fs.readFileSync(path.join(DIR, 'Annotations', 'F0', 'vocadito_' + id + '_f0.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map(Number));
  const hop = truth[1][0] - truth[0][0];
  // voice resampled to 48 kHz
  const n = Math.floor(w.x.length * SR / w.sr), v = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = i * w.sr / SR, j = Math.floor(s), a = s - j; v[i] = (w.x[j] || 0) * (1 - a) + (w.x[j + 1] || 0) * a; }
  // band in the singer's key: tonic = the most common pitch class of the sung notes
  const pcs = new Array(12).fill(0);
  for (const [, hz] of truth) if (hz > 0) pcs[((Math.round(toMidi(hz)) % 12) + 12) % 12]++;
  const tonic = pcs.indexOf(Math.max(...pcs));
  const NOTE = 0.45, notes = Math.ceil(n / SR / NOTE) + 1;
  const prog = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [57, 60, 64]];
  const chords = Array.from({ length: Math.ceil(notes / 4) + 1 }, (_, k) => prog[k % 4]);
  const band = synth({ voice: 0, melody: new Array(notes).fill(60), chords, shift: tonic <= 6 ? tonic : tonic - 12 }).x;
  // voiced-frame RMS of the voice vs the band's RMS
  const voicedRms = Math.sqrt(truth.filter((r) => r[1] > 0).reduce((s, r) => { const i = Math.round(r[0] * SR); return s + (v[i] || 0) ** 2; }, 0) / Math.max(1, truth.filter((r) => r[1] > 0).length));
  const g = LEVEL * rms(band.subarray(0, n)) / Math.max(1e-6, voicedRms);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = g * v[i] + (band[i] || 0);
  resetMelody();
  const t = { sung: 0, right: 0, octave: 0, missing: 0, rest: 0, bandShown: 0 };
  for (const r of fftFrames(x, melodyPitch)) {
    const k = Math.round(r.t / hop);
    if (k < 3 || k >= truth.length - 3) continue;
    const near = [truth[k - 3][1], truth[k][1], truth[k + 3][1]];
    if (near.every((hz) => hz > 0)) {
      t.sung++;
      if (r.got == null) t.missing++;
      else { const d = Math.abs(r.got - toMidi(truth[k][1])); if (d < 0.75) t.right++; else if (Math.abs(d - 12) < 0.75) t.octave++; }
    } else if (near.every((hz) => hz === 0)) { t.rest++; if (r.got != null) t.bandShown++; }
  }
  for (const k in T) T[k] += t[k];
  per.push({ id, right: t.right / Math.max(1, t.sung), band: t.bandShown / Math.max(1, t.rest) });
}
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';
console.log(`melody-real (voice ${LEVEL}x the band): ${files.length} singers, ${T.sung} sung frames, ${T.rest} rest frames`);
console.log(`  sung: right ${pct(T.right, T.sung)}, octave ${pct(T.octave, T.sung)}, missing ${pct(T.missing, T.sung)}`);
console.log(`  while the singer rests: band's pitch shown ${pct(T.bandShown, T.rest)}`);
if (verbose) console.log('  ' + per.map((p) => `#${p.id} ${(p.right * 100).toFixed(0)}/${(p.band * 100).toFixed(0)}`).join('  '));
// 18 Nov 2026: right 76.1%, octave 1.9%, band shown in rests 99.6% (melody.js has no voicing cue yet). Tweaks of
// tilt / keep / octUp / lowPen moved "right" by under 1% or made it worse. Limits only when run with default options.
let failed = 0;
if (!process.argv.some((a) => a.startsWith('{'))) {
  if (T.right / T.sung < 0.74) { failed++; console.log('FAIL sung frames right below 74%'); }
  if (T.octave / T.sung > 0.03) { failed++; console.log('FAIL octave errors above 3%'); }
}
console.log(failed ? 'melody-real: FAILED' : 'melody-real: passed');
process.exitCode = failed ? 1 : 0;
