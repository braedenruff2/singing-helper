#!/usr/bin/env python3
"""Generate an UltraStar karaoke chart (vocal notes + lyrics) from an audio file.

    pip install -r tools/requirements.txt
    python tools/make_chart.py song.mp3 --artist "Artist" --title "Title" -o song.txt

Pipeline: Demucs isolates the vocals -> CREPE tracks their pitch every 10 ms ->
pitch is cut into notes -> LRCLIB synced lyrics are spread over the notes.
Load the result in Singing Helper with "Load UltraStar .txt" while the song plays.
Use audio you own (e.g. a purchased download); Spotify streams can't be used.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

import numpy as np

MS_PER_BEAT = 10  # chart resolution; UltraStar BPM = 60000 / (MS_PER_BEAT * 4)


# ---------------------------------------------------------------- audio
def separate_vocals(path, model, device):
    out = tempfile.mkdtemp(prefix="chart_")
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", model, "-o", out, path]
    if device:
        cmd[3:3] = ["-d", device]
    print("Separating vocals (first run downloads the model, ~80 MB)...", file=sys.stderr)
    try:
        subprocess.run(cmd, check=True)
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)  # no half-made temp folder left behind
        raise
    name = os.path.splitext(os.path.basename(path))[0]
    return os.path.join(out, model, name, "vocals.wav")


def load_mono_16k(path):
    import soundfile as sf
    import torch
    import torchaudio.functional as AF

    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = torch.from_numpy(x.mean(axis=1))
    if sr != 16000:
        x = AF.resample(x, sr, 16000)
    return x.numpy()


# ---------------------------------------------------------------- pitch
def track_pitch(audio16k, model, device):
    import torch
    import torchcrepe

    hop = 160  # 10 ms
    a = torch.from_numpy(audio16k)[None]
    print("Tracking pitch...", file=sys.stderr)
    f0, per = torchcrepe.predict(a, 16000, hop, 65.0, 1100.0, model, batch_size=1024,
                                 device=device or "cpu", return_periodicity=True,
                                 decoder=torchcrepe.decode.viterbi)
    per = torchcrepe.filter.median(per, 3)
    f0 = f0[0].numpy()
    per = per[0].numpy()
    # loudness per frame, to drop near-silent bleed (windows centred on the frame times, like CREPE's padded frames)
    n = len(f0)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(audio16k, (512, hop * n + 1024)), 1024)[::hop][:n]
    rms = np.sqrt((frames ** 2).mean(axis=1))
    db = 20 * np.log10(rms + 1e-9)
    return f0, per, db


def to_notes(f0, per, db, per_th=0.45, db_floor=None, min_ms=90, split_semitones=0.7):
    """Cut a 10 ms pitch track into notes: [(start_ms, dur_ms, midi)]."""
    if db_floor is None:
        db_floor = np.percentile(db, 95) - 35
    voiced = (per > per_th) & (db > db_floor) & (f0 > 0)
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0), np.nan)
    notes = []
    i, n = 0, len(midi)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n and voiced[j]:
            j += 1
        notes += split_run(midi[i:j], i, split_semitones)
        i = j
    min_frames = min_ms / 10
    notes = [(s, d, m) for s, d, m in notes if d >= min_frames]
    # merge same-pitch neighbours separated by tiny gaps (consonants)
    merged = []
    for s, d, m in notes:
        if merged and merged[-1][2] == m and s - (merged[-1][0] + merged[-1][1]) <= 6:
            ps, pd, pm = merged[-1]
            merged[-1] = (ps, s + d - ps, pm)
        else:
            merged.append((s, d, m))
    return [(s * 10, d * 10, m) for s, d, m in merged]


def split_run(run, offset, th):
    """Split a voiced run where the pitch settles on a new semitone (ignores vibrato)."""
    out = []
    start = 0
    k = 0
    while k < len(run):
        cur = np.median(run[start:k + 1])
        # a change must hold for 4 frames (40 ms) to count, so vibrato doesn't split notes
        if k - start >= 4 and np.all(np.abs(run[k:k + 4] - cur) > th) and k + 4 <= len(run):
            out.append((offset + start, k - start, int(round(np.median(run[start:k])))))
            start = k
        k += 1
    out.append((offset + start, len(run) - start, int(round(np.median(run[start:])))))
    return out


# ---------------------------------------------------------------- lyrics
MAX_DURATION_DIFF_S = 10  # same rule as lyrics.js: a version this much longer/shorter would be out of sync


def _lrclib(endpoint, params):
    req = urllib.request.Request("https://lrclib.net/api/" + endpoint + "?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": "SingingHelper/0.1"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def fetch_lrc(artist, title, duration_s):
    """Synced lyrics from LRCLIB: exact match first, then a search (like the app's lyrics.js)."""
    try:
        j = _lrclib("get", {"artist_name": artist, "track_name": title, "duration": int(round(duration_s))})
        if j.get("syncedLyrics"):
            return j["syncedLyrics"]
    except Exception:  # noqa: BLE001  (404 = no exact match; fall through to the search)
        pass
    try:
        hits = _lrclib("search", {"artist_name": artist, "track_name": title})
    except Exception as e:  # noqa: BLE001
        print(f"LRCLIB lookup failed ({e}); continuing without lyrics", file=sys.stderr)
        return None
    hits = [h for h in hits if h.get("syncedLyrics") and abs((h.get("duration") or 0) - duration_s) <= MAX_DURATION_DIFF_S]
    hits.sort(key=lambda h: abs(h["duration"] - duration_s))
    return hits[0]["syncedLyrics"] if hits else None


def parse_lrc(text):
    lines = []
    for raw in text.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        body = re.sub(r"\[[^\]]*\]", "", raw).strip()
        body = re.sub(r"<\d+:\d+(?:\.\d+)?>", "", body)
        for mm, ss in stamps:
            lines.append(((int(mm) * 60 + float(ss)) * 1000, body))
    lines.sort()
    return [(t, b) for t, b in lines]


VOWELS = set("aeiouyAEIOUYàáâäèéêëìíîïòóôöùúûü")
DIGRAPHS = ("ng", "ck", "sh", "ch", "th", "ph", "wh", "gh")


def syllables(word):
    """Rough English-ish syllable split: 'singing' -> ['sing', 'ing'], 'little' -> ['lit', 'tle']."""
    # vowel groups (a 'y' at the very start is a consonant)
    groups = []
    i = 0
    while i < len(word):
        if word[i] in VOWELS and not (i == 0 and word[i] in "yY"):
            j = i
            while j < len(word) and word[j] in VOWELS:
                j += 1
            groups.append((i, j))
            i = j
        else:
            i += 1
    # silent final e: 'time', 'love', 'smile(s)' (but not 'the', 'be')
    if len(groups) > 1 and re.search(r"[^aeiouy]e[sd]?$", word, re.I) and groups[-1][1] - groups[-1][0] == 1 \
            and word[groups[-1][0]].lower() == "e" and not re.search(r"[^aeiouy]le$", word, re.I):
        groups.pop()
    if len(groups) < 2:
        return [word]
    cuts = []
    for (_, end), (start, _) in zip(groups, groups[1:]):
        cons = word[end:start]
        if len(cons) <= 1:
            cut = end  # V-CV: 'mu-sic'
        elif cons[:2].lower() in DIGRAPHS and len(cons) >= 2:
            cut = end + 2 if len(cons) > 2 or cons.lower() == "ng" else end  # 'sing-ing', 'mo-ther'
        else:
            cut = end + 1  # VC-CV: 'lit-tle', 'win-ter'
        cuts.append(cut)
    parts, prev = [], 0
    for c in cuts:
        parts.append(word[prev:c])
        prev = c
    parts.append(word[prev:])
    return [p for p in parts if p]


def attach_lyrics(notes, lrc_lines):
    """Give each note a syllable. Returns texts and the note indexes where lines start."""
    texts = ["~"] * len(notes)
    line_starts = []
    for li, (t, body) in enumerate(lrc_lines):
        if not body:
            continue
        end = lrc_lines[li + 1][0] if li + 1 < len(lrc_lines) else t + 8000
        idx = [k for k, (s, d, m) in enumerate(notes) if t - 150 <= s < end - 150]
        if not idx:
            continue
        line_starts.append(idx[0])
        sylls = []
        for w in body.split():
            ss = syllables(w)
            ss[-1] += " "
            sylls += ss
        if len(sylls) > len(idx):  # more syllables than notes: pack extras into the last notes
            per = len(sylls) / len(idx)
            groups = [sylls[int(round(k * per)):int(round((k + 1) * per))] for k in range(len(idx))]
            for k, g in zip(idx, groups):
                texts[k] = "".join(g) or "~"
        else:  # spread syllables over notes in time; leftover notes are held vowels ("~")
            span = len(idx) / len(sylls)
            for si, syl in enumerate(sylls):
                texts[idx[int(si * span)]] = syl
    return texts, line_starts


# ---------------------------------------------------------------- output
def write_ultrastar(path, notes, texts, line_starts, artist, title):
    bpm = 60000 / (MS_PER_BEAT * 4)
    out = [f"#TITLE:{title or 'Unknown'}", f"#ARTIST:{artist or 'Unknown'}", f"#BPM:{bpm:g}", "#GAP:0",
           "#COMMENT:generated by Singing Helper make_chart.py"]
    starts = set(line_starts)
    for k, ((s, d, m), txt) in enumerate(zip(notes, texts)):
        if k in starts and k > 0:
            out.append(f"- {int(s // MS_PER_BEAT) - 1}")
        out.append(f": {int(s // MS_PER_BEAT)} {max(1, int(d // MS_PER_BEAT))} {m - 60} {txt}")
    out.append("E")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("-o", "--out", help="output .txt (default: next to the audio)")
    ap.add_argument("--artist", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--lyrics", help="local .lrc file instead of looking it up on LRCLIB")
    ap.add_argument("--no-separate", action="store_true", help="audio is already an isolated vocal")
    ap.add_argument("--demucs-model", default="htdemucs")
    ap.add_argument("--crepe-model", default="full", choices=["full", "tiny"])
    ap.add_argument("--device", default=None, help="cpu, cuda or mps")
    a = ap.parse_args()

    vocals = a.audio if a.no_separate else separate_vocals(a.audio, a.demucs_model, a.device)
    try:
        audio = load_mono_16k(vocals)
    finally:
        if vocals != a.audio:  # <tmp>/<model>/<name>/vocals.wav: Demucs' temp folder (~80 MB a song)
            shutil.rmtree(os.path.dirname(os.path.dirname(os.path.dirname(vocals))), ignore_errors=True)
    f0, per, db = track_pitch(audio, a.crepe_model, a.device)
    notes = to_notes(f0, per, db)
    print(f"{len(notes)} notes found", file=sys.stderr)

    lrc = open(a.lyrics, encoding="utf-8").read() if a.lyrics else (
        fetch_lrc(a.artist, a.title, len(audio) / 16000) if a.title else None)
    texts, starts = attach_lyrics(notes, parse_lrc(lrc)) if lrc else (["~"] * len(notes), [])
    out = a.out or os.path.splitext(a.audio)[0] + ".txt"
    write_ultrastar(out, notes, texts, starts, a.artist, a.title)
    print("wrote " + out, file=sys.stderr)


if __name__ == "__main__":
    main()
