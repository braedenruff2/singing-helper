// Spotify edge cases (all mocked): a brief "nothing playing" keeps the song's chart and score,
// lyrics for an old song never replace the new song's, an expired token is refreshed without
// a "Nothing playing" blink, Loop line ignores a stale position right after seeking, and a
// "too many requests" answer pauses polling.
// node tests/e2e/spotify-robust.cjs
const path = require('path');
const { test, fakeSpotifyLogin, trackJson, EXAMPLES } = require('./lib.cjs');

test('spotify-robust', async ({ url, newPage, check, sleep }) => {
  const p = await newPage({ viewport: { width: 1280, height: 800 } });
  // a scripted Spotify: mode decides what /currently-playing answers
  const sp = { mode: 'play', id: 'trkA', name: 'Song A', base: Date.now(), startPos: 2000, calls: 0, seeks: [], stale: 0, tokens: 0, after429: 0 };
  const pos = () => sp.startPos + (Date.now() - sp.base);
  await p.route('https://api.spotify.com/v1/me/player/currently-playing', (r) => {
    sp.calls++;
    if (sp.mode === 'gap') return r.fulfill({ status: 204, body: '' });
    if (sp.mode === '401once') { sp.mode = 'play'; return r.fulfill({ status: 401, json: { error: { status: 401 } } }); }
    if (sp.mode === '429') { sp.after429++; return r.fulfill({ status: 429, headers: { 'Retry-After': '4' }, json: {} }); }
    // right after a seek, report the position from before it for a while (Spotify's lag)
    if (sp.stale > 0) { sp.stale--; return r.fulfill({ json: trackJson(sp.id, sp.name, sp.preSeek + (Date.now() - sp.preSeekAt)) }); }
    r.fulfill({ json: trackJson(sp.id, sp.name, pos(), sp.uri ? { item: { id: null, uri: sp.uri, name: sp.name, duration_ms: 200000, artists: [{ name: 'A' }], album: { name: 'B', images: [] } } } : {}) });
  });
  await p.route('https://api.spotify.com/v1/me/player/seek**', (r) => {
    const ms = +new URL(r.request().url()).searchParams.get('position_ms');
    sp.seeks.push(ms);
    sp.preSeek = pos(); sp.preSeekAt = Date.now(); sp.stale = 2;
    sp.startPos = ms; sp.base = Date.now();
    r.fulfill({ status: 204, body: '' });
  });
  await p.route('https://accounts.spotify.com/api/token', (r) => {
    sp.tokens++;
    if (sp.tokenMode === 'revoked') return r.fulfill({ status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token revoked' } });
    r.fulfill({ json: { access_token: 'a2', expires_in: 3600 } });
  });
  // LRCLIB: Song A's lyrics arrive slowly, Song B's at once
  await p.route('https://lrclib.net/**', async (r) => {
    const u = r.request().url();
    if (/track_name=Song\+A/.test(u)) { await sleep(2500); return r.fulfill({ json: { syncedLyrics: '[00:01.00]old song words\n[00:30.00]more old' } }); }
    r.fulfill({ json: { syncedLyrics: '[00:01.00]new song words\n[00:30.00]more new' } });
  });
  await p.goto(url);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('outDelay', '300'); }); // Bluetooth-like speaker delay
  await fakeSpotifyLogin(p);
  await p.reload();
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkA');

  // 1. lyrics race: switch to Song B while Song A's lyrics are still loading
  sp.id = 'trkB'; sp.name = 'Song B';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkB', null, { timeout: 5000 });
  await sleep(3200); // Song A's slow answer arrives during this wait
  const lyr = await p.evaluate(() => window.__state.lyrics && window.__state.lyrics[0].text);
  check("old song's late lyrics don't replace the new song's", lyr === 'new song words', lyr);

  // 2. brief "nothing playing": chart, score and loop survive when the same song comes back
  await p.setInputFiles('#usfile', path.join(EXAMPLES, 'warmup-scale.txt'));
  await p.waitForFunction(() => window.__state.chart);
  await p.evaluate(() => { window.__state.hits.set(0, { good: 5, total: 5, near: 5, sum: 0, sq: 0, trace: [] }); });
  sp.mode = 'gap';
  await p.waitForFunction(() => !window.__state.track, null, { timeout: 5000 });
  check('gap shows Nothing playing', /Nothing playing/.test(await p.textContent('#np')));
  sp.mode = 'play';
  await p.waitForFunction(() => window.__state.track, null, { timeout: 5000 });
  const kept = await p.evaluate(() => ({ chart: !!window.__state.chart, hits: window.__state.hits.size }));
  check('same song after a gap keeps its chart and score', kept.chart && kept.hits === 1, JSON.stringify(kept));
  check('now playing shown again after the gap', /Song B/.test(await p.textContent('#np')));

  // 3. expired token: one 401 -> refresh and retry, no "Nothing playing"
  const tokensBefore = sp.tokens;
  await p.evaluate(() => { window.__npSeen = []; new MutationObserver(() => window.__npSeen.push(document.getElementById('np').textContent)).observe(document.getElementById('np'), { childList: true, subtree: true, characterData: true }); });
  sp.mode = '401once';
  await p.waitForFunction(() => localStorage.getItem('sp_access') === 'a2', null, { timeout: 5000 });
  await sleep(1700);
  const seen = await p.evaluate(() => window.__npSeen);
  check('401 refreshes the token', sp.tokens === tokensBefore + 1, sp.tokens - tokensBefore);
  check('401 never blinks "Nothing playing" or resets the song', !seen.some((t) => /Nothing playing/.test(t)) && (await p.evaluate(() => window.__state.hits.size)) === 1, JSON.stringify(seen));

  // 4. Loop line with a stale position after the seek: exactly one seek per pass
  await p.evaluate(() => { window.__state.hits.clear(); });
  sp.startPos = 3000; sp.base = Date.now(); // song time 3 s: inside the warm-up's first line
  await p.waitForFunction(() => { const s = window.__state, t = s.track; return t && Math.abs(t.progressMs + performance.now() - t.at - 3000) < 1500; }, null, { timeout: 5000 });
  await sleep(300);
  await p.click('#loop');
  const lp = await p.evaluate(() => window.__state.loop);
  check('loop set', !!lp, JSON.stringify(lp));
  if (lp) {
    // jump to just past the loop end so it fires now
    sp.startPos = lp.end + 900; sp.base = Date.now(); // heard 300 ms later, so song time = end + 600
    await p.waitForFunction(() => window.__state.track && window.__state.track.progressMs > window.__state.loop.end, null, { timeout: 5000 }).catch(() => {});
    await sleep(5000);
    check('loop seeks once, not again on the stale position', sp.seeks.length === 1, JSON.stringify(sp.seeks));
    // you hear the seek target 300 ms later, so seeking to start - 1500 gives the full 1.5 s lead-in
    check('seek goes 1.5 s before the line (speaker delay not added)', sp.seeks.length && Math.abs(sp.seeks[0] - (lp.start - 1500)) <= 5, sp.seeks[0]);
    await p.click('#loop');
  }

  // 5. 429: polling pauses for Retry-After (4 s) instead of every 1.5 s
  sp.mode = '429'; sp.after429 = 0;
  await sleep(5000);
  check('429 pauses polling', sp.after429 >= 1 && sp.after429 <= 2, sp.after429 + ' calls in 5 s');
  check('429 message shown', /slow down/.test(await p.textContent('#sp-status')));
  sp.mode = 'play';
  await sleep(3000);
  check('polling resumes after the pause', (await p.textContent('#sp-status')) === '');

  // 6. offsets are per song: B's offset doesn't carry over to C, and comes back with B
  await p.$eval('#offset', (el) => { el.value = '300'; el.dispatchEvent(new Event('input')); });
  sp.id = 'trkC'; sp.name = 'Song C';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkC', null, { timeout: 5000 });
  check('a new song starts at offset 0', (await p.evaluate(() => window.__state.offset)) === 0 && (await p.textContent('#offset-v')) === '0');
  sp.id = 'trkB'; sp.name = 'Song B';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkB', null, { timeout: 5000 });
  check("back to B: B's offset restored", (await p.evaluate(() => window.__state.offset)) === 300);

  // 7. local files have no Spotify id (null): one after another must still count as a new song, with its own offset
  sp.id = null; sp.uri = 'spotify:local:A:B:Local+One:200'; sp.name = 'Local One';
  await p.waitForFunction(() => window.__state.track && window.__state.track.name === 'Local One', null, { timeout: 5000 });
  await p.$eval('#offset', (el) => { el.value = '200'; el.dispatchEvent(new Event('input')); });
  sp.uri = 'spotify:local:A:B:Local+Two:180'; sp.name = 'Local Two';
  await p.waitForFunction(() => window.__state.track && window.__state.track.name === 'Local Two', null, { timeout: 5000 });
  await sleep(500);
  const lt = await p.evaluate(() => ({ shown: window.__state.shownId, off: window.__state.offset, nul: localStorage.getItem('offset_null') }));
  check('a second local file is a new song (own id, offset 0)', lt.shown && /Local\+Two/.test(lt.shown) && lt.off === 0 && lt.nul === null, JSON.stringify(lt));
  sp.id = 'trkB'; sp.uri = null; sp.name = 'Song B';
  await p.waitForFunction(() => window.__state.track && window.__state.track.id === 'trkB', null, { timeout: 5000 });

  // 8. the refresh token was revoked: log out with a clear message instead of asking Spotify every 1.5 s forever
  sp.tokenMode = 'revoked'; sp.tokens = 0;
  await p.evaluate(() => localStorage.setItem('sp_expires', '0'));
  await sleep(5000);
  const st = await p.evaluate(() => ({ refresh: localStorage.getItem('sp_refresh'), msg: document.getElementById('sp-status').textContent, setup: !document.getElementById('sp-setup').hidden }));
  check('revoked login: logged out, reconnect message, setup shown', st.refresh === null && /Connect Spotify again/.test(st.msg) && st.setup, JSON.stringify(st));
  check('revoked login: token endpoint not hammered', sp.tokens === 1, sp.tokens + ' token requests in 5 s');
}, { mic: 'sing.wav', ignore: /status of (400|401|429)/ });
