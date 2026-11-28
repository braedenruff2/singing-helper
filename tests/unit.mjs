// Unit tests for lyrics.js (LRC + UltraStar parsing, LRCLIB lookup with a fake fetch). Node only.
//   node tests/unit.mjs
import { parseLrc, parseUltraStar, fetchSyncedLyrics } from '../lyrics.js';
import { readFileSync } from 'fs';

let fails = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? '  (' + detail + ')' : ''}`); if (!ok) fails++; };

// ---- parseLrc
{
  const c = parseLrc('[00:01:50]colon style\n[00:03]no fraction\n[01:02.5]half');
  check('LRC: [mm:ss:xx] and [mm:ss] stamps read', c.map((x) => x.t).join(',') === '1500,3000,62500', c.map((x) => x.t).join(','));
}
{
  // word tags written <mm:ss:xx> (old code: the line's words were all lost)
  const c = parseLrc('[00:12:00]<00:12:00>Hello <00:12:50>world\n[00:15:00]next');
  check('LRC: <mm:ss:xx> word tags read, text kept', c.length === 2 && c[0].text === 'Hello world' && c[0].words && c[0].words[1].t === 12500, JSON.stringify(c[0]));
  const d = parseLrc('[00:10.00]a\n[00:10.00]b\n[00:12.00]c');
  check('LRC: two lines at the same time become one (the first used to never show)', d.length === 2 && d[0].text === 'a / b' && d[0].end === 12000, JSON.stringify(d));
}
{
  const l = parseLrc('[ar:Someone]\n[00:01.00] one\n[00:03.50]two\r\n[00:06.00]\n[00:10.00] three\n');
  check('LRC: metadata skipped, lines in order', l.map((x) => x.text).join('|') === 'one|two||three', JSON.stringify(l.map((x) => x.text)));
  check('LRC: times in ms', l[0].t === 1000 && l[1].t === 3500, l.map((x) => x.t).join(','));
  check('LRC: end = next line start, last +5 s', l[0].end === 3500 && l[3].end === 15000);
  check('LRC: long empty gap kept as a marker', l[2].text === '' && l[2].end - l[2].t === 4000);
  const short = parseLrc('[00:01.00]a\n[00:02.00]\n[00:03.00]b');
  check('LRC: short empty line dropped', short.length === 2, short.length);
}
{
  const l = parseLrc('[00:20.00][00:50.00]chorus line\n[00:10.00]verse');
  check('LRC: one line, two stamps -> two lines, sorted', l.map((x) => x.t).join(',') === '10000,20000,50000' && l[2].text === 'chorus line');
}
{
  const l = parseLrc('[00:12.00]<00:12.00>Hello <00:12.50>world\n[00:15.00]next');
  check('LRC word tags: words and times', l[0].text === 'Hello world' && l[0].words.length === 2 && l[0].words[1].t === 12500, JSON.stringify(l[0].words));
  const r = parseLrc('[00:12.00][01:12.00]<00:12.00>Hi <00:12.40>there');
  const second = r.find((x) => x.t === 72000);
  check('LRC word tags on a repeated line move with it', second && second.words[0].t === 72000 && second.words[1].t === 72400, JSON.stringify(second && second.words));
  check('LRC word tags: first copy unchanged', r[0].words[1].t === 12400);
}
{
  // the first word often has no tag of its own (the line stamp covers it); it used to vanish
  const l = parseLrc('[00:12.00]Hello <00:12.50>world');
  check('LRC word tags: untagged first word kept', l[0].text === 'Hello world' && l[0].words[0].text === 'Hello ' && l[0].words[0].t === 12000, JSON.stringify(l[0]));
  // [offset:+500] means the lyrics come 0.5 s earlier
  const o = parseLrc('[offset:+500]\n[00:12.00]a\n[00:15.00]b');
  check('LRC: [offset:] tag applied', o[0].t === 11500 && o[1].t === 14500, o.map((x) => x.t).join(','));
  const n = parseLrc('[offset:-250]\n[00:00.10]a');
  check('LRC: negative offset, never below 0', n[0].t === 350, n[0].t);
  const ow = parseLrc('[offset:+500]\n[00:12.00]Hello <00:12.50>world');
  check('LRC: offset moves word times too, untagged first word included', ow[0].words[0].t === 11500 && ow[0].words[1].t === 12000, JSON.stringify(ow[0].words));
}
{
  check('LRC: empty text gives no lines', parseLrc('').length === 0);
  const l = parseLrc('[1:02.5]x');
  check('LRC: one-digit minutes and one decimal', l[0].t === 62500, l[0] && l[0].t);
}

// ---- parseUltraStar
{
  // #ECHO:yes: freestyle notes are listen notes (played, not scored); without it freestyle stays plain freestyle
  const e = parseUltraStar('#TITLE:E\n#BPM:120\n#ECHO:yes\nF 0 8 0 listen\n: 10 10 0 you\nE\n');
  check('ECHO: listen notes marked, sung ones not', e.echo === true && e.notes[0].listen === true && e.notes[0].free && !e.notes[1].listen, JSON.stringify(e.notes));
  const f = parseUltraStar('#TITLE:E\n#BPM:120\nF 0 8 0 x\n: 10 10 0 y\nE\n');
  check('no ECHO: freestyle is not a listen note', f.echo === false && !f.notes[0].listen);
  const ex = parseUltraStar(readFileSync(new URL('../examples/echo.txt', import.meta.url), 'utf8'));
  const iv = parseUltraStar(readFileSync(new URL('../examples/echo-intervals.txt', import.meta.url), 'utf8'));
  check('examples/echo-intervals.txt: 10 rounds of two listen notes then the same two to sing', iv.echo && iv.notes.length === 40 && iv.notes.every((n, i) => (i % 4 < 2) === !!n.listen && (i % 4 < 2 || n.midi === iv.notes[i - 2].midi)));
  check('examples/echo.txt: 12 pairs, 3 s each, same pitch to sing back', ex.notes.length === 24 && ex.notes.every((n, i) => i % 2 ? !n.listen && n.midi === ex.notes[i - 1].midi : n.listen) && ex.notes[2].t - ex.notes[0].t === 3000);
}
{
  const txt = readFileSync(new URL('../examples/warmup-scale.txt', import.meta.url), 'utf8');
  const c = parseUltraStar(txt);
  check('UltraStar: warm-up has 45 notes', c.notes.length === 45, c.notes.length);
  check('UltraStar: lines grouped by breaks', c.lines.length >= 3, c.lines.length);
  check('UltraStar: notes sorted, indexes match', c.notes.every((n, i) => n.i === i && (i === 0 || n.t >= c.notes[i - 1].t)));
  check('UltraStar: every line has words', c.lines.every((l) => l.words.length > 0));
}
{
  const c = parseUltraStar('﻿#TITLE:T\n#BPM:120,5\n#GAP:1000\n: 0 4 0 Hel\n* 4 4 2 lo~\nF 8 2 0 ah\n- 12\n: 16 4 -12 there\nE\n: 100 1 1 ignored');
  check('UltraStar: BOM, decimal comma BPM', c.title === 'T' && c.notes.length === 4);
  const ms = 60000 / (120.5 * 4);
  check('UltraStar: times from BPM and GAP', Math.abs(c.notes[1].t - (1000 + 4 * ms)) < 1e-6 && Math.abs(c.notes[0].dur - 4 * ms) < 1e-6);
  check('UltraStar: pitch 0 = C4 (60), negative pitches', c.notes[0].midi === 60 && c.notes[3].midi === 48);
  check('UltraStar: golden, freestyle, ~ removed', c.notes[1].golden && c.notes[2].free && c.notes[1].text === 'lo');
  check('UltraStar: stops at E', c.notes.length === 4);
  check('UltraStar: line break splits lines', c.lines.length === 2 && c.lines[0].text === 'Helloah' && c.lines[1].text === 'there', JSON.stringify(c.lines.map((l) => l.text)));
  let threw = false; try { parseUltraStar('hello'); } catch (_) { threw = true; }
  check('UltraStar: not a chart -> error', threw);
}

{
  // mid-song tempo changes ("B beat bpm"): times and lengths follow the new BPM from that beat on
  const c = parseUltraStar('#BPM:150\n#GAP:500\n: 0 4 0 a\n: 8 4 2 b\nB 16 300\n- 14\n: 16 4 4 c\n: 24 8 5 d\nB 32 75\n: 40 2 7 e\nE');
  const m1 = 60000 / 600, m2 = 60000 / 1200, m3 = 60000 / 300;
  const want = [500, 500 + 8 * m1, 500 + 16 * m1, 500 + 16 * m1 + 8 * m2, 500 + 16 * m1 + 16 * m2 + 8 * m3];
  check('UltraStar B lines: note times', c.notes.every((n, i) => Math.abs(n.t - want[i]) < 1e-6), c.notes.map((n) => n.t).join(','));
  check('UltraStar B lines: lengths at the tempo of their beat', Math.abs(c.notes[0].dur - 4 * m1) < 1e-6 && Math.abs(c.notes[3].dur - 8 * m2) < 1e-6 && Math.abs(c.notes[4].dur - 2 * m3) < 1e-6);
  check('UltraStar B lines: the break before the change stays at its beat', c.lines.length === 2 && c.lines[1].text === 'cde', JSON.stringify(c.lines.map((l) => l.text)));
  const span = parseUltraStar('#BPM:150\n: 0 8 0 long\nB 4 300\nE');
  check('UltraStar B lines: a note across a change', Math.abs(span.notes[0].dur - (4 * m1 + 4 * m2)) < 1e-6, span.notes[0].dur);
  const same = parseUltraStar('#BPM:150\n#GAP:0\n: 0 4 0 a\n: 8 4 0 b\nE');
  check('UltraStar: no B lines, unchanged', same.notes[1].t === 8 * m1);
  const at0 = parseUltraStar('#BPM:150\nB 0 300\n: 8 4 0 a\nE');
  check('UltraStar B lines: a change at beat 0 replaces the header BPM', Math.abs(at0.notes[0].t - 8 * m2) < 1e-6);
  const bad = parseUltraStar('#BPM:150\nB 4 0\nB x 100\n: 8 4 0 a\nE');
  check('UltraStar B lines: a zero or broken one is ignored', bad.notes[0].t === 8 * m1);
  const rel = parseUltraStar('#BPM:150\n#RELATIVE:yes\n: 0 2 0 a\n- 8 8\nB 0 300\n: 4 2 0 b\nE');
  check('UltraStar B lines in relative mode count from the line', Math.abs(rel.notes[1].t - (8 * m1 + 4 * m2)) < 1e-6, rel.notes[1].t);
  // duets: both singers follow a tempo change, whichever part it is written in (or before P1)
  const du = '#BPM:150\n#GAP:0\nP1\n: 0 4 0 a\nB 16 300\n: 32 4 0 b\nP2\n: 0 4 0 X\n: 32 4 0 Y\nE';
  const d1 = parseUltraStar(du, { part: 1 }), d2 = parseUltraStar(du, { part: 2 });
  check('UltraStar duet: a B line under P1 times P2 too', Math.abs(d2.notes[1].t - d1.notes[1].t) < 1e-6 && Math.abs(d2.notes[1].t - (16 * m1 + 16 * m2)) < 1e-6, d1.notes[1].t + ' vs ' + d2.notes[1].t);
  const du0 = parseUltraStar('#BPM:150\nB 0 300\nP1\n: 8 4 0 a\nP2\n: 8 4 0 X\nE', { part: 2 });
  check('UltraStar duet: a B line before P1 counts for P2', Math.abs(du0.notes[0].t - 8 * m2) < 1e-6, du0.notes[0].t);
  const duUnder2 = parseUltraStar('#BPM:150\nP1\n: 32 4 0 a\nP2\nB 16 300\n: 0 4 0 X\nE', { part: 1 });
  check('UltraStar duet: a B line under P2 times P1 too', Math.abs(duUnder2.notes[0].t - (16 * m1 + 16 * m2)) < 1e-6, duUnder2.notes[0].t);
  const durel = parseUltraStar('#BPM:150\n#RELATIVE:yes\nP1\n: 0 2 0 a\n- 8 8\nB 0 300\n: 4 2 0 b\nP2\n: 0 2 0 X\n- 8 8\n: 4 2 0 Y\nE', { part: 2 });
  check('UltraStar duet, relative: P2 lines and P1\'s change line up', Math.abs(durel.notes[1].t - (8 * m1 + 4 * m2)) < 1e-6 && durel.lines.length === 2, durel.notes[1].t);
}
{
  // relative mode: beats restart after each break; "- 8 12" = the next line starts 12 beats after the last one did
  const rel = parseUltraStar('#BPM:150\n#GAP:0\n#RELATIVE:yes\n: 0 2 0 a\n: 4 2 2 b\n- 8 12\n: 0 2 4 c\n: 4 2 5 d\n- 6\n: 1 2 7 e\nE');
  const ms = 60000 / 600;
  check('UltraStar relative: beats offset by each line', rel.notes.map((n) => n.t / ms).join(',') === '0,4,12,16,19', rel.notes.map((n) => n.t / ms).join(','));
  check('UltraStar relative: three lines in order', rel.lines.map((l) => l.text).join('|') === 'ab|cd|e', rel.lines.map((l) => l.text).join('|'));
  const abs = parseUltraStar('#BPM:150\n: 0 2 0 a\n- 8 12\n: 12 2 4 c\nE');
  check('UltraStar: "- a b" break in normal mode', abs.lines.length === 2 && abs.notes[1].t / ms === 12);
}
{
  // duet: P1 only (P2 used to be merged in, flipping the target between singers); breaks out of order still group right
  const d = parseUltraStar('#BPM:150\n#GAP:0\nP1\n: 0 2 0 a\n- 4\n: 8 2 2 b\nP2\n: 2 2 9 X\n- 6\n: 10 2 9 Y\nE');
  check('UltraStar duet: only the first singer', d.notes.map((n) => n.text).join('') === 'ab', d.notes.map((n) => n.text).join(''));
  check('UltraStar duet: lines from P1', d.lines.map((l) => l.text).join('|') === 'a|b', d.lines.map((l) => l.text).join('|'));
  check('UltraStar duet: knows there are 2 parts', d.parts === 2 && d.part === 1 && d.partNames.join('|') === 'Singer 1|Singer 2', JSON.stringify([d.parts, d.part, d.partNames]));
  const d2 = parseUltraStar('#BPM:150\n#GAP:0\n#DUETSINGERP1:Ann\n#DUETSINGERP2:Bo\nP1\n: 0 2 0 a\n- 4\n: 8 2 2 b\nP2\n: 2 2 9 X\n- 6\n: 10 2 9 Y\nE', { part: 2 });
  check('UltraStar duet: the second singer when asked', d2.notes.map((n) => n.text).join('') === 'XY' && d2.notes[0].midi === 69, d2.notes.map((n) => n.text).join(''));
  check('UltraStar duet: P2 lines', d2.lines.map((l) => l.text).join('|') === 'X|Y', d2.lines.map((l) => l.text).join('|'));
  check('UltraStar duet: singer names from the header', d2.partNames.join('|') === 'Ann|Bo', d2.partNames.join('|'));
  const solo = parseUltraStar('#BPM:150\n: 0 2 0 a\nE', { part: 2 });
  check('UltraStar: a part that isn\'t there falls back to the only one', solo.notes.length === 1 && solo.parts === 1 && solo.part === 1);
  const rd = parseUltraStar('#BPM:150\n#RELATIVE:yes\nP1\n: 0 2 0 a\n- 4\n: 0 2 0 b\nP2\n: 0 2 5 X\nE', { part: 2 });
  check('UltraStar relative duet: P2 counts its beats from 0', rd.notes[0].t === 0, String(rd.notes[0].t));
  check('UltraStar: a lyric syllable "P1" isn\'t read as a part marker', parseUltraStar('#BPM:150\n: 0 2 0 P1\nE').notes.length === 1);
  const o = parseUltraStar('#BPM:150\n: 0 2 0 a\n: 8 2 0 b\n: 16 2 0 c\n- 12\n- 4\nE');
  check('UltraStar: breaks in any order', o.lines.map((l) => l.text).join('|') === 'a|b|c', o.lines.map((l) => l.text).join('|'));
}
{
  const l = parseLrc('[00:01.00]<00:01.0x>tag');
  check('LRC: unreadable word tags -> no words array', l.length === 1 && l[0].words === undefined, JSON.stringify(l));
}

// ---- fetchSyncedLyrics with a fake fetch
const lrc = '[00:01.00]a line';
async function withFetch(handler, fn) {
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); return handler(String(u)); };
  try { return { result: await fn(), calls }; } finally { delete globalThis.fetch; }
}
const json = (j, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => j });
const np = { name: 'Song', firstArtist: 'Artist', album: 'Album', durationMs: 200000 };
{
  const { result, calls } = await withFetch((u) => (u.includes('/get?') ? json({ syncedLyrics: lrc }) : json([])), () => fetchSyncedLyrics(np));
  check('LRCLIB: exact match used', result && result[0].text === 'a line' && calls.length === 1);
  check('LRCLIB: asks with duration in seconds', /duration=200/.test(calls[0]), calls[0]);
}
{
  const { result, calls } = await withFetch((u) => (u.includes('/get?') ? json({ statusCode: 404 }, 404)
    : json([{ duration: 260, syncedLyrics: '[00:01.00]far' }, { duration: 203, syncedLyrics: '[00:01.00]near' }, { duration: 200, syncedLyrics: null, plainLyrics: 'x' }])), () => fetchSyncedLyrics(np));
  check('LRCLIB: falls back to search, closest synced duration', result && result[0].text === 'near' && calls.length === 2, result && result[0].text);
}
{
  const { result } = await withFetch((u) => (u.includes('/get?') ? json({}, 404) : json([{ duration: 260, syncedLyrics: '[00:01.00]live version' }])), () => fetchSyncedLyrics(np));
  check('LRCLIB: a version 60 s longer is not used', result === null, JSON.stringify(result));
}
{
  const { result } = await withFetch((u) => { if (u.includes('/get?')) throw new TypeError('network'); return json([{ duration: 199, syncedLyrics: lrc }]); }, () => fetchSyncedLyrics(np));
  check('LRCLIB: network error on get still searches', result && result.length === 1);
}
{
  const { result } = await withFetch(() => json({}, 404), () => fetchSyncedLyrics(np));
  check('LRCLIB: nothing found -> null', result === null);
}
{
  const { result } = await withFetch((u) => (u.includes('/get?') ? json({ syncedLyrics: '[ar:x]\nno timed lines' }) : json([])), () => fetchSyncedLyrics(np));
  check('LRCLIB: lyrics with no timed lines -> null (not an empty list)', result === null, JSON.stringify(result));
}

console.log(fails ? `unit: ${fails} FAILED` : 'unit: passed');
process.exitCode = fails ? 1 : 0;
