// Unit tests for karaoke.js (the TV karaoke screen's logic): UltraStar files saved unchanged, charts written as
// UltraStar, scoring, the lyric line on screen, and the phone -> TV pitch messages. Node only.
//   node tests/karaoke.mjs
import { readFileSync, readdirSync } from 'fs';
import {
  readUltraStar, writeUltraStar, headValue, setHead, chartToUltraStar, parseUltraStar,
  Scorer, LEVELS, foldTo, hzToMidi, rating, lyricView, duetLines, estimateLag, encodePitch, decodeMessage, newer, PORT, uploadName,
} from '../karaoke.js';

let fails = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '  (' + detail + ')' : ''}`); if (!ok) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ex = new URL('../examples/', import.meta.url);

// ---- read / write
for (const f of readdirSync(ex).filter((f) => f.endsWith('.txt'))) {
  const text = readFileSync(new URL(f, ex), 'utf8');
  const raw = readUltraStar(text);
  const again = writeUltraStar(raw);
  check('write(read(x)) reads back the same: ' + f, same(readUltraStar(again), raw));
  check('write(read(x)) sings the same: ' + f, same(parseUltraStar(again), parseUltraStar(text)));
}
{
  const duet = '﻿#TITLE:Duet\r\n#ARTIST:Two\r\n#BPM:300\r\n#GAP:500\r\n#RELATIVE:yes\r\n#DUETSINGERP1:Ann\r\nP1\r\n: 0 4 2 Hel\r\n: 4 4 4 lo \r\n- 10 12\r\n* 0 8 5 there\r\nP2\r\nG 0 4 -3 yo\r\nF 4 4 0 ...\r\nR 8 2 0 rap \r\n: 12 4 1\r\nE\r\nignored after E\r\n';
  const raw = readUltraStar(duet);
  check('duet: two parts with their numbers, no empty part before P1', raw.parts.length === 2 && raw.parts[0].p === 1 && raw.parts[1].p === 2, JSON.stringify(raw.parts.map((p) => p.p)));
  check('relative break "- 10 12" keeps both numbers', same(raw.parts[0].events[2], { kind: '-', beat: 10, next: 12 }));
  check('note text keeps its trailing space (a word break)', raw.parts[0].events[1].text === 'lo ');
  check('a note with no text reads as empty text', raw.parts[1].events[3].text === '');
  check('golden / rap / freestyle kinds kept', raw.parts[0].events[3].kind === '*' && raw.parts[1].events.map((e) => e.kind).join('') === 'GFR:');
  check('headers kept in order, BOM dropped', raw.head.map(([k]) => k).join(',') === 'TITLE,ARTIST,BPM,GAP,RELATIVE,DUETSINGERP1');
  const w = writeUltraStar(raw);
  check('duet written with P1/P2 and E', /\nP1\n/.test(w) && /\nP2\n/.test(w) && w.endsWith('\nE\n'));
  for (const part of [1, 2]) check('duet part ' + part + ' sings the same after saving', same(parseUltraStar(w, { part }), parseUltraStar(duet, { part })));
  setHead(raw, 'gap', 750); setHead(raw, 'MP3', 'duet.mp3');
  check('setHead changes a header in place and adds a new one at the end', headValue(raw, 'GAP') === '750' && raw.head[3][0] === 'GAP' && raw.head[raw.head.length - 1][0] === 'MP3');
  check('the new #GAP is what the song uses', parseUltraStar(writeUltraStar(raw)).notes[0].t === 750);
}
{
  let threw = false; try { readUltraStar('just some text\n: 0 1 2 a'); } catch (_) { threw = true; }
  check('a file without #BPM is refused', threw);
}
// ---- chart -> UltraStar
{
  const src = parseUltraStar(readFileSync(new URL('warmup-scale.txt', ex), 'utf8'));
  const txt = chartToUltraStar(src, { mp3: 'scale.mp3' });
  const back = parseUltraStar(txt);
  check('a timed chart saved as UltraStar keeps every note within 10 ms', back.notes.length === src.notes.length &&
    back.notes.every((n, i) => Math.abs(n.t - src.notes[i].t) <= 10 && Math.abs(n.dur - src.notes[i].dur) <= 10 && n.midi === src.notes[i].midi && n.text === src.notes[i].text));
  check('... and its lyric lines', back.lines.length === src.lines.length && back.lines.every((l, i) => l.text === src.lines[i].text), back.lines.length + ' vs ' + src.lines.length);
  check('... with #MP3, #BPM:1500 and #GAP at the first note', /#MP3:scale\.mp3/.test(txt) && /#BPM:1500/.test(txt) && headValue(readUltraStar(txt), 'GAP') === String(Math.round(src.notes[0].t)));
  let threw = false; try { chartToUltraStar({ notes: [] }); } catch (_) { threw = true; }
  check('an empty chart is refused', threw);
}
// ---- scoring
{
  check('foldTo moves a pitch into the target octave', foldTo(48, 60) === 60 && foldTo(73, 60) === 61 && foldTo(66, 60) === 54);
  check('hzToMidi(440) = 69, 261.63 Hz ~ 60', hzToMidi(440) === 69 && Math.abs(hzToMidi(261.63) - 60) < 0.01);
  const chart = { notes: [{ t: 1000, dur: 1000, midi: 60 }, { t: 2000, dur: 1000, midi: 64, golden: true }, { t: 3000, dur: 500, midi: 62, free: true }] };
  // a frame's pitch is what was sung in the time since the frame before (t - step, t], so a note ending at 2000 is still
  // being sung in the frame at t = 2000
  const run = (sc, fn, from = 0, to = 4000, step = 20) => { for (let t = from; t <= to; t += step) sc.frame(t, fn(t)); return sc; };
  const exact = run(new Scorer(chart), (t) => (t <= 2000 ? 60 : t <= 3000 ? 64 : 50));
  check('singing every note right scores 10,000 (freestyle not scored)', exact.points >= 9950, exact.points);
  const octave = run(new Scorer(chart), (t) => (t <= 2000 ? 48 : 76));
  check('an octave lower/higher counts (any voice fits)', octave.points >= 9950, octave.points);
  const nofold = run(new Scorer(chart, { fold: false }), (t) => (t < 2000 ? 48 : 76));
  check('... unless folding is off', nofold.points === 0, nofold.points);
  const silent = run(new Scorer(chart), () => null);
  check('silence scores nothing', silent.points === 0);
  const half = run(new Scorer(chart), (t) => (t <= 2000 ? 60 : null));
  check('golden notes count double: first note only = 1/3', Math.abs(half.points - 3333) <= 30, half.points);
  // review 6 (28 Nov): frames that don't line up with the notes (the phone's 21.33 ms) still reach 10000 when every note
  // is sung right: a note's last ms after its last frame count (before: ~9844 on a 320-note chart)
  {
    const many = { notes: Array.from({ length: 320 }, (_, k) => ({ t: 1000 + k * 300, dur: 250, midi: 60 + (k % 5) })) };
    const at = (t) => { for (const n of many.notes) if (t - 21.33 < n.t + n.dur && t > n.t) return n.midi; return null; };
    const sc = new Scorer(many); for (let t = 0; t < 1000 + 320 * 300; t += 21.33) sc.frame(t, at(t));
    check('perfect singing on frames 21.33 ms apart scores 10000', sc.points >= 9990, sc.points);
    const late = new Scorer(many); for (let t = 0; t < 1000 + 320 * 300; t += 21.33) late.frame(t, at(t - 125)); // half of each note
    check('... and half of each note sung (125 ms late) scores about half', late.points > 4500 && late.points < 6000, late.points);
  }
  // review 3: rap (R) and golden rap (G) count for being heard on time, at any pitch; G double; freestyle F never
  {
    const rap = parseUltraStar('#BPM:150\n#GAP:0\n: 0 4 0 sung\nR 8 4 5 rap\nG 16 4 7 gold\nF 24 4 0 free\nE\n');
    const kinds = rap.notes.map((n) => (n.rap ? (n.golden ? 'G' : 'R') : n.free ? 'F' : ':')).join('');
    check('UltraStar R / G read as rap (G golden), F freestyle', kinds === ':RGF', kinds);
    const sc = new Scorer(rap); const span = rap.notes[3].t + rap.notes[3].dur + 100;
    for (let t = 0; t <= span; t += 20) { const n = rap.notes.find((x) => t - 20 < x.t + x.dur && t > x.t); sc.frame(t, n ? (n.rap ? 47 : n.midi) : null); }
    check('rapping at a speaking pitch scores full marks on rap notes', sc.points >= 9950, sc.points);
    const g = rap.notes[2]; check('golden rap is drawn as free (not a pitch bar)', g.free === true && g.golden === true);
  }
  const rare = new Scorer(chart); rare.frame(1000, 60); rare.frame(1900, 60);
  check('a long gap between frames credits at most 60 ms', rare.hit[0] === 60, rare.hit[0]);
  const flat = run(new Scorer(chart, { tolerance: LEVELS.hard }), (t) => (t < 2000 ? 59.3 : null));
  const flatEasy = run(new Scorer(chart, { tolerance: LEVELS.easy }), (t) => (t < 2000 ? 59.3 : null));
  check('70 cents flat: wrong on Hard, right on Easy', flat.points === 0 && flatEasy.points > 3000, flat.points + ' / ' + flatEasy.points);
  const back = run(new Scorer(chart), (t) => (t < 2000 ? 60 : null), 0, 2500);
  run(back, (t) => (t < 2000 ? 60 : null), 1000, 1500);
  check('a seek back (song started again) keeps counting from the right note, never over 100%', back.noteScore(0) <= 1 && back.noteAt(1200) === 0);
  back.reset(); check('reset clears the score', back.points === 0);
  check('ratings', rating(9500) === 'Superstar' && rating(0) === 'Warming up' && rating(6500) === 'Rising star');
  check('a chart with only freestyle notes scores 0, no NaN', new Scorer({ notes: [{ t: 0, dur: 100, midi: 60, free: true }] }).points === 0);
}
// ---- how late the pitch arrives
{
  const chart = parseUltraStar(readFileSync(new URL('warmup-scale.txt', ex), 'utf8'));
  const sing = (lag, wobble = 0) => {
    const fr = [];
    for (let t = 0; t < 40000; t += 20) {
      const n = chart.notes.find((x) => t - lag >= x.t && t - lag < x.t + x.dur);
      fr.push({ t, midi: n ? n.midi - 12 + wobble * Math.sin(t / 37) : null }); // an octave low, slightly wobbly
    }
    return fr;
  };
  for (const lag of [0, 120, 180, 320]) {
    const e = estimateLag(chart, sing(lag, 0.2));
    check('estimateLag finds a ' + lag + ' ms delay (within 30 ms)', e && Math.abs(e.lag - lag) <= 30, JSON.stringify(e));
  }
  check('not enough singing: no guess', estimateLag(chart, sing(150).slice(0, 40)) === null);
  check('nothing sung: no guess', estimateLag(chart, sing(150).map((f) => ({ t: f.t, midi: null }))) === null);
  {
    const e = estimateLag(chart, sing(120, 0.2), { current: 120 });
    check('estimateLag tells how well the delay in use fits (in the plateau: as well as the best)', e && e.current != null && e.current >= e.hits * 0.98, JSON.stringify(e));
    const f = estimateLag(chart, sing(320, 0.2), { current: 0 });
    check('a delay far off fits clearly worse', f && f.current < f.hits * 0.9, JSON.stringify(f));
  }
  {
    // a quick trill (100 ms notes, 60/62): it fits again every 200 ms; the answer stays in the plateau around the best
    // fit instead of averaging separate spots (it said 190 ms for a 0 ms delay)
    const tr = { notes: [] };
    for (let i = 0; i < 100; i++) tr.notes.push({ t: 1000 + i * 100, dur: 100, midi: i % 2 ? 62 : 60 });
    const fr = [];
    for (let t = 0; t < 12000; t += 20) { const n = tr.notes.find((x) => t >= x.t + 30 && t < x.t + x.dur - 10); fr.push({ t, midi: n ? n.midi : null }); }
    const e = estimateLag(tr, fr);
    check('trill sung on time: the delay found is near 0 or one clear fit, never between two fits', e && (e.lag <= 40 || e.lag % 200 <= 40 || e.lag % 200 >= 160), JSON.stringify(e));
  }
  const held = { notes: [{ t: 0, dur: 20000, midi: 60 }] };
  const hf = []; for (let t = 0; t < 20000; t += 20) hf.push({ t: t + 200, midi: 60 });
  check('one long held note: any delay fits, so no guess', estimateLag(held, hf) === null, JSON.stringify(estimateLag(held, hf)));
}
// ---- lyric view
{
  const lines = parseUltraStar('#BPM:300\n#GAP:5000\n: 0 4 0 Hel\n: 4 4 0 lo \n- 10\n: 20 4 0 world\nE\n').lines;
  const v0 = lyricView(lines, 1000);
  check('before the first line: it shows, nothing wiped, countdown running', v0.cur === 0 && v0.words.every((w) => w.frac === 0) && v0.countdown === 1, JSON.stringify(v0));
  const v1 = lyricView(lines, 5000 + 100); // #BPM:300 = 50 ms beats: "Hel" is 5000-5200
  check('half-way through the first syllable: half wiped', v1.cur === 0 && Math.abs(v1.words[0].frac - 0.5) < 0.01 && v1.words[1].frac === 0 && v1.next === 1, JSON.stringify(v1.words));
  const v2 = lyricView(lines, lines[1].t + 1);
  check('then the next line', v2.cur === 1 && v2.next === -1 && v2.countdown === 0);
  check('after the last line: nothing', lyricView(lines, 1e9).cur === -1);
  // review 2 (28 Nov): after a long instrumental the sung line goes 1 s after its last word, the next one shows with
  // the countdown dots in the last 3 s (before: the old line stayed until the next one's first note, no dots)
  {
    const gap = parseUltraStar('#BPM:150\n#GAP:0\n: 0 4 0 one\n- 10\n: 200 4 0 two\nE\n').lines; // 100 ms beats: 0-400, then 20000
    check('gap: just after the line it stays up', lyricView(gap, 1000).cur === 0, lyricView(gap, 1000).cur);
    const mid = lyricView(gap, 10000);
    check('gap: in the instrumental the next line shows, with the dots waiting', mid.cur === 1 && mid.countdown === 1, JSON.stringify(mid));
    const soon = lyricView(gap, 18500);
    check('gap: the dots count down in the last 3 s', soon.cur === 1 && soon.countdown > 0 && soon.countdown < 1, soon.countdown);
    const tight = parseUltraStar('#BPM:150\n#GAP:0\n: 0 4 0 a\n: 4 4 0 b\n- 9\n: 10 4 0 c\nE\n').lines;
    check('back-to-back lines: unchanged (the line goes when the next starts)', lyricView(tight, 900).cur === 0 && lyricView(tight, 1001).cur === 1);
  }
  // review 1: a duet's lyrics on the TV: both singers' lines, in time order, each with its part
  {
    const duet = '#BPM:150\n#GAP:0\n#P1:Ann\n#P2:Bob\nP1\n: 0 4 0 Ann1\n- 10\n: 100 4 0 Ann2\nP2\n: 40 4 2 Bob1\nE\n';
    const c = parseUltraStar(duet), ls = duetLines(duet, c);
    check('duet: both parts\' lines, in time order', ls.map((l) => l.part + ':' + l.text).join(' ') === '1:Ann1 2:Bob1 1:Ann2', ls.map((l) => l.part + ':' + l.text).join(' '));
    check('duet: during P2\'s line it is the one shown', lyricView(ls, 4100).cur === 1, lyricView(ls, 4100).cur);
    check('duet: scoring stays on P1', c.notes.length === 2 && c.partNames[1] === 'Bob');
    const solo = parseUltraStar('#BPM:150\n: 0 4 0 x\nE\n');
    check('one-part chart: its own lines, part 1', duetLines('#BPM:150\n: 0 4 0 x\nE\n', solo).every((l) => l.part === 1));
  }
  // review 5: tab-separated notes are kept by readUltraStar (as parseUltraStar reads them)
  {
    const tab = '#TITLE:t\n#BPM:150\n:\t0\t4\t0\tla\n: 4 4 0\tli\nE\n';
    const r = readUltraStar(tab);
    check('tab before the text: notes kept', r.parts[0].events.filter((e) => e.kind === ':').map((e) => e.text).join('|') === 'la|li', JSON.stringify(r.parts[0].events));
  }
}
// ---- messages
{
  const m = decodeMessage(encodePitch(7, 220.123, 0.917));
  check('pitch message round trip (rounded)', same(m, { type: 'pitch', seq: 7, hz: 220.12, conf: 0.92 }), JSON.stringify(m));
  const t = decodeMessage(encodePitch(8, 220, 0.9, 123456.7));
  check('the phone\'s time goes along (whole ms)', t.ms === 123457 && !('ms' in decodeMessage(encodePitch(8, 220, 0.9))), JSON.stringify(t));
  check('a bad phone time is refused', decodeMessage('{"v":1,"type":"pitch","seq":1,"hz":200,"conf":1,"ms":-5}') === null && decodeMessage('{"v":1,"type":"pitch","seq":1,"hz":200,"conf":1,"ms":"x"}') === null);
  check('not singing = hz 0', decodeMessage(encodePitch(1, 0, 0)).hz === 0 && decodeMessage(encodePitch(1, -5, 0)).hz === 0);
  check('hello', same(decodeMessage('{"v":1,"type":"hello","name":"Pixel"}'), { type: 'hello', name: 'Pixel' }));
  const bad = ['', 'x', '{}', '{"v":2,"type":"pitch","seq":1,"hz":200,"conf":1}', '{"v":1,"type":"pitch","seq":1,"hz":"a","conf":1}',
    '{"v":1,"type":"pitch","seq":-1,"hz":200,"conf":1}', '{"v":1,"type":"pitch","seq":1,"hz":20,"conf":1}', '{"v":1,"type":"pitch","seq":1,"hz":200,"conf":2}',
    '{"v":1,"type":"pitch","seq":1.5,"hz":200,"conf":1}', '{"v":1,"type":"other"}', 'null', '"text"', 'a'.repeat(600), null];
  check('bad or unknown messages are ignored', bad.every((b) => decodeMessage(b) === null));
  check('newer: in order, duplicates and late ones dropped, wraps at 2^32', newer(5, 4) && !newer(4, 4) && !newer(3, 4) && newer(0, 0xffffffff) && newer(1, null));
  check('port', PORT === 47321);
}

// ---- upload names: the same as the TV app's TvFiles.safeName (tests/java/TvFilesTest.java checks the same names)
{
  const cases = [['Song 🎤.mp3', 'Song _.mp3'], ['Track ½.mp3', 'Track _.mp3'], ['Beyoncé - Halo.mp3', 'Beyoncé - Halo.mp3'], ['Niño ng Ñ.ogg', 'Niño ng Ñ.ogg'], ['a:b*c.txt', 'a_b_c.txt'], ['C:\\x\\Song 2.mp3', 'Song 2.mp3']];
  for (const [a, b] of cases) check('upload name ' + JSON.stringify(a), uploadName(a) === b, uploadName(a));
  check('in a browser (not the TV app) the name is used as it is', uploadName('Song 🎤.mp3', false) === 'Song 🎤.mp3');
}
console.log(fails ? `${fails} karaoke unit test(s) FAILED` : 'karaoke unit tests passed');
process.exitCode = fails ? 1 : 0;
