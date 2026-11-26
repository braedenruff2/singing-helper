// The TV karaoke screen (tv.html) driven like the Fire TV remote: the song list from songs/index.json plus warm-ups,
// D-pad focus, a song on its clock with the phone's pitch arriving as messages (scored, drawn, best kept), pitch bars
// off (no score), a song with audio (pause, Back), stale/duplicate messages ignored, and the layout at TV sizes.
//   node tests/e2e/tv.cjs
const fs = require('fs');
const path = require('path');
const { test, FIXTURES } = require('./lib.cjs');
// 3 notes of 400 ms at #GAP 500 (BPM 300 = 50 ms beats), two lyric lines; no #MP3, so it runs on the clock
const SHORT = '#TITLE:Short song\n#ARTIST:Tester\n#BPM:300\n#GAP:500\n: 0 8 0 Do \n: 8 8 4 re \n- 18\n* 20 8 7 mi\nE\n';
const WITH_AUDIO = '#TITLE:With audio\n#ARTIST:Tester\n#MP3:tones.wav\n#BPM:300\n#GAP:1000\n: 0 20 0 la \n: 20 20 2 la\nE\n';
test('tv', async ({ newPage, url, check, shot, sleep }) => {
  const p = await newPage({ viewport: { width: 960, height: 540 } });
  await p.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ txt: 'songs/short.txt' }, { txt: 'songs/audio.txt' }, { txt: 'songs/broken.txt' }]) }));
  await p.route('**/songs/short.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT }));
  await p.route('**/songs/audio.txt', (r) => r.fulfill({ contentType: 'text/plain', body: WITH_AUDIO }));
  await p.route('**/songs/broken.txt', (r) => r.fulfill({ contentType: 'text/plain', body: 'not a chart' }));
  await p.route('**/songs/tones.wav', (r) => r.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(path.join(FIXTURES, 'tones.wav')) }));
  await p.goto(url + 'tv.html');
  await p.waitForSelector('#songs button');
  const titles = await p.$$eval('#songs .t', (e) => e.map((x) => x.textContent));
  check('song list: songs/index.json first, then the warm-ups; a broken chart left out', titles.join('|') === 'Short song|With audio|Warm-up: Warm-up scale|Warm-up: Arpeggios|Warm-up: Long held notes' || (titles.length === 5 && titles[0] === 'Short song' && titles[1] === 'With audio' && titles.slice(2).every((t) => t.startsWith('Warm-up'))), titles.join('|'));
  check('the first song has focus (the remote needs one)', await p.evaluate(() => document.activeElement && document.activeElement.dataset.i === '0'));
  await p.keyboard.press('ArrowDown');
  check('down moves to the next song', await p.evaluate(() => document.activeElement.dataset.i === '1'));
  await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp');
  check('up from the first song reaches the settings buttons', await p.evaluate(() => document.activeElement.id === 'lag'));
  check('status says the phone mic is not connected', /not connected/.test(await p.textContent('#status')), await p.textContent('#status'));
  await p.keyboard.press('ArrowDown');

  // ---- a song with the phone singing it right
  await p.keyboard.press('Enter');
  await p.waitForSelector('#sing:not([hidden])');
  await p.evaluate(() => {
    // the phone: pitch of the note that was due S.lag ms ago (what the singer is singing now, as heard by the TV)
    const notes = [{ t: 500, dur: 400, midi: 60 }, { t: 900, dur: 400, midi: 64 }, { t: 1500, dur: 400, midi: 67 }];
    let seq = 0;
    window.__sim = setInterval(() => {
      const st = SHTV.state(); if (st.screen !== 'sing') return;
      const t = st.t - 120, n = notes.find((x) => t >= x.t && t < x.t + x.dur);
      const hz = n ? 440 * Math.pow(2, (n.midi - 12 - 69) / 12) : 0; // an octave low: still right
      SHTV.message(JSON.stringify({ v: 1, type: 'pitch', seq: ++seq, hz, conf: 0.9 }));
    }, 20);
  });
  await sleep(1000);
  const mid = await p.evaluate(() => ({ line: document.getElementById('line').textContent, next: document.getElementById('next').textContent, score: +document.getElementById('score').textContent.replace(/\D/g, '') }));
  check('lyrics: the line being sung and the next one', /Do re/.test(mid.line) && /mi/.test(mid.next), JSON.stringify(mid));
  check('the score goes up while the phone sends the right notes', mid.score > 1000, mid.score);
  const drawn = await p.evaluate(() => { const c = document.getElementById('bars'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  check('pitch bars drawn', drawn > 1000, drawn);
  await p.waitForSelector('#done:not([hidden])', { timeout: 8000 });
  const fin = +(await p.textContent('#final')).replace(/\D/g, '');
  check('end of the song: the score (all right, an octave low)', fin >= 8500, fin);
  check('... a rating and "your best"', (await p.textContent('#rating')).length > 3 && /best/.test(await p.textContent('#best')), await p.textContent('#rating'));
  check('"Sing again" has focus', await p.evaluate(() => document.activeElement.id === 'again'));
  await p.evaluate(() => clearInterval(window.__sim));
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
  await p.waitForSelector('#library:not([hidden])');
  check('back in the list: the best score shows by the song', /best \d/.test(await p.textContent('#songs button[data-i="0"]')), await p.textContent('#songs button[data-i="0"]'));
  check('status: phone mic connected (messages came in)', /connected/.test(await p.textContent('#status')) && !/not connected/.test(await p.textContent('#status')), await p.textContent('#status'));

  // ---- late or repeated messages
  const dup = await p.evaluate(() => [SHTV.message('{"v":1,"type":"pitch","seq":900000,"hz":220,"conf":1}'), SHTV.message('{"v":1,"type":"pitch","seq":900000,"hz":220,"conf":1}'), SHTV.message('{"v":1,"type":"pitch","seq":899999,"hz":220,"conf":1}'), SHTV.message('rubbish')]);
  check('a repeated or late pitch message, or rubbish, is ignored', JSON.stringify(dup) === '[true,false,false,false]', JSON.stringify(dup));

  // ---- the phone app restarted: its numbers start again, low; after a quiet moment the TV takes them
  const restart = await p.evaluate(async () => {
    const a = SHTV.message('{"v":1,"type":"pitch","seq":5,"hz":220,"conf":1}', performance.now()); // far below the last: a new start
    const b = SHTV.message('{"v":1,"type":"pitch","seq":4,"hz":220,"conf":1}', performance.now()); // one late packet: still dropped
    const c = SHTV.message('{"v":1,"type":"pitch","seq":3,"hz":220,"conf":1}', performance.now() + 2500); // after 2.5 s quiet: anything goes
    return [a, b, c];
  });
  check('a restarted phone (numbers start again) is heard at once; a late packet still isn\'t', JSON.stringify(restart) === '[true,false,true]', JSON.stringify(restart));

  // ---- pitch bars off: just the lyrics, no score
  await p.click('#pitch');
  check('pitch bars off (remembered)', (await p.textContent('#pitch')) === 'Pitch bars: Off' && await p.evaluate(() => localStorage.getItem('tv_pitch') === 'false'));
  await p.click('#songs button[data-i="0"]');
  await p.waitForSelector('#sing:not([hidden])');
  check('pitch off: no bars on screen', await p.evaluate(() => getComputedStyle(document.getElementById('bars')).display === 'none'));
  await p.evaluate(() => SHTV.message('{"v":1,"type":"pitch","seq":900001,"hz":261.63,"conf":1}'));
  await p.waitForSelector('#done:not([hidden])', { timeout: 8000 });
  check('pitch off: no score at the end', /no score/.test(await p.textContent('#best')) && (await p.textContent('#final')) === '♪');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#library:not([hidden])');
  await p.click('#pitch');

  // ---- a song with audio: the TV plays it; OK pauses; Back stops
  await p.click('#songs button[data-i="1"]');
  await p.waitForSelector('#sing:not([hidden])');
  await sleep(1200);
  const a = await p.evaluate(() => ({ t: SHTV.state().t, playing: !document.getElementById('audio').paused }));
  check('the song plays and its time drives the screen', a.playing && a.t > 700 && a.t < 2500, JSON.stringify(a));
  await p.keyboard.press('Enter');
  const t1 = await p.evaluate(() => SHTV.state().t); await sleep(400); const t2 = await p.evaluate(() => SHTV.state().t);
  check('OK pauses the song (time stands still, "Paused" shown)', Math.abs(t2 - t1) < 30 && await p.isVisible('#paused'), t1 + ' -> ' + t2);
  await p.keyboard.press('Enter'); await sleep(300);
  check('OK again carries on', await p.evaluate(() => !document.getElementById('audio').paused) && !(await p.isVisible('#paused')));
  const handled = await p.evaluate(() => SHTV.back());
  check('Back (the Android button) stops it and returns to the list', handled && await p.evaluate(() => document.getElementById('audio').paused && SHTV.state().screen === 'library'));
  check('Back on the list is left to the app (it leaves)', !(await p.evaluate(() => SHTV.back())));

  // ---- the TV app leaves the screen (Home): the song pauses
  await p.click('#songs button[data-i="1"]'); await p.waitForSelector('#sing:not([hidden])'); await sleep(600);
  await p.evaluate(() => SHTV.hide());
  check('Home on the remote pauses the song', await p.evaluate(() => document.getElementById('audio').paused && SHTV.state().paused));
  await p.evaluate(() => SHTV.back()); await p.waitForSelector('#library:not([hidden])');
  // ---- OK twice quickly while the song loads: it still plays after the second OK (no silent clock)
  await p.click('#songs button[data-i="1"]'); await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
  await sleep(900);
  check('OK, OK while loading: the song plays with sound', await p.evaluate(() => !document.getElementById('audio').paused && !SHTV.state().paused), JSON.stringify(await p.evaluate(() => SHTV.state())));
  await p.evaluate(() => SHTV.back()); await p.waitForSelector('#library:not([hidden])');

  // ---- TV sizes
  for (const vp of [{ width: 960, height: 540 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await p.setViewportSize(vp);
    await sleep(100);
    const over = await p.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    check(`the list fits ${vp.width}x${vp.height} (no page scroll)`, over.x <= 0 && over.y <= 0, JSON.stringify(over));
  }
  await shot(p, 'tv-list.png');
  await p.setViewportSize({ width: 960, height: 540 });
  await p.click('#songs button[data-i="0"]'); await sleep(700);
  const lay = await p.evaluate(() => ({ line: document.getElementById('line').getBoundingClientRect().bottom, prog: document.getElementById('progress').getBoundingClientRect().bottom, h: innerHeight, bars: document.getElementById('bars').clientHeight }));
  check('a new song shows its own words, not the last song\'s', /Do/.test(await p.textContent('#line')), await p.textContent('#line'));
  check('singing screen: bars, lyrics and progress fit on the TV', lay.prog <= lay.h && lay.bars > 150, JSON.stringify(lay));
  await shot(p, 'tv-sing.png');

  // ---- inside the TV app: its address for the phone and for adding songs; songs added from a PC show up
  const q = await newPage({ viewport: { width: 960, height: 540 } });
  await q.addInitScript(() => { window.SHTVAndroid = { info: () => JSON.stringify({ ip: '192.168.1.50', port: 47321, upload: 'http://192.168.1.50:47322/', code: '0427', name: 'AFTKA' }) }; });
  let list = [{ txt: 'songs/short.txt' }];
  await q.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(list) }));
  await q.route('**/songs/short.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT }));
  await q.route('**/songs/new.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT.replace('Short song', 'New song') }));
  await q.goto(url + 'tv.html'); await q.waitForSelector('#songs button');
  check('TV app: the phone is told where to send (the TV address)', /Karaoke on TV > 192\.168\.1\.50/.test(await q.textContent('#status')), await q.textContent('#status'));
  check('TV app: how to add songs from a PC, with the code', /http:\/\/192\.168\.1\.50:47322\/.*0427/.test(await q.textContent('#add')), await q.textContent('#add'));
  list = [{ txt: 'songs/new.txt' }, { txt: 'songs/short.txt' }];
  await q.evaluate(() => SHTV.songsChanged());
  await q.waitForFunction(() => document.querySelectorAll('#songs button').length === 5);
  check('songs added from the PC appear in the list', (await q.textContent('#songs')).includes('New song'));
  check('... with a song still focused', await q.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#songs')));
  // the TV app keeps uploads under a safe name ("Halo [Karaoke].mp3" -> "Halo _Karaoke_.mp3"): the chart still finds it
  const asked = [];
  await q.route('**/songs/Halo*', (r) => { asked.push(decodeURIComponent(new URL(r.request().url()).pathname)); r.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(path.join(FIXTURES, 'tones.wav')) }); });
  await q.route('**/songs/halo.txt', (r) => r.fulfill({ contentType: 'text/plain', body: WITH_AUDIO.replace('With audio', 'Halo').replace('tones.wav', 'Halo [Karaoke] #1.mp3') }));
  list = [{ txt: 'songs/halo.txt' }];
  await q.evaluate(() => SHTV.songsChanged());
  await q.waitForFunction(() => document.querySelector('#songs').textContent.includes('Halo'));
  await q.click('#songs button[data-i="0"]'); await sleep(800);
  check('an uploaded song\'s audio is found under its safe name', asked.includes('/songs/Halo _Karaoke_ _1.mp3') && await q.evaluate(() => !document.getElementById('audio').paused), JSON.stringify(asked));
  await q.evaluate(() => SHTV.back());
  await q.evaluate(() => SHTV.problem('The TV couldn\'t listen for the phone: port in use'));
  check('a listening problem is shown', /port in use/.test(await q.textContent('#status')));

  // ---- a song whose audio is missing: lyrics and bars on the clock, and it still ends with a score
  const r2 = await newPage({ viewport: { width: 960, height: 540 } });
  await r2.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ txt: 'songs/gone.txt' }, { txt: 'songs/short.txt' }]) }));
  await r2.route('**/songs/gone.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT.replace('Short song', 'Gone').replace('#BPM', '#MP3:gone.mp3\n#BPM') }));
  await r2.route('**/songs/short.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT }));
  await r2.goto(url + 'tv.html'); await r2.waitForSelector('#songs button');
  await r2.click('#songs button[data-i="0"]');
  await r2.waitForSelector('#done:not([hidden])', { timeout: 8000 });
  check('audio missing: the song runs on the clock and ends at the score', /no sound/.test(await r2.textContent('#now')) || (await r2.isVisible('#done')), await r2.textContent('#now'));
  await r2.keyboard.press('ArrowRight'); await r2.keyboard.press('Enter'); await r2.waitForSelector('#library:not([hidden])');

  // ---- Wi-Fi delivers the phone's pitch in bursts every 200 ms: the phone's own times keep the score right
  await r2.click('#songs button[data-i="1"]'); await r2.waitForSelector('#sing:not([hidden])');
  await r2.evaluate(() => {
    const notes = [{ t: 500, dur: 400, midi: 60 }, { t: 900, dur: 400, midi: 64 }, { t: 1500, dur: 400, midi: 67 }];
    let seq = 1000, q = [];
    window.__sim2 = setInterval(() => {
      const st = SHTV.state(); if (st.screen !== 'sing') return;
      const t = st.t - 120, n = notes.find((x) => t >= x.t && t < x.t + x.dur);
      q.push(JSON.stringify({ v: 1, type: 'pitch', seq: ++seq, hz: n ? 440 * Math.pow(2, (n.midi - 69) / 12) : 0, conf: 0.9, ms: Math.round(performance.now() + 5000) }));
    }, 20);
    window.__flush = setInterval(() => { const now = performance.now(); q.forEach((m) => SHTV.message(m, now)); q = []; }, 200);
  });
  await r2.waitForSelector('#done:not([hidden])', { timeout: 8000 });
  await r2.evaluate(() => { clearInterval(window.__sim2); clearInterval(window.__flush); });
  const burst = +(await r2.textContent('#final')).replace(/\D/g, '');
  check('pitch in 200 ms bursts still scores (phone times used)', burst >= 7000, burst);
});
