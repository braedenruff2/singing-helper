Browser tests (Playwright + Chromium with a fake mic). Each test serves the app itself on a free
127.0.0.1 port, so no separate web server is needed, and prints `ok`/`FAIL` per check (exit code 1 on a failure).

Run everything (unit tests, detector benchmark, all browser tests; a failing browser test is retried once):

    node tests/run-all.cjs
    node tests/run-all.cjs spotify        # only the tests whose name contains "spotify"

Or one test: `node tests/e2e/karaoke.cjs` (optionally pass a different fake-mic WAV: `node tests/e2e/karaoke.cjs my.wav`).
Screenshots go to `tests/out/`.

Setup once: `npm install playwright` (in this folder or globally) and `npx playwright install chromium`.

`make-notes` needs the chart helper and its Python packages: start
`python tools/server.py --port 8124 --no-separate --crepe-model tiny`, then `node tests/e2e/make-notes.cjs`
(or `MAKE_NOTES=1 node tests/run-all.cjs`).

The fake mic file isn't synced to the app's clock, so karaoke/sync-loop-summary scores can occasionally miss under load;
run-all retries once before reporting a failure. Expected browser log lines (404 for `api/health`, the mocked
401/429 answers in spotify-robust) are ignored.
