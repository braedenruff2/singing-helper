// "Make notes from this song": turns the song pitch heard while a song plays (Live song pitch, the lead voice in
// the mix, frames every 20 ms keyed by the Spotify position) into an UltraStar chart with the synced lyrics spread
// over the notes. Only pitch numbers are kept, never the audio. The note cutting, syllables and chart format follow
// tools/make_chart.py, so charts made either way look alike.

export const STEP_MS = 20; // one frame of Live song pitch
const MS_PER_BEAT = 10; // chart resolution, as make_chart.py: BPM = 60000 / (MS_PER_BEAT * 4)

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// Split a voiced run where the pitch settles on a new semitone for 60 ms (vibrato and slides don't split it).
function splitRun(run, startMs, th = 0.7, hold = 3) {
  const out = [];
  let start = 0;
  for (let k = 0; k < run.length; k++) {
    if (k - start < hold || k + hold > run.length) continue;
    const cur = median(run.slice(start, k + 1).map((x) => x[1]));
    if (run.slice(k, k + hold).every((x) => Math.abs(x[1] - cur) > th)) {
      out.push([run[start][0], run[k][0], Math.round(median(run.slice(start, k).map((x) => x[1])))]);
      start = k;
    }
  }
  out.push([run[start][0], run[run.length - 1][0] + STEP_MS, Math.round(median(run.slice(start).map((x) => x[1])))]);
  return out;
}

// frames: [[ms, midi], ...] (any order; one per 20 ms bucket). Returns notes [{s, d, m}] in ms, sorted.
export function framesToNotes(frames, { minMs = 100, gapMs = 40, mergeGapMs = 60 } = {}) {
  const f = frames.filter((x) => isFinite(x[0]) && isFinite(x[1])).sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const x of f) {
    const r = runs[runs.length - 1];
    if (r && x[0] - r[r.length - 1][0] <= gapMs) r.push(x); else runs.push([x]);
  }
  let notes = [];
  for (const r of runs) for (const [s, e, m] of splitRun(r, r[0][0])) if (e - s >= minMs) notes.push({ s, d: e - s, m });
  // same pitch either side of a short gap (a consonant): one note
  const merged = [];
  for (const n of notes) {
    const p = merged[merged.length - 1];
    if (p && p.m === n.m && n.s - (p.s + p.d) <= mergeGapMs) p.d = n.s + n.d - p.s; else merged.push({ ...n });
  }
  return merged;
}

// ---- lyrics: rough English-ish syllables, like make_chart.py ('singing' -> sing|ing, 'little' -> lit|tle)
const VOWELS = new Set('aeiouyAEIOUYàáâäèéêëìíîïòóôöùúûü');
const DIGRAPHS = ['ng', 'ck', 'sh', 'ch', 'th', 'ph', 'wh', 'gh'];
export function syllables(word) {
  const groups = [];
  for (let i = 0; i < word.length;) {
    if (VOWELS.has(word[i]) && !(i === 0 && /y/i.test(word[i]))) {
      let j = i; while (j < word.length && VOWELS.has(word[j])) j++;
      groups.push([i, j]); i = j;
    } else i++;
  }
  // silent final e: 'time', 'love', 'smiles' (but not 'the', 'be', 'little')
  const last = groups[groups.length - 1];
  if (groups.length > 1 && /[^aeiouy]e[sd]?$/i.test(word) && last[1] - last[0] === 1 && /e/i.test(word[last[0]]) && !/[^aeiouy]le$/i.test(word)) groups.pop();
  if (groups.length < 2) return [word];
  const cuts = [];
  for (let g = 0; g + 1 < groups.length; g++) {
    const end = groups[g][1], start = groups[g + 1][0], cons = word.slice(end, start);
    if (cons.length <= 1) cuts.push(end); // mu-sic
    else if (DIGRAPHS.includes(cons.slice(0, 2).toLowerCase())) cuts.push(cons.length > 2 || cons.toLowerCase() === 'ng' ? end + 2 : end); // sing-ing, mo-ther
    else cuts.push(end + 1); // lit-tle
  }
  const parts = []; let prev = 0;
  for (const c of cuts) { parts.push(word.slice(prev, c)); prev = c; }
  parts.push(word.slice(prev));
  return parts.filter(Boolean);
}

// lines: [{t, text}] (synced lyrics, ms). Gives each note a syllable ("~" = a held vowel); returns {texts, lineStarts}.
export function attachLyrics(notes, lines) {
  const texts = notes.map(() => '~'), lineStarts = [];
  (lines || []).forEach((ln, li) => {
    const body = String(ln.text || '').trim();
    if (!body) return;
    const end = li + 1 < lines.length ? lines[li + 1].t : ln.t + 8000;
    const idx = [];
    notes.forEach((n, k) => { if (n.s >= ln.t - 150 && n.s < end - 150) idx.push(k); });
    if (!idx.length) return;
    lineStarts.push(idx[0]);
    const syl = [];
    for (const w of body.split(/\s+/)) { const ss = syllables(w); ss[ss.length - 1] += ' '; syl.push(...ss); }
    if (syl.length > idx.length) { // more syllables than notes: share them out
      const per = syl.length / idx.length;
      idx.forEach((k, j) => { texts[k] = syl.slice(Math.round(j * per), Math.round((j + 1) * per)).join('') || '~'; });
    } else { // spread over the notes in time; leftover notes are held vowels
      const span = idx.length / syl.length;
      syl.forEach((s, j) => { texts[idx[Math.floor(j * span)]] = s; });
    }
  });
  return { texts, lineStarts };
}

// With synced lyrics, a note far from any sung line is the band (Live song pitch can't tell in instrumental parts).
export function keepSung(notes, lines) {
  const ls = (lines || []).filter((l) => String(l.text || '').trim());
  if (!ls.length) return notes;
  return notes.filter((n) => ls.some((l, i) => {
    const next = (lines || []).find((x) => x.t > l.t);
    const end = l.end != null ? l.end : next ? next.t : l.t + 8000;
    return n.s >= l.t - 400 && n.s < end + 200;
  }));
}

const clean = (s) => String(s || '').replace(/[\r\n#:]/g, ' ').trim();
export function toUltraStar(notes, texts, lineStarts, artist, title) {
  const bpm = 60000 / (MS_PER_BEAT * 4);
  const out = [`#TITLE:${clean(title) || 'Unknown'}`, `#ARTIST:${clean(artist) || 'Unknown'}`, `#BPM:${bpm}`, '#GAP:0',
    '#COMMENT:made by Singing Helper from the song as it played (Live song pitch)'];
  const starts = new Set(lineStarts);
  notes.forEach((n, k) => {
    if (starts.has(k) && k > 0) out.push(`- ${Math.floor(n.s / MS_PER_BEAT) - 1}`);
    out.push(`: ${Math.floor(n.s / MS_PER_BEAT)} ${Math.max(1, Math.floor(n.d / MS_PER_BEAT))} ${n.m - 60} ${texts[k]}`);
  });
  out.push('E');
  return out.join('\n') + '\n';
}

// The whole step: frames heard -> chart text (or null with too little sung). {text, notes, lyrics}
export function chartFromFrames(frames, { lines, artist, title } = {}) {
  const notes = keepSung(framesToNotes(frames), lines).filter((n) => n.s >= 0);
  if (notes.length < 8) return { text: null, notes: notes.length, lyrics: false };
  const { texts, lineStarts } = attachLyrics(notes, lines);
  return { text: toUltraStar(notes, texts, lineStarts, artist, title), notes: notes.length, lyrics: lineStarts.length > 0 };
}
