// TV karaoke fixes from the 27 Nov review: pitch that arrives late in a Wi-Fi burst lands where it was sung also with
// a song's real audio playing; songs added from the PC while a song plays don't flip the screen back to the list over
// the song, and focus stays on the song he sang (not the Pitch bars button); #AUDIO: (UltraStar 1.x) finds the audio.
// node tests/e2e/tv-review5.cjs
const fs = require('fs'); const path = require('path');
const { test, FIXTURES } = require('./lib.cjs');
const P = [0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7];
const ALT = '#TITLE:A\n#ARTIST:T\n#MP3:tones.wav\n#BPM:300\n#GAP:500\n' + P.map((p, i) => ': ' + (i * 5) + ' 5 ' + p + ' la').join('\n') + '\nE\n';
const SHORT = '#TITLE:Short song\n#ARTIST:Tester\n#BPM:300\n#GAP:500\n: 0 8 0 Do \n: 8 8 4 re \n- 18\n* 20 8 7 mi\nE\n';
const AUDIO1 = '#VERSION:1.0.0\n#TITLE:New format\n#ARTIST:Tester\n#AUDIO:tones.wav\n#BPM:300\n#GAP:1000\n: 0 20 0 la \n: 20 20 2 la\nE\n';
test('tv-review5', async ({ newPage, check, url, sleep }) => {
  const scores = {};
  for (const mode of ['steady', 'burst']) {
    const p = await newPage({ viewport: { width: 960, height: 540 } });
    await p.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ txt: 'songs/a.txt' }]) }));
    await p.route('**/songs/a.txt', (r) => r.fulfill({ contentType: 'text/plain', body: ALT }));
    await p.route('**/songs/tones.wav', (r) => r.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(path.join(FIXTURES, 'tones.wav')) }));
    await p.goto(url + 'tv.html'); await p.waitForSelector('#songs button');
    await p.click('#songs button[data-i="0"]'); await p.waitForSelector('#sing:not([hidden])');
    await p.evaluate((mode) => {
      const P = [0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7, 0, 7]; const notes = P.map((x, i) => ({ t: 500 + i * 250, dur: 250, midi: 60 + x }));
      let seq = 1, q = [];
      window.__s = setInterval(() => {
        const st = SHTV.state(); if (st.screen !== 'sing') return; const t = st.t - 120;
        const n = notes.find((x) => t >= x.t && t < x.t + x.dur);
        const m = JSON.stringify({ v: 1, type: 'pitch', seq: ++seq, hz: n ? 440 * Math.pow(2, (n.midi - 69) / 12) : 0, conf: 0.9, ms: Math.round(performance.now() + 5000) });
        if (mode === 'steady') SHTV.message(m); else q.push(m);
      }, 20);
      if (mode === 'burst') window.__f = setInterval(() => { const now = performance.now(); q.forEach((m) => SHTV.message(m, now)); q = []; }, 200);
    }, mode);
    await sleep(4400);
    scores[mode] = (await p.evaluate(() => SHTV.state())).points;
    await p.close();
  }
  check('pitch in 200 ms Wi-Fi bursts scores about the same as steady pitch, with the song\'s audio playing', scores.steady > 6000 && scores.burst >= scores.steady * 0.85, JSON.stringify(scores));

  const p = await newPage({ viewport: { width: 960, height: 540 } });
  let slow = false;
  await p.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ txt: 'songs/a.txt' }, { txt: 'songs/b.txt' }]) }));
  await p.route('**/songs/a.txt', async (r) => { if (slow) await new Promise((res) => setTimeout(res, 800)); r.fulfill({ contentType: 'text/plain', body: AUDIO1 }); });
  await p.route('**/songs/b.txt', (r) => r.fulfill({ contentType: 'text/plain', body: SHORT }));
  await p.route('**/songs/tones.wav', (r) => r.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(path.join(FIXTURES, 'tones.wav')) }));
  await p.goto(url + 'tv.html'); await p.waitForSelector('#songs button');
  const a = await p.evaluate(() => [...document.querySelectorAll('#songs button')].map((b) => b.textContent));
  check('#AUDIO: chart listed', a.some((x) => /New format/.test(x)), JSON.stringify(a));
  await p.click('#songs button[data-i="0"]'); await p.waitForSelector('#sing:not([hidden])'); await sleep(600);
  check('#AUDIO: its audio plays', await p.evaluate(() => !document.getElementById('audio').paused && /tones\.wav/.test(document.getElementById('audio').src)));
  await p.evaluate(() => SHTV.back()); await p.waitForSelector('#library:not([hidden])');
  // sang song 1 (b), back to the list, songs added from the PC: focus stays on that song
  await p.click('#songs button[data-i="1"]'); await p.waitForSelector('#sing:not([hidden])');
  await sleep(300); await p.evaluate(() => SHTV.back()); await p.waitForSelector('#library:not([hidden])');
  await p.evaluate(() => SHTV.songsChanged()); await sleep(500);
  check('songs added while on the list: focus stays on the song he sang', await p.evaluate(() => document.activeElement.dataset.i) === '1', await p.evaluate(() => document.activeElement.id || document.activeElement.dataset.i));
  // songs added during a song; Back; OK on a song while the list is still reloading
  await p.click('#songs button[data-i="1"]'); await p.waitForSelector('#sing:not([hidden])');
  await p.evaluate(() => SHTV.songsChanged()); slow = true;
  await sleep(200); await p.evaluate(() => SHTV.back());
  await p.evaluate(() => document.querySelector('#songs button[data-i="0"]').click());
  await sleep(1500);
  const st = await p.evaluate(() => ({ screen: SHTV.state().screen, playing: !document.getElementById('audio').paused, lib: !document.getElementById('library').hidden }));
  check('the late reload doesn\'t put the list over the song he started', st.screen === 'sing' && !st.lib && st.playing, JSON.stringify(st));
  // OK held down: the song doesn't pause and resume
  await p.keyboard.down('Enter'); await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))); await p.keyboard.up('Enter');
  check('a held OK pauses once, repeats ignored', (await p.evaluate(() => SHTV.state().paused)) === true);
});
