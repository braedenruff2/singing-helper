// Karaoke on the TV (tv.html): UltraStar files read and written exactly, scoring, the lyric line on screen, and the
// small messages the phone sends to the TV with the singer's pitch. Plain functions, no DOM, so Node tests cover them.
import { parseUltraStar } from './lyrics.js';

// ---- UltraStar .txt, kept as written ------------------------------------------------------------------------
// parseUltraStar (lyrics.js) turns a chart into timed notes for singing; this keeps every header and event in order
// so a chart can be saved again unchanged (or with an edited header, e.g. #GAP after syncing).
// { head: [[KEY, value], ...], parts: [{ p: null|1|2, events: [{kind, beat, len, pitch, text} | {kind: '-', beat, next}] }] }
const NOTE = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?: (.*))?$/;
export function readUltraStar(text) {
  const head = [];
  const parts = [{ p: null, events: [] }];
  let cur = parts[0];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const i = line.indexOf(':');
      if (i > 0) head.push([line.slice(1, i).trim().toUpperCase(), line.slice(i + 1).trim()]);
      continue;
    }
    const pm = /^P\s*(\d+)\s*$/.exec(line);
    if (pm) {
      if (cur.p == null && !cur.events.length) parts.pop();
      cur = { p: +pm[1], events: [] }; parts.push(cur); continue;
    }
    if (line.startsWith('E')) break;
    const m = NOTE.exec(line);
    if (m) { cur.events.push({ kind: m[1], beat: +m[2], len: +m[3], pitch: +m[4], text: m[5] == null ? '' : m[5] }); continue; }
    const b = /^-\s+(-?\d+)(?:\s+(-?\d+))?/.exec(line);
    if (b) cur.events.push(b[2] != null ? { kind: '-', beat: +b[1], next: +b[2] } : { kind: '-', beat: +b[1] });
  }
  if (!head.some(([k]) => k === 'BPM')) throw new Error('Not a valid UltraStar file (no #BPM)');
  return { head, parts };
}
export function headValue(raw, key) { const h = raw.head.find(([k]) => k === key.toUpperCase()); return h ? h[1] : undefined; }
export function setHead(raw, key, value) {
  key = key.toUpperCase();
  const h = raw.head.find(([k]) => k === key);
  if (h) h[1] = String(value); else raw.head.push([key, String(value)]);
  return raw;
}
// One line per header and event, "E" at the end; the text after a note keeps its spaces (they mark word breaks).
export function writeUltraStar(raw) {
  const out = raw.head.map(([k, v]) => '#' + k + ':' + v);
  for (const part of raw.parts) {
    if (part.p != null) out.push('P' + part.p);
    for (const e of part.events) {
      if (e.kind === '-') out.push('- ' + e.beat + (e.next != null ? ' ' + e.next : ''));
      else out.push(e.kind + ' ' + e.beat + ' ' + e.len + ' ' + e.pitch + ' ' + (e.text || ''));
    }
  }
  out.push('E');
  return out.join('\n') + '\n';
}
// A timed chart ({notes: [{t, dur, midi, text, golden, free}], lines}) as an UltraStar file: 10 ms beats
// (#BPM:1500), #GAP at the first note, a line break before each new lyric line.
export function chartToUltraStar(chart, meta = {}) {
  const notes = (chart.notes || []).slice().sort((a, b) => a.t - b.t);
  if (!notes.length) throw new Error('No notes to save');
  const gap = Math.max(0, Math.round(notes[0].t));
  const beat = (ms) => Math.round((ms - gap) / 10);
  const starts = new Set((chart.lines || []).slice(1).map((l) => Math.round(l.t)));
  const head = [['TITLE', meta.title || chart.title || 'Untitled'], ['ARTIST', meta.artist || chart.artist || 'Unknown']];
  if (meta.mp3) head.push(['MP3', meta.mp3]);
  head.push(['BPM', '1500'], ['GAP', String(gap)]);
  const events = [];
  let prevEnd = null;
  for (const n of notes) {
    const b = beat(n.t);
    if (prevEnd != null && starts.has(Math.round(n.t))) events.push({ kind: '-', beat: Math.min(prevEnd, b) });
    events.push({ kind: n.free ? 'F' : n.golden ? '*' : ':', beat: b, len: Math.max(1, Math.round(n.dur / 10)), pitch: Math.round(n.midi) - 60, text: n.text || '' });
    prevEnd = b + Math.max(1, Math.round(n.dur / 10));
  }
  return writeUltraStar({ head, parts: [{ p: null, events }] });
}
export { parseUltraStar };

// ---- Scoring -----------------------------------------------------------------------------------------------
// Like the karaoke games: 10,000 points for every note sung right all the way through; golden notes count double;
// freestyle notes aren't scored. A frame counts as right when the sung pitch, moved into the note's octave (any voice
// fits), is within `tolerance` semitones (0.5 = the right note; Easy 1.5, Normal 0.75, Hard 0.5). Time-based: each
// pitch frame credits the time since the last one (at most 60 ms), so staying silent scores nothing.
export const LEVELS = { easy: 1.5, normal: 0.75, hard: 0.5 };
export function foldTo(midi, target) { return midi - 12 * Math.round((midi - target) / 12); }
export function hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }
export class Scorer {
  constructor(chart, opts = {}) {
    this.notes = chart.notes || [];
    this.tol = opts.tolerance != null ? opts.tolerance : LEVELS.normal;
    this.fold = opts.fold !== false;
    this.hit = new Float64Array(this.notes.length); // ms sung right, per note
    this.last = null; this.k = 0;
    let w = 0; for (const n of this.notes) if (!n.free) w += n.dur * (n.golden ? 2 : 1);
    this.weight = w;
  }
  noteAt(t) {
    const ns = this.notes;
    if (this.k >= ns.length || (ns[this.k] && ns[this.k].t > t)) this.k = 0; // a seek back
    while (this.k + 1 < ns.length && ns[this.k + 1].t <= t) this.k++;
    const n = ns[this.k];
    return n && t >= n.t && t < n.t + n.dur ? this.k : -1;
  }
  // t: song time (ms) the sound was sung at; midi: sung pitch or null for silence
  frame(t, midi) {
    const dt = this.last == null || t < this.last ? 0 : Math.min(60, t - this.last);
    this.last = t;
    if (midi == null || !isFinite(midi) || !dt) return null;
    const i = this.noteAt(t);
    if (i < 0) return null;
    const n = this.notes[i];
    if (n.free) return null;
    const m = this.fold ? foldTo(midi, n.midi) : midi;
    const ok = Math.abs(m - n.midi) <= this.tol;
    if (ok) this.hit[i] = Math.min(n.dur, this.hit[i] + dt);
    return { i, ok, off: m - n.midi };
  }
  noteScore(i) { const n = this.notes[i]; return n && n.dur ? this.hit[i] / n.dur : 0; }
  get points() {
    if (!this.weight) return 0;
    let s = 0;
    this.notes.forEach((n, i) => { if (!n.free) s += this.hit[i] * (n.golden ? 2 : 1); });
    return Math.round((10000 * s) / this.weight);
  }
  reset() { this.hit.fill(0); this.last = null; this.k = 0; }
}
export function rating(points) {
  return points >= 9000 ? 'Superstar' : points >= 7500 ? 'Lead singer' : points >= 6000 ? 'Rising star' : points >= 4000 ? 'Hero' : points >= 2000 ? 'Amateur' : 'Warming up';
}

// ---- How late the singer's pitch reaches the TV ----------------------------------------------------------------
// frames: [{t, midi}] with t = the song's time when each pitch arrived (no delay taken off). Tries delays 0..500 ms
// and keeps the one that puts the most pitches on the right note (any octave); null when there wasn't enough singing
// on notes to tell (or no delay stands out). Note changes are what give it away: a held note fits any delay.
export function estimateLag(chart, frames, opts = {}) {
  const notes = (chart.notes || []).filter((n) => !n.free && !n.listen);
  const voiced = frames.filter((f) => f.midi != null && isFinite(f.midi));
  if (!notes.length || voiced.length < (opts.min || 60)) return null;
  const tol = opts.tolerance != null ? opts.tolerance : 0.5;
  let k = 0;
  const at = (t) => { // the note sung at song time t (frames are in time order, so walk forward; restart on a step back)
    if (k >= notes.length || notes[k].t > t) k = 0;
    while (k + 1 < notes.length && notes[k + 1].t <= t) k++;
    const n = notes[k];
    return n && t >= n.t && t < n.t + n.dur ? n : null;
  };
  const hitsAt = (lag) => {
    k = 0;
    let hits = 0;
    for (const f of voiced) { const n = at(f.t - lag); if (n && Math.abs(foldTo(f.midi, n.midi) - n.midi) <= tol) hits++; }
    return hits;
  };
  let best = null, bi = 0;
  const scores = [];
  for (let lag = 0; lag <= 500; lag += 10) {
    const hits = hitsAt(lag);
    scores.push(hits);
    if (!best || hits > best.hits) { best = { lag, hits }; bi = scores.length - 1; }
  }
  if (best.hits < (opts.minHits || 40)) return null;
  const sorted = scores.slice().sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  if (best.hits < median * 1.1) return null; // flat: every delay fits about as well (held notes only)
  // the middle of the best plateau (several delays often fit equally well): only the run of near-best delays around
  // the best one, so two separate good spots (a quick trill fits at 0 and at 380 ms) aren't averaged into neither
  let lo = bi, hi = bi;
  while (lo > 0 && scores[lo - 1] >= best.hits * 0.98) lo--;
  while (hi < scores.length - 1 && scores[hi + 1] >= best.hits * 0.98) hi++;
  const lag = (lo + ((hi - lo + 1) >> 1)) * 10;
  const out = { lag, hits: scores[lag / 10], best: best.hits, frames: voiced.length };
  // how well the delay in use now fits: the caller offers a change only when the new one clearly fits better
  if (opts.current != null && isFinite(opts.current)) out.current = hitsAt(opts.current);
  return out;
}

// ---- The lyric lines on screen -------------------------------------------------------------------------------
// The line being sung (or coming up next) and the one after it; each word's share sung so far (for the wipe), and
// a countdown (0..1) while a line is still to come after a gap of more than 3 s.
export function lyricView(lines, t) {
  let cur = lines.findIndex((l) => l.end > t);
  if (cur < 0) return { cur: -1, next: -1, words: [], countdown: 0 };
  const l = lines[cur];
  const words = (l.words && l.words.length ? l.words : [{ t: l.t, end: l.end, text: l.text }]).map((w) => ({
    text: w.text,
    frac: t <= w.t ? 0 : t >= w.end ? 1 : (t - w.t) / (w.end - w.t),
  }));
  const p = cur > 0 ? lines[cur - 1] : null;
  const prevEnd = !p ? 0 : p.words && p.words.length ? p.words[p.words.length - 1].end : p.end;
  const countdown = t < l.t && l.t - prevEnd > 3000 ? Math.min(1, (l.t - t) / 3000) : 0;
  return { cur, next: cur + 1 < lines.length ? cur + 1 : -1, words, countdown };
}

// ---- Phone -> TV messages -----------------------------------------------------------------------------------
// One small JSON text per message (UDP datagram to the TV app, port 47321). The phone sends a pitch about 50 times a
// second while pitch mode is on: {"v":1,"type":"pitch","seq":n,"hz":220.5,"conf":0.92,"ms":123456} (hz 0 = not singing).
// "hello" asks the TV to answer with its name; the TV ignores anything it doesn't understand.
export const PORT = 47321;
// ms: when it was sung, on the phone's own clock (ms); the TV lines these up with its song so a burst of late
// Wi-Fi packets still lands at the right moments.
export function encodePitch(seq, hz, conf, ms) {
  const m = { v: 1, type: 'pitch', seq: seq >>> 0, hz: hz > 0 ? Math.round(hz * 100) / 100 : 0, conf: Math.round(Math.max(0, Math.min(1, conf || 0)) * 100) / 100 };
  if (ms != null && isFinite(ms) && ms >= 0) m.ms = Math.round(ms);
  return JSON.stringify(m);
}
export function decodeMessage(text) {
  if (typeof text !== 'string' || text.length > 512) return null;
  let m; try { m = JSON.parse(text); } catch (_) { return null; }
  if (!m || m.v !== 1 || typeof m.type !== 'string') return null;
  if (m.type === 'pitch') {
    const hz = +m.hz, conf = +m.conf, seq = +m.seq;
    if (!isFinite(hz) || hz < 0 || hz > 4000 || (hz > 0 && hz < 40) || !isFinite(conf) || conf < 0 || conf > 1 || !Number.isInteger(seq) || seq < 0) return null;
    const out = { type: 'pitch', seq, hz, conf };
    if (m.ms != null) { const ms = +m.ms; if (!isFinite(ms) || ms < 0) return null; out.ms = ms; }
    return out;
  }
  if (m.type === 'hello') return { type: 'hello', name: String(m.name || 'Phone').slice(0, 40) };
  return null;
}
// Pitch frames can arrive late or twice over Wi-Fi: keep only ones newer than the last (sequence numbers wrap).
export function newer(seq, last) { if (last == null) return true; const d = (seq - last) >>> 0; return d !== 0 && d < 0x80000000; }
