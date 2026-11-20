#!/usr/bin/env python3
"""Tests for make_chart.py's note cutting, syllables, lyrics and chart writing. Needs only numpy.

    python tools/test_make_chart.py
"""
import json
import os
import sys
import tempfile
import urllib.error

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_chart as mc  # noqa: E402

fails = 0


def check(label, ok, detail=""):
    global fails
    print(("ok   " if ok else "FAIL ") + label + (f"  ({detail})" if detail != "" else ""))
    if not ok:
        fails += 1


def track(segments, vib=0.0):
    """10 ms pitch track from [(midi or None, frames)] -> f0, periodicity, dB."""
    f0, per, db = [], [], []
    t = 0
    for m, n in segments:
        for _ in range(n):
            if m is None:
                f0.append(0.0); per.append(0.05); db.append(-80.0)
            else:
                mm = m + vib * np.sin(2 * np.pi * 5.5 * t * 0.01)
                f0.append(440 * 2 ** ((mm - 69) / 12)); per.append(0.9); db.append(-20.0)
            t += 1
    return np.array(f0), np.array(per), np.array(db)


# ---- to_notes
notes = mc.to_notes(*track([(None, 20), (60, 40), (62, 40), (None, 30), (64, 50)]))
check("three notes cut from a clean track", [(m) for _, _, m in notes] == [60, 62, 64], notes)
check("note times in ms", notes[0][0] == 200 and abs(notes[0][1] - 400) <= 10 and notes[2][0] == 1300, notes)
notes = mc.to_notes(*track([(None, 10), (67, 120), (None, 10)], vib=0.4))
check("vibrato (±40¢) doesn't split a held note", len(notes) == 1 and notes[0][2] == 67, notes)
notes = mc.to_notes(*track([(None, 10), (60, 5), (None, 10), (62, 40)]))
check("blips under 90 ms dropped", [m for _, _, m in notes] == [62], notes)
notes = mc.to_notes(*track([(60, 30), (None, 3), (60, 30)]))
check("same pitch across a 30 ms consonant gap merged", len(notes) == 1 and abs(notes[0][1] - 630) <= 10, notes)
check("all-silent track -> no notes", mc.to_notes(*track([(None, 100)])) == [])

# ---- syllables
for word, want in [("singing", ["sing", "ing"]), ("little", ["lit", "tle"]), ("mother", ["mo", "ther"]),
                   ("music", ["mu", "sic"]), ("time", ["time"]), ("the", ["the"]), ("love", ["love"]),
                   ("yesterday", ["yes", "ter", "day"]), ("I", ["I"])]:
    got = mc.syllables(word)
    check(f"syllables({word})", got == want, got)
check("syllables never lose letters", all("".join(mc.syllables(w)) == w for w in
                                          "beautiful remember together smiles don't rock'n'roll a".split()))

# ---- lyrics
lrc = "[ar:x]\n[00:01.00]hello world\n[00:03.00]\n[00:04.00][00:08.00]again\n"
lines = mc.parse_lrc(lrc)
check("parse_lrc: stamps, empty lines, repeated stamps", lines == [(1000.0, "hello world"), (3000.0, ""), (4000.0, "again"), (8000.0, "again")], lines)
notes = [(1000, 300, 60), (1400, 300, 62), (1800, 300, 64), (4000, 500, 65), (8000, 400, 67)]
texts, starts = mc.attach_lyrics(notes, lines)
check("syllables spread over the line's notes", texts[:3] == ["hel", "lo ", "world "], texts)
check("each lyric line starts a chart line", starts == [0, 3, 4], starts)
texts, _ = mc.attach_lyrics([(1000, 300, 60)], [(1000.0, "so many words here")])
check("more syllables than notes: packed, none lost", texts == ["so many words here "], texts)

# ---- write_ultrastar round trip
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "c.txt")
    mc.write_ultrastar(p, notes, ["a", "b", "c", "d", "e"], [0, 3, 4], "Art", "Tit")
    txt = open(p, encoding="utf-8").read().splitlines()
check("header", txt[:4] == ["#TITLE:Tit", "#ARTIST:Art", "#BPM:1500", "#GAP:0"], txt[:4])
body = [l for l in txt if l[:1] in ":-"]
check("notes and breaks in beats of 10 ms", body[:4] == [": 100 30 0 a", ": 140 30 2 b", ": 180 30 4 c", "- 399"], body)
check("ends with E", txt[-1] == "E")

# ---- fetch_lrc: exact match, search fallback, duration limit (network faked)
calls = []


def fake(answers):
    def _lrclib(endpoint, params):
        calls.append(endpoint)
        a = answers[endpoint]
        if isinstance(a, Exception):
            raise a
        return a
    return _lrclib


real = mc._lrclib
try:
    nf = urllib.error.HTTPError("u", 404, "not found", {}, None)
    mc._lrclib = fake({"get": {"syncedLyrics": "[00:01.00]exact"}, "search": []})
    calls.clear()
    check("LRCLIB exact match", mc.fetch_lrc("A", "T", 200) == "[00:01.00]exact" and calls == ["get"], calls)
    mc._lrclib = fake({"get": nf, "search": [{"duration": 260, "syncedLyrics": "far"}, {"duration": 203, "syncedLyrics": "near"},
                                             {"duration": 200, "syncedLyrics": None}]})
    check("LRCLIB search fallback picks the closest synced version", mc.fetch_lrc("A", "T", 200) == "near")
    mc._lrclib = fake({"get": nf, "search": [{"duration": 260, "syncedLyrics": "live"}]})
    check("LRCLIB: a version 60 s longer is not used", mc.fetch_lrc("A", "T", 200) is None)
    mc._lrclib = fake({"get": OSError("offline"), "search": OSError("offline")})
    check("LRCLIB offline -> no lyrics, no crash", mc.fetch_lrc("A", "T", 200) is None)
finally:
    mc._lrclib = real

# Demucs failing (no ffmpeg, bad file) leaves no temp folder behind
import glob, subprocess
before = set(glob.glob(os.path.join(tempfile.gettempdir(), "chart_*")))
real_run = subprocess.run
def boom(*a, **k): raise subprocess.CalledProcessError(1, "demucs")
subprocess.run = boom
try:
    mc.separate_vocals("song.mp3", "htdemucs", None)
    check("separate_vocals: failure raises", False)
except subprocess.CalledProcessError:
    check("separate_vocals: failure raises", True)
finally:
    subprocess.run = real_run
check("separate_vocals: no temp folder left on failure", set(glob.glob(os.path.join(tempfile.gettempdir(), "chart_*"))) == before)

print("make_chart: " + (f"{fails} FAILED" if fails else "passed"))
sys.exit(1 if fails else 0)
