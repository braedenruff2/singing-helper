// Live song pitch (melody.js) on synthetic song mixes, offline in Node: a sung melody with vibrato and
// vowel formants over chords, bass and drums. Reproduces what the AnalyserNode gives the app
// (Blackman window, 4096-point FFT, dB) every 20 ms, plus the app's 5-frame median.
//   node tests/melody.mjs            pass/fail
//   node tests/melody.mjs --verbose  per-mix numbers
import { melodyPitch, resetMelody } from '../melody.js';

const SR = 48000, N = 4096, HOP = SR * 0.02;
const verbose = process.argv.includes('--verbose');
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// deterministic noise
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

// ---- synthesis
const NOTE = 0.45;
const MELODY = [64, 67, 69, 67, 64, 62, 60, 62, 64, 64, 64, 62, 62, 64, 67, 67, 69, 71, 72, 71, 69, 67, 64, 62];
const CHORDS = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55], [57, 60, 64], [53, 57, 60]];

// vowel formant envelope (dB-ish gain) for "ah"
function formant(f, formants) {
  let g = 0.3; // the glottal source has energy everywhere; formants lift some of it
  for (const [fc, bw, a] of formants) g += a / (1 + ((f - fc) / (bw / 2)) ** 2);
  return g;
}
const AH = [[750, 120, 1], [1150, 140, 0.55], [2700, 200, 0.3], [3300, 250, 0.15]];
const EE = [[300, 80, 1], [2300, 160, 0.5], [3000, 200, 0.3]];

function synth({ melody = MELODY, chords = CHORDS, padShift = 0, shift = 0, voice = 1, pads = 0.35, bass = 0.8, drums = 0.5, vowel = AH, vib = 30, breath = 0.02 }) {
  const len = Math.ceil((melody.length * NOTE + 0.5) * SR);
  const x = new Float32Array(len);
  let ph = 0, vph = 0;
  // voice: additive harmonics shaped by the vowel, -6 dB/octave source
  for (let i = 0; i < len; i++) {
    const t = i / SR, k = Math.floor(t / NOTE);
    if (k >= melody.length) break;
    const inNote = t - k * NOTE;
    const env = Math.min(1, inNote / 0.03) * (inNote > NOTE - 0.05 ? 0.3 : 1);
    vph += 2 * Math.PI * 5.5 / SR;
    const f0 = hz(melody[k] + shift) * 2 ** ((vib / 1200) * Math.sin(vph));
    ph += 2 * Math.PI * f0 / SR;
    let s = 0;
    for (let h = 1; h * f0 < 5000; h++) s += Math.sin(h * ph) * (1 / h) * formant(h * f0, vowel) * 1.0;
    x[i] = voice * env * (s * 0.6 + breath * rnd());
  }
  // pads: sawtooth chords, low-passed (harmonics up to 1.5 kHz)
  const padPh = [0, 0, 0];
  let bph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR, c = chords[Math.min(chords.length - 1, Math.floor(t / (4 * NOTE)))];
    let s = 0;
    for (let v = 0; v < 3; v++) {
      const f = hz(c[v] + shift + padShift);
      padPh[v] += 2 * Math.PI * f / SR;
      for (let h = 1; h * f < 1500; h++) s += Math.sin(h * padPh[v]) / h;
    }
    const fb = hz(c[0] + shift - 12);
    bph += 2 * Math.PI * fb / SR;
    const b = Math.sin(bph) + 0.3 * Math.sin(2 * bph) + 0.1 * Math.sin(3 * bph);
    x[i] += pads * 0.25 * s + bass * 0.35 * b;
  }
  // drums: kick on the beat, hats in between
  for (let k = 0; k < melody.length; k++) {
    const t0 = Math.round(k * NOTE * SR), t1 = Math.round((k + 0.5) * NOTE * SR);
    for (let j = 0; j < SR * 0.15 && t0 + j < len; j++) x[t0 + j] += drums * 0.6 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-j / 800)) * j / SR) * Math.exp(-j / 3000);
    for (let j = 0; j < SR * 0.04 && t1 + j < len; j++) x[t1 + j] += drums * 0.15 * rnd() * Math.exp(-j / 300);
  }
  return { x, melody: melody.map((m) => m + shift) };
}

// ---- analyser (as Chrome's AnalyserNode with smoothingTimeConstant 0)
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
function fftMagDb(frame) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = frame[i] * win[i];
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= N; size <<= 1) {
    const ang = -2 * Math.PI / size;
    for (let i = 0; i < N; i += size) for (let k = 0; k < size / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const a = i + k, b = a + size / 2;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const out = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / N + 1e-30);
  return out;
}

// ---- run the app's pipeline and score it
export function evaluate(mix, pitchFn = melodyPitch) {
  const { x, melody } = mix;
  const rows = [];
  const recent = [];
  for (let end = N; end <= x.length; end += HOP) {
    const spec = fftMagDb(x.subarray(end - N, end));
    const m = pitchFn(spec, SR / N);
    recent.push(m == null ? NaN : m); if (recent.length > 5) recent.shift();
    const good = recent.filter((v) => !isNaN(v)).sort((a, b) => a - b);
    const got = good.length >= 3 ? good[good.length >> 1] : null;
    const t = end / SR - 0.09; // REF_DELAY_MS
    const k = Math.floor(t / NOTE), into = t - k * NOTE;
    if (k >= 0 && k < melody.length && into > 0.12 && into < NOTE - 0.06) rows.push({ want: melody[k], got });
  }
  const n = rows.length;
  const right = rows.filter((r) => r.got != null && Math.abs(r.got - r.want) < 0.75).length;
  const octave = rows.filter((r) => r.got != null && Math.abs(Math.abs(r.got - r.want) - 12) < 0.75).length;
  const missing = rows.filter((r) => r.got == null).length;
  let flicker = 0;
  for (let i = 1; i < n; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.want !== b.want) continue;
    if ((a.got == null) !== (b.got == null) || (a.got != null && Math.abs(a.got - b.got) > 1.5)) flicker++;
  }
  return { n, right: right / n, octave: octave / n, missing: missing / n, wrong: (n - right - missing) / n, flicker, rows };
}

const M2 = [55, 59, 62, 67, 71, 69, 66, 62, 64, 67, 72, 76, 74, 71, 67, 64, 57, 60, 64, 69, 67, 64, 60, 57];
const C2 = [[43, 47, 50], [52, 55, 59], [48, 52, 55], [50, 54, 57], [45, 48, 52], [43, 47, 50]];
// [mix options, minimum share of in-note frames right]. The first group was used to tune melody.js,
// the "held-out" group was only measured afterwards.
export const MIXES = {
  'voice alone': { pads: 0, bass: 0, drums: 0 },
  'voice + bass': { pads: 0, drums: 0 },
  'voice + band': {},
  'quieter voice': { voice: 0.6 },
  'ee vowel + band': { vowel: EE },
  'low male voice': { shift: -12 },
  'high voice': { shift: 7 },
  'busy, voice under': { voice: 0.45, pads: 0.6, drums: 0.8 },
  'held-out: other tune': { melody: M2, chords: C2 },
  'held-out: pads 2 oct up': { melody: M2, chords: C2, padShift: 24 },
  'held-out: pads 1 oct up': { padShift: 12 },
  'held-out: female': { melody: M2.map((m) => m + 9), chords: C2.map((c) => c.map((x) => x + 9)) },
  'held-out: low male': { melody: M2.map((m) => m - 7), chords: C2 },
  'held-out: loud drums': { melody: M2, chords: C2, drums: 1.5 },
};
// the voice much quieter than the band is still hard; everything else must stay mostly right
const HARD = new Set(['busy, voice under']);
// limits: what the current detector must keep doing (tightened as it improves)
export const LIMITS = { right: 0.85, wrong: 0.15, flicker: 6 };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('melody.mjs')) {
  let fails = 0;
  for (const [name, opt] of Object.entries(MIXES)) {
    seed = 1; resetMelody();
    const r = evaluate(synth(opt));
    const ok = HARD.has(name) ? r.right >= 0.6 && r.flicker <= 15
      : r.right >= LIMITS.right && r.wrong <= LIMITS.wrong && r.flicker <= LIMITS.flicker;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} right ${(r.right * 100).toFixed(0).padStart(3)}%  missing ${(r.missing * 100).toFixed(0).padStart(3)}%  wrong ${(r.wrong * 100).toFixed(0).padStart(3)}% (octave ${(r.octave * 100).toFixed(0)}%)  flicker ${r.flicker}`);
    if (verbose) console.log('     ' + r.rows.filter((_, i) => i % 4 === 0).map((q) => q.want + ':' + (q.got == null ? '-' : q.got)).join(' '));
  }
  console.log(fails ? `melody: ${fails} FAILED` : 'melody: passed');
  process.exitCode = fails ? 1 : 0;
}
// The app's pipeline frame by frame for any signal: [{ t (s, the moment the shown pitch refers to), got }]
export function fftFrames(x, pitchFn = melodyPitch) {
  const out = [], recent = [];
  for (let end = N; end <= x.length; end += HOP) {
    const m = pitchFn(fftMagDb(x.subarray(end - N, end)), SR / N);
    recent.push(m == null ? NaN : m); if (recent.length > 5) recent.shift();
    const good = recent.filter((v) => !isNaN(v)).sort((a, b) => a - b);
    out.push({ t: end / SR - 0.09, got: good.length >= 3 ? good[good.length >> 1] : null });
  }
  return out;
}
export { synth };
