#!/usr/bin/env python3
"""Tests for tools/server.py's /api/chart endpoint, with the heavy steps (Demucs, CREPE) faked. Needs only numpy.

    python tools/test_server.py
"""
import glob
import http.client
import json
import os
import sys
import tempfile
import threading
import socket
import types
from functools import partial
from http.server import ThreadingHTTPServer

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_chart as mc  # noqa: E402
import server  # noqa: E402

fails = 0


def check(label, ok, detail=""):
    global fails
    print(("ok   " if ok else "FAIL ") + label + (f"  ({detail})" if detail != "" else ""))
    if not ok:
        fails += 1


# fake the slow parts: "separation" copies the file into a Demucs-like folder, pitch is a fixed scale
sep_dirs = []


def fake_separate(path, model, device):
    out = tempfile.mkdtemp(prefix="chart_")
    d = os.path.join(out, model, "song")
    os.makedirs(d)
    sep_dirs.append(out)
    v = os.path.join(d, "vocals.wav")
    open(v, "wb").write(open(path, "rb").read())
    return v


mc.separate_vocals = fake_separate
mc.load_mono_16k = lambda p: np.zeros(16000 * 3, dtype=np.float32)
mc.track_pitch = lambda a, m, d: (np.array([0.0] * 10 + [261.63] * 50 + [293.66] * 50 + [0.0] * 10),
                                  np.array([0.0] * 10 + [0.9] * 100 + [0.0] * 10),
                                  np.array([-80.0] * 10 + [-20.0] * 100 + [-80.0] * 10))
mc.fetch_lrc = lambda a, t, d: "[00:00.10]do re"

server.Handler.ready = True  # the real check needs torch etc.; the heavy steps are faked here
for separate in (False, True):
    server.Handler.opts = types.SimpleNamespace(no_separate=not separate, demucs_model="htdemucs", device=None, crepe_model="tiny")
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=server.APP_DIR))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    before = set(glob.glob(os.path.join(tempfile.gettempdir(), "upload_*")))

    c = http.client.HTTPConnection("127.0.0.1", port)
    c.request("POST", "/api/chart?name=song.wav&artist=A&title=T", body=b"RIFF" + b"\0" * 2000, headers={"Origin": f"http://127.0.0.1:{port}"})
    r = c.getresponse()
    j = json.loads(r.read())
    tag = "separate" if separate else "no-separate"
    check(f"{tag}: chart made", r.status == 200 and j["notes"] == 2 and j["lyrics"] and ": 10 50 0 do " in j["chart"], (r.status, j.get("error")))
    left = set(glob.glob(os.path.join(tempfile.gettempdir(), "upload_*"))) - before
    check(f"{tag}: uploaded file removed afterwards", not left, left)
    if separate:
        check("separated vocals folder removed afterwards", sep_dirs and not any(os.path.exists(d) for d in sep_dirs), sep_dirs)

    c = http.client.HTTPConnection("127.0.0.1", port)
    c.request("POST", "/api/chart?name=x.wav", body=b"x" * 10, headers={"Origin": "http://evil.example"})
    r = c.getresponse(); r.read()
    check(f"{tag}: other websites refused", r.status == 403, r.status)

    c = http.client.HTTPConnection("127.0.0.1", port)
    c.request("GET", "/api/health")
    r = c.getresponse()
    check(f"{tag}: health", r.status == 200 and json.loads(r.read()) == {"ok": True})
    srv.shutdown()

# without the chart packages: plain web server, "Make notes" off; JavaScript served as JavaScript (Windows registry issue)
server.Handler.ready = False
srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=server.APP_DIR))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
c = http.client.HTTPConnection("127.0.0.1", port)
c.request("GET", "/api/health"); r = c.getresponse()
check("no chart packages: health says off", r.status == 404 and json.loads(r.read()) == {"ok": False})
c.request("POST", "/api/chart?name=a.wav", body=b"x" * 10); r = c.getresponse()
check("no chart packages: make-notes refused with a hint", r.status == 503 and "pip install" in json.loads(r.read())["error"])
for f, want in [("/app.js", "text/javascript"), ("/pitch-worklet.js", "text/javascript"), ("/manifest.webmanifest", "application/manifest+json"), ("/", "text/html")]:
    c.request("GET", f); r = c.getresponse(); r.read()
    check(f"serves {f} as {want}", r.status == 200 and r.getheader("Content-Type", "").startswith(want), r.getheader("Content-Type"))
srv.shutdown()
server.Handler.ready = True

# bad Content-Length values get a 400 straight away (no hang, no crash)
srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=server.APP_DIR))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
for cl in ("-5", "abc", "0"):
    s2 = socket.create_connection(("127.0.0.1", port)); s2.settimeout(5)
    s2.sendall(f"POST /api/chart?name=a.wav HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {cl}\r\n\r\nxyz".encode())
    try:
        first = s2.recv(4096).decode(errors="replace").split("\r\n")[0]
    except socket.timeout:
        first = "timeout"
    s2.close()
    check(f"Content-Length {cl}: 400", " 400 " in first, first)
srv.shutdown()

# a cut-off upload: says Content-Length 5000, sends 100 bytes, then closes
server.Handler.opts = types.SimpleNamespace(no_separate=True, demucs_model="htdemucs", device=None, crepe_model="tiny")
srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=server.APP_DIR))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
s = socket.create_connection(("127.0.0.1", port))
s.sendall(b"POST /api/chart?name=a.wav HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5000\r\n\r\n" + b"x" * 100)
s.shutdown(socket.SHUT_WR)
resp = b""
while True:
    b = s.recv(4096)
    if not b:
        break
    resp += b
resp = resp.decode(errors="replace")
s.close()
check("cut-off upload refused, no chart made", " 400 " in resp.split("\r\n")[0] and "incomplete" in resp, resp.split("\r\n")[0])
srv.shutdown()

print("server: " + (f"{fails} FAILED" if fails else "passed"))
sys.exit(1 if fails else 0)
