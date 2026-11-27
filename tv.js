// Karaoke on the living-room TV (tv.html). The TV plays the song itself and shows the lyrics, big, with a wipe; with
// pitch bars on, the song's notes scroll past and the singer's pitch is drawn over them and scored. The pitch comes
// from the phone (Singing Helper app, mic plugged into it), which sends it over Wi-Fi to the Fire TV app; the app
// passes each message to SHTV.message(). Only one singer: the mic receiver mixes every mic into one signal, so for
// duets or groups turn pitch bars off and just sing.
// Songs: songs/index.json next to this page ([{"txt": "songs/x.txt", "audio": "songs/x.mp3"}]; "audio" defaults to
// the chart's #MP3 next to it), plus three warm-ups from examples/ (no audio; they run on a clock).
import { parseUltraStar, Scorer, LEVELS, foldTo, hzToMidi, rating, lyricView, decodeMessage, newer, estimateLag, uploadName } from './karaoke.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('tv_' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('tv_' + k, JSON.stringify(v)); } catch (_) { /* storage off: keep going */ } },
};
const WARMUPS = ['examples/warmup-scale.txt', 'examples/arpeggios.txt', 'examples/sustain.txt'];
const LAGS = [0, 40, 80, 120, 160, 200, 250, 300, 400, 500];
const NATIVE = window.SHTVAndroid || null;

const S = {
  songs: [], song: null, chart: null, scorer: null, screen: 'library',
  pitchOn: store.get('pitch', true), level: store.get('level', 'normal'), lag: store.get('lag', 120),
  clock: null,  // {base, at}: song ms at performance.now() = at (no audio, or between audio updates)
  paused: false, trail: [], raw: [], lastSeq: null, phone: null, lastMsg: 0, ended: false,
};

// ---------------------------------------------------------------- the phone's pitch
window.SHTV = {
  // text: one message from the phone (see karaoke.js); arrived: performance.now() when it came in (default now)
  message(text, arrived) {
    const m = decodeMessage(text);
    if (!m) return false;
    const now = arrived == null ? performance.now() : arrived;
    if (m.type === 'hello') { S.lastMsg = now; S.phone = m.name; status(); return true; }
    // the phone app restarted (its numbers start again) or went quiet for a while: a new session
    if (S.lastSeq != null && (now - S.lastMsg > 2000 || ((S.lastSeq - m.seq) >>> 0) < 0x80000000 && ((S.lastSeq - m.seq) >>> 0) > 500)) { S.lastSeq = null; S.phoneOff = null; }
    if (!newer(m.seq, S.lastSeq)) return false;
    S.lastSeq = m.seq; S.lastMsg = now; S.problem = null;
    if (!S.phone) { S.phone = 'phone'; status(); }
    if (m.hz > 0) S.heard = { hz: m.hz, at: now };
    pitch(m.hz, phoneToHere(m.ms, now));
    if (S.screen === 'library' && now - (S.statusAt || 0) > 250) { S.statusAt = now; status(); } // a few times a second is plenty
    return true;
  },
  // the Android back button: true when the page handled it
  back() { return back(); },
  // the TV app: songs were added from a PC; something went wrong listening for the phone
  songsChanged() { if (S.screen === 'library') loadLibrary().then(() => { if (S.screen === 'library') show('library'); }); else S.reload = true; },
  problem(text) { S.problem = String(text); status(); },
  // the TV app is leaving the screen (Home, another app): pause the song
  hide() { if (S.screen === 'sing' && !S.paused) togglePause(); },
  state: () => ({ screen: S.screen, points: S.scorer ? S.scorer.points : 0, song: S.song && S.song.title, pitchOn: S.pitchOn, t: songTime(), paused: S.paused }),
};
// When the phone says it was sung, on this page's clock: arrival minus the smallest delay seen lately (the packets that
// came straight through), so a burst of late packets still lands at the moments they were sung.
function phoneToHere(ms, now) {
  if (ms == null) return now;
  const off = now - ms;
  const o = S.phoneOff;
  if (!o || off < o.min || now - o.at > 3000) S.phoneOff = { min: off, at: now };
  else S.phoneOff.min += 0.002 * (off - o.min); // drift up slowly if the network gets slower for good
  return Math.min(now, ms + S.phoneOff.min);
}
function pitch(hz, arrived) {
  if (S.screen !== 'sing' || !S.pitchOn || S.paused || !S.scorer) return;
  const t = songTime(arrived) - S.lag;
  const midi = hz > 0 ? hzToMidi(hz) : null;
  if (S.raw.length < 30000) S.raw.push({ t: t + S.lag, midi }); // as it arrived: for working out the right Mic delay
  S.scorer.frame(t, midi);
  S.trail.push({ t, midi });
  if (S.trail.length > 400) S.trail.splice(0, S.trail.length - 400);
}
// Hosted on a home server instead of inside the TV app: ?ws=ws://host:port relays the phone's messages.
(function relay() {
  const u = new URLSearchParams(location.search).get('ws');
  if (!u || !/^wss?:\/\//.test(u)) return;
  let ws;
  const open = () => {
    try { ws = new WebSocket(u); } catch (_) { return; }
    ws.onmessage = (e) => window.SHTV.message(String(e.data));
    ws.onclose = () => setTimeout(open, 3000);
  };
  open();
})();

function status() {
  const el = $('status');
  const live = S.lastMsg && performance.now() - S.lastMsg < 4000;
  const info = NATIVE && NATIVE.info ? safeJson(NATIVE.info()) : null;
  el.className = live ? 'on' : '';
  // while choosing a song: what the phone hears right now, to check the mic before singing
  const hearing = live && S.heard && performance.now() - S.heard.at < 400 ? ' · hearing ' + noteName(hzToMidi(S.heard.hz)) : '';
  const add = $('add');
  add.textContent = info && info.upload ? 'Add songs: on a PC on the same Wi-Fi, open ' + info.upload + ' and type the code ' + info.code + '.' : '';
  if (S.problem) el.textContent = S.problem;
  else if (live) el.textContent = 'Phone mic connected' + (S.phone && S.phone !== 'phone' ? ' (' + S.phone + ')' : '') + hearing;
  else if (info && info.ip) el.textContent = 'Phone mic: on the phone, Karaoke on TV > ' + info.ip;
  else el.textContent = S.pitchOn ? 'Phone mic: not connected (pitch bars need the TV app)' : '';
}
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteName(midi) { const m = Math.round(midi); return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
setInterval(() => { if (S.screen === 'library') status(); }, 2000);

// ---------------------------------------------------------------- the song list
// Charts are often saved as Windows-1252 (ANSI), not UTF-8: UTF-8 strictly, else ANSI (as the PC page does).
async function getText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(url + ': ' + r.status);
  const b = await r.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) { return new TextDecoder('windows-1252').decode(b); }
}
// The TV app stores uploads under a safe name (TvFiles.safeName: odd characters become _); the chart's #MP3 line
// still has the original name, so the audio is looked up the same way.
function audioName(mp3) { return uploadName(mp3, NATIVE); }
async function loadLibrary() {
  const entries = [];
  try {
    const list = JSON.parse(await getText('songs/index.json'));
    if (Array.isArray(list)) for (const e of list) if (e && typeof e.txt === 'string') entries.push({ txt: e.txt, audio: typeof e.audio === 'string' ? e.audio : null });
  } catch (_) { /* no songs folder yet: warm-ups only */ }
  for (const w of WARMUPS) entries.push({ txt: w, audio: null, warmup: true });
  const songs = [];
  for (const e of entries) {
    try {
      const text = await getText(e.txt);
      const c = parseUltraStar(text);
      const mp3 = (/^#AUDIO:(.*)$/mi.exec(text) || /^#MP3:(.*)$/mi.exec(text) || [])[1]; // #AUDIO: UltraStar format 1.x
      const audio = e.warmup ? null : e.audio || (mp3 && mp3.trim() ? new URL(encodeURIComponent(audioName(mp3)), new URL(e.txt, location.href)).href : null);
      songs.push({ txt: e.txt, text, audio, title: c.title || e.txt.replace(/^.*\//, ''), artist: c.artist || '', warmup: !!e.warmup, parts: c.parts });
    } catch (_) { /* a bad chart is left out */ }
  }
  S.songs = songs;
  drawLibrary();
}
function drawLibrary() {
  const ol = $('songs');
  ol.innerHTML = '';
  S.songs.forEach((s, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.i = i;
    const best = store.get('best_' + s.txt, null);
    b.innerHTML = '<span class="t"></span><span class="a"></span><span class="best"></span>';
    b.querySelector('.t').textContent = (s.warmup ? 'Warm-up: ' : '') + s.title;
    b.querySelector('.a').textContent = s.artist;
    b.querySelector('.best').textContent = best != null ? 'best ' + best.toLocaleString() : '';
    b.onclick = () => start(s);
    li.appendChild(b); ol.appendChild(li);
  });
  controls();
  status();
}
function controls() {
  $('pitch').textContent = 'Pitch bars: ' + (S.pitchOn ? 'On' : 'Off');
  $('pitch').setAttribute('aria-pressed', String(S.pitchOn));
  $('level').textContent = 'Level: ' + S.level[0].toUpperCase() + S.level.slice(1);
  $('lag').textContent = 'Mic delay: ' + S.lag + ' ms';
}
$('pitch').onclick = () => { S.pitchOn = !S.pitchOn; store.set('pitch', S.pitchOn); controls(); status(); };
$('level').onclick = () => { const k = Object.keys(LEVELS); S.level = k[(k.indexOf(S.level) + 1) % k.length]; store.set('level', S.level); controls(); };
$('lag').onclick = () => { const i = LAGS.findIndex((x) => x > S.lag); S.lag = LAGS[i < 0 ? 0 : i]; store.set('lag', S.lag); controls(); }; // also from a measured value between steps

// ---------------------------------------------------------------- singing
const audio = $('audio');
function show(screen) {
  S.screen = screen;
  for (const id of ['library', 'sing', 'done']) $(id).hidden = id !== screen;
  document.body.classList.toggle('pitch-off', !S.pitchOn);
  // the song he last sang, found by its file (after songs are added the list holds new objects for the same songs)
  const at = S.song ? S.songs.findIndex((x) => x === S.song || x.txt === S.song.txt) : 0;
  const first = screen === 'library' ? (document.querySelector('#songs button[data-i="' + Math.max(0, at) + '"]') || $('pitch')) : screen === 'done' ? $('again') : null;
  if (first) first.focus();
}
function start(song) {
  S.song = song;
  S.chart = parseUltraStar(song.text);
  S.scorer = new Scorer(S.chart, { tolerance: LEVELS[S.level] || LEVELS.normal });
  S.trail = []; S.raw = []; S.paused = false; S.ended = false; $('paused').hidden = true;
  $('now').textContent = song.title + (song.artist ? ' · ' + song.artist : '');
  $('score').textContent = '0';
  $('line').dataset.cur = ''; $('line').textContent = ''; $('next').textContent = ''; // another song's words must not stay
  show('sing');
  resize();
  if (song.audio) {
    audio.src = song.audio;
    audio.currentTime = 0;
    S.clock = null;
    audio.play().catch((e) => { if (!(e && e.name === 'AbortError')) noAudio(song); }); // AbortError: paused or stopped while loading
  } else {
    audio.removeAttribute('src');
    S.clock = { base: 0, at: performance.now() };
  }
}
// Song time in ms. With audio: its currentTime, moved on smoothly between the element's coarse updates.
let anchor = { ct: -1, at: 0 };
function songTime(now) {
  const real = performance.now();
  now = now == null ? real : now;
  if (S.clock) return S.paused ? S.clock.base : S.clock.base + (now - S.clock.at);
  if (!S.song || !S.song.audio) return 0;
  const ct = audio.currentTime * 1000;
  // paused or not really playing yet (loading, just resumed): the element's time as it is, no running ahead
  // (the anchor is always the real present: a pitch sung earlier is placed back from it, below)
  if (audio.paused || audio.readyState < 3 || ct !== anchor.ct) anchor = { ct, at: real };
  const t = ct + Math.max(-250, Math.min(250, real - anchor.at));
  // a moment in the past (a pitch that arrived late in a Wi-Fi burst): that much before now, while the song plays
  return now < real && !audio.paused ? Math.max(0, t - (real - now)) : t;
}
// The song's audio won't play (missing file, a format the TV can't play): lyrics and bars run on the clock instead.
function noAudio(song) {
  if (S.song !== song || S.screen !== 'sing' || S.clock || S.ended) return;
  // the audio failed part way (Wi-Fi dropped the file): the words carry on from where it got to, not from the start
  const from = Math.max(0, (audio.currentTime || 0) * 1000) || 0;
  S.clock = { base: from, at: performance.now() };
  if (S.paused) S.clock = { base: from, at: 0 };
  $('now').textContent = song.title + ' · (no sound: the audio file didn’t play)';
}
audio.onerror = () => { if (S.song && S.song.audio && S.screen === 'sing') noAudio(S.song); };
function togglePause() {
  if (S.screen !== 'sing') return;
  S.paused = !S.paused;
  $('paused').hidden = !S.paused;
  if (S.clock) { if (S.paused) S.clock = { base: S.clock.base + (performance.now() - S.clock.at), at: 0 }; else S.clock.at = performance.now(); }
  else if (S.paused) audio.pause(); else audio.play().catch(() => {});
  S.scorer.last = null; // no credit for the paused time
}
function stopSong() { audio.pause(); S.clock = null; }
function finish() {
  if (S.ended) return;
  S.ended = true;
  stopSong();
  const pts = S.scorer.points, key = 'best_' + S.song.txt, best = store.get(key, null);
  if (S.pitchOn && (best == null || pts > best)) store.set(key, pts);
  $('done-title').textContent = S.song.title;
  $('final').textContent = S.pitchOn ? pts.toLocaleString() : '♪';
  $('rating').textContent = S.pitchOn ? rating(pts) : 'Nice singing';
  $('best').textContent = S.pitchOn ? (best == null || pts > best ? 'Your best for this song' : 'Your best: ' + best.toLocaleString()) : 'Pitch bars were off, so no score.';
  lagOffer();
  show('done');
}
// After a song: if the pitch clearly reached the TV later (or earlier) than Mic delay allows for, offer the delay that
// fits, with the score it would have given. One tap sets it for next time.
function lagOffer() {
  const box = $('lag-offer'); box.hidden = true; box.innerHTML = '';
  if (!S.pitchOn || !S.raw || !S.chart) return;
  const e = estimateLag(S.chart, S.raw, { current: S.lag });
  if (!e || Math.abs(e.lag - S.lag) < 40) return;
  if (e.current != null && e.current >= e.hits * 0.98) return; // the delay in use fits as well (a flat stretch): no offer
  const sc = new Scorer(S.chart, { tolerance: LEVELS[S.level] || LEVELS.normal });
  for (const f of S.raw) sc.frame(f.t - e.lag, f.midi);
  const now = new Scorer(S.chart, { tolerance: LEVELS[S.level] || LEVELS.normal });
  for (const f of S.raw) now.frame(f.t - S.lag, f.midi);
  if (sc.points <= now.points) return; // it wouldn't have scored more: keep his Mic delay
  const nice = Math.round(e.lag / 10) * 10;
  box.innerHTML = '<p>Your pitch reached the TV about <b>' + nice + ' ms</b> after the song (Mic delay is ' + S.lag + ' ms). With ' + nice + ' ms this would have scored ' + sc.points.toLocaleString() + '.</p>';
  const b = document.createElement('button'); b.id = 'lag-use'; b.textContent = 'Use ' + nice + ' ms from now on';
  b.onclick = () => { S.lag = nice; store.set('lag', nice); controls(); box.innerHTML = '<p>Mic delay set to ' + nice + ' ms.</p>'; $('again').focus(); };
  box.appendChild(b); box.hidden = false;
}
audio.onended = () => { if (S.screen === 'sing') finish(); };
// Home on the remote, or another app: the song pauses (it would keep playing over the home screen)
document.addEventListener('visibilitychange', () => { if (document.hidden && S.screen === 'sing' && !S.paused) togglePause(); });
$('again').onclick = () => start(S.song);
// (songs added meanwhile: the list reloads, and shows again only if he is still on it, not over a song he just started)
function toLibrary() { if (S.reload) { S.reload = false; loadLibrary().then(() => { if (S.screen === 'library') show('library'); }); } drawLibrary(); show('library'); }
$('back').onclick = toLibrary;
function back() {
  if (S.screen === 'sing') { stopSong(); toLibrary(); return true; }
  if (S.screen === 'done') { toLibrary(); return true; }
  return false; // the song list: leave the app
}

// ---------------------------------------------------------------- the remote
// Fire TV remotes send arrow keys, Enter (OK), Back (handled by the app: SHTV.back) and media keys.
document.addEventListener('keydown', (e) => {
  const k = e.key;
  // OK held a little long repeats: one press starts a song, it must not then pause and resume it
  if (e.repeat && (k === 'Enter' || k === ' ' || /^Media/.test(k))) { e.preventDefault(); return; }
  if (S.screen === 'sing') {
    if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { e.preventDefault(); togglePause(); }
    else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') { e.preventDefault(); back(); }
    return;
  }
  if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') { if (back()) e.preventDefault(); return; }
  if (!/^Arrow(Up|Down|Left|Right)$/.test(k)) return;
  const sec = $(S.screen);
  const all = Array.from(sec.querySelectorAll('button')).filter((b) => !b.hidden && b.offsetParent !== null);
  if (!all.length) return;
  e.preventDefault();
  let i = all.indexOf(document.activeElement);
  const fwd = k === 'ArrowDown' || k === 'ArrowRight';
  i = i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + (fwd ? 1 : -1)));
  all[i].focus();
  all[i].scrollIntoView({ block: 'nearest' });
});

// ---------------------------------------------------------------- drawing
const cv = $('bars'), g = cv.getContext('2d');
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(cv.clientWidth * dpr)); cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
}
window.addEventListener('resize', resize);
const BEFORE = 1500, AFTER = 4000; // ms of song shown behind and ahead of the "now" line
let lo = 55, hi = 72;
function frame() {
  requestAnimationFrame(frame);
  if (S.screen !== 'sing' || !S.chart) return;
  const t = songTime();
  const notes = S.chart.notes, last = notes[notes.length - 1];
  if (!S.ended && (!S.song.audio || S.clock) && t > last.t + last.dur + 1500) { finish(); return; } // on the clock (no audio, or it wouldn't play)
  // lyrics
  const v = lyricView(S.chart.lines, t);
  const line = $('line');
  if (line.dataset.cur !== String(v.cur)) {
    line.dataset.cur = String(v.cur);
    line.innerHTML = '';
    for (const w of v.words) { const s = document.createElement('span'); s.textContent = w.text; line.appendChild(s); }
    $('next').textContent = v.next >= 0 ? S.chart.lines[v.next].text : '';
  }
  Array.from(line.children).forEach((s, i) => { const f = v.words[i] ? v.words[i].frac : 0; s.style.setProperty('--p', (f * 100).toFixed(1) + '%'); });
  $('dots').textContent = v.countdown > 0 ? '•'.repeat(Math.ceil(v.countdown * 3)) : '';
  const total = last.t + last.dur;
  $('progress').firstElementChild.style.width = Math.max(0, Math.min(100, (t / total) * 100)).toFixed(1) + '%';
  if (S.pitchOn) { $('score').textContent = S.scorer.points.toLocaleString(); bars(t); }
}
function bars(t) {
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const from = t - BEFORE, to = t + AFTER;
  const vis = S.chart.notes.filter((n) => n.t + n.dur >= from && n.t <= to && !n.listen);
  if (vis.length) {
    const vlo = Math.min(...vis.map((n) => n.midi)) - 3, vhi = Math.max(...vis.map((n) => n.midi)) + 3;
    lo += (Math.min(vlo, vhi - 12) - lo) * 0.05; hi += (Math.max(vhi, vlo + 12) - hi) * 0.05;
  }
  const x = (ms) => ((ms - from) / (to - from)) * W;
  const y = (m) => H - ((m - lo) / (hi - lo)) * H;
  const bh = Math.max(6, H / (hi - lo) * 0.8);
  const nowX = x(t);
  g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(nowX - 1, 0, 2, H);
  for (const n of vis) {
    const i = S.chart.notes.indexOf(n), sc = S.scorer.noteScore(i);
    g.fillStyle = n.free ? 'rgba(169,177,214,0.35)' : n.golden ? '#fbbf24' : sc > 0.6 ? '#34d399' : '#7c8cff';
    g.globalAlpha = n.t + n.dur < t && sc < 0.3 && !n.free ? 0.45 : 1;
    roundRect(x(n.t), y(n.midi) - bh / 2, Math.max(4, x(n.t + n.dur) - x(n.t)), bh, bh / 2);
  }
  g.globalAlpha = 1;
  // the singer: dots over the last 1.5 s, moved into the octave of the note there (any voice fits)
  const r = Math.max(3, bh * 0.28);
  for (const p of S.trail) {
    if (p.midi == null || p.t < from || p.t > t + 100) continue;
    const k = S.scorer.noteAt(p.t), target = k >= 0 ? S.chart.notes[k].midi : (lo + hi) / 2;
    const m = foldTo(p.midi, target);
    const on = k >= 0 && Math.abs(m - target) <= (LEVELS[S.level] || 0.75);
    g.fillStyle = on ? '#ffffff' : '#f87171';
    g.beginPath(); g.arc(x(p.t), y(m), r, 0, Math.PI * 2); g.fill();
  }
}
function roundRect(x0, y0, w, h, rad) {
  rad = Math.min(rad, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x0 + rad, y0); g.arcTo(x0 + w, y0, x0 + w, y0 + h, rad); g.arcTo(x0 + w, y0 + h, x0, y0 + h, rad);
  g.arcTo(x0, y0 + h, x0, y0, rad); g.arcTo(x0, y0, x0 + w, y0, rad); g.closePath(); g.fill();
}
requestAnimationFrame(frame);

controls();
loadLibrary().then(() => show('library'));
