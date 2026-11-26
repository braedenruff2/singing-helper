# Singing Helper

Real-time pitch display for singing practice, with Spotify now-playing, synced lyrics and karaoke-style notes ahead.

## What it is and who it's for

Singing Helper is Braeden's own practice tool. His brief, in his words: *"something that can as fast as possible tell your current pitch for the purposes of singing practice. I noticed there is a very annoying lag with other apps. I want it to track the song that is currently playing's singing pitch maybe a few seconds ahead with lyrics (idk how much) and then do a karaoke. Start with getting it working with Spotify."*

It is a small static web app (HTML + JavaScript, no build step) that runs in Chrome or Edge from a local web server on his computer, plus optional Python tools for making note charts from audio files he owns.

It was built in one day (24 Oct 2026) in 7 rounds. **Nobody has yet tried it with a real voice or a real Spotify account**; everything below was verified with synthetic audio, a fake mic and mocked Spotify/lyrics responses.

## Features that work now (tested in automated tests)

- **Your pitch, fast**: note name, cents needle and a scrolling trace that turns white when you're on the note. New notes register in about 8–11 ms (median).
- **Follows Spotify**: shows what's playing, scrolls synced lyrics (LRCLIB) word by word with a karaoke wipe and countdown dots after long gaps, and stays smooth despite Spotify's position jitter (±150 ms jitter moves the notes by at most ~60 ms, was 300+).
- **Notes ahead**: load an UltraStar `.txt` chart, or make one from your own copy of the song (`tools/server.py`), to see the melody coming ~5 s early with your score (any octave counts). Charts are saved per Spotify track.
- **No chart? Live song pitch**: share the Spotify web player tab and the singer's melody is drawn under yours (16/16 notes correct on a test track with bass and noise).
- **Live song pitch ahead** (added 18 Nov, tested only with synthetic audio): tick "Show the song 2 s ahead" (1–4 s) before starting Live song pitch. The Spotify tab goes quiet and you hear it through the page that many seconds late, so the song's notes scroll in from the right before you sing them, for any song, without a chart. The needle compares with the note you're hearing; auto-sync and Spotify timing allow for the delay. Nothing is recorded (the delay is only in the audio graph's memory).
- **Auto-sync**: matches live song pitch against the chart and sets the offset (within ~40 ms in tests; remembered per song).
- **Loop line**: repeats the current line by seeking Spotify back (Premium; works with Start clock too).
- **Key shift**: move a song's notes up/down by semitones; remembered per song (and one key for all exercises).
- **Headphone / speaker lag calibration**: "Measure (speakers)" times clicks with the mic (measured a simulated 120 ms delay exactly); "Tap test (headphones)" (within 5 ms).
- **Tuner**: drone reference note, and an optional guide tone that plays the chart melody.
- **Practice summary**: % of notes on pitch, flat/sharp tendency, steadiness, vibrato rate and depth on long notes (5.4 Hz / ±38¢ measured on a 5.5 Hz / ±40¢ test), lines to work on. Every summary is saved and **Progress** shows recent sessions and the trend.
- **Choose the mic** (settings column, top): a Bluetooth headset, an external/USB mic or the default; remembered (by id, and by name if the browser gives it a new id), used on every Start mic and switched at once while the mic is on; ↻ looks again after plugging one in; a missing mic falls back to the default and says so; a Bluetooth mic gets a note that it adds delay (often 0.1–0.2 s). The phone app also asks once for "Nearby devices" (Android 12+), which Android needs before a Bluetooth headset's mic is offered. Test: `mic-pick`.
- **Stage view** (full screen; S or Escape to leave) and **keyboard shortcuts**: M mic, S stage view, L loop line, Y summary, D drone, A auto-sync.
- **Phone layout**, **installable** from Chrome/Edge, works **offline** (Spotify and lyrics still need the internet).
- **Exercises**: pick one from the **Exercise** list (major scale warm-up, arpeggios, long held notes, and **Hear it, sing it back**: the page plays a note, then you sing it back on your own; outlined notes are for listening and aren't scored, so it trains pitch matching rather than singing along; **Hear two notes, sing them back** does the same with intervals): it starts 2 s later on its own clock, also while Spotify is connected (the song's chart, key and offset are left alone and come back when you pick "—"). The files are in `examples/` and also load with **Start clock** and no Spotify.
- **Chart generator** `tools/make_chart.py`: Demucs vocal separation → CREPE pitch → notes → LRCLIB lyrics spread over the notes, with syllable splitting (sing-ing, lit-tle, mo-ther). Recovered every note exactly on a test vocal.

## Half-built, untested or limited

- **Never tried for real**: no real voice, no real Spotify account, no real song yet.
- **Lyrics**: the app's lyrics lookup was run against live LRCLIB on 18 Nov with Spotify-style names for three real songs (a "- Remastered 2011" title, a "(with …)" title): all found and shown (`tests/e2e/lyrics-live.cjs`). Spotify itself was still mocked.
- **Vocal separation (Demucs) is untested**: its model weights couldn't be downloaded on the build machine, so only `--no-separate` (already-isolated vocals) was tested. On real songs expect to nudge the offset slider and occasionally see a backing vocal picked up.
- **Live song pitch** shows notes ahead only with "Show the song … ahead" ticked (you then hear the song late; Chrome's tab muting (`suppressLocalAudioPlayback`) is needed so you don't hear it twice). On busy synthetic mixes (voice + chords + bass + drums) it now follows the voice most of the time (before 18 Nov it drew the bass line instead), but it still shows the band's pitch in instrumental parts, and with a voice much quieter than the band about a quarter of its notes still come out wrong (synthetic test). Not yet tried on a real song.
- **Duet charts** (P1/P2): a "Duet: sing the part of" picker appears under the chart button (names from #DUETSINGERP1/P2 when the chart has them); the choice is remembered per Spotify track. One-singer charts and exercises hide it.
- **Low notes** still take up to 16–19 ms to lock (the detector needs two periods of the note; a physical limit).
- **Flaky test**: karaoke / sync-loop-summary scores can occasionally miss under load because the fake mic file isn't synced to the app clock; `tests/run-all.cjs` retries a failing browser test once.
- **Spotify loop line** needs the playback-control permission: if you connected before it was added, Disconnect and Connect again.
- **Spotify login lost** (you removed the app's access, or Spotify ended the login): the page now says "Spotify login expired" and shows Connect Spotify again, instead of retrying every 1.5 s. Local files played in Spotify each get their own offset/key/chart (they have no Spotify id).

## Run it (PC)

No build step. Easiest: double-click **`Start Singing Helper.bat`** in this folder (needs Python; it runs `tools/server.py`
and opens the page in your browser; "Make notes from audio" appears once its packages are installed). Or by hand,
in this folder (`C:\Users\braed\Desktop\singing-helper`):

```
python tools/server.py
```

(`python3` on macOS/Linux. `python -m http.server 8000 --bind 127.0.0.1` also works, except on Windows PCs whose registry
gives `.js` files the wrong type, which stops the page loading; `tools/server.py` always sends the right type.) To also turn
on "make notes from your own copy of the song", install its packages once: `pip install -r tools/requirements.txt`.

Open **http://127.0.0.1:8000/** in Chrome or Edge. Use `127.0.0.1`, not `localhost`: Spotify only accepts loopback IPs for http redirects. Click **Start mic**. Use wired headphones while singing along so the song doesn't leak into the mic.

### Connect Spotify (one-time)

1. Go to https://developer.spotify.com/dashboard → Create app.
2. Redirect URI: `http://127.0.0.1:8000/` (the page shows the exact value). API: Web API.
3. Copy the Client ID into the app and click **Connect Spotify**.

Since Feb 2026, development-mode Spotify apps need the owner to have Premium and allow only a few test users. The app only reads "currently playing" and the playback position, plus seeking for Loop line (scopes: `user-read-currently-playing user-read-playback-state user-modify-playback-state`). Login is PKCE in the browser; there is no server and no client secret.

### Notes ahead

Load an UltraStar `.txt` chart while the song plays on Spotify (a large community library is at usdb.animux.de, free account). Use the offset slider or Auto-sync if it's early or late. Or make a chart:

```
python tools/make_chart.py "song.mp3" --artist "Artist" --title "Title" -o song.txt
```

Add `--device cuda` (NVIDIA) or `--device mps` (Apple Silicon) to speed it up. `--no-separate` skips Demucs when the file is already vocals only.

### Live song pitch

Play the song in the Spotify web player (open.spotify.com) in Chrome, click **Live song pitch**, pick that tab and enable "Share tab audio".

### How it's used

Built for Chrome/Edge on a PC, with a phone layout and an installable (PWA) mode. Braeden hasn't said yet which device he practises on. On a phone, the page can't simply be opened from the PC over Wi-Fi (`http://192.168.x.x:8000/`): browsers only allow the microphone on `https://` pages or on `127.0.0.1`/`localhost` of the device itself, so the phone layout needs the app hosted over HTTPS (e.g. GitHub Pages once there's a repo; Spotify's redirect URI then becomes that https address).

## On your phone (Android app)

The same app, packaged for the phone: `dist/SingingHelper.apk` (built by `tools/build-apk.sh`; the Android side is in
`android/`). The PC version keeps working as before; both use the same web files, so every change reaches both.

**Set up once (PC):** double-click **Turn on app updates.bat**. It puts this folder in a public GitHub repository
`singing-helper` you own (nothing personal goes there) and uploads changes every 15 minutes. At the end it shows a
link: open it on the phone to install the app. After that the app **updates itself** like Wellness and Loudbook: it
checks GitHub, downloads a newer version in the background and installs it once you've been out of the app for 10
minutes (so switching to Spotify or locking the screen doesn't restart it; the first time it asks you to "Allow
updates": Settings opens, switch it on, and to allow notifications for "Tap to install"). The side panel shows the
version and has "Check now"; "Update now" there shows Android's install prompt straight away.

**Spotify on the phone:** in your Spotify developer app (developer.spotify.com > your app > Edit), add a second
Redirect URI: `https://appassets.androidplatform.net/index.html` (the app shows it under Spotify). Keep the PC one.
Then Connect Spotify in the app; it uses the Spotify app or web player that's playing on any of your devices.
In the app, log in to Spotify with your email (or username) and password: the "Continue with Google / Apple /
Facebook" buttons open the browser, and the login can't come back to the app from there.

**What's different on the phone:** Live song pitch, "Show the song ahead" and Auto-sync are PC-only (phones don't let
an app listen to another app's audio). Everything else is the same: pitch readout, charts, exercises (including Hear it,
sing it back), lyrics, key shift, tuner, summary and progress. The screen stays on while the app is open, and the mic is
let go when you switch away (tap Start mic when you're back). Headphones help, as on the PC.

**How it's built:** the page is served inside the app from `https://appassets.androidplatform.net/` (never fetched
from the internet; a secure address so the microphone and the audio worklet work). `MainActivity.java` grants the
microphone to that page only. The signing key is `android/singing.keystore`: keep it, never put it in git (it's in
.gitignore); updates only install over the app when signed with the same key.

## Karaoke on the TV (Fire TV)

Braeden's request (26 Nov 2026): karaoke on the living-room TCL TV (75Q550F-CA, Fire TV OS, so no Chromecast): the TV
plays the song itself and shows scrolling lyrics, plus pitch bars when pitch mode is on; the WOW wireless mic
receiver's 1/4" output goes through a USB-C recording cable into the Pixel, the phone works out the pitch and sends
it to the TV. No screen mirroring (it adds about a second of delay).

**Built 26 Nov (first version; tested in automated tests only, not yet on the TV or the phone):**

- **The TV app** `dist/SingingHelperTV.apk` (sideload it on the Fire TV; built by `tools/build-tv-apk.sh` from
  `android-tv/`, same signing key as the phone app). It shows `tv.html` full screen: the song list (songs you add,
  plus three warm-ups), driven by the remote (up/down, OK to sing; during a song OK pauses, Back stops). While
  singing: big lyrics with a gold wipe and countdown dots before a line after a long gap, a progress line, and with
  **Pitch bars: On** the song's notes scrolling past (gold = golden notes, green once sung right) with your pitch as
  dots (white on the note, red off it) and a karaoke-style score out of 10,000 (golden notes count double; any octave
  counts; **Level** Easy/Normal/Hard = within 1.5 / 0.75 / 0.5 semitones). The best score per song is kept on the TV.
  **Mic delay** (default 120 ms) lines your pitch up with the song: raise it if your pitch dots trail the bars.
- **Adding songs**: the TV shows an address and a 4-digit code: on a PC on the same Wi-Fi, open
  `http://<TV address>:47322/`, type the code, pick an UltraStar chart (`.txt`) and its audio file (the name in the
  chart's `#MP3:` line), and send. They show up in the list straight away. Only songs he owns. The page only takes
  charts, audio and pictures (200 MB at most each), into the TV app's own songs folder.
- **The phone**: in the Singing Helper phone app, side panel **Karaoke on TV**: **Find TV** (or type the address the
  TV shows), then tick **Send my pitch to the TV** (it starts the mic). It sends about 50 pitch readings a second over
  Wi-Fi (UDP port 47321, only to home-network addresses) while you sing. Keep the app open on the phone while singing
  (it lets go of the mic in the background).
- **One singer only**: the receiver mixes every mic into one signal, so for duets or group songs untick sending on
  the phone and turn Pitch bars off on the TV (lyrics only, no score). The app doesn't try to separate singers.
- **Songs**: UltraStar `.txt` files are read and can be written back exactly (`karaoke.js`: `readUltraStar` /
  `writeUltraStar`, and `chartToUltraStar` for a timed chart), so later a synced offset or a chart made from his own
  audio can be saved for the TV.
- **Without the TV app**: `tv.html` also opens in the TV's Silk browser from a web server (lyrics, songs from
  `songs/index.json`), but pitch bars need the TV app (a browser can't receive the phone's pitch), unless a home
  server relays it: `tv.html?ws=ws://<server>:<port>` takes the same messages over a WebSocket. Hosting the app, songs
  and scores on the Acer home lab comes once that's set up.

Not yet: trying it on the real TV and phone (Wi-Fi delay, whether the Fire TV's WebView plays every audio format
and lets you seek), scores kept anywhere but the TV, the home-lab hosting.

## Test it

- Detector accuracy/latency benchmark (Node only, no browser):
  ```
  node tests/bench.cjs
  ```
  Expected: 99.8–100% of frames within 25 cents and no octave errors for clean, vibrato, breathy, weak fundamental, loud 2nd harmonic and rough voices, and real octave leaps (also breathy / weak-fundamental / loud-2nd-harmonic); new notes lock in ~8–11 ms median, 16–19 ms worst case.
- Real singers (40 solo recordings with hand-checked pitch, the Vocadito dataset, CC BY 4.0, 58 MB from
  https://zenodo.org/records/5578807, unzip anywhere): `VOCADITO=path/to/vocadito node tests/real-voice.cjs`
  (skipped when the data isn't there). 19 Nov 2026: the readout is within 50 cents 97.7% of the time it shows a pitch
  (96.2% before octave continuity, 97.4% before the YIN threshold went 0.15 -> 0.1), 1.1% octave/twelfth errors (was 2.5%; still concentrated in a few voices, the worst
  10-11%; with "fold" on, the default, octave errors don't count against you), 2.9% of sung frames shown as no pitch, and a pitch
  shown in 7.6% of breaths/silences (was 11% before the detector stopped showing readings with no clear dip, maxD 0.25).
  Most of those are the fuzzy edges of a note's label: more than 120 ms away from any singing it's 1.2%.
  The synthetic benchmark above is much kinder than real voices; this is the one to watch when changing the detector.
- Live song pitch on real singers: `node tests/melody-real.mjs` (Vocadito voices over a synthetic band in the singer's key,
  ~5 min; `MELODY_REAL=1` adds it to run-all). 18 Nov 2026: the right note 76% of the time while they sing (synthetic
  voices: 85-100%), and while the singer rests it shows the band's pitch almost all the time (99.6%): Live song pitch has
  no way yet to tell that nobody is singing.
- Everything at once (unit tests, benchmark, browser tests; pass/fail per check, exit code 1 on failure):
  ```
  node tests/run-all.cjs
  ```
- Unit tests for lyrics/chart parsing and the LRCLIB lookup (Node only): `node tests/unit.mjs`
- Live song pitch on synthetic song mixes, offline (Node only, ~1 min): `node tests/melody.mjs` (`--verbose` for details)
- Chart maker and its server, with Demucs/CREPE faked (Python + numpy only): `python tools/test_make_chart.py`, `python tools/test_server.py` (run-all runs them when numpy is installed)
- Browser tests in `tests/e2e/` (Node + the `playwright` package with Chromium, fake mic). Each one serves the app itself, so no web server is needed; works on Windows too. See `tests/e2e/README.md`.
  ```
  node tests/e2e/karaoke.cjs
  ```
  Tests: `calibration-tuner-pwa`, `exercise`, `karaoke`, `key-history-clock`, `live-ahead`, `live-busy-mix` (voice over chords, bass and drums), `live-song-pitch`, `make-notes` (needs `tools/server.py` running on port 8124), `phone`, `settings-mic`, `spotify-lyrics`, `spotify-robust` (Spotify gaps, expired token, slow lyrics, loop seek lag, rate limits), `lyrics-live` (real LRCLIB, needs internet; run-all runs it with `LIVE=1`), `sync-loop-summary`, `vibrato-summary`, `bad-storage` (damaged saved data, a failed mic start, the mic unplugged during calibration), `chart-edge-cases` (a chart without lyrics, score reset, dropdown focus). Screenshots go to `tests/out/`.

## How latency is kept low

- Mic opened with echo cancellation, noise suppression and auto-gain **off** (each adds buffering).
- `AudioContext({latencyHint: 0})` and an AudioWorklet (`pitch-worklet.js`) that runs YIN on the audio thread every 128 samples (~2.7–2.9 ms).
- YIN scans lags only until the first confident dip (~10% of one core).
- Adaptive window: once a pitch is known, YIN integrates over ~1.2 periods of the current note, so a new note fills the window sooner.
- A gentle 2.5 kHz low-pass before analysis stops breathy singing jumping octaves (breathy went from 54% to 99.8% correct).
- Octave continuity: if a reading is suddenly an octave away from the last one and YIN also has a good dip at the old
  period (below 0.4, or for an octave up clearly deeper), it keeps the old octave, for at most 150 ms, so a real leap
  is always followed (synthetic leaps: no delay at all). Real singers' octave errors 2.5% -> 1.2%.
- Total felt latency is the detector time plus mic/OS input (~10 ms on most machines) plus one screen frame.

## Files

| File | What it is |
|---|---|
| `index.html` | The page and UI |
| `app.js` | Main app: pitch display, karaoke, Spotify sync smoothing, charts, practice tools, summary/history |
| `pitch-worklet.js` | YIN pitch detector running in an AudioWorklet |
| `spotify.js` | Spotify PKCE login, now-playing, seek |
| `lyrics.js` | LRCLIB synced lyrics, LRC and UltraStar parsing |
| `melody.js` | Live song pitch: the lead melody's pitch from the shared tab's spectrum |
| `tv.html`, `tv.js` | The TV karaoke screen (song list, lyrics, pitch bars, score) |
| `karaoke.js` | UltraStar read/write, karaoke scoring, lyric line on screen, phone -> TV messages |
| `android-tv/`, `tools/build-tv-apk.sh` | The Fire TV app (WebView, phone pitch on UDP 47321, song uploads on 47322) |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline/installable app (network-first cache) |
| `examples/` | Exercise charts: scale warm-up, arpeggios, sustain |
| `tools/make_chart.py`, `tools/server.py`, `tools/requirements.txt` | Chart generator and local server with POST `/api/chart` (listens on 127.0.0.1 only) |
| `tests/run-all.cjs`, `tests/unit.mjs`, `tests/bench.cjs`, `tests/e2e/` | Test runner, unit tests, benchmark and browser tests (with WAV fixtures) |

Data the app stores in the browser's localStorage: `chart_<trackId>`, `offset` / `offset_<trackId>`, `key_<trackId>`, `outDelay`, `history` (last 200 summaries).

## Decisions made

- **Web app, no build step, runs locally** on `http://127.0.0.1:8000/` (Spotify rejects `localhost`).
- **Speed first**: browser audio processing turned off, detector on the audio thread with an adaptive window.
- **Spotify via the user's own developer app and PKCE**, no backend, read-only plus seek.
- **Song melody** comes from UltraStar charts (Spotify's API gives no audio and its audio-analysis endpoint is closed to new apps), from charts generated from audio files Braeden owns, or from live tab-audio pitch (harmonic-sum salience; plain YIN failed on full mixes).
- **Lyrics** from LRCLIB (free, no key).
- **Small Spotify position corrections are blended in gradually (20% when under 500 ms)**; real seeks snap.
- Code lives only in this folder and the project's shared files; there's no GitHub repo yet. Braeden was told that if he creates an empty repo, the code can be moved there.
- On 24 Oct Braeden asked for his autonomous projects to work on this when there are credits; on 17 Nov he asked for it to be handed to his Claude autopilot (runs every 5 hours) in this folder.

## What Braeden has said he wants / doesn't want

- Wants the fastest possible pitch readout; the lag in other apps is "very annoying".
- Wants the playing song's sung pitch shown a few seconds ahead, with lyrics, karaoke-style.
- Start with Spotify.
- Asked for continuous improvement (24 Oct) and now autopilot improvement every 5 hours.
- Keep documentation factual: only what's in the project and the chats, nothing invented.

## Next steps (most valuable first)

1. **Try it for real**: real voice, real Spotify account, a real song (double-click `Start Singing Helper.bat`). Note what feels off and fix that first. Braeden was asked to report this and hasn't yet.
2. **Verify the lyrics flow with real Spotify** (live LRCLIB checked 18 Nov with mocked Spotify; see `tests/e2e/lyrics-live.cjs`).
3. **Verify Demucs separation on a real song** with `tools/make_chart.py` (never run because its weights couldn't download), and tune note cutting / backing-vocal rejection.
4. ~~Make the browser tests run on Windows~~ (done 18 Nov: portable paths, built-in server, pass/fail checks, `tests/run-all.cjs`).
5. **Live song pitch on real songs**: check it with a real Spotify tab; next ideas are a voicing check (hide it in instrumental parts; a simple "clearly stronger than any other note" check was tried on 18 Nov and dropped too much of the voice on synthetic mixes, so it needs real recordings to tune) and help for voices much quieter than the band.
6. **Desktop/mobile wrapper for lower input latency** (native audio APIs on iOS/macOS beat browsers by several ms).
7. **Move the code to a GitHub repo** once Braeden creates one.

## Rules

From Braeden's handoff request:

- **No paid services** and **no new accounts** to sign up for. (The existing setup already relies on his own Spotify developer app, and Spotify requires Premium for dev-mode apps; the optional usdb.animux.de chart library needs a free account. Don't add more.)
- **Never record anyone but Braeden.** The mic is only for his own voice; tab audio is only analysed live for pitch, not saved.

From how the project was built:

- Only make charts from audio files he owns.
- Keep everything local (`127.0.0.1`), no backend, no secrets in code.
- Keep the README factual; don't invent features or results.

## Changes by the autopilot

- **26 Nov 2026 (karaoke on the TV)**: first version of his TV karaoke request (see "Karaoke on the TV"): the TV page
  and Fire TV app, the phone's "Karaoke on TV" sender, UltraStar read/write, karaoke scoring. Tests: `tests/karaoke.mjs`,
  `tests/e2e/tv.cjs`, `tests/e2e/tv-phone.cjs`, Java `TvFilesTest` (+ `Assets.lanIp`). Also: `tools/build-apk.sh`
  no longer makes a new signing key when `android/singing.keystore` is missing (a new key can't update the installed
  app; `SH_NEW_KEY=1` only for a first-ever build), and takes the key from `SH_KEYSTORE=<path>`.
- **18 Nov 2026**: tests now pass/fail on their own and run on Windows (`node tests/run-all.cjs`); new unit tests for
  lyrics/chart parsing and a Spotify edge-case test. Fixed: a moment of "nothing playing" from Spotify (or an expired
  login) no longer wipes the song's score and loop; lyrics from the previous song can't replace the current song's when
  they arrive late; Loop line no longer seeks twice when Spotify reports the old position just after a seek; polling
  pauses when Spotify says "too many requests"; LRCLIB versions more than 10 s longer/shorter than the Spotify track are
  no longer used (they'd be out of sync); repeated chorus lines with word timings get their own word times; after a
  silence the "Steady needle" smoothing starts fresh on the next note; double-clicking Start mic can't open the mic twice;
  the countdown dots measure the gap from the last sung line.
- **18 Nov 2026 (later)**: Live song pitch (now in `melody.js`) followed the bass line instead of the singer whenever a
  band played (0% right on a synthetic busy mix in Chrome; 39% on average over 8 offline mixes). It now weighs each
  harmonic by how much it stands out, leans toward the top line, avoids the bass range, prefers the octave above when
  it's nearly as strong, and sticks a little to the previous note: 75–85% right in Chrome on the busy mix, ~99% on 13
  of 14 offline mixes (including 6 held out from tuning), and far less flicker. New tests: `tests/melody.mjs`,
  `tests/e2e/live-busy-mix.cjs`.
- **18 Nov 2026 (second review)**: fixes from a second code review of today's changes: a Spotify song change during an
  exercise no longer wipes its score or shifts its timing; leaving an exercise during a Spotify gap brings the song's
  chart back when Spotify does; a chart loaded during an exercise gets the song's key and offset; without Spotify, a
  chart you had loaded comes back after the exercise, and the clock button reads "Stop exercise"; picking "—" while an
  exercise loads cancels it; "Mic disconnected" isn't overwritten when paused audio resumes; Safari's "interrupted"
  audio resumes on a click. Tests: exercise, settings-mic.
- **18 Nov 2026 (layout)**: on a PC the roll grew to the height of the long settings column, so the lyrics and Loop/Summary
  buttons were below the bottom of the window (about 1,600 px down on an 800 px screen). The readout, roll and lyrics now
  fit the window and stay in place while the settings scroll, in stage view too. Test: karaoke.
- **18 Nov 2026 (readout when quiet)**: when you stop singing, the label no longer keeps the last reading ("0¢ vs E");
  it says which note to sing ("sing E") or nothing.
- **18 Nov 2026 (roll view)**: the piano roll now widens to keep your own pitch dot on screen when you're a few notes
  off the chart (it could sit above the top edge, so you couldn't see where you were).
- **18 Nov 2026 (exercises)**: an Exercise list (scale, new arpeggios chart, held notes) that starts with a 2 s count-in,
  even with Spotify on, without touching the song's saved chart/key/offset. Test: `tests/e2e/exercise.cjs`.
- **18 Nov 2026 (Live song pitch tuning)**: 12 equally weighted harmonics instead of 10 decaying ones; on the synthetic
  mix with the voice much quieter than the band, 42% -> 73% right, other mixes unchanged (~99-100%).
- **18 Nov 2026 (code review fixes)**: auto-sync now works with a key shift (it compared the singer with the shifted
  notes and usually found no match); Loop line with a speaker delay or look-ahead now gives the full 1.5 s lead-in (the
  delay was added to the seek, cutting it short); vibrato in the summary is measured on the latest pass of a looped
  note (repeats were counted together and read as "no vibrato"); a double-click on Drone can't leave a second drone
  playing; lyrics with no timed lines no longer stop the loop/guide tone; `#RELATIVE:yes` UltraStar charts load
  correctly; a song file over 200 MB gets a clear message, and the server answers bad upload sizes with 400.
- **18 Nov 2026 (offsets)**: a song without its own saved offset now starts at 0 instead of inheriting the previous
  song's offset (which put it out of sync); each song's offset still comes back with it. Test: spotify-robust.
- **18 Nov 2026 (readout)**: when you're on a different note from the song's, the label says "3 semitones low vs C"
  instead of "-300¢ vs C"; the readout only touches the page when its text changes (it ran every frame).
- **18 Nov 2026 (look-ahead)**: "Show the song N s ahead" for Live song pitch (see Features). Test: `tests/e2e/live-ahead.cjs`
  (2 s delay heard, needle compares with the note heard now, trace drawn ahead, auto-sync finds -2740 ms for an expected
  -2700 ms).
- **18 Nov 2026 (settings, mic)**: the settings panel (match any octave, steady needle, guide tone, mic gate, drone note)
  is remembered between visits; an unplugged or switched mic no longer leaves "Mic on" stuck (Start mic works again);
  when the browser pauses audio (sleep, a call) the page says so and the next click or key resumes it. Test:
  `tests/e2e/settings-mic.cjs`.
- **18 Nov 2026 (starting it)**: `Start Singing Helper.bat` starts the app and opens it in the browser. `tools/server.py`
  now runs without the chart packages (then "Make notes" stays hidden) and always serves `.js` as JavaScript.
- **18 Nov 2026 (chart maker)**: `make_chart.py` now falls back to an LRCLIB search when there's no exact match (it
  only tried the exact lookup), with the same 10 s duration rule as the app; `server.py` deletes each uploaded song and
  Demucs' separated vocals after making the chart (they stayed in the temp folder, up to 200 MB each) and refuses a
  cut-off upload instead of charting half a song. New tests: `tools/test_make_chart.py` (note cutting, syllables,
  lyrics, chart format, LRCLIB fallback) and `tools/test_server.py`. Not yet run with the real Demucs/CREPE.
- **19 Nov 2026 (evening review)**: a chart loaded while Spotify briefly reports nothing (paused a while, an ad, a
  device switch) is saved for the song still shown, not for whatever plays next; a chart loaded with nothing shown
  replaces an older saved chart of the song that then starts; paused Spotify stops the guide tone and doesn't score
  humming; clicking a calibration button twice no longer runs two measurements; Loop line on a line near 0:00 no longer
  puts the clock before the start; LRCLIB lookups time out (8-10 s) instead of hanging on "Looking up…"; Loop line keeps
  jumping back while the browser window is covered. Test: `tests/e2e/review4.cjs`.
- 20 Nov 2026: new exercise **Hear it, sing it back** (`examples/echo.txt`, `#ECHO:yes` charts): the page plays each
  note (outlined), then stays quiet while you sing it back (guide tone on or off); only the sung notes are scored.
  The summary then says how many notes you found, how fast, and which ones to work on (late, flat or sharp).
  Test: `tests/e2e/echo.cjs`, unit (ECHO parsing).
- 20 Nov 2026: **Hear two notes, sing them back** (`examples/echo-intervals.txt`): 10 rounds of two notes (thirds,
  fourths, fifths, sixths, up and down), same listen-then-sing rules. sw.js cache v3.
- 20 Nov 2026 (review): echo summary counts every note to sing that has gone by (silent ones say "not sung"), "found"
  needs 150 ms in tune (a glide through the note doesn't count), off-pitch notes say flat/sharp; the listen tone is
  played early by the calibrated output delay, stops while the page is hidden, and the readout has no target while
  you listen.
- 20 Nov 2026: the Key you set during an exercise is remembered for all exercises (songs keep their own key).
- 20 Nov 2026: **phone app** (his request): `android/` (WebView app, mic, self-updating from GitHub like Wellness),
  `tools/build-apk.sh`, `dist/SingingHelper.apk`, "Turn on app updates.bat" + tools/publish.*. In the app the page
  hides the tab-audio features and shows App updates. Tests: tests/e2e/app-mode.cjs (fake Android bridge),
  tests/java.cjs (Assets: paths, MIME, version.json, which pages stay in the app). Not yet tried on the real phone.

