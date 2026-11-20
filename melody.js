// Predominant-melody pitch (usually the lead vocal) from one spectrum of a full song mix.
// A mix has no single period, so instead of YIN we look for the strongest harmonic series.
// Used by "Live song pitch" in app.js; a pure module so tests/melody.mjs can run it in Node.
//
// Plain harmonic sums favour low candidates in a busy mix (a bass note's "harmonics" collect the
// partials of the chord and the voice), so on 18 Nov 2026 five things were added, tuned on
// synthetic mixes and checked on a held-out set (tests/melody.mjs; held-out right 53% -> 100%):
//  - harmonic contrast: each partial counts only by how far it stands above the spectrum halfway
//    to its neighbours (a voice's partials stand alone; a dense chord fills the gaps),
//  - a gentle tilt toward higher candidates (the tune is usually the top line) and a stronger
//    penalty below MIDI 53 (F3, where bass lines live),
//  - prefer the octave above when it's nearly as strong,
//  - a small bonus for staying within a semitone of the last frame (less flicker).
// Later the same day: 12 equally weighted harmonics instead of 10 decaying ones (a voice much quieter than the band:
// 42% -> 72% right; others unchanged).

export const SAL_LO = 43, SAL_HI = 86, SAL_STEP = 0.25;
// tuning (tests may change these to compare settings)
export const PARAMS = { harm: 12, decay: 1, tilt: 0.2, lowPen: 0.5, lowEnd: 53, octUp: 0.7, keep: 0.15 };
const NCAND = Math.round((SAL_HI - SAL_LO) / SAL_STEP) + 1;

let mag = null, prev = null;
const sals = new Float32Array(NCAND);

// Forget the previous frame (call when a new capture starts).
export function resetMelody() { prev = null; }

// specDb: AnalyserNode.getFloatFrequencyData() output (dB); binHz: sampleRate / fftSize.
// Returns MIDI (quarter-semitone steps) or null.
export function melodyPitch(specDb, binHz) {
  const n = specDb.length;
  if (!mag || mag.length !== n) mag = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { mag[i] = Math.pow(10, specDb[i] / 40); mean += mag[i]; } // sqrt-magnitude
  mean /= n;
  if (mean < 1e-4) { prev = null; return null; }
  const { harm, decay, tilt, lowPen, lowEnd, octUp, keep } = PARAMS;
  let best = -1, bestK = 0, total = 0;
  for (let k = 0; k < NCAND; k++) {
    const m = SAL_LO + k * SAL_STEP;
    const f = 440 * Math.pow(2, (m - 69) / 12);
    let sal = 0, w = 1;
    for (let h = 1; h <= harm; h++, w *= decay) {
      const bin = Math.round((h * f) / binHz);
      if (bin + 1 >= n) break;
      const peak = Math.max(mag[bin - 1], mag[bin], mag[bin + 1]);
      const b1 = Math.round(((h - 0.5) * f) / binHz), b2 = Math.round(((h + 0.5) * f) / binHz);
      const valley = 0.5 * (b1 > 0 ? mag[b1] : 0) + 0.5 * (b2 < n ? mag[b2] : 0);
      sal += w * Math.max(0, peak - valley);
    }
    sal *= Math.pow(2, (tilt * (m - 64)) / 12);
    if (m < lowEnd) sal *= 1 - (lowPen * (lowEnd - m)) / (lowEnd - SAL_LO);
    if (prev != null && Math.abs(m - prev) <= 1) sal *= 1 + keep;
    sals[k] = sal; total += sal;
    if (sal > best) { best = sal; bestK = k; }
  }
  // a low winner whose octave above is nearly as strong: take the octave above (up to twice)
  for (let step = 0; step < 2; step++) {
    const up = bestK + Math.round(12 / SAL_STEP);
    let bu = -1, bk = -1;
    for (let d = -1; d <= 1; d++) if (up + d >= 0 && up + d < NCAND && sals[up + d] > bu) { bu = sals[up + d]; bk = up + d; }
    if (bk < 0 || bu < octUp * best) break;
    bestK = bk; best = Math.max(best, bu);
  }
  // voiced only when one harmonic series clearly stands out
  const r = best > 2.2 * (total / NCAND) ? SAL_LO + bestK * SAL_STEP : null;
  prev = r;
  return r;
}
