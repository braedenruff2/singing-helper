// Low-latency pitch detector running on the audio thread.
// YIN with an early exit: we stop scanning lags at the first dip below the
// threshold, so a typical sung note costs a few hundred lags, not the full range.
// Every HOP samples we analyse only the most recent W + maxLag samples.

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.minF = o.minF || 70;
    this.maxF = o.maxF || 1400;
    // First-dip threshold. 0.1 (was 0.15): on 40 real singers right note 97.4% -> 97.7%, octave errors 1.2% -> 1.1%,
    // nothing else changed; tests/bench.cjs identical (19 Nov). 0.08 was no better overall.
    this.threshold = o.threshold || 0.1;
    this.hop = o.hop || 128; // one render quantum = 2.7 ms at 48 kHz
    this.gate = o.gate || 0.008; // RMS below this = silence
    // Adaptive window: once we know the period, integrate over ~1.2 periods instead of
    // the worst case (lowest note). Shorter window = the new note fills it sooner.
    this.adaptive = o.adaptive !== false;
    this.winPeriods = o.winPeriods || 1.2;
    this.coldFrac = o.coldFrac || 1; // window (fraction of worst case) before a pitch is known
    // A reading without a clear dip is only shown if its best dip is below maxD. 0.4 showed a pitch in 11% of
    // real singers' breaths and silences; 0.25 shows it in 8% and loses 0.4% of sung frames (tests/real-voice.cjs).
    this.maxD = o.maxD || 0.25;
    // Octave continuity (see continuity()): on 40 real singers octave errors 2.5% -> 1.2%, right note 96.2% -> 97.4%.
    // contDown 0.5 held a real octave drop with a loud 2nd harmonic (tests/bench.cjs "octave leaps"); 0.4 doesn't.
    this.cont = o.cont !== undefined ? o.cont : true;
    this.contDown = o.contDown || 0.4;
    this.contUp = o.contUp || 0.8;
    this.contHold = o.contHold || 0.15;
    this.held = 0;
    this.dLen = 0; this.running = 0;
    this.prevTau = 0;
    this.misses = 0; // keep the short window through brief dropouts (e.g. mid note change)
    // Gentle low-pass before analysis: breath noise is broadband, the voice's strongest
    // harmonics sit lower. Two 1-pole stages at 2.5 kHz (~0.1 ms delay) fix most octave errors
    // on breathy singing (54% -> 99.8% in tests/bench.cjs).
    const fc = o.lowpass === undefined ? 2500 : o.lowpass;
    this.lpA = fc ? 1 - Math.exp((-2 * Math.PI * fc) / sampleRate) : 1;
    this.lp1 = 0; this.lp2 = 0;

    this.maxLag = Math.ceil(sampleRate / this.minF);
    this.minLag = Math.max(2, Math.floor(sampleRate / this.maxF));
    this.W = this.maxLag; // integration window: long enough for the lowest period
    this.size = this.W + this.maxLag + 2;
    this.buf = new Float32Array(this.size * 2); // doubled so a window is always contiguous
    this.write = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.d = new Float32Array(this.maxLag + 2);

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.threshold) this.threshold = m.threshold;
      if (m.gate !== undefined) this.gate = m.gate;
    };
  }

  push(x) {
    const n = x.length, size = this.size, buf = this.buf;
    const a = this.lpA;
    for (let i = 0; i < n; i++) {
      this.lp1 += a * (x[i] - this.lp1);
      this.lp2 += a * (this.lp1 - this.lp2);
      const v = this.lp2;
      buf[this.write] = v;
      buf[this.write + size] = v;
      this.write = (this.write + 1) % size;
    }
    this.filled = Math.min(size, this.filled + n);
  }

  detect() {
    const buf = this.buf, start = this.write; // oldest sample in ring
    const W = this.adaptive && this.prevTau
      ? Math.min(this.W, Math.max(this.minLag * 2, Math.ceil(this.prevTau * this.winPeriods)))
      : this.adaptive ? Math.ceil(this.W * this.coldFrac) : this.W;
    // RMS over the newest W samples (cheap voice gate)
    let e = 0;
    const s0 = start + this.size - W;
    for (let j = 0; j < W; j++) { const v = buf[s0 + j]; e += v * v; }
    const rms = Math.sqrt(e / W);
    if (rms < this.gate) { this.prevTau = 0; return { f: 0, conf: 0, rms }; }


    // Window = the newest samples; compare against the past by lag tau.
    // x[j] = buf[base + j], x[j - tau] in the past.
    const base = start + this.size - W;
    const d = this.d, minLag = this.minLag, maxLag = this.maxLag, th = this.threshold;
    let running = 0, tauFound = -1;
    d[0] = 1;
    for (let tau = 1; tau <= maxLag; tau++) {
      let sum = 0;
      const p = base - tau;
      for (let j = 0; j < W; j++) { const diff = buf[base + j] - buf[p + j]; sum += diff * diff; }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1; // cumulative mean normalised difference
      if (tauFound < 0 && tau > minLag && d[tau - 1] < th && d[tau] >= d[tau - 1]) {
        tauFound = tau - 1; // local minimum after crossing below threshold
        this.dLen = tau; this.running = running;
        break;
      }
    }
    if (tauFound < 0) { this.dLen = maxLag; this.running = running; }
    if (tauFound < 0) {
      // no confident dip; take the global minimum but report low confidence
      let best = minLag;
      for (let t = minLag; t <= maxLag; t++) if (d[t] < d[best]) best = t;
      if (d[best] > this.maxD) {
        if (++this.misses * this.hop > sampleRate * 0.05) this.prevTau = 0;
        return { f: 0, conf: 0, rms };
      }
      tauFound = best;
    }
    if (this.cont && this.prevTau) {
      const c = this.continuity(tauFound, base, W);
      // never hold the old octave for long: a real leap is followed after contHold seconds at worst
      if (c !== tauFound && ++this.held * this.hop <= sampleRate * this.contHold) tauFound = c;
      else if (c === tauFound) this.held = 0;
    } else this.held = 0;
    // parabolic interpolation for sub-sample period
    let t = tauFound;
    if (t > 1 && t < maxLag) {
      const a = d[t - 1], b = d[t], c = d[t + 1];
      const den = a + c - 2 * b;
      if (den !== 0) t = t + (a - c) / (2 * den);
    }
    this.prevTau = t;
    this.misses = 0;
    return { f: sampleRate / t, conf: 1 - d[tauFound], rms, win: W };
  }

  // Octave continuity: real singers' octave errors almost always start right after a correct reading
  // (tests/real-voice.cjs). If the new period is about twice / half the last one and the d curve also has a
  // good dip at the old period, keep the old octave.
  continuity(tau, base, W) {
    const d = this.d, r = tau / this.prevTau;
    const near = (c) => { // best local d around lag c (computing lags past the early exit if needed)
      const lo = Math.max(this.minLag, Math.floor(c) - 2), hi = Math.min(this.maxLag - 1, Math.ceil(c) + 2);
      if (hi <= lo) return -1;
      this.fill(hi + 1, base, W);
      let b = lo; for (let k = lo + 1; k <= hi; k++) if (d[k] < d[b]) b = k;
      return b;
    };
    if (r > 1.85 && r < 2.15) { // dropped an octave: is there a usable dip at half this period?
      const h = near(tau / 2);
      if (h > 0 && d[h] < this.contDown) return h;
    } else if (r > 0.46 && r < 0.54) { // jumped up an octave: is the dip at twice the period clearly deeper?
      const h = near(tau * 2);
      if (h > 0 && d[h] < d[tau] * this.contUp) return h;
    }
    return tau;
  }

  // d[] is filled up to this.dLen by detect(); extend it to lag n (same cumulative-mean normalisation).
  fill(n, base, W) {
    const buf = this.buf, d = this.d;
    for (let tau = this.dLen + 1; tau <= n; tau++) {
      let sum = 0;
      const p = base - tau;
      for (let j = 0; j < W; j++) { const diff = buf[base + j] - buf[p + j]; sum += diff * diff; }
      this.running += sum;
      d[tau] = this.running > 0 ? (sum * tau) / this.running : 1;
    }
    if (n > this.dLen) this.dLen = n;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.push(ch);
    this.sinceHop += ch.length;
    if (this.filled >= this.size && this.sinceHop >= this.hop) {
      this.sinceHop = 0;
      const r = this.detect();
      r.t = currentTime; // audio-clock time of the newest sample
      this.port.postMessage(r);
    }
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);

// Raw mic capture for latency calibration: posts each 128-sample block with its audio-clock time.
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage({ t: currentTime, x: ch.slice() });
    return true;
  }
}
registerProcessor('tap-processor', TapProcessor);
