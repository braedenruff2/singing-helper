// Unit tests for notes.js ("Make notes from this song": song pitch frames -> UltraStar chart). Node only.
//   node tests/notes.mjs
import { framesToNotes, syllables, attachLyrics, keepSung, chartFromFrames, STEP_MS, sungText } from '../notes.js';
import { parseUltraStar } from '../lyrics.js';

let fails = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '  (' + detail + ')' : ''}`); if (!ok) fails++; };
// a sung line: [startMs, durMs, midi] -> 20 ms frames, with vibrato (+-0.3 semitone) and a little noise
const sing = (parts, vib = 0.3) => parts.flatMap(([s, d, m]) => Array.from({ length: Math.round(d / STEP_MS) }, (_, i) => [s + i * STEP_MS, m + vib * Math.sin(i / 2.5)]));

{
  const n = framesToNotes(sing([[1000, 400, 60], [1400, 300, 62], [1900, 500, 64]]));
  check('three notes: pitches and starts (vibrato doesn\'t split them)', n.length === 3 && n.map((x) => x.m).join() === '60,62,64' && n[0].s === 1000 && n[1].s === 1400 && n[2].s === 1900, JSON.stringify(n));
  check('lengths close to what was sung', Math.abs(n[0].d - 400) <= 40 && Math.abs(n[2].d - 500) <= 40, n.map((x) => x.d).join());
}
{
  const blip = framesToNotes(sing([[0, 60, 70], [1000, 300, 60]]));
  check('a 60 ms blip is dropped', blip.length === 1 && blip[0].m === 60, JSON.stringify(blip));
  const cons = framesToNotes(sing([[0, 300, 60], [340, 300, 60]], 0));
  check('same pitch across a consonant gap: one note', cons.length === 1 && cons[0].d >= 600, JSON.stringify(cons));
  const shuffled = sing([[0, 300, 60], [300, 300, 65]]).reverse();
  check('frames in any order (a seek back fills in later)', framesToNotes(shuffled).map((x) => x.m).join() === '60,65');
  check('nothing heard: no notes', framesToNotes([]).length === 0 && framesToNotes([[0, NaN]]).length === 0);
}
check('syllables like make_chart.py', [['singing', 'sing|ing'], ['little', 'lit|tle'], ['mother', 'mo|ther'], ['music', 'mu|sic'], ['time', 'time'], ['the', 'the'], ['love', 'love']]
  .every(([w, want]) => syllables(w).join('|') === want), ['singing', 'little', 'mother', 'music', 'time'].map((w) => syllables(w).join('|')).join(' '));
{
  const notes = [{ s: 1000, d: 200, m: 60 }, { s: 1250, d: 200, m: 62 }, { s: 1500, d: 400, m: 64 }, { s: 5000, d: 300, m: 60 }];
  const { texts, lineStarts } = attachLyrics(notes, [{ t: 950, text: 'hello there' }, { t: 4900, text: 'singing little songs' }]);
  check('lyrics: syllables onto notes, a line start per line', texts.slice(0, 3).join('|') === 'hel|lo |there ' && lineStarts.join() === '0,3', texts.join('|'));
  check('more syllables than notes: shared out', texts[3] === 'singing little songs ', texts[3]);
  const kept = keepSung([{ s: 500, d: 200, m: 50 }, ...notes, { s: 20000, d: 300, m: 40 }], [{ t: 950, text: 'hello there' }, { t: 4900, text: 'singing', end: 6000 }]);
  check('with lyrics, notes far from any sung line (the band) are left out', kept.length === 4 && kept[0].s === 1000, kept.map((x) => x.s).join());
}
{
  const frames = sing([[1000, 400, 60], [1400, 300, 62], [1900, 500, 64], [2600, 300, 65], [3000, 300, 67], [3400, 300, 65], [3800, 300, 64], [4200, 600, 62], [5000, 400, 60]]);
  const r = chartFromFrames(frames, { lines: [{ t: 950, text: 'twinkle twinkle little star' }, { t: 4100, text: 'how I wonder' }], artist: 'Me', title: 'Test: song' });
  const c = parseUltraStar(r.text);
  check('a chart the app reads: notes, lyrics, title', r.notes === 9 && r.lyrics && c.notes.length === 9 && c.title === 'Test  song' && c.lines.length === 2, r.text.split('\n').slice(0, 8).join(' / '));
  check('the chart\'s notes keep the song\'s timing and pitch', Math.abs(c.notes[0].t - 1000) <= 20 && c.notes[0].midi === 60 && Math.abs(c.notes[8].t - 5000) <= 20, JSON.stringify(c.notes[0]));
  check('too little heard (under 8 notes): no chart', chartFromFrames(sing([[0, 300, 60]])).text === null);
  const noLyr = chartFromFrames(frames, {});
  check('no synced lyrics: notes only', noLyr.text && !noLyr.lyrics && parseUltraStar(noLyr.text).notes.length === 9);
}
// ---- the faster splitRun gives the same notes as the old sort-every-frame one; a 4-minute drone is quick
{
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const oldSplit = (run, th = 0.7, hold = 3) => { // the version before 27 Nov, kept here as the reference
    const out = []; let start = 0;
    for (let k = 0; k < run.length; k++) {
      if (k - start < hold || k + hold > run.length) continue;
      const cur = med(run.slice(start, k + 1).map((x) => x[1]));
      if (run.slice(k, k + hold).every((x) => Math.abs(x[1] - cur) > th)) { out.push([run[start][0], run[k][0], Math.round(med(run.slice(start, k).map((x) => x[1])))]); start = k; }
    }
    out.push([run[start][0], run[run.length - 1][0] + STEP_MS, Math.round(med(run.slice(start).map((x) => x[1])))]);
    return out;
  };
  const oldNotes = (frames, minMs = 100, gapMs = 40, mergeGapMs = 60) => {
    const f = frames.filter((x) => isFinite(x[0]) && isFinite(x[1])).sort((a, b) => a[0] - b[0]);
    const runs = []; for (const x of f) { const r = runs[runs.length - 1]; if (r && x[0] - r[r.length - 1][0] <= gapMs) r.push(x); else runs.push([x]); }
    const notes = []; for (const r of runs) for (const [s0, e, m] of oldSplit(r)) if (e - s0 >= minMs) notes.push({ s: s0, d: e - s0, m });
    const merged = []; for (const n of notes) { const q = merged[merged.length - 1]; if (q && q.m === n.m && n.s - (q.s + q.d) <= mergeGapMs) q.d = n.s + n.d - q.s; else merged.push({ ...n }); }
    return merged;
  };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let same = 0;
  for (let trial = 0; trial < 40; trial++) {
    const parts = []; let t = 0;
    for (let i = 0; i < 25; i++) { const d = 60 + Math.round(rnd() * 600 / 20) * 20; parts.push([t, d, 50 + Math.floor(rnd() * 20)]); t += d + (rnd() < 0.3 ? 20 * Math.floor(rnd() * 6) : 0); }
    const fr = sing(parts, rnd() * 0.6).map(([ms, m]) => [ms, m + (rnd() - 0.5) * 0.4]);
    if (JSON.stringify(framesToNotes(fr)) === JSON.stringify(oldNotes(fr))) same++;
  }
  check('faster note splitting: same notes as before on 40 random sung lines', same === 40, same + '/40');
  const drone = []; for (let t = 0; t < 240000; t += 20) drone.push([t, 57 + 0.3 * Math.sin(t / 90)]);
  const t0 = Date.now(), dn = framesToNotes(drone), ms = Date.now() - t0;
  check('a 4-minute held drone: one note, well under a second', dn.length === 1 && ms < 1000, ms + ' ms');
}
// ---- music marks in synced lyrics aren't sung words
{
  check('sungText: music marks and (Instrumental) are not words', sungText('♪') === '' && sungText(' ♪ ♪ ') === '' && sungText('(Instrumental)') === '' && sungText('[Music]') === '' && sungText('🎵') === '');
  check('sungText: real words stay (marks around them dropped)', sungText('♪ Hello there ♪') === 'Hello there' && sungText('Sing (yeah)') === 'Sing (yeah)' && sungText('99 Luftballons') === '99 Luftballons');
  const notes = [{ s: 1000, d: 300, m: 60 }, { s: 6000, d: 300, m: 62 }, { s: 6500, d: 300, m: 64 }];
  const lines = [{ t: 900, text: 'la la' }, { t: 5000, text: '♪' }, { t: 9000, text: '' }];
  check('keepSung: notes in a "♪" stretch are the band, dropped', JSON.stringify(keepSung(notes, lines).map((n) => n.s)) === '[1000]', JSON.stringify(keepSung(notes, lines)));
  const at = attachLyrics(notes, lines);
  check('attachLyrics: no "♪" syllable on a note', at.texts.every((x) => !/♪/.test(x)) && at.lineStarts.length === 1, JSON.stringify(at));
}
console.log(fails ? `notes: ${fails} FAILED` : 'notes: passed');
process.exit(fails ? 1 : 0);
