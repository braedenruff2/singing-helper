#!/usr/bin/env python3
"""Serve Singing Helper locally and let it generate charts from dropped audio files.

    python tools/server.py            # then open http://127.0.0.1:8000/

Same as `python -m http.server`, plus POST /api/chart which runs make_chart.py on the
uploaded audio and returns the UltraStar text. Listens on 127.0.0.1 only.
Works without the chart packages too (then it's just the web server and "Make notes" stays hidden).
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import traceback
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import make_chart as mc  # noqa: E402  (needs numpy)
except ImportError:
    mc = None
# packages "Make notes from audio" needs (Demucs only when separating); checked without importing them
CHART_PACKAGES = ("numpy", "soundfile", "torch", "torchaudio", "torchcrepe")


def chart_ready():
    return mc is not None and all(importlib.util.find_spec(p) is not None for p in CHART_PACKAGES)

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_UPLOAD = 200 * 1024 * 1024
LOCK = threading.Lock()  # one separation at a time; they're memory hungry


def build_chart(audio_path, artist, title, opts):
    vocals = audio_path if opts.no_separate else mc.separate_vocals(audio_path, opts.demucs_model, opts.device)
    try:
        return _build(audio_path, vocals, artist, title, opts)
    finally:
        if vocals != audio_path:  # <tmp>/<model>/<name>/vocals.wav: remove Demucs' temp folder
            shutil.rmtree(os.path.dirname(os.path.dirname(os.path.dirname(vocals))), ignore_errors=True)


def _build(audio_path, vocals, artist, title, opts):
    audio = mc.load_mono_16k(vocals)
    f0, per, db = mc.track_pitch(audio, opts.crepe_model, opts.device)
    notes = mc.to_notes(f0, per, db)
    lrc = mc.fetch_lrc(artist, title, len(audio) / 16000) if title else None
    texts, starts = mc.attach_lyrics(notes, mc.parse_lrc(lrc)) if lrc else (["~"] * len(notes), [])
    out = audio_path + ".txt"
    name = os.path.splitext(os.path.basename(audio_path))[0]
    mc.write_ultrastar(out, notes, texts, starts, artist, title or name)
    with open(out, encoding="utf-8") as f:
        return f.read(), len(notes), bool(lrc)


class Handler(SimpleHTTPRequestHandler):
    opts = None
    ready = None  # set in main(); tests may set it
    # Windows can map .js to text/plain in the registry, and browsers refuse ES modules served that way
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".html": "text/html",
                      ".json": "application/json", ".txt": "text/plain"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/health"):
            ready = chart_ready() if self.ready is None else self.ready
            return self.reply(200 if ready else 404, {"ok": ready})
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/chart":
            return self.reply(404, {"error": "not found"})
        if not (chart_ready() if self.ready is None else self.ready):
            return self.reply(503, {"error": "install the chart packages first: pip install -r tools/requirements.txt"})
        # only accept requests from the page itself
        origin = self.headers.get("Origin", "")
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return self.reply(403, {"error": "forbidden origin"})
        q = urllib.parse.parse_qs(u.query)
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_UPLOAD:  # (the page checks the size first, so a too-big file never gets here)
            self.close_connection = True
            return self.reply(400, {"error": "send the audio file as the request body (max 200 MB)"})
        name = os.path.basename(q.get("name", ["song.mp3"])[0]) or "song.mp3"
        tmp = tempfile.mkdtemp(prefix="upload_")
        path = os.path.join(tmp, name)
        try:
            with open(path, "wb") as f:
                left = n
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:  # the upload was cut off: don't make a chart from half a song
                code, obj = 400, {"error": "upload incomplete, try again"}
            else:
                with LOCK:
                    text, count, has_lyrics = build_chart(path, q.get("artist", [""])[0], q.get("title", [""])[0], self.opts)
                code, obj = 200, {"chart": text, "notes": count, "lyrics": has_lyrics}
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            code, obj = 500, {"error": str(e)}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)  # uploads can be 200 MB; don't leave them in the temp folder
        self.reply(code, obj)

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--device", default=None, help="cpu, cuda or mps")
    ap.add_argument("--demucs-model", default="htdemucs")
    ap.add_argument("--crepe-model", default="full", choices=["full", "tiny"])
    ap.add_argument("--no-separate", action="store_true", help=argparse.SUPPRESS)  # for tests
    Handler.opts = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", Handler.opts.port), partial(Handler, directory=APP_DIR))
    print(f"Singing Helper on http://127.0.0.1:{Handler.opts.port}/", file=sys.stderr)
    if not chart_ready():
        print("(\"Make notes from audio\" is off: pip install -r tools/requirements.txt to turn it on)", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
