// The phone side of karaoke on the TV: in the phone app (window.SHAndroid) a "Karaoke on TV" panel finds the TV or
// takes its address (home network only), and while "Send my pitch to the TV" is ticked the sung pitch goes to the TV
// as small messages (about 50 a second while singing) that the TV page accepts. Not on the PC page.
// Then the whole path: those same messages fed into tv.html score a sung song.
//   node tests/e2e/tv-phone.cjs [fixtures/sing.wav]
const { test } = require('./lib.cjs');
test('tv-phone', async ({ url, newPage, check, sleep }) => {
  const pc = await newPage({ viewport: { width: 1280, height: 800 } });
  await pc.goto(url);
  check('PC page: no Karaoke on TV panel (a browser can\'t send to the TV)', (await pc.$('#tv-panel')) === null);
  await pc.close();

  const p = await newPage({ viewport: { width: 412, height: 915 } });
  await p.addInitScript(() => {
    window.__sent = []; window.__finds = 0;
    window.SHAndroid = {
      isApp: () => true,
      updateStatus: () => JSON.stringify({ version: '0.1.1', code: 1, allowed: true, checked: 0 }),
      updateCheck() {}, updateAllow() {}, updateInstall() {},
      tvSend: (ip, msg) => { window.__sent.push({ ip, msg, at: performance.now() }); return true; },
      tvFind: () => { window.__finds++; setTimeout(() => window.SHTVFound([{ ip: '192.168.1.50', name: 'AFTKA' }, { ip: '192.168.1.51', name: 'Other' }]), 50); },
    };
  });
  await p.goto(url);
  await p.waitForSelector('#tv-panel');
  check('phone app: the panel is there, nothing sent yet', (await p.evaluate(() => window.__sent.length)) === 0);
  await p.click('#tv-on');
  check('ticking without an address: asks for it, stays off', !(await p.isChecked('#tv-on')) && /address first/.test(await p.textContent('#tv-status')), await p.textContent('#tv-status'));
  await p.fill('#tv-ip', '8.8.8.8'); await p.dispatchEvent('#tv-ip', 'change');
  check('an internet address is refused', /home-network/.test(await p.textContent('#tv-status')), await p.textContent('#tv-status'));
  await p.click('#tv-find');
  await p.waitForFunction(() => document.getElementById('tv-ip').value === '192.168.1.50');
  check('Find TV fills in the first TV that answered and says so', /Found AFTKA \(192\.168\.1\.50\)\. 1 more/.test(await p.textContent('#tv-status')), await p.textContent('#tv-status'));
  check('... and remembers it', await p.evaluate(() => localStorage.getItem('tv_ip') === '192.168.1.50'));
  await p.check('#tv-on'); // also starts the mic
  await p.waitForFunction(() => window.__state.node, null, { timeout: 5000 });
  await sleep(3500); // the fake mic's file starts with 2 s of silence
  const got = await p.evaluate(async () => {
    const k = await import('./karaoke.js');
    const s = window.__sent.filter((x) => performance.now() - x.at < 1500 && performance.now() - x.at > 500);
    const msgs = window.__sent.map((x) => k.decodeMessage(x.msg));
    return { n: s.length, ips: [...new Set(window.__sent.map((x) => x.ip))], valid: msgs.every((m) => m && m.type === 'pitch'), sung: msgs.filter((m) => m && m.hz > 0).length,
      seqs: msgs.every((m, i) => i === 0 || m.seq === msgs[i - 1].seq + 1) };
  });
  check('pitch goes to the TV: about 50 a second at most', got.n >= 8 && got.n <= 55, got.n);
  check('... every message valid for the TV, in order', got.valid && got.seqs && got.ips.join() === '192.168.1.50', JSON.stringify(got));
  check('... with sung pitches in it (the fake mic sings)', got.sung > 5, got.sung);
  check('status says it\'s sending', /Sending to 192\.168\.1\.50/.test(await p.textContent('#tv-status')), await p.textContent('#tv-status'));
  // 28 Nov: UDP never says nobody is listening: the TV answers about once a second, and the phone says whether it does
  await p.waitForFunction(() => /isn’t answering/.test(document.querySelector('#tv-status').textContent), null, { timeout: 5000 });
  check('no answer from the TV: the phone says so (TV app open? same Wi-Fi?)', /Singing Helper TV open/.test(await p.textContent('#tv-status')), await p.textContent('#tv-status'));
  await p.evaluate(() => window.SHTVAck('192.168.1.99')); await sleep(2300);
  check('... an answer from another address doesn\'t count', /isn’t answering/.test(await p.textContent('#tv-status')));
  await p.evaluate(() => window.SHTVAck('192.168.1.50'));
  await p.waitForFunction(() => /the TV hears it/.test(document.querySelector('#tv-status').textContent), null, { timeout: 3000 });
  check('the TV answers: "the TV hears it"', true);
  await p.uncheck('#tv-on');
  const n0 = await p.evaluate(() => window.__sent.length); await sleep(400);
  check('untick: nothing more is sent', (await p.evaluate(() => window.__sent.length)) === n0);

  // the whole path: what the phone sent, replayed into the TV page as it arrived, scores against a chart of it
  const msgs = await p.evaluate(() => window.__sent.map((x) => ({ msg: x.msg, at: x.at })));
  const tv = await newPage({ viewport: { width: 960, height: 540 } });
  await tv.route('**/songs/index.json', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await tv.goto(url + 'tv.html'); await tv.waitForSelector('#songs button');
  const accepted = await tv.evaluate((msgs) => msgs.map((m) => SHTV.message(m.msg)).filter(Boolean).length, msgs);
  check('the TV page accepts every message the phone sent', accepted === msgs.length, accepted + ' of ' + msgs.length);
  check('TV status: phone mic connected', /connected/.test(await tv.textContent('#status')) && !/not connected/.test(await tv.textContent('#status')));
}, { mic: 'sing.wav' });
