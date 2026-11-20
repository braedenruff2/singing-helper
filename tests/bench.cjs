// Offline accuracy + latency benchmark for pitch-worklet.js. Run: node tests/bench.cjs
// Synthesises voice-like signals (harmonics, vibrato, breath noise) and feeds them
// through the real worklet code in 128-sample quanta, like the browser does.
const fs = require('fs');
const path = require('path');

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

function rand(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// voice: sum of harmonics with a formant-ish rolloff, vibrato, noise
// amps: harmonic amplitudes (index 0 = fundamental); jitter: random period jitter (fraction)
function voice(sr, segs, { vibrato = 0, noise = 0, seed = 1, amps = null, jitter = 0 } = {}) {
  const r = rand(seed);
  const total = segs.reduce((a, s) => a + s.dur, 0);
  const x = new Float32Array(Math.round(total * sr));
  let phase = 0, i = 0;
  const truth = new Float32Array(x.length);
  for (const s of segs) {
    const n = Math.round(s.dur * sr);
    for (let k = 0; k < n; k++, i++) {
      const t = i / sr;
      const f = s.f ? s.f * Math.pow(2, (vibrato / 1200) * Math.sin(2 * Math.PI * 5.5 * t)) : 0;
      truth[i] = f;
      phase += (2 * Math.PI * f * (1 + jitter * (r() * 2 - 1))) / sr;
      let v = 0;
      if (f) for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) * (amps ? amps[h - 1] || 0 : h === 2 || h === 3 ? 0.7 : 1 / h);
      x[i] = 0.15 * v + noise * (r() * 2 - 1);
    }
  }
  return { x, truth };
}

function run(sr, sig, opts) {
  const { make, out, env } = loadProcessor(sr);
  const p = make(opts);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i + 128 <= sig.x.length; i += 128) {
    env.currentTime = (i + 128) / sr;
    p.process([[sig.x.subarray(i, i + 128)]]);
  }
  const cpu = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out, cpu };
}

function score(sr, sig, out) {
  let good = 0, octave = 0, voicedFrames = 0, missed = 0;
  for (const m of out) {
    const idx = Math.min(sig.truth.length - 1, Math.round(m.t * sr) - 1);
    const f = sig.truth[idx];
    // skip frames within 40 ms of a change (that's what the latency test measures)
    const back = sig.truth[Math.max(0, idx - Math.round(0.04 * sr))];
    if (!f || !back || Math.abs(1200 * Math.log2(f / back)) > 150) continue;
    voicedFrames++;
    if (!m.f) { missed++; continue; }
    const c = Math.abs(1200 * Math.log2(m.f / f));
    if (c < 25) good++; else if (Math.abs(c - 1200) < 60 || Math.abs(c - 1902) < 60) octave++;
  }
  return { accuracy: good / voicedFrames, octaveErr: octave / voicedFrames, missed: missed / voicedFrames };
}

function lockTimes(sr, segs, out) {
  const res = [];
  let t = 0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (k > 0 && s.f) {
      const hit = out.find((m) => m.t > t && m.f && Math.abs(1200 * Math.log2(m.f / s.f)) < 50);
      res.push(hit ? (hit.t - t) * 1000 : NaN);
    }
    t += s.dur;
  }
  return res;
}

const sr = 48000;
const jumps = [];
const notes = [98, 147, 220, 330, 440, 196, 523, 131, 262, 87, 175, 349, 698, 110];
for (const f of notes) jumps.push({ f, dur: 0.4 });
const legato = jumps;
const staccato = notes.flatMap((f) => [{ f, dur: 0.3 }, { f: 0, dur: 0.1 }]);
// a singer really leaping an octave (and a fifth+octave) must be followed at once, not held at the old octave
const leaps = [110, 220, 440, 220, 110, 220, 330, 660, 330, 165, 494, 988, 494, 247, 123].map((f) => ({ f, dur: 0.4 }));

let failed = 0;
const configs = JSON.parse(process.argv[2] || '[{}]');
for (const cfg of configs) {
  console.log('config', JSON.stringify(cfg));
  for (const [name, segs, opt] of [
    ['legato clean', legato, {}],
    ['legato vibrato+noise', legato, { vibrato: 40, noise: 0.03 }],
    ['staccato vibrato+noise', staccato, { vibrato: 40, noise: 0.03 }],
    ['breathy (heavy noise)', legato, { vibrato: 30, noise: 0.12 }],
    ['weak fundamental', legato, { vibrato: 30, noise: 0.02, amps: [0.08, 1, 0.8, 0.5, 0.3, 0.2, 0.1, 0.05] }],
    ['loud 2nd harmonic', legato, { vibrato: 30, noise: 0.02, amps: [0.5, 1.4, 0.3, 0.2, 0.1, 0.05, 0, 0] }],
    ['rough (period jitter)', legato, { vibrato: 30, noise: 0.03, jitter: 0.03 }],
    ['octave leaps', leaps, { vibrato: 30, noise: 0.02 }],
    ['octave leaps, loud 2nd harm.', leaps, { vibrato: 30, noise: 0.02, amps: [0.5, 1.4, 0.3, 0.2, 0.1, 0.05, 0, 0] }],
    ['octave leaps, breathy', leaps, { vibrato: 30, noise: 0.12 }],
    ['octave leaps, weak fund.', leaps, { vibrato: 30, noise: 0.02, amps: [0.08, 1, 0.8, 0.5, 0.3, 0.2, 0.1, 0.05] }],
  ]) {
    const sig = voice(sr, segs, opt);
    const { out, cpu } = run(sr, sig, cfg);
    const s = score(sr, sig, out);
    const lt = lockTimes(sr, segs, out).filter((v) => !isNaN(v));
    const sorted = [...lt].sort((a, b) => a - b);
    console.log(`  ${name.padEnd(26)} acc ${(s.accuracy * 100).toFixed(1)}%  octave ${(s.octaveErr * 100).toFixed(1)}%  miss ${(s.missed * 100).toFixed(1)}%  ` +
      `lock median ${sorted[sorted.length >> 1].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms  cpu ${(cpu / (sig.x.length / sr) / 10).toFixed(1)}%`);
    // pass/fail limits for the shipped settings (README: 99.8-100%, no octave errors, ~8-11 ms median, 16-19 ms worst)
    if (!process.argv[2]) {
      const med = sorted[sorted.length >> 1], max = sorted[sorted.length - 1];
      if (s.accuracy < 0.99 || s.octaveErr > 0.005 || med > 14 || max > 25) { failed++; console.log(`  FAIL ${name}: below the accuracy/latency limits`); }
    }
  }
}
console.log(failed ? `bench: ${failed} FAILED` : 'bench: passed');
process.exitCode = failed ? 1 : 0;
