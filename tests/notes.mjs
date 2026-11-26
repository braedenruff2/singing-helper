// Unit tests for notes.js ("Make notes from this song": song pitch frames -> UltraStar chart). Node only.
//   node tests/notes.mjs
import { framesToNotes, syllables, attachLyrics, keepSung, chartFromFrames, STEP_MS } from '../notes.js';
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
console.log(fails ? `notes: ${fails} FAILED` : 'notes: passed');
process.exit(fails ? 1 : 0);
