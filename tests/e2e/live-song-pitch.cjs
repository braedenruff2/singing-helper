// Live song pitch from a shared tab: a vocal-like melody over bass and noise should be tracked.
// node tests/e2e/live-song-pitch.cjs
const { test } = require('./lib.cjs');
test('live-song-pitch', async ({ url, newPage, check, shot }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url);
  await p.click('#start');
  const res = await p.evaluate(async () => {
    // fake "song": vocal-like melody + bass + noise, as a MediaStream
    const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
    const voice = ac.createOscillator(); voice.type = 'sawtooth';
    const vg = ac.createGain(); vg.gain.value = 0.25; const vf = ac.createBiquadFilter(); vf.type = 'lowpass'; vf.frequency.value = 2500;
    voice.connect(vf).connect(vg).connect(dest);
    const bass = ac.createOscillator(); bass.type = 'triangle'; bass.frequency.value = 55; const bg = ac.createGain(); bg.gain.value = 0.35; bass.connect(bg).connect(dest);
    const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate); const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.04;
    const ns = ac.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(dest);
    const melody = [196, 220, 247, 262, 294, 330, 349, 392];
    const t0 = ac.currentTime + 0.1;
    melody.forEach((f, i) => voice.frequency.setValueAtTime(f, t0 + i * 0.5));
    voice.start(); bass.start(); ns.start();
    await window.__captureSong(dest.stream);
    const got = [];
    await new Promise((r) => { let k = 0; const id = setInterval(() => { const rp = window.__state.ref.pitch; got.push(rp ? Math.round(440 * 2 ** ((rp.midi - 69) / 12)) : 0); if (++k >= 16) { clearInterval(id); r(); } }, 250); });
    return got;
  });
  const want = [196, 220, 247, 262, 294, 330, 349, 392].flatMap((f) => [f, f]);
  const right = res.filter((f, i) => f && Math.abs(12 * Math.log2(f / want[i])) < 0.6).length;
  check('melody tracked (at least 14 of 16 samples)', right >= 14, `${right}/16: ${res.join(',')}`);
  await shot(p, 'live-song-pitch.png');
  await p.click('#capture');
  check('Stop song pitch turns it off', (await p.evaluate(() => window.__state.ref.pitch)) == null && /Live song pitch/.test(await p.textContent('#capture')));
}, { mic: 'sing.wav' });
