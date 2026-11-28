// Synced lyrics from LRCLIB (free, no key, CORS-enabled) and UltraStar note charts.

// ---- LRCLIB ---------------------------------------------------------------
export const MAX_DURATION_DIFF_S = 10;
// a hung request (flaky Wi-Fi, after sleep) would leave "Looking up synced lyrics…" for the whole song
const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});
export async function fetchSyncedLyrics({ name, firstArtist, album, durationMs }) {
  const base = 'https://lrclib.net/api/';
  const q = new URLSearchParams({
    track_name: name, artist_name: firstArtist || '', album_name: album || '',
    duration: String(Math.round(durationMs / 1000)),
  });
  try {
    const r = await fetch(base + 'get?' + q, timeout(8000));
    if (r.ok) {
      const j = await r.json();
      const l = j.syncedLyrics && parseLrc(j.syncedLyrics);
      if (l && l.length) return l;
    }
  } catch (_) { /* fall through to search */ }
  const s = await fetch(base + 'search?' + new URLSearchParams({ track_name: name, artist_name: firstArtist || '' }), timeout(10000));
  if (!s.ok) return null;
  const list = await s.json();
  const dur = durationMs / 1000;
  // a version more than 10 s longer or shorter (live, extended, another song of the same name)
  // would put every line at the wrong time, so it's better to show none
  const hit = (Array.isArray(list) ? list : [])
    .filter((x) => x.syncedLyrics && !(Math.abs(x.duration - dur) > MAX_DURATION_DIFF_S))
    .sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur))[0];
  const l = hit && parseLrc(hit.syncedLyrics);
  return l && l.length ? l : null;
}

// Returns [{ t, end, text, words?: [{t, text}] }], times in ms.
// Supports enhanced LRC word tags: [00:12.00]<00:12.00>Hello <00:12.50>world
export function parseLrc(text) {
  const lines = [];
  // [mm:ss.xx], and [mm:ss:xx] (hundredths after a colon, written by some LRC editors)
  const stamp = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  // [offset:+500]: the lyrics should show 500 ms earlier
  const om = text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im), off = om ? +om[1] : 0;
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let m, last = 0;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw))) { times.push(Math.max(0, (+m[1] * 60 + +(m[2] + '.' + (m[3] || '0'))) * 1000 - off)); last = stamp.lastIndex; }
    if (!times.length) continue;
    let body = raw.slice(last);
    let words;
    if (/<\d+:\d+/.test(body)) {
      words = [];
      // the first word often has no tag of its own (the line stamp covers it)
      const lead = body.slice(0, body.search(/<\d+:\d+/));
      if (lead.trim()) words.push({ t: times[0], text: lead });
      let tags = 0;
      // <mm:ss.xx>, and <mm:ss:xx> like the line stamps
      body.replace(/<(\d+):(\d+)(?:[.:](\d+))?>([^<]*)/g, (_, mm, ss, fr, w) => {
        tags++;
        words.push({ t: Math.max(0, (+mm * 60 + +(ss + '.' + (fr || '0'))) * 1000 - off), text: w });
      });
      if (tags) body = words.map((w) => w.text).join('');
      else { words = undefined; body = body.replace(/<[^>]*>/g, ''); } // tags we couldn't read: keep the words, estimate their times
    }
    // a line stamped more than once (a repeated chorus) gets its word times moved along with it
    for (const t of times) lines.push({ t, text: body.trim(), words: words && words.map((w) => ({ t: w.t + t - times[0], text: w.text })) });
  }
  lines.sort((a, b) => a.t - b.t);
  // two lines at the same moment (e.g. a line and its translation): one line, or the first would never show
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].t !== lines[i - 1].t) continue;
    const a = lines[i - 1], b = lines[i];
    if (b.text) a.text = a.text ? a.text + ' / ' + b.text : b.text;
    if (b.text) a.words = undefined;
    lines.splice(i, 1);
  }
  for (let i = 0; i < lines.length; i++) lines[i].end = i + 1 < lines.length ? lines[i + 1].t : lines[i].t + 5000;
  return lines.filter((l) => l.text || l.end - l.t > 3000);
}

// ---- UltraStar .txt -------------------------------------------------------
// Community karaoke charts with per-syllable pitch + timing (the "pitch ahead" data).
// Returns { title, artist, notes: [{t, dur, midi, text, golden, free}], lines: [...], parts, partNames }
// Duet charts (P1 / P2 sections): opts.part picks the singer (1 by default); parts says how many there are.
export function parseUltraStar(text, opts = {}) {
  const want = Math.max(1, Math.floor(+opts.part) || 1);
  let parts = 1;
  const head = {};
  const notes = [];
  const breaks = [];
  let rel = 0; // #RELATIVE:yes charts count beats from the start of each line
  let part = 1; // duet charts: P1 / P2 sections
  const tempo = []; // mid-song BPM changes (B lines) of the chosen part
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (line.startsWith('#')) {
      const i = line.indexOf(':');
      if (i > 0) head[line.slice(1, i).toUpperCase()] = line.slice(i + 1).trim();
      continue;
    }
    // duets: only the chosen singer's part; the other's notes would be mixed in with it
    const pm = /^P\s*(\d+)\s*$/.exec(line);
    if (pm) { part = +pm[1]; parts = Math.max(parts, part); rel = 0; continue; } // each part counts its own beats
    if (line.startsWith('E')) break;
    if (part !== want) continue;
    const m = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/.exec(line);
    if (m) {
      notes.push({ beat: +m[2] + rel, len: +m[3], pitch: +m[4], text: m[5], golden: m[1] === '*' || m[1] === 'G', free: m[1] === 'F' || m[1] === 'R' || m[1] === 'G', rap: m[1] === 'R' || m[1] === 'G' }); // G = golden rap: pitch doesn't matter
      continue;
    }
    // "B beat bpm": the tempo changes from that beat on (older charts and some live recordings)
    const bc = /^B\s+(-?\d+)\s+([\d.,]+)\s*$/.exec(line);
    if (bc) { const v = parseFloat(bc[2].replace(',', '.')); if (v > 0) tempo.push({ beat: +bc[1] + rel, bpm: v }); continue; }
    const b = /^-\s+(-?\d+)(?:\s+(-?\d+))?/.exec(line);
    if (b) {
      breaks.push(+b[1] + rel);
      // relative mode: "- a b" ends the line at a and starts the next one b beats on (just a when there's one number)
      if (/^yes$/i.test(head.RELATIVE || '')) rel += b[2] != null ? +b[2] : +b[1];
    }
  }
  const bpm = parseFloat((head.BPM || '0').replace(',', '.'));
  if (!bpm) throw new Error('Not a valid UltraStar file');
  if (!notes.length) {
    if (want > 1 && want > parts) return parseUltraStar(text);         // a part that isn't there: the first one
    throw new Error('Not a valid UltraStar file');
  }
  const gap = parseFloat((head.GAP || '0').replace(',', '.'));
  const msPerBeat = 60000 / (bpm * 4); // UltraStar beats are quarter-beats
  // beat -> ms from the GAP, through any tempo changes (each B line sets the BPM from its beat on)
  tempo.sort((a, b) => a.beat - b.beat);
  const at = (x) => {
    let t = gap, from = 0, ms = msPerBeat;
    for (const c of tempo) {
      if (c.beat <= from) { ms = 60000 / (c.bpm * 4); continue; } // at the start (or the same beat as the last change)
      if (c.beat > x) break;
      t += (c.beat - from) * ms; from = c.beat; ms = 60000 / (c.bpm * 4);
    }
    return t + (x - from) * ms;
  };
  notes.sort((a, b) => a.beat - b.beat);
  const out = notes.map((n, i) => ({
    i,
    t: at(n.beat),
    dur: at(n.beat + n.len) - at(n.beat),
    midi: 60 + n.pitch, // pitch 0 = C4
    text: n.text.replace(/~/g, ''), golden: n.golden, free: n.free, ...(n.rap ? { rap: true } : {}), // '~' = held note
  }));
  // group into lyric lines using the "-" line breaks
  const lines = [];
  let cur = [];
  let bi = 0;
  const bts = breaks.slice().sort((a, b) => a - b).map(at);
  for (const n of out) {
    while (bi < bts.length && n.t >= bts[bi]) { if (cur.length) lines.push(cur); cur = []; bi++; }
    cur.push(n);
  }
  if (cur.length) lines.push(cur);
  const lyricLines = lines.map((ns, i) => ({
    t: ns[0].t,
    end: i + 1 < lines.length ? lines[i + 1][0].t : ns[ns.length - 1].t + ns[ns.length - 1].dur + 1000,
    text: ns.map((n) => n.text).join('').trim(),
    words: ns.map((n) => ({ t: n.t, end: n.t + n.dur, text: n.text })),
  }));
  const partNames = [];
  for (let k = 1; k <= parts; k++) partNames.push(head['DUETSINGERP' + k] || head['P' + k] || 'Singer ' + k);
  // "#ECHO:yes" (Singing Helper's own exercises): freestyle notes are played for you to hear, then you sing them back
  const echo = /^(yes|1|true)$/i.test(head.ECHO || '');
  if (echo) for (const n of out) if (n.free) n.listen = true;
  return { title: head.TITLE, artist: head.ARTIST, notes: out, lines: lyricLines, parts, part: want, partNames, echo };
}
