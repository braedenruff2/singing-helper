// Live song pitch on a busy mix: a vibrato "voice" with formants over chords, bass and hi-hats.
// Measures how often the drawn song pitch is right, missing, or flickers to an instrument.
// node tests/e2e/live-busy-mix.cjs
const { test } = require('./lib.cjs');

test('live-busy-mix', async ({ url, newPage, check }) => {
  const p = await newPage();
  await p.goto(url);
  if (process.env.MELODY_PARAMS) await p.evaluate(async (j) => Object.assign((await import('./melody.js')).PARAMS, JSON.parse(j)), process.env.MELODY_PARAMS);
  const r = await p.evaluate(async () => {
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const mix = ac.createGain(); mix.gain.value = 0.5; mix.connect(dest);
    const T0 = ac.currentTime + 0.3, NOTE = 0.45;
    // melody (MIDI) and chords (one per 4 melody notes)
    const melody = [64, 67, 69, 67, 64, 62, 60, 62, 64, 64, 64, 62, 62, 64, 67, 67, 69, 71, 72, 71, 69, 67, 64, 62];
    const chords = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55], [57, 60, 64], [53, 57, 60]];
    const hz = (m) => 440 * 2 ** ((m - 69) / 12);
    // voice: sawtooth + vibrato through three formant band-passes
    const v = ac.createOscillator(); v.type = 'sawtooth';
    const lfo = ac.createOscillator(); lfo.frequency.value = 5.5; const lg = ac.createGain(); lfo.connect(lg); lg.connect(v.detune); lg.gain.value = 30;
    const vg = ac.createGain(); vg.gain.value = 0;
    for (const [f, q, a] of [[700, 5, 1], [1200, 6, 0.6], [2600, 8, 0.35]]) { const b = ac.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; const g = ac.createGain(); g.gain.value = a * 2.2; v.connect(b).connect(g).connect(vg); }
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; const lpg = ac.createGain(); lpg.gain.value = 0.5; v.connect(lp).connect(lpg).connect(vg);
    vg.connect(mix);
    melody.forEach((m, i) => { const t = T0 + i * NOTE; v.frequency.setValueAtTime(hz(m), t); vg.gain.setValueAtTime(0.5, t + 0.02); vg.gain.setValueAtTime(0.15, t + NOTE - 0.04); });
    vg.gain.setValueAtTime(0, T0 + melody.length * NOTE);
    // chords: three sawtooth-ish pads (lowpassed), as loud together as the voice
    const pads = [0, 1, 2].map(() => { const o = ac.createOscillator(); o.type = 'sawtooth'; const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1500; const g = ac.createGain(); g.gain.value = 0.16; o.connect(f).connect(g).connect(mix); o.start(); return o; });
    const bass = ac.createOscillator(); bass.type = 'triangle'; const bg = ac.createGain(); bg.gain.value = 0.45; bass.connect(bg).connect(mix); bass.start();
    chords.forEach((c, i) => { const t = T0 + i * 4 * NOTE; c.forEach((m, k) => pads[k].frequency.setValueAtTime(hz(m), t)); bass.frequency.setValueAtTime(hz(c[0] - 12), t); });
    // hi-hats: short noise bursts on every half note-length
    const nb = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate); const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / 400);
    for (let k = 0; k < melody.length * 2; k++) { const s = ac.createBufferSource(); s.buffer = nb; const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000; s.connect(hp).connect(mix); s.start(T0 + k * NOTE / 2); }
    v.start(); lfo.start();
    await window.__captureSong(dest.stream);
    // sample the app's song pitch every 20 ms; truth is the melody note sounding REF delay earlier
    const out = [];
    await new Promise((res) => {
      const id = setInterval(() => {
        const t = ac.currentTime - T0 - 0.09; // REF_DELAY_MS
        const i = Math.floor(t / NOTE);
        if (t > melody.length * NOTE) { clearInterval(id); res(); return; }
        const inNote = i >= 0 && t - i * NOTE > 0.12 && t - i * NOTE < NOTE - 0.06; // skip transitions
        const rp = window.__state.ref.pitch;
        if (inNote) out.push({ want: melody[i], got: rp ? rp.midi : null });
      }, 20);
    });
    return out;
  });
  if (process.env.DUMP) console.log(r.filter((_, i) => i % 6 === 0).map((x) => x.want + ":" + (x.got == null ? "-" : x.got)).join(" "));
  const n = r.length;
  const right = r.filter((x) => x.got != null && Math.abs(x.got - x.want) < 0.75).length;
  // "Match any octave" is on by default and auto-sync compares note names, so an octave slip
  // (e.g. a pad doubling the voice an octave down) matters much less than a wrong note
  const octave = r.filter((x) => x.got != null && Math.abs(Math.abs(x.got - x.want) % 12 - 0) < 0.75 && Math.abs(x.got - x.want) >= 11).length;
  const missing = r.filter((x) => x.got == null).length;
  const wrong = n - right - octave - missing;
  let flips = 0;
  for (let i = 1; i < n; i++) if ((r[i].got == null) !== (r[i - 1].got == null) || (r[i].got != null && r[i - 1].got != null && Math.abs(r[i].got - r[i - 1].got) > 1.5 && r[i].want === r[i - 1].want)) flips++;
  const pc = (v) => `${(100 * v / n).toFixed(0)}%`;
  console.log(`busy mix: ${n} samples inside notes: right ${pc(right)}, octave off ${pc(octave)}, missing ${pc(missing)}, wrong note ${pc(wrong)}, flickers ${flips}`);
  // before 18 Nov 2026 this mix gave 0% right (the bass line was drawn instead of the voice)
  check('busy mix: right note (any octave) most of the time', (right + octave) / n >= 0.8, pc(right + octave));
  check('busy mix: right octave more often than not', right / n >= 0.6, pc(right));
  check('busy mix: wrong note rarely', wrong / n <= 0.2, pc(wrong));
  check('busy mix: little flicker', flips <= 12, flips);
});
