// Shared harness for the browser tests: serves the app on a free port, launches Chromium with a
// fake mic, collects page errors and reports pass/fail. Works the same on Windows, macOS and Linux.
//   node tests/e2e/<name>.cjs [fixture.wav]
// Exit code 0 = every check passed. Screenshots go to tests/out/ (not the project root).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(ROOT, 'tests', 'out');
const EXAMPLES = path.join(ROOT, 'examples');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.wav': 'audio/wav', '.css': 'text/css',
};

// Plain static server, like `python -m http.server` (404 for api/health, so "Make notes" stays hidden).
function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { p = '/'; }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

// Resolve a fixture: a path given on the command line, else the test's default from fixtures/.
function fixture(def) {
  const a = process.argv[2];
  if (a && a.endsWith('.wav')) return path.resolve(a);
  return def ? path.join(FIXTURES, def) : null;
}

// test(name, async ({url, newPage, check, shot, sleep}) => {...}, {mic: 'sing.wav'})
async function test(name, fn, opts = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const mic = 'mic' in opts ? fixture(opts.mic) : null;
  if (mic) args.push('--use-file-for-fake-audio-capture=' + mic);
  const browser = await chromium.launch({ args });
  let fails = 0;
  const errors = [];
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined && detail !== '' ? '  (' + detail + ')' : ''}`);
    if (!ok) fails++;
    return ok;
  };
  const newPage = async (o) => {
    const p = await browser.newPage(o);
    // A 404 is expected: the app asks for api/health, which only tools/server.py answers.
    // Tests that mock failing APIs pass opts.ignore (a RegExp) for the browser's own network log lines.
    p.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text()) && !(opts.ignore && opts.ignore.test(m.text()))) errors.push('console: ' + m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('dialog', (d) => { errors.push('alert: ' + d.message()); d.dismiss().catch(() => {}); });
    return p;
  };
  const shot = (p, file) => p.screenshot({ path: path.join(OUT, file) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`--- ${name}`);
  try {
    await fn({ url, newPage, check, shot, sleep, browser, EXAMPLES, FIXTURES });
  } catch (e) {
    check('test ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
  }
  check('no page errors or alerts', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  server.close();
  console.log(`${name}: ${fails ? fails + ' check(s) FAILED' : 'passed'}`);
  process.exitCode = fails ? 1 : 0;
}

// Pretend to be logged in to Spotify (the API itself is mocked with page.route).
async function fakeSpotifyLogin(p) {
  await p.evaluate(() => {
    localStorage.setItem('sp_client_id', 'x'); localStorage.setItem('sp_refresh', 'r');
    localStorage.setItem('sp_access', 'a'); localStorage.setItem('sp_expires', String(Date.now() + 3600e3));
  });
}

function trackJson(id, name, progressMs, extra = {}) {
  return { is_playing: true, progress_ms: Math.round(progressMs), item: { id, name, duration_ms: 600000, artists: [{ name: 'A' }], album: { name: 'B', images: [] } }, ...extra };
}

module.exports = { test, serve, fixture, fakeSpotifyLogin, trackJson, ROOT, OUT, EXAMPLES, FIXTURES };
