import * as sp from './spotify.js';
import { fetchSyncedLyrics, parseUltraStar } from './lyrics.js';
import { melodyPitch, resetMelody } from './melody.js';

const $ = (id) => document.getElementById(id);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const PAST_MS = 2500, FUTURE_MS = 5000; // piano-roll window around "now"

const state = {
  ctx: null, node: null,
  pitch: null,          // latest {midi, f, conf, rms}
  trace: [],            // [{song, wall, midi}] recent user pitch points
  smoothMidi: 0,
  track: null,          // Spotify now-playing
  lyrics: null,         // [{t, end, text, words}]
  chart: null,          // UltraStar {notes, lines}
  manualClock: null,    // performance.now() when manual clock started
  offset: 0,
  key: 0,              // semitone shift applied to the chart
  outDelay: 0,          // ms between Spotify's reported position and what you hear (Bluetooth etc.)
  drone: null,          // MIDI of the reference tone, when on
  hits: new Map(),      // note index -> {good, total}
  ref: { pitch: null, trace: [], recent: [], hist: [] }, // live pitch of the captured song playback
};

// One context, made once its detector module has loaded. If loading fails (e.g. offline on a first visit) the next
// call tries again, instead of keeping a context with no detector (every Start mic then failed until a reload).
let ctxReady = null;
function audioCtx() {
  if (!ctxReady) ctxReady = makeCtx().catch((e) => { ctxReady = null; throw e; });
  return ctxReady;
}
async function makeCtx() {
  const ctx = new AudioContext({ latencyHint: 0 });
  try { await ctx.audioWorklet.addModule('pitch-worklet.js'); } catch (e) { ctx.close().catch(() => {}); throw e; }
  {
    state.ctx = ctx;
    // the browser can pause audio (sleep, another tab, a phone call); say so instead of silently freezing
    state.ctx.onstatechange = () => {
      if (state.ctx.state === 'running') { if (state.audioPausedMsg) { $('lat').textContent = state.audioPausedMsg; state.audioPausedMsg = null; } }
      else if (state.ctx.state !== 'closed' && state.node && !state.audioPausedMsg) { state.audioPausedMsg = $('lat').textContent; $('lat').textContent = 'Audio paused by the browser: click or press a key to carry on.'; }
    };
  }
  return state.ctx;
}
// any click or key resumes audio the browser paused
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { if (state.ctx && state.ctx.state !== 'running' && state.ctx.state !== 'closed') state.ctx.resume(); }, true); // 'suspended', or Safari's 'interrupted'

function pitchNode(ctx, src, opts, onMsg) {
  const node = new AudioWorkletNode(ctx, 'pitch-processor', { processorOptions: opts });
  node.port.onmessage = (e) => onMsg(e.data);
  src.connect(node);
  // Worklets only run while connected to the graph; route to a muted gain.
  const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
  return node;
}

// ---------------------------------------------------------------- mic
let micStarting = false;
async function startMic() {
  if (micStarting || state.node) return; // a double click would open the mic twice
  micStarting = true;
  try { await openMic(); } finally { micStarting = false; }
}

async function openMic() {
  // Every browser DSP stage adds buffering, so turn them all off.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, latency: 0 },
  });
  let ctx;
  try {
    ctx = await audioCtx();
    if (ctx.state !== 'running') await ctx.resume();
  } catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; } // don't leave the mic (and its indicator) on
  // the app went to the background while Android was asking for the mic: don't switch it on behind his back
  if (NATIVE && document.hidden) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.suspend().catch(() => {});
    $('lat').textContent = 'Mic stopped while the app was in the background. Tap Start mic.';
    return;
  }
  state.micStream = stream;
  state.micSrc = ctx.createMediaStreamSource(stream);
  state.micLatency = (stream.getAudioTracks()[0].getSettings().latency || 0.01) * 1000;
  state.node = pitchNode(ctx, state.micSrc, { minF: 70, maxF: 1400, hop: 128, gate: +$('gate').value }, onPitch);

  const track = stream.getAudioTracks()[0];
  const s = track.getSettings ? track.getSettings() : {};
  const parts = [`${(ctx.sampleRate / 1000).toFixed(1)} kHz`, `pitch updates every ${(128 / ctx.sampleRate * 1000).toFixed(1)} ms`, 'new notes lock in ~8–16 ms'];
  if (ctx.baseLatency) parts.push(`audio buffer ${(ctx.baseLatency * 1000).toFixed(1)} ms`);
  if (s.latency) parts.push(`device ${(s.latency * 1000).toFixed(1)} ms`);
  $('lat').textContent = parts.join(' · ');
  $('start').textContent = 'Mic on';
  $('start').disabled = true;
  // unplugged headset, Bluetooth switching, another app taking the mic: let Start mic open it again
  track.onended = () => stopMic('Mic disconnected. Click Start mic to use the current mic.');
}

function stopMic(msg) {
  try { if (state.micSrc && state.node) state.micSrc.disconnect(state.node); } catch (_) { /* already */ }
  try { if (state.node) state.node.disconnect(); } catch (_) { /* already */ }
  if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  state.node = state.micSrc = state.micStream = null;
  state.pitch = null; state.smoothMidi = 0; state.audioPausedMsg = null;
  $('start').textContent = 'Start mic'; $('start').disabled = false;
  $('lat').textContent = msg;
}

function onPitch(r) {
  const now = performance.now();
  // after a gap, the next note starts fresh: don't ease it toward the last note sung
  if (!r.f) { state.pitch = null; state.smoothMidi = 0; return; }
  let midi = 69 + 12 * Math.log2(r.f / 440);
  if ($('smooth').checked && state.smoothMidi && Math.abs(midi - state.smoothMidi) < 0.8) {
    midi = state.smoothMidi + 0.35 * (midi - state.smoothMidi); // no lag on note changes, only on wobble
  }
  state.smoothMidi = midi;
  state.pitch = { midi, f: r.f, conf: r.conf };
  const song = songPos();
  state.trace.push({ song, wall: now, midi, tgt: songTarget(song) });
  while (state.trace.length && now - state.trace[0].wall > PAST_MS + 500) state.trace.shift();
  if (song != null && state.chart && !songPaused()) scoreFrame(song, midi); // paused: humming or talking isn't scored
}

// ---------------------------------------------------------------- live song pitch
// Pitch-track the song itself from a shared browser tab (e.g. open.spotify.com).
// The full mix is noisier than a chart, but it works for any song.
// Look-ahead ("Show the song N s ahead"): the tab is muted and you hear it through this page N seconds
// late, so the pitch found now is drawn N seconds ahead of the now line, like a chart's notes.
// The delay lives only in the audio graph's memory; nothing is recorded or saved.
async function captureSong(stream) {
  const ahead = $('ahead').checked ? +$('ahead-s').value * 1000 : 0;
  if (!stream) {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome only offers tab audio alongside video
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: ahead > 0 },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include',
    });
  }
  const audio = stream.getAudioTracks()[0];
  if (!audio) { stream.getTracks().forEach((t) => t.stop()); throw new Error('No audio shared. Pick the Spotify tab and tick "Share tab audio".'); }
  stream.getVideoTracks().forEach((t) => t.stop()); // we only need the sound
  let ctx;
  try { ctx = await audioCtx(); } catch (err) { stream.getTracks().forEach((t) => t.stop()); throw err; } // don't leave the tab shared (and muted)
  // A full mix has no single period, so instead of YIN we look for the strongest
  // harmonic series in the spectrum (predominant melody, usually the lead vocal).
  const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
  const src = ctx.createMediaStreamSource(new MediaStream([audio]));
  src.connect(an);
  if (ahead) {
    if (ctx.state !== 'running') await ctx.resume();
    const dl = ctx.createDelay(5); dl.delayTime.value = ahead / 1000;
    src.connect(dl).connect(ctx.destination);
    state.refDelay = dl;
  }
  state.lookAhead = ahead;
  state.refSrc = src;
  const spec = new Float32Array(an.frequencyBinCount);
  const binHz = ctx.sampleRate / an.fftSize;
  resetMelody();
  state.refTimer = setInterval(() => { an.getFloatFrequencyData(spec); onRefPitch(melodyPitch(spec, binHz)); }, 20);
  state.refNode = an;
  audio.onended = stopCapture;
  state.refTrack = audio;
  $('capture').textContent = 'Stop song pitch';
}

function stopCapture() {
  if (state.refTrack) state.refTrack.stop();
  if (state.refNode) state.refNode.disconnect();
  if (state.refSrc) state.refSrc.disconnect();
  if (state.refDelay) state.refDelay.disconnect();
  clearInterval(state.refTimer);
  state.refTrack = state.refNode = state.refSrc = state.refDelay = null;
  state.lookAhead = 0;
  state.ref.pitch = null; state.ref.trace = [];
  $('capture').textContent = 'Live song pitch';
}

// the live song pitch trails the audio by about half the FFT window plus the median filter
const REF_DELAY_MS = 90;
const lookAheadMs = () => (state.refTrack && state.lookAhead) || 0;
// ms between Spotify's reported position and what you hear: speakers/Bluetooth, plus the look-ahead delay
const heardDelay = () => (state.track ? state.outDelay + lookAheadMs() : 0);

// the song pitch you're hearing right now (with look-ahead, the one found lookAhead ms ago)
function refHeardNow() {
  const la = lookAheadMs();
  if (!la) return state.ref.pitch ? state.ref.pitch.midi : null;
  const tr = state.ref.trace, t = performance.now() - la;
  let lo = 0, hi = tr.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tr[mid].wall <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k >= 0 && t - tr[k].wall < 60 ? tr[k].midi : null;
}

function onRefPitch(midi) {
  const ref = state.ref, now = performance.now();
  // median of the last 5 frames (100 ms): a mix flickers between voice and instruments
  ref.recent.push(midi == null ? NaN : midi);
  if (ref.recent.length > 5) ref.recent.shift();
  const good = ref.recent.filter((m) => !isNaN(m)).sort((a, b) => a - b);
  ref.pitch = good.length >= 3 ? { midi: good[good.length >> 1] } : null;
  if (ref.pitch) ref.trace.push({ wall: now, midi: ref.pitch.midi });
  while (ref.trace.length && now - ref.trace[0].wall > PAST_MS + lookAheadMs() + 500) ref.trace.shift();
  // song-time history (without the offset) for auto-sync
  const song = songPos();
  if (song != null && ref.pitch) {
    // the tab capture hears the song before you do (speaker delay, and the look-ahead), so undo that here
    const early = (state.track ? state.outDelay : 0) + lookAheadMs();
    ref.hist.push({ raw: song - state.offset + early - REF_DELAY_MS, midi: ref.pitch.midi });
    while (ref.hist.length && ref.hist[ref.hist.length - 1].raw - ref.hist[0].raw > 30000) ref.hist.shift();
    if (ref.hist.length > 1600) ref.hist.splice(0, ref.hist.length - 1500); // looping a line never spans 30 s
  }
}

// Find the offset that best lines the chart up with what the singer is actually singing.
function autoSync() {
  const hist = state.ref.hist;
  if (!state.chart) return 'Load or make a chart first.';
  if (hist.length < 150) return 'Turn on Live song pitch and let a few lines of singing play first.';
  const score = (off) => {
    let hit = 0;
    for (const p of hist) {
      // the song is heard in its own key: compare with the chart before the key shift
      const t = targetAt(p.raw + off), tgt = t == null ? null : t - (state.key || 0);
      if (tgt != null) { const d = ((p.midi - tgt) % 12 + 12) % 12; if (d < 0.5 || d > 11.5) hit++; }
    }
    return hit / hist.length;
  };
  let best = 0, bestScore = -1;
  const scores = [];
  for (let off = -3000; off <= 3000; off += 20) {
    const sc = score(off); scores.push(sc);
    if (sc > bestScore) { bestScore = sc; best = off; }
  }
  scores.sort((a, b) => a - b);
  const median = scores[scores.length >> 1];
  if (bestScore < 0.2 || bestScore < median * 1.5) return `Couldn't find a clear match (best ${Math.round(bestScore * 100)}% of the singing). Try again during a clearer vocal part.`;
  setOffset(best);
  return `Synced: offset ${best > 0 ? '+' : ''}${best} ms (${Math.round(bestScore * 100)}% of the singer's pitch lines up with the notes).`;
}

function setOffset(ms) {
  state.offset = ms;
  $('offset').value = ms; $('offset-v').textContent = ms;
  try {
    localStorage.setItem('offset', String(ms));
    if (state.track && !state.exerciseMode) localStorage.setItem('offset_' + state.track.id, String(ms)); // charts differ per song
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- loop a line
async function jumpTo(song) {
  // Spotify position that you'll hear as `song`. Don't add the speaker/look-ahead delay: Spotify starts playing
  // `raw` now and you hear it that much later, so the lead-in would be cut short by the delay.
  let raw = song - state.offset;
  if (state.track && !state.exerciseMode) {
    raw = Math.max(0, raw); // Spotify can't go before the start (a line near 0:00): the clock must not either
    const tr = state.track, at = performance.now();
    const from = tr.isPlaying ? tr.progressMs + (at - tr.at) : tr.progressMs; // where Spotify was before the seek
    await sp.seek(raw);
    if (!state.track) return;
    state.track.progressMs = raw; state.track.at = performance.now();
    state.seekGuard = { until: state.track.at + 5000, from, fromAt: at };
  } else if (state.manualClock != null) {
    state.manualClock = performance.now() - raw;
  }
}

function toggleLoop() {
  if (state.loop) { state.loop = null; $('loop').textContent = 'Loop line'; return; }
  const lines = shown.lines, l = lines && lines[shown.i];
  if (!l) return;
  const words = lineWords(l);
  const last = words.length ? words[words.length - 1].end : l.end;
  state.loop = { start: l.t, end: Math.max(l.t + 1000, last), busy: false };
  $('loop').textContent = 'Stop loop';
}

// also when the page isn't drawn (Spotify's window in front pauses requestAnimationFrame): the loop still jumps back
setInterval(() => { if (state.loop) checkLoop(songPos()); }, 100);
function checkLoop(song) {
  const lp = state.loop;
  if (!lp || lp.busy || song == null || song < lp.end + 500) return;
  lp.busy = true;
  jumpTo(lp.start - 1500)
    .catch((e) => { state.loop = null; $('loop').textContent = 'Loop line'; alert(e.message); })
    .finally(() => { lp.busy = false; });
}

// ---------------------------------------------------------------- progress over time
const SESSION = Date.now();
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem('history') || '[]');
    // an older or damaged value must not stop the summary from opening
    return Array.isArray(h) ? h.filter((r) => r && Number.isFinite(r.pct) && Number.isFinite(r.at)) : [];
  } catch (_) { return []; }
}
// a saved number, or `d` when it's missing or not a number (damaged storage must not turn the song clock into NaN)
function num(v, d = 0) { return v != null && v !== '' && Number.isFinite(+v) ? +v : d; }

function saveSession() {
  let good = 0, tot = 0, near = 0, sum = 0;
  for (const h of state.hits.values()) { tot++; if (h.good / h.total > 0.5) good++; near += h.near; sum += h.sum; }
  const song = state.exerciseMode ? state.chart.title || 'Exercise' : (state.track && state.track.name) || state.chart.title || 'Your chart';
  const hist = loadHistory().filter((r) => !(r.session === SESSION && r.song === song));
  hist.push({ session: SESSION, at: Date.now(), song, pct: good / tot, notes: tot, bias: near ? sum / near : 0 });
  try { localStorage.setItem('history', JSON.stringify(hist.slice(-200))); } catch (_) { /* ignore */ }
}

function showHistory(add) {
  const hist = loadHistory().filter((r) => r.notes >= 5);
  if (hist.length < 2) return;
  add('h3', 'Your recent practice');
  const ul = add('ul', '');
  for (const r of hist.slice(-6).reverse()) {
    const li = document.createElement('li');
    li.textContent = `${new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}  ${r.song}: ${Math.round(r.pct * 100)}%`;
    ul.append(li);
  }
  // trend: last 5 sessions vs the 5 before
  const pcts = hist.map((r) => r.pct);
  if (pcts.length >= 6) {
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const recent = avg(pcts.slice(-5)), before = avg(pcts.slice(-10, -5));
    const d = Math.round((recent - before) * 100);
    add('p', d > 2 ? `Up ${d} points on your earlier sessions. Nice.` : d < -2 ? `Down ${-d} points on your earlier sessions (harder songs count too).` : 'Holding steady compared with your earlier sessions.');
  }
}

// ---------------------------------------------------------------- practice summary
// Vibrato on held notes: smooth the cents trace, count crossings of its own mean.
// "Hear it, sing it back": per note to sing (every one already past `upTo`, sung or not), did he find it, how long it
// took (first moment he then stayed within 50¢ for 150 ms, from the note's start; a glide through it doesn't count)
// and how far off he was otherwise. Returns null when there's nothing to report.
const HOLD_MS = 150;
function echoStats(notes, hits, upTo) {
  const out = [];
  for (const n of notes) {
    if (n.listen || n.free) continue;
    const h = hits.get(n.i);
    if (!h && !(upTo != null && n.t + n.dur <= upTo)) continue; // not reached yet
    let found = null, runStart = null;
    const tr = h ? h.trace : [];
    for (let i = 0; i + 1 < tr.length; i += 2) {
      if (Math.abs(tr[i + 1]) < 50) {
        if (runStart == null) runStart = tr[i];
        if (tr[i] - runStart >= HOLD_MS) { found = Math.max(0, runStart - n.t); break; }
      } else runStart = null;
    }
    out.push({ k: n.i, midi: n.midi, ok: !!h && h.good / h.total > 0.5, found, off: h && h.near ? h.sum / h.near : null });
  }
  if (!out.length) return null;
  out.sort((a, b) => a.k - b.k);
  const times = out.filter((x) => x.found != null).map((x) => x.found).sort((a, b) => a - b);
  return { notes: out, matched: out.filter((x) => x.found != null).length, median: times.length ? times[Math.floor(times.length / 2)] : null };
}
function noteName(m) { return NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1); }

function vibratoStats(hits) {
  let long = 0, count = 0, rate = 0, depth = 0;
  for (const h of hits.values()) {
    const tr = h.trace, n = tr.length / 2;
    if (n < 80) continue;
    const dur = (tr[tr.length - 2] - tr[0]) / 1000;
    if (dur < 0.6) continue;
    long++;
    const c = [];
    for (let i = 0; i < n; i++) {
      let s = 0, k = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { s += tr[2 * j + 1]; k++; }
      c.push(s / k);
    }
    const mean = c.reduce((a, b) => a + b, 0) / n;
    let cross = 0;
    for (let i = 1; i < n; i++) if ((c[i - 1] - mean) * (c[i] - mean) < 0) cross++;
    const sorted = [...c].sort((a, b) => a - b);
    const d = (sorted[Math.floor(n * 0.95)] - sorted[Math.floor(n * 0.05)]) / 2;
    const r = cross / 2 / dur;
    if (r >= 3.5 && r <= 9 && d >= 12) { count++; rate += r; depth += d; }
  }
  if (!long) return null;
  return { long, count, rate: count ? rate / count : 0, depth: count ? depth / count : 0 };
}

function showSummary() {
  if ($('summary').open) return;
  const box = $('summary-body');
  box.textContent = '';
  const add = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; box.append(el); return el; };
  if (!state.chart || !state.hits.size) {
    add('p', 'Sing along with a chart (loaded, generated or the warm-up) and the summary fills in here.');
  } else {
    const notes = state.chart.notes;
    let good = 0, tot = 0, near = 0, sum = 0, sq = 0;
    const perLine = state.chart.lines.map((l) => ({ text: l.text, good: 0, tot: 0, near: 0, sum: 0, sq: 0 }));
    for (const [k, h] of state.hits) {
      const n = notes[k];
      const li = state.chart.lines.findIndex((l) => n.t >= l.t && n.t < l.end);
      const ok = h.good / h.total > 0.5;
      tot++; good += ok; near += h.near; sum += h.sum; sq += h.sq;
      if (li >= 0) { const L = perLine[li]; L.tot++; L.good += ok; L.near += h.near; L.sum += h.sum; L.sq += h.sq; }
    }
    const bias = near ? sum / near : 0;
    const spread = near ? Math.sqrt(Math.max(0, sq / near - bias * bias)) : 0;
    add('p', `${Math.round((100 * good) / tot)}% of ${tot} notes on pitch.`, 'big');
    add('p', Math.abs(bias) < 8 ? `No overall flat/sharp tendency (${Math.round(bias) || 0}¢ on average).`
      : `You tend to sing ${bias < 0 ? 'flat' : 'sharp'}: ${Math.abs(bias).toFixed(0)}¢ on average.`);
    add('p', `Steadiness: notes wobble ±${spread.toFixed(0)}¢ around your average (under ±20¢ is very steady; vibrato raises it).`);
    const vib = vibratoStats(state.hits);
    if (vib) add('p', vib.count
      ? `Vibrato on ${vib.count} of ${vib.long} long notes: about ${vib.rate.toFixed(1)} wobbles per second, ±${vib.depth.toFixed(0)}¢ deep (classical singers sit around 5–7 per second).`
      : `No vibrato on your ${vib.long} long notes (straight tone).`);
    const echo = state.chart.echo ? echoStats(notes, state.hits, songPos()) : null;
    if (echo) {
      add('p', `Pitch matching: you found ${echo.matched} of ${echo.notes.length} notes` + (echo.median != null ? `, usually within ${(echo.median / 1000).toFixed(1)} s of starting.` : '.'));
      const miss = echo.notes.filter((x) => x.found == null || x.found > 600 || !x.ok);
      if (miss.length) {
        add('h3', 'Notes to work on');
        const ul = add('ul', '');
        miss.slice(0, 6).forEach((x) => {
          const li = document.createElement('li');
          const offTxt = x.off != null && Math.abs(x.off) >= 15 ? `mostly ${x.off < 0 ? 'flat' : 'sharp'} by ${Math.abs(x.off).toFixed(0)}¢` : '';
          li.textContent = noteName(x.midi) + ': ' + (!x.ok && offTxt ? offTxt : x.found != null ? `found it after ${(x.found / 1000).toFixed(1)} s` : !x.ok && x.off == null ? 'not sung' : 'not matched');
          ul.append(li);
        });
      } else add('p', 'Every note found quickly. Try it with the key moved up or down (Key +/−) to stretch your range.');
    }
    const rows = echo ? [] : perLine.filter((L) => L.tot).map((L) => ({ ...L, pct: L.good / L.tot, b: L.near ? L.sum / L.near : 0 }));
    const weak = rows.filter((L) => L.pct < 0.9);
    if (rows.length && !weak.length) add('p', 'Every line you sang was at least 90% on pitch.');
    if (weak.length) {
      add('h3', 'Lines to work on');
      const ul = add('ul', '');
      weak.sort((a, b) => a.pct - b.pct).slice(0, 5).forEach((L) => {
        const li = document.createElement('li');
        li.textContent = `${Math.round(L.pct * 100)}%  “${L.text || '…'}”` + (Math.abs(L.b) >= 15 ? ` (${L.b < 0 ? 'flat' : 'sharp'} ${Math.abs(L.b).toFixed(0)}¢)` : '');
        ul.append(li);
      });
    }
  }
  if (state.chart && state.hits.size) saveSession();
  showHistory(add);
  $('summary').showModal();
}



// ---------------------------------------------------------------- output delay calibration
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function click(ctx, t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 2000;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6, t + 0.001); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  o.connect(g).connect(state.clickOut || ctx.destination); o.start(t); o.stop(t + 0.04); // clickOut: test hook
}

// Speakers: play clicks and find them in the mic signal. Returns output delay in ms.
async function measureWithMic() {
  if (!state.micSrc) throw new Error('Start the mic first.');
  const ctx = state.ctx;
  const tap = new AudioWorkletNode(ctx, 'tap-processor');
  const blocks = [];
  tap.port.onmessage = (e) => blocks.push(e.data);
  const mute = ctx.createGain(); mute.gain.value = 0;
  const src = state.micSrc;
  src.connect(tap); tap.connect(mute).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.6, gap = 0.45, n = 8;
  for (let i = 0; i < n; i++) click(ctx, t0 + i * gap);
  await sleep((0.6 + n * gap + 0.6) * 1000);
  try { src.disconnect(tap); } catch (_) { /* already gone */ }
  tap.disconnect();
  if (state.micSrc !== src) throw new Error('Mic disconnected during the test: start the mic and try again.');
  const sr = ctx.sampleRate;
  // noise floor from the quiet lead-in
  const quiet = [];
  for (const b of blocks) if (b.t < t0 - 0.05) for (const v of b.x) quiet.push(Math.abs(v));
  quiet.sort((a, b) => a - b);
  const floor = quiet.length ? quiet[Math.floor(quiet.length * 0.99)] : 0.01;
  const th = Math.max(0.02, floor * 4);
  const delays = [];
  for (let i = 0; i < n; i++) {
    const ts = t0 + i * gap;
    let hit = null;
    for (const b of blocks) {
      if (b.t + 128 / sr < ts || b.t > ts + gap * 0.9) continue;
      for (let k = 0; k < b.x.length && hit == null; k++) if (Math.abs(b.x[k]) > th && b.t + k / sr >= ts) hit = b.t + k / sr;
      if (hit != null) break;
    }
    if (hit != null) delays.push((hit - ts) * 1000);
  }
  state.calDelays = delays.slice(); // for debugging
  if (delays.length < 5) throw new Error("Couldn't hear the clicks. With headphones on, use the tap test instead.");
  delays.sort((a, b) => a - b);
  // the round trip includes the mic's own input delay; take that off
  return Math.max(0, delays[delays.length >> 1] - (state.micLatency ?? 10));
}

// Headphones: tap along with clicks; your taps line up with when you hear them.
async function measureWithTaps() {
  const ctx = await audioCtx();
  if (ctx.state !== 'running') await ctx.resume();
  const t0 = ctx.currentTime + 0.8, gap = 0.6, n = 12;
  for (let i = 0; i < n; i++) click(ctx, t0 + i * gap);
  state.tapClicks = { t0, gap, n }; // lets tests tap on time
  const taps = [];
  const onTap = (e) => { if (e.type === 'pointerdown' || e.code === 'Space' || e.key === 't') { e.preventDefault(); taps.push(ctx.currentTime); } };
  addEventListener('keydown', onTap, true);
  const btn = $('tap-pad'); btn.hidden = false; btn.addEventListener('pointerdown', onTap);
  await sleep((0.8 + n * gap + 0.4) * 1000);
  removeEventListener('keydown', onTap, true); btn.removeEventListener('pointerdown', onTap); btn.hidden = true;
  // match each tap to the nearest click, skip the first 4 while you find the beat
  const d = [];
  for (const t of taps) {
    const i = Math.round((t - t0) / gap);
    if (i >= 4 && i < n) d.push((t - (t0 + i * gap)) * 1000);
  }
  if (d.length < 5) throw new Error('Not enough taps. Press Space (or the Tap button) on every click.');
  d.sort((a, b) => a - b);
  return Math.max(0, d[d.length >> 1]);
}

function setOutDelay(ms) {
  state.outDelay = Math.round(ms);
  $('outdelay-v').textContent = state.outDelay;
  try { localStorage.setItem('outDelay', String(state.outDelay)); } catch (_) { /* ignore */ }
}

let calibrating = false;
async function runCalibration(fn, label) {
  if (calibrating) return; // a second click would play a second click train and match the wrong taps
  calibrating = true;
  const st = $('cal-status');
  st.textContent = label;
  try { const ms = await fn(); setOutDelay(ms); st.textContent = `Output delay set to ${Math.round(ms)} ms.`; }
  catch (e) { st.textContent = e.message; }
  finally { calibrating = false; }
}

// ---------------------------------------------------------------- reference tones
let droneOsc = null, guide = null, guideStarting = false;
function toneVoice(ctx) {
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
  g2.gain.value = 0.3; o2.connect(g2).connect(g);
  o.connect(g); g.gain.value = 0; g.connect(ctx.destination);
  o.start(); o2.start();
  return {
    set(midi, on) {
      const f = 440 * Math.pow(2, (midi - 69) / 12), t = ctx.currentTime;
      if (midi != null) { o.frequency.setTargetAtTime(f, t, 0.005); o2.frequency.setTargetAtTime(2 * f, t, 0.005); }
      g.gain.setTargetAtTime(on ? 0.12 : 0, t, 0.02);
    },
    stop() { g.gain.setTargetAtTime(0, ctx.currentTime, 0.02); setTimeout(() => { o.stop(); o2.stop(); }, 200); },
  };
}

let droneStarting = false;
async function toggleDrone() {
  if (droneStarting) return; // a double click while the audio starts would leave a second drone playing
  if (droneOsc) { droneOsc.stop(); droneOsc = null; state.drone = null; $('drone').textContent = 'Drone'; return; }
  droneStarting = true;
  try {
    const ctx = await audioCtx(); if (ctx.state !== 'running') await ctx.resume();
    state.drone = +$('drone-note').value;
    droneOsc = toneVoice(ctx); droneOsc.set(state.drone, true);
    $('drone').textContent = 'Stop drone';
  } finally { droneStarting = false; }
}

// guide tone: plays the chart's melody so you can learn it (use headphones)
// Echo exercises ("Hear it, sing it back"): the page plays each listen note, then stays quiet while you sing it back,
// whether or not the guide tone is on (hearing it while you sing would make it a copy, not pitch matching).
function listenAt(song) {
  if (!state.chart || !state.chart.echo || song == null) return null;
  const n = state.chart.notes[noteIndexAt(song)];
  return n && n.listen && song >= n.t && song < n.t + n.dur ? n.midi : null;
}
async function updateGuide(song) {
  const echo = !!(state.chart && state.chart.echo);
  const want = (echo || $('guide').checked) && state.chart && song != null && !songPaused() && !document.hidden; // paused Spotify / hidden page: no endless tone
  if (!want) { if (guide) { guide.stop(); guide = null; } return; }
  if (!guide) {
    // frames keep coming while the audio context starts; make only one voice
    if (guideStarting) return;
    guideStarting = true;
    try { guide = toneVoice(await audioCtx()); } finally { guideStarting = false; }
  }
  // the tone is heard outDelay ms after it's played (calibrated: Bluetooth, speakers): play it that much early
  const t = echo ? listenAt(song + (state.outDelay || 0)) : targetAt(song);
  guide.set(t, t != null);
}
// the tone is set from the drawing loop, which stops when the page is hidden: never leave it sounding then
setInterval(() => { if (guide && document.hidden) updateGuide(songPos()); }, 100);

// ---------------------------------------------------------------- song clock
function songPos() {
  const tr = state.exerciseMode ? null : state.track; // an exercise runs on its own clock, even with Spotify on
  if (tr) return (tr.isPlaying ? tr.progressMs + (performance.now() - tr.at) : tr.progressMs) + state.offset - heardDelay();
  if (state.manualClock != null) return performance.now() - state.manualClock + state.offset;
  return null;
}

function songPaused() { return !!(state.track && !state.exerciseMode && !state.track.isPlaying); }

// Fold a sung pitch into the octave of the target so any voice range can match.
let foldOn = true;
function fold(midi, target) {
  if (!foldOn) return midi;
  return midi - 12 * Math.round((midi - target) / 12);
}

function scoreFrame(song, midi) {
  const k = noteIndexAt(song);
  const n = state.chart.notes[k];
  if (!n || song >= n.t + n.dur || n.free) return;
  const h = state.hits.get(k) || { good: 0, total: 0, near: 0, sum: 0, sq: 0, trace: [] };
  const c = (fold(midi, n.midi) - n.midi) * 100;
  // song time went back (Loop line, a seek): keep only this pass, or vibrato is counted over several passes
  // (Spotify's small corrections can move the clock back up to ~100 ms: that's not a new pass)
  if (h.trace.length && song < h.trace[h.trace.length - 2] - 300) h.trace = [];
  if (h.trace.length < 2000) h.trace.push(song, c); // flat [t, cents, t, cents...] for vibrato analysis
  h.total++;
  if (Math.abs(c) < 50) h.good++;
  if (Math.abs(c) < 150) { h.near++; h.sum += c; h.sq += c * c; } // bias/steadiness ignore wrong notes
  state.hits.set(k, h);
}

// ---------------------------------------------------------------- drawing
const cv = $('roll');
const g = cv.getContext('2d');
let viewLo = 48, viewHi = 72; // MIDI range shown, eased toward what's on screen

function resize() {
  // the stage fills the window below the header, whose height changes when it wraps
  document.documentElement.style.setProperty('--hdr', document.querySelector('header').offsetHeight + 'px');
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
// the roll's box changes size with the layout (stage view, settings column, phone rotation)
if (window.ResizeObserver) { const ro = new ResizeObserver(resize); ro.observe(cv.parentElement); ro.observe(document.querySelector('header')); }

function frame() {
  requestAnimationFrame(frame);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  const song = songPos();
  const nowX = W * (PAST_MS / (PAST_MS + FUTURE_MS));
  const pxPerMs = W / (PAST_MS + FUTURE_MS);

  // pick vertical range from visible targets, else from the voice
  const visible = [];
  if (state.chart && song != null) {
    for (const n of state.chart.notes) if (n.t + n.dur > song - PAST_MS && n.t < song + FUTURE_MS && (!n.free || n.listen)) visible.push(n);
  }
  let lo, hi;
  if (visible.length) {
    lo = Math.min(...visible.map((n) => n.midi)) - 3; hi = Math.max(...visible.map((n) => n.midi)) + 3;
    // keep your own pitch dot on screen when you're a few notes off (it's folded to within 6 semitones)
    if (state.pitch) {
      const tg = songTarget(song), m = tg != null && foldOn ? fold(state.pitch.midi, tg) : state.pitch.midi;
      if (Math.abs(m - (lo + hi) / 2) < 24) { lo = Math.min(lo, m - 2); hi = Math.max(hi, m + 2); }
    }
  } else if (state.pitch || state.ref.pitch) {
    const m = (state.pitch || state.ref.pitch).midi;
    lo = m - 9; hi = m + 9;
  } else { lo = viewLo; hi = viewHi; }
  if (hi - lo < 14) { const c = (hi + lo) / 2; lo = c - 7; hi = c + 7; }
  viewLo += (lo - viewLo) * 0.08; viewHi += (hi - viewHi) * 0.08;
  const y = (m) => H - ((m - viewLo) / (viewHi - viewLo)) * H;
  const rowH = H / (viewHi - viewLo);

  g.clearRect(0, 0, W, H);
  // semitone grid
  g.font = '11px system-ui'; g.textBaseline = 'middle';
  for (let m = Math.floor(viewLo); m <= Math.ceil(viewHi); m++) {
    const pc = ((m % 12) + 12) % 12;
    const black = [1, 3, 6, 8, 10].includes(pc);
    g.fillStyle = black ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
    g.fillRect(0, y(m + 0.5), W, rowH - 1);
    if (pc === 0 || pc === 5 || pc === 9 || rowH > 16) {
      g.fillStyle = '#5b6375'; g.fillText(NAMES[pc] + (Math.floor(m / 12) - 1), 6, y(m));
    }
  }
  // now line
  g.fillStyle = 'rgba(94,234,212,0.5)'; g.fillRect(nowX - 1, 0, 2, H);

  // target notes (the song's melody, scrolling in from the right)
  if (song != null) {
    for (const n of visible) {
      const x0 = nowX + (n.t - song) * pxPerMs, x1 = nowX + (n.t + n.dur - song) * pxPerMs;
      const idx = n.i;
      const h = state.hits.get(idx);
      const active = song >= n.t && song < n.t + n.dur;
      if (n.listen) {
        // a note to listen to: outlined, not scored
        g.strokeStyle = '#94a3b8'; g.lineWidth = 2; g.globalAlpha = active ? 1 : 0.6;
        g.beginPath(); g.roundRect ? g.roundRect(x0, y(n.midi) - rowH * 0.42, Math.max(3, x1 - x0), rowH * 0.84, Math.min(6, rowH / 3)) : g.rect(x0, y(n.midi) - rowH * 0.42, Math.max(3, x1 - x0), rowH * 0.84);
        g.stroke(); g.globalAlpha = 1;
      } else {
        g.fillStyle = n.golden ? '#f59e0b' : (h && h.good / h.total > 0.5 ? '#22c55e' : '#6366f1');
        g.globalAlpha = active ? 1 : 0.75;
        roundRect(x0, y(n.midi) - rowH * 0.42, Math.max(3, x1 - x0), rowH * 0.84, Math.min(6, rowH / 3));
        g.globalAlpha = 1;
      }
      if (x1 - x0 > 14 && n.text.trim()) {
        g.fillStyle = '#e8eaf0'; g.fillText(n.text.trim(), x0 + 3, y(n.midi) - rowH * 0.9);
      }
    }
  }

  // the singer's pitch trace (wall-clock based so it scrolls even with no song)
  const now = performance.now();
  g.lineWidth = 3; g.lineJoin = 'round'; g.lineCap = 'round';
  const centre = (viewLo + viewHi) / 2;
  const place = (midi, tgt) => (tgt != null ? fold(midi, tgt) : foldOn && visible.length ? fold(midi, centre) : midi);
  // live song pitch (from the shared tab), drawn under your own trace
  g.strokeStyle = 'rgba(165,180,252,0.8)'; g.lineWidth = 5;
  let rp = null;
  const la = lookAheadMs(); // with look-ahead, what was found now is heard la ms from now
  for (const p of state.ref.trace) {
    const x = nowX - (now - la - p.wall) * pxPerMs;
    const yy = y(state.pitch && foldOn ? fold(p.midi, state.pitch.midi) : p.midi);
    if (rp && p.wall - rp.wall < 80 && Math.abs(yy - rp.y) < rowH * 4) { g.beginPath(); g.moveTo(rp.x, rp.y); g.lineTo(x, yy); g.stroke(); }
    rp = { wall: p.wall, x, y: yy };
  }
  g.lineWidth = 3;
  let prev = null;
  for (const p of state.trace) {
    const x = nowX - (now - p.wall) * pxPerMs;
    const yy = y(place(p.midi, p.tgt));
    const on = p.tgt != null && Math.abs(fold(p.midi, p.tgt) - p.tgt) < 0.5;
    if (prev && p.wall - prev.wall < 60 && Math.abs(yy - prev.y) < rowH * 4 && p.tgt === prev.tgt) {
      g.strokeStyle = on ? '#dcfce7' : '#f472b6';
      g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(x, yy); g.stroke();
    }
    prev = { wall: p.wall, x, y: yy, tgt: p.tgt };
  }
  if (state.pitch) {
    const tgt = songTarget(song);
    g.fillStyle = '#f472b6'; g.beginPath(); g.arc(nowX, y(place(state.pitch.midi, tgt)), 7, 0, Math.PI * 2); g.fill();
  }

  drawReadout(song);
  drawLyrics(song);
  checkLoop(song);
  updateGuide(song);
}

function roundRect(x, y0, w, h, r) {
  g.beginPath(); g.roundRect ? g.roundRect(x, y0, w, h, r) : g.rect(x, y0, w, h); g.fill();
}

// index of the last chart note starting at or before `song`
function noteIndexAt(song) {
  const notes = state.chart.notes;
  let lo = 0, hi = notes.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (notes[mid].t <= song) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k;
}

// what you should be singing now: the chart note, else the live song pitch
function songTarget(song) {
  const t = targetAt(song);
  if (t != null) return t;
  if (listenAt(song) != null) return null; // listening, not singing: no target from the drone or the song
  const heard = refHeardNow();
  if (heard != null) return heard;
  return state.drone;
}

function targetAt(song) {
  if (!state.chart || song == null) return null;
  const n = state.chart.notes[noteIndexAt(song)];
  return n && song < n.t + n.dur && !n.free ? n.midi : null;
}

// Write to the page only when something changed: the readout runs every frame.
const shownText = new Map();
function put(id, text, html) {
  if (shownText.get(id) === text) return;
  shownText.set(id, text);
  if (html) $(id).innerHTML = text; else $(id).textContent = text;
}

// "+12¢ vs C", or whole semitones when you're on another note: "3 semitones low vs C"
function centsLabel(cents, tgt) {
  const vs = tgt != null ? ' vs ' + NAMES[((Math.round(tgt) % 12) + 12) % 12] : '';
  if (tgt != null && Math.abs(cents) >= 50) {
    const st = Math.round(cents / 100);
    if (st) return `${Math.abs(st)} semitone${Math.abs(st) > 1 ? 's' : ''} ${st < 0 ? 'low' : 'high'}${vs}`;
  }
  const cr = Math.round(cents) || 0;
  return (cr > 0 ? '+' : '') + cr + '¢' + vs;
}

function drawReadout(song) {
  const p = state.pitch;
  const needle = $('needle');
  if (!p) {
    // not singing: don't leave the last reading up; name the note to sing when there is one
    const t = songTarget(song);
    put('note', '–'); put('hz', '– Hz'); put('cents', t != null ? 'sing ' + NAMES[((Math.round(t) % 12) + 12) % 12] : '');
    needle.style.opacity = 0.25; return;
  }
  const tgt = songTarget(song);
  // big letter is always what you're singing; the needle compares to the song's note when there is one
  const near = Math.round(p.midi);
  const cents = tgt != null ? (fold(p.midi, tgt) - tgt) * 100 : (p.midi - near) * 100;
  const pc = ((near % 12) + 12) % 12;
  put('note', `${NAMES[pc]}<sub>${Math.floor(near / 12) - 1}</sub>`, true);
  const c = Math.max(-50, Math.min(50, cents));
  needle.style.left = (50 + c) + '%';
  needle.style.opacity = 1;
  needle.style.background = Math.abs(cents) < 10 ? '#22c55e' : Math.abs(cents) < 25 ? '#eab308' : '#f472b6';
  put('cents', centsLabel(cents, tgt));
  put('hz', p.f.toFixed(1) + ' Hz');

  if (state.chart && state.hits.size) {
    let good = 0, tot = 0;
    for (const h of state.hits.values()) { tot++; if (h.good / h.total > 0.5) good++; }
    put('score', Math.round((good / tot) * 100) + '%  (' + good + '/' + tot + ' notes)');
  }
}

// Word timings for a line: real ones when the source has them, otherwise an estimate
// spread over a plausible sung length, weighted by characters.
function lineWords(l) {
  if (l._words) return l._words;
  let ws;
  if (l.words) {
    ws = l.words.map((w, k) => ({
      t: w.t, text: w.text,
      end: w.end != null ? w.end : (l.words[k + 1] ? l.words[k + 1].t : Math.min(l.end, w.t + 600)),
    }));
  } else {
    const parts = l.text.split(/(?<=\s)/);
    const chars = l.text.length || 1;
    const dur = Math.min((l.end - l.t) * 0.9, 400 + 110 * chars);
    let t = l.t;
    ws = parts.map((p) => { const d = (dur * p.length) / chars; const w = { t, end: t + d, text: p }; t += d; return w; });
  }
  return (l._words = ws);
}

let shown = { lines: null, i: -2 }, wordEls = [];
function drawLyrics(song) {
  // a chart made without lyrics has only blank lines: show the song's own lyrics then
  const lines = (state.chart && state.chart.lines && state.chart.lines.some((l) => l.text) && state.chart.lines) || state.lyrics;
  const curEl = $('lyr-cur'), nextEl = $('lyr-next'), cd = $('lyr-count');
  if (!lines || !lines.length || song == null) {
    if (shown.i !== -2) { curEl.textContent = ''; nextEl.textContent = ''; cd.textContent = ''; shown = { lines: null, i: -2 }; }
    return;
  }
  let i = lines.findIndex((l) => song < l.end);
  if (i < 0) i = lines.length - 1;
  // skip empty instrumental-gap lines: show the next sung line instead
  while (i < lines.length - 1 && !lines[i].text) i++;
  const cur = lines[i];
  if (shown.lines !== lines || shown.i !== i) {
    shown = { lines, i };
    curEl.textContent = '';
    wordEls = lineWords(cur).map((w) => {
      const el = document.createElement('span'); el.className = 'w'; el.textContent = w.text; el._p = -1;
      curEl.append(el); return el;
    });
    const next = lines.slice(i + 1).find((l) => l.text);
    nextEl.textContent = next ? next.text : '';
  }
  // smooth per-word wipe
  const ws = lineWords(cur);
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    const p = Math.round(Math.max(0, Math.min(1, (song - w.t) / Math.max(1, w.end - w.t))) * 200) / 2;
    if (p !== wordEls[k]._p) { wordEls[k]._p = p; wordEls[k].style.setProperty('--p', p + '%'); }
  }
  // countdown dots before a line that follows a long gap
  const wait = cur.t - song;
  let pi = i - 1;
  while (pi >= 0 && !lines[pi].text) pi--; // an empty gap marker isn't singing
  const prevEnd = pi >= 0 ? lineWords(lines[pi]).slice(-1)[0].end : 0;
  const dots = wait > 0 && wait < 3000 && cur.t - prevEnd > 2500 ? Math.ceil(wait / 1000) : 0;
  const txt = '●'.repeat(dots);
  if (cd.textContent !== txt) cd.textContent = txt;
  curEl.style.opacity = wait > 0 ? 0.6 : 1;
}

// ---------------------------------------------------------------- spotify
let polling = false, pollPauseUntil = 0;
let pollTimer = 0;
async function pollSpotify() {
  if (polling) return; // a slow answer must not be overtaken by (and then overwrite) a newer one
  if (NATIVE && document.hidden) return; // the phone app in the background: no Spotify calls (battery, data)
  if (performance.now() < pollPauseUntil) return; // Spotify said "too many requests"
  polling = true;
  try {
    const np = await sp.nowPlaying();
    $('sp-status').textContent = '';
    if (!np) {
      // Spotify answers "nothing" for a moment between devices, after an ad, or when it stops.
      // Keep the song's chart, lyrics and score: if the same song comes back, carry on with it.
      if (state.track || !state.shownId) $('np').innerHTML = '<span class="hint">Nothing playing</span>';
      state.track = null;
      return;
    }
    const old = state.track;
    const changed = state.shownId !== np.id;
    // Spotify's position comes with network jitter. Small disagreements are blended in
    // gradually so lyrics and notes don't twitch; real jumps (seeks) snap immediately.
    if (!changed && old && old.id === np.id && old.isPlaying && np.isPlaying) {
      const predicted = old.progressMs + (np.at - old.at);
      const diff = np.progressMs - predicted;
      // Just after we seek (Loop line), Spotify can still report the old position for a moment:
      // ignore answers far from where we jumped to, or the loop would fire again and stutter.
      const sg = state.seekGuard;
      const stale = sg && np.at < sg.until && Math.abs(np.progressMs - (sg.from + (np.at - sg.fromAt))) < 1000;
      if (stale && Math.abs(diff) > 1000) np.progressMs = predicted;
      else if (Math.abs(diff) < 500) np.progressMs = predicted + diff * 0.2;
    }
    state.track = np;
    if (changed) onTrackChange(np);
    else if (!old) showNowPlaying(np); // the same song is back after a gap
  } catch (e) {
    $('sp-status').textContent = e.message;
    if (e.retryAfterMs) pollPauseUntil = performance.now() + e.retryAfterMs;
    if (e.loggedOut) { // spotify.js logged out: stop polling, show Connect again
      clearInterval(pollTimer); pollTimer = 0;
      $('sp-setup').hidden = false; $('sp-on').hidden = true; $('clock-row').hidden = false;
    }
  } finally {
    polling = false;
  }
}

function showNowPlaying(np) {
  const el = $('np'); el.textContent = '';
  if (np.art) { const img = document.createElement('img'); img.src = np.art; img.alt = ''; el.append(img); }
  const box = document.createElement('div');
  const t = document.createElement('div'); t.className = 't'; t.textContent = np.name;
  const a = document.createElement('div'); a.className = 'a'; a.textContent = np.artist;
  box.append(t, a); el.append(box);
}

async function onTrackChange(np) {
  state.shownId = np.id;
  showNowPlaying(np);
  // during an exercise leave everything alone; leaving it loads this song's chart, key, offset and lyrics
  if (state.exerciseMode) return;
  state.hits.clear(); put('score', '–');
  state.ref.hist = []; state.loop = null; $('loop').textContent = 'Loop line';
  const savedOff = localStorage.getItem('offset_' + np.id);
  // offsets belong to a song's chart/lyrics; another song's offset would put this one out of sync
  setOffset(num(savedOff));
  state.lyrics = null;
  state.chart = loadChartFor(np.id);
  if (state.pendingChart) { // loaded while nothing was playing (or shown): it's for this song, over any older chart
    try { localStorage.removeItem('part_' + np.id); } catch (_) { /* ignore */ } // loaded while nothing was playing: it's for this song
    try { const c = parseUltraStar(state.pendingChart); c.src = state.pendingChart; state.chart = c; localStorage.setItem('chart_' + np.id, state.pendingChart); } catch (_) { /* shown, not saved */ }
  }
  state.pendingChart = null;
  showParts();
  setKey(Math.max(-12, Math.min(12, Math.round(num(localStorage.getItem('key_' + np.id))))));
  const looking = state.chart ? `Chart loaded for this song (${state.chart.notes.length} notes).` : 'No chart for this song yet. Looking up synced lyrics…';
  $('us-status').textContent = looking;
  // the lookup's answer replaces only its own "Looking up…" line, never a newer message (e.g. "Made … for <the
  // previous song>" from a chart that finished meanwhile)
  const stillOurs = () => $('us-status').textContent === looking;
  try {
    const lyrics = await fetchSyncedLyrics(np);
    if (state.shownId !== np.id) return; // the song changed while we waited: these lyrics are for the old one
    state.lyrics = lyrics;
    if (!state.chart && stillOurs()) $('us-status').textContent = state.lyrics ? 'Synced lyrics found (LRCLIB). Load an UltraStar chart to see the notes ahead.' : 'No synced lyrics found for this song.';
  } catch (_) {
    if (state.shownId === np.id && !state.chart && stillOurs()) $('us-status').textContent = 'Lyrics lookup failed.';
  }
}

function loadChartFor(id) {
  try {
    const t = localStorage.getItem('chart_' + id);
    if (!t) return null;
    const c = parseUltraStar(t, { part: num(localStorage.getItem('part_' + id)) || 1 });
    c.src = t;
    return c;
  } catch (_) { return null; }
}
// Duet charts: choose whose part to sing (remembered per Spotify track). Hidden for one-singer charts and exercises.
function showParts() {
  const c = state.chart, row = $('part-row');
  if (!c || !(c.parts > 1) || !c.src || state.exerciseMode) { row.hidden = true; return; }
  const sel = $('part');
  sel.innerHTML = '';
  c.partNames.forEach((name, i) => { const o = document.createElement('option'); o.value = String(i + 1); o.textContent = name; sel.appendChild(o); });
  sel.value = String(c.part || 1);
  row.hidden = false;
}
$('part').onchange = (e) => {
  const c = state.chart; if (!c || !c.src) return;
  const part = +e.target.value;
  try {
    const next = parseUltraStar(c.src, { part });
    next.src = c.src;
    state.chart = next;
    applyKey();
    state.hits.clear(); put('score', '–'); state.loop = null; $('loop').textContent = 'Loop line';
    if (state.track) try { localStorage.setItem('part_' + state.track.id, String(part)); } catch (_) { /* ignore */ }
    $('us-status').textContent = `Singing ${next.partNames[part - 1]} (${next.notes.length} notes).`;
  } catch (err) { $('us-status').textContent = err.message; }
  e.target.blur(); // keys (L/A/M…) go back to the app
};

// ---------------------------------------------------------------- wiring
$('start').onclick = () => startMic().catch((e) => {
  $('lat').textContent = 'Mic error: ' + e.message;
  // the phone app with the mic refused (Android stops asking after two refusals): offer its settings page
  if (NATIVE && NATIVE.openSettings && e.name === 'NotAllowedError') {
    $('lat').textContent = 'The app isn’t allowed to use the mic. ';
    const b = document.createElement('button'); b.id = 'mic-settings'; b.textContent = 'Open app settings';
    b.onclick = () => NATIVE.openSettings();
    $('lat').append(b);
  }
});
$('capture').onclick = () => (state.refTrack ? stopCapture() : captureSong().catch((e) => { if (e.name !== 'NotAllowedError') alert(e.message); }));
window.__captureSong = captureSong; // lets tests feed a synthetic stream
window.__songTarget = () => songTarget(songPos()); // for tests
$('fold').onchange = (e) => { foldOn = e.target.checked; };
$('gate').oninput = (e) => state.node && state.node.port.postMessage({ gate: +e.target.value });
$('offset').oninput = (e) => setOffset(+e.target.value);
$('loop').onclick = toggleLoop;
$('key-down').onclick = () => setKey((state.key || 0) - 1);
$('key-up').onclick = () => setKey((state.key || 0) + 1);
$('summary-btn').onclick = showSummary;
$('sync').onclick = () => { $('sync-status').textContent = autoSync(); };
$('clock').onclick = () => {
  if (state.exerciseMode) { leaveExercise(); return; }
  // a new clock is a new time base: old auto-sync samples would point at the wrong offset
  state.ref.hist = [];
  if (state.manualClock == null) { state.manualClock = performance.now(); $('clock').textContent = 'Stop clock'; state.hits.clear(); put('score', '–'); }
  else { state.manualClock = null; $('clock').textContent = 'Start clock'; }
};
// Key shift: move every chart note by whole semitones to suit your voice.
function applyKey() {
  if (!state.chart) return;
  const k = state.key || 0;
  for (const n of state.chart.notes) { if (n.orig == null) n.orig = n.midi; n.midi = n.orig + k; }
}
function setKey(k) {
  state.key = k;
  $('key-v').textContent = (k > 0 ? '+' : '') + k;
  applyKey();
  if (state.track && !state.exerciseMode) try { localStorage.setItem('key_' + state.track.id, String(k)); } catch (_) { /* ignore */ }
  // exercises share one key (moved to suit your voice once, it stays for every exercise)
  if (state.exerciseMode) try { localStorage.setItem('key_exercises', String(k)); } catch (_) { /* ignore */ }
}

// forTrack: the Spotify song the chart is for (default: the one playing now). A chart made for a song that has
// since ended is saved for that song only, not shown on the next one. Loaded with nothing playing while logged in:
// kept until Spotify reports a song, then saved for it (instead of being thrown away).
function useChart(text, label, forTrack) {
  // nothing playing for a moment (paused a while, ad, device switch) but a song still shown: the chart is for that song
  const shown = !state.track && state.shownId && !state.exerciseMode ? { id: state.shownId, name: $('np').querySelector('.t')?.textContent || 'that song' } : null;
  const tr = forTrack === undefined ? state.track || shown : forTrack;
  try {
    const chart = parseUltraStar(text);
    chart.src = text;
    if (tr && tr.id !== (state.track ? state.track.id : state.shownId)) {
      let ok = true;
      try { localStorage.setItem('chart_' + tr.id, text); localStorage.removeItem('part_' + tr.id); } catch (_) { ok = false; }
      $('us-status').textContent = ok ? `Made “${chart.title || label}” for “${tr.name}” (the song changed meanwhile): it loads when that song plays.`
        : `Made “${chart.title || label}” for “${tr.name}”, but couldn’t save it: browser storage is full.`;
      return;
    }
    if (state.exerciseMode) leaveExercise(); // back to the song's key and offset first
    state.chart = chart;
    state.pendingChart = null;
    if (state.track) try { localStorage.removeItem('part_' + state.track.id); } catch (_) { /* ignore */ }
    showParts();
    applyKey();
    state.hits.clear(); put('score', '–');
    const forId = state.track ? state.track.id : tr && tr.id === state.shownId ? tr.id : null;
    if (!state.track && forId) try { localStorage.removeItem('part_' + forId); } catch (_) { /* ignore */ }
    let saved = !!forId;
    if (forId) try { localStorage.setItem('chart_' + forId, text); } catch (_) { saved = false; }
    const waiting = !forId && sp.isLoggedIn();
    if (waiting) state.pendingChart = text;
    $('us-status').textContent = `Loaded “${state.chart.title || label}” (${state.chart.notes.length} notes)` +
      (saved ? ', saved for this Spotify track.' : forId ? ' (couldn’t save it for this song: browser storage is full).'
        : waiting ? '. Play the song on Spotify: it’s saved for the next song that starts.' : '. Press Start clock when the song starts.');
  } catch (err) { $('us-status').textContent = err.message; }
}
// ---------------------------------------------------------------- exercises
// Built-in warm-ups (examples/*.txt) on their own clock, with a short count-in. Works with or without Spotify.
let exerciseLoad = 0;
async function startExercise(file) {
  const ticket = ++exerciseLoad;
  const text = await (await fetch(file)).text();
  if (ticket !== exerciseLoad || $('exercise').value !== file) return; // changed your mind while it loaded
  const chart = parseUltraStar(text);
  // remember what to go back to when there's no Spotify song to reload it from
  if (!state.exerciseMode) state.preExercise = { chart: state.chart, key: state.key || 0, offset: state.offset, clock: state.manualClock };
  state.exerciseMode = true;
  state.chart = chart;
  showParts();
  let ek = 0; try { ek = Math.max(-12, Math.min(12, Math.round(+localStorage.getItem('key_exercises') || 0))); } catch (_) { /* ignore */ }
  setKey(ek);
  state.hits.clear(); put('score', '–'); state.loop = null; $('loop').textContent = 'Loop line'; state.ref.hist = [];
  state.manualClock = performance.now() - (chart.notes[0].t - 2000); // first note 2 s from now
  state.offset = 0; $('offset').value = 0; $('offset-v').textContent = '0'; // not saved: the song keeps its offset
  $('clock').textContent = 'Stop exercise';
  $('us-status').textContent = `Exercise: “${chart.title}” (${chart.notes.length} notes). ${chart.echo ? 'Listen to each outlined note, then sing it back' : 'Sing along'}; Y for the summary. Pick “—” to go back to the song.`;
}

function leaveExercise() {
  if (!state.exerciseMode) { $('exercise').value = ''; return; }
  exerciseLoad++;
  state.exerciseMode = false;
  $('exercise').value = '';
  const pre = state.preExercise || { chart: null, key: 0, offset: 0, clock: null };
  state.preExercise = null;
  state.hits.clear(); put('score', '–'); state.loop = null; $('loop').textContent = 'Loop line'; state.ref.hist = [];
  state.manualClock = pre.clock;
  $('clock').textContent = state.manualClock == null ? 'Start clock' : 'Stop clock';
  if (sp.isLoggedIn()) {
    // reload the song's chart, key, offset and lyrics now, or when Spotify next reports a song
    state.shownId = null; state.chart = null; state.lyrics = null;
    if (state.track) onTrackChange(state.track);
    else $('us-status').textContent = 'Back to the song: waiting for Spotify.';
  } else {
    state.chart = pre.chart; setKey(pre.key); setOffset(pre.offset); showParts();
    $('us-status').textContent = state.chart ? `Back to “${state.chart.title || 'your chart'}”.` : 'No chart loaded.';
  }
}

$('exercise').onchange = (e) => {
  if (!e.target.value) { leaveExercise(); return; }
  startExercise(e.target.value).catch((err) => { $('us-status').textContent = 'Could not load the exercise: ' + err.message; });
};

$('usfile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = ''; // picking the same (edited) file again still loads it
  useChart(await readText(f), f.name);
};
// UltraStar charts are often saved as Windows-1252 (ANSI), not UTF-8: try UTF-8 strictly, else read it as ANSI
async function readText(f) {
  const b = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) { return new TextDecoder('windows-1252').decode(b); }
}

// "Make notes from audio": only when the page is served by tools/server.py
fetch('api/health').then((r) => r.ok && r.json()).then((j) => { if (j && j.ok) $('gen').hidden = false; }).catch(() => {});
$('genfile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 200 * 1024 * 1024) { $('gen-status').textContent = 'That file is over 200 MB; use a smaller copy of the song (an mp3 is fine).'; e.target.value = ''; return; }
  const tr = state.track;
  const q = new URLSearchParams({ name: f.name, artist: tr ? tr.firstArtist || '' : '', title: tr ? tr.name : '' });
  const st = $('gen-status');
  const t0 = performance.now();
  const tick = setInterval(() => { st.textContent = `Separating vocals and tracking pitch… ${Math.round((performance.now() - t0) / 1000)} s (a few minutes on CPU)`; }, 1000);
  e.target.disabled = true;
  try {
    const r = await fetch('api/chart?' + q, { method: 'POST', body: f });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    useChart(j.chart, f.name, tr);
    st.textContent = `Made ${j.notes} notes` + (j.lyrics ? ' with lyrics.' : ' (no lyrics found: play the song on Spotify first so the title is known).');
  } catch (err) {
    st.textContent = 'Could not make notes: ' + err.message;
  } finally { clearInterval(tick); e.target.disabled = false; e.target.value = ''; }
};

const toggleStage = (on) => {
  const st = document.body.classList.toggle('stage', on);
  $('stage').textContent = st ? 'Show settings' : 'Stage view';
};
$('stage').onclick = () => { toggleStage(); resize(); };
// a dropdown keeps focus after a pick, and typing a letter would pick another option: let go of it
addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') e.target.blur(); });
// keyboard shortcuts (ignored while typing)
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') { toggleStage(); resize(); }
  else if (k === 'escape' && document.body.classList.contains('stage') && !$('summary').open) { toggleStage(false); resize(); }
  else if (k === 'l') toggleLoop();
  else if (k === 'y') showSummary();
  else if (k === 'd') toggleDrone();
  else if (k === 'a') $('sync').click();
  else if (k === 'm' && !state.node) $('start').click();
});
$('cal-mic').onclick = () => runCalibration(measureWithMic, 'Listening for clicks… keep quiet.');
$('cal-tap').onclick = () => runCalibration(measureWithTaps, 'Tap Space (or the Tap button) on every click you hear…');
$('cal-reset').onclick = () => { setOutDelay(0); $('cal-status').textContent = 'Output delay cleared.'; };
$('drone').onclick = toggleDrone;
$('drone-note').onchange = (e) => { if (droneOsc) { state.drone = +e.target.value; droneOsc.set(state.drone, true); } };
for (let m = 43; m <= 79; m++) {
  const o = document.createElement('option'); o.value = m; o.textContent = NAMES[m % 12] + (Math.floor(m / 12) - 1);
  if (m === 57) o.selected = true;
  $('drone-note').append(o);
}
{ const od = localStorage.getItem('outDelay'); if (od) setOutDelay(num(od)); }
// remember the settings panel between visits
const PREF_IDS = ['fold', 'smooth', 'guide', 'gate', 'drone-note', 'ahead', 'ahead-s'];
function savePrefs() {
  const p = {};
  for (const id of PREF_IDS) { const el = $(id); p[id] = el.type === 'checkbox' ? el.checked : el.value; }
  try { localStorage.setItem('prefs', JSON.stringify(p)); } catch (_) { /* ignore */ }
}
try {
  const p = JSON.parse(localStorage.getItem('prefs') || '{}');
  for (const id of PREF_IDS) {
    if (!(id in p)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!p[id]; else el.value = p[id];
  }
  foldOn = $('fold').checked;
} catch (_) { /* ignore */ }
for (const id of PREF_IDS) $(id).addEventListener('change', savePrefs);
// ---------------------------------------------------------------- phone app (android/: the same page in a WebView)
// window.SHAndroid is there only inside the phone app. There: no offline service worker (the files are inside the app),
// no tab-audio features (phones can't share another app's audio), app updates in the side panel, and the mic is
// let go when the app is in the background.
const NATIVE = window.SHAndroid || null;
function updState() { try { return NATIVE && NATIVE.updateStatus ? JSON.parse(NATIVE.updateStatus()) : null; } catch (_) { return null; } }
function updHtml() {
  const u = updState(); if (!u) return '';
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = u.checked ? new Date(u.checked).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  let h = '<h2>App updates</h2><p class="hint">Version ' + esc(u.version) + '. New versions download by themselves from GitHub and install when you leave the app.</p>';
  if (!u.allowed) h += '<p><b>One-time step:</b> let Singing Helper install its own updates.</p><div class="row"><button class="primary" id="upd-allow">Allow updates</button></div>';
  if (u.ready) h += '<p>Version ' + esc(u.readyName) + ' is downloaded.' + (u.allowed ? ' It installs when you leave the app, or now:' : '') + '</p>' +
    (u.allowed ? '<div class="row"><button class="primary" id="upd-install">Update now (the app restarts)</button></div>' : '');
  else h += '<p class="hint">' + (u.busy ? 'Checking…' : 'Up to date as of ' + esc(when) + '.') + '</p>';
  if (u.error) h += '<p class="hint">Last check: ' + esc(u.error) + '</p>';
  return h + '<div class="row"><button id="upd-check"' + (u.busy ? ' disabled' : '') + '>Check now</button></div>';
}
let updRetry = 0;
function drawUpdates() {
  const box = $('updates'); if (!box) return;
  box.innerHTML = updHtml();
  // right after the Spotify login comes back, Android may not know yet that this is our page: ask again shortly
  if (!box.innerHTML && updRetry < 5) { updRetry++; setTimeout(drawUpdates, 400); return; }
  updRetry = 0;
  const c = $('upd-check'); if (c) c.onclick = () => { NATIVE.updateCheck(); c.disabled = true; c.textContent = 'Checking…'; };
  const a = $('upd-allow'); if (a) a.onclick = () => NATIVE.updateAllow();
  const i = $('upd-install'); if (i) i.onclick = () => { i.disabled = true; NATIVE.updateInstall(); };
}
if (NATIVE) {
  document.documentElement.classList.add('in-app');
  for (const id of ['capture', 'sync']) { const el = $(id); if (el) el.closest('.row').hidden = true; }
  for (const id of ['ahead', 'sync-status']) { const el = $(id); if (el) (el.closest('label') || el).hidden = true; }
  const hint = $('ahead') && $('ahead').closest('label') && $('ahead').closest('label').nextElementSibling; if (hint) hint.hidden = true;
  // Spotify's Google / Apple / Facebook buttons leave the app and can't come back: say so where he logs in
  const spHint = document.createElement('p'); spHint.className = 'hint'; spHint.id = 'sp-app-hint';
  spHint.textContent = 'In the app, log in with your Spotify email and password (Google / Apple / Facebook open the browser and can’t come back).';
  if ($('sp-setup')) $('sp-setup').append(spHint);
  const box = document.createElement('div'); box.id = 'updates'; document.querySelector('aside').append(box);
  window.SHUpdateState = drawUpdates;
  drawUpdates();
  // in the background the app lets go of the mic (and Android's mic indicator); Start mic again when you're back
  // and its audio (guide tone, drone) sleeps; it wakes when the app is back
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.node) stopMic('Mic stopped while the app was in the background. Tap Start mic.');
    const c = state.ctx;
    if (c && c.state !== 'closed') (document.hidden ? c.suspend() : c.resume()).catch(() => {});
  });
} else if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
$('ruri').textContent = location.origin + location.pathname;
$('cid').value = sp.getClientId();
$('sp-login').onclick = () => { sp.setClientId($('cid').value); sp.login().catch((e) => alert(e.message)); };
$('sp-logout').onclick = () => { sp.logout(); location.reload(); };
const savedOffset = localStorage.getItem('offset');
if (savedOffset && Number.isFinite(+savedOffset)) { $('offset').value = savedOffset; state.offset = +savedOffset; $('offset-v').textContent = savedOffset; }

(async () => {
  try { await sp.handleRedirect(); } catch (e) { alert('Spotify login failed: ' + e.message); }
  if (sp.isLoggedIn()) {
    $('sp-setup').hidden = true; $('sp-on').hidden = false; $('clock-row').hidden = true;
    pollSpotify(); pollTimer = setInterval(pollSpotify, 1500);
  }
})();

resize();
requestAnimationFrame(frame);
window.__state = state; // handy for debugging in the console
