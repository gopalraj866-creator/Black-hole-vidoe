#!/usr/bin/env python3
"""Builds narration (edge-tts neural voice), synthesized score + SFX, subtitle timing.

Outputs (in build/):
  audio/narration.wav, audio/music.wav, timing.json, subtitles.srt
"""
import argparse, asyncio, json, os, re, subprocess, wave
import numpy as np

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
WORK = os.path.join(BUILD, "audio", "work")


def run(cmd):
    subprocess.run(cmd, check=True)


def split_sentences(text):
    text = text.replace("\u201c", "").replace("\u201d", "").replace('"', "")
    return [p for p in re.split(r"(?<=[.?!])\s+", text.strip()) if p]


async def _tts(text, voice, rate, out):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate=rate, pitch="-3Hz").save(out)


def tts(text, voice, rate, out):
    for attempt in range(5):
        try:
            asyncio.run(_tts(text, voice, rate, out))
            if os.path.getsize(out) > 1000:
                return
        except Exception as e:  # network hiccup
            print("tts retry:", e)
        import time
        time.sleep(2 + attempt * 2)
    raise RuntimeError("TTS failed for: " + text[:60])


def to_wav(src, dst, tempo=1.0):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", str(SR), "-ac", "1"]
    if abs(tempo - 1.0) > 1e-3:
        cmd += ["-filter:a", f"atempo={tempo:.4f}"]
    run(cmd + [dst])


def read_wav(path):
    with wave.open(path) as w:
        d = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    # trim silence
    idx = np.where(np.abs(d) > 0.01)[0]
    if len(idx):
        d = d[max(0, idx[0] - int(0.03 * SR)): idx[-1] + int(0.08 * SR)]
    pk = np.max(np.abs(d)) + 1e-9
    return d * (0.85 / pk)


def write_wav(path, stereo):
    st = np.clip(stereo, -1, 1)
    pcm = (st * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def pieces(sent, maxc=84):
    """Split a sentence into subtitle-sized pieces."""
    if len(sent) <= maxc:
        return [sent]
    parts = re.split(r"(?<=[,;:])\s+", sent)
    out, cur = [], ""
    for p in parts:
        if cur and len(cur) + 1 + len(p) > maxc:
            out.append(cur)
            cur = p
        else:
            cur = (cur + " " + p).strip()
    out.append(cur)
    final = []
    for p in out:
        while len(p) > maxc * 1.3:
            mid = p.rfind(" ", 0, len(p) // 2 + 10)
            final.append(p[:mid])
            p = p[mid + 1:]
        final.append(p)
    return final


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def build_narration(tl, voice, rate):
    os.makedirs(WORK, exist_ok=True)
    N = int(tl["duration"] * SR)
    out = np.zeros(N, dtype=np.float32)
    timing = {"fps": tl["fps"], "duration": tl["duration"], "scenes": []}
    for i, s in enumerate(tl["scenes"]):
        sents = split_sentences(s["narration"])
        mp3s = []
        for j, t in enumerate(sents):
            mp3 = f"{WORK}/s{i:02d}_{j}.mp3"
            tts(t, voice, rate, mp3)
            mp3s.append(mp3)

        def load(tempo):
            ws = []
            for j, mp3 in enumerate(mp3s):
                w = f"{WORK}/s{i:02d}_{j}.wav"
                to_wav(mp3, w, tempo)
                ws.append(read_wav(w))
            return ws

        wavs = load(1.0)
        start = s["start"] + (0.5 if i == 0 else 0.6)
        budget = s["end"] - 0.35 - start
        gaps = [0.6 if sents[j].endswith("?") else 0.45 for j in range(len(sents))]
        speech = sum(len(w) for w in wavs) / SR
        if speech + sum(gaps) > budget:
            min_gap = 0.12 * len(sents)
            if speech + min_gap <= budget:
                scale = (budget - speech) / sum(gaps)
                gaps = [g * scale for g in gaps]
            else:
                tempo = min(1.25, speech / max(budget - min_gap, 1.0))
                print(f"scene {s['id']}: speeding narration x{tempo:.2f}")
                wavs = load(tempo)
                gaps = [0.12] * len(sents)
        cur = start
        chunks = []
        for j, w in enumerate(wavs):
            a = int(cur * SR)
            out[a:a + len(w)] += w[: max(0, N - a)]
            dur = len(w) / SR
            ps = pieces(sents[j])
            total_chars = sum(len(p) for p in ps)
            tt = cur
            for p in ps:
                d = dur * len(p) / total_chars
                chunks.append({"t0": round(tt, 3), "t1": round(tt + d, 3), "text": p})
                tt += d
            cur += dur + gaps[j]
        if cur - gaps[-1] > s["end"]:
            print(f"WARNING: scene {s['id']} narration overruns by {cur - gaps[-1] - s['end']:.1f}s")
        timing["scenes"].append({"id": s["id"], "start": s["start"], "end": s["end"], "narrationStart": start, "chunks": chunks})
    # subtitles
    lines, k = [], 1
    for sc in timing["scenes"]:
        for c in sc["chunks"]:
            lines += [str(k), f"{srt_time(c['t0'])} --> {srt_time(c['t1'])}", c["text"], ""]
            k += 1
    with open(os.path.join(BUILD, "subtitles.srt"), "w") as f:
        f.write("\n".join(lines))
    with open(os.path.join(BUILD, "timing.json"), "w") as f:
        json.dump(timing, f, indent=1)
    return np.stack([out, out], axis=1)


# ----------------------------------------------------------------- synthesized score / SFX
def ma(x, k):
    cs = np.cumsum(np.pad(x.astype(np.float64), (k, 0)))
    return ((cs[k:] - cs[:-k]) / k).astype(np.float32)


def build_music(duration):
    rng = np.random.default_rng(7)
    N = int(duration * SR)
    L = np.zeros(N, dtype=np.float32)
    R = np.zeros(N, dtype=np.float32)

    # evolving pad: one chord per 48 s with 6 s crossfades
    chords = [
        [55.0, 82.41, 110.0, 164.81, 220.0],      # Am
        [43.65, 65.41, 87.31, 130.81, 174.61],    # F
        [65.41, 98.0, 130.81, 196.0, 261.63],     # C
        [49.0, 73.42, 98.0, 146.83, 196.0],       # G
        [55.0, 82.41, 110.0, 164.81, 220.0],      # Am
        [43.65, 65.41, 87.31, 130.81, 174.61],    # F
        [73.42, 110.0, 146.83, 220.0, 293.66],    # Dm
        [55.0, 82.41, 110.0, 164.81, 220.0],      # Am
        [43.65, 65.41, 87.31, 130.81, 174.61],    # F
        [55.0, 82.41, 110.0, 164.81, 220.0],      # Am
    ]
    seg, xf = 48.0, 6.0
    for ci, freqs in enumerate(chords):
        a, b = max(0.0, ci * seg - xf), min(duration, (ci + 1) * seg + xf)
        if b <= a:
            continue
        t = np.arange(int(a * SR), int(b * SR)) / SR
        env = np.ones_like(t)
        lo_edge, hi_edge = ci * seg, (ci + 1) * seg
        env = np.where(t < lo_edge, 0.5 - 0.5 * np.cos(np.pi * np.clip((t - (lo_edge - xf)) / xf, 0, 1)), env) if ci > 0 else env
        env = np.where(t > hi_edge, 0.5 + 0.5 * np.cos(np.pi * np.clip((t - hi_edge) / xf, 0, 1)), env)
        sl, sr = np.zeros_like(t), np.zeros_like(t)
        for k, f in enumerate(freqs):
            lfo = 0.6 + 0.4 * np.sin(2 * np.pi * (0.05 + 0.013 * k) * t + k)
            for h, amp in ((1, 1.0), (2, 0.35), (3, 0.15)):
                sl += amp * lfo * np.sin(2 * np.pi * (f * h + 0.15 * k) * t)
                sr += amp * lfo * np.sin(2 * np.pi * (f * h - 0.15 * k) * t + 0.7)
        i0 = int(a * SR)
        L[i0:i0 + len(t)] += (0.030 * env * sl).astype(np.float32)
        R[i0:i0 + len(t)] += (0.030 * env * sr).astype(np.float32)

    # master dynamics
    kx = [0, 2, 30, 60, 100, 140, 215, 255, 300, 340, 380, 430, 470, 480]
    ky = [0.0, 0.7, 0.8, 0.6, 0.7, 0.8, 0.9, 0.7, 0.9, 0.5, 0.6, 0.7, 0.5, 0.0]
    master = np.interp(np.arange(N) / SR, kx, ky).astype(np.float32)
    L *= master
    R *= master

    # rumble (low-passed noise) with slow swell
    w = rng.standard_normal(N).astype(np.float32)
    rum = ma(ma(w, 300), 300)
    rum /= (np.std(rum) + 1e-9)
    rk = np.interp(np.arange(N) / SR, [0, 20, 60, 255, 270, 340, 380, 480], [0.25, 0.9, 0.5, 0.8, 1.2, 0.8, 0.5, 0.2]).astype(np.float32)
    L += 0.09 * rum * rk * master
    R += 0.09 * np.roll(rum, 2000) * rk * master

    def add(sig, at, gain=1.0, pan=0.0):
        a = int(at * SR)
        if a >= N or a + len(sig) <= 0:
            return
        s0 = max(0, -a)
        seg_ = sig[s0:N - a]
        L[a + s0:a + s0 + len(seg_)] += seg_ * gain * (1 - 0.5 * max(pan, 0))
        R[a + s0:a + s0 + len(seg_)] += seg_ * gain * (1 + 0.5 * min(pan, 0))

    # bass impacts
    for at, strength in {0.0: 1.0, 30.0: 0.45, 60.0: 0.35, 135.0: 0.4, 175.0: 0.5, 220.0: 0.4, 255.0: 1.0, 300.0: 0.6, 340.0: 0.7, 380.0: 0.4, 430.0: 0.5}.items():
        t = np.arange(int(4.0 * SR)) / SR
        f = 28 + 62 * np.exp(-t * 3.0)
        phase = 2 * np.pi * np.cumsum(f) / SR
        body = np.sin(phase) * np.exp(-t / 1.3)
        burst = ma(rng.standard_normal(len(t)), 20) * np.exp(-t / 0.22) * 4.0
        add((0.8 * body + 0.35 * burst).astype(np.float32), at, strength)

    # transition whooshes (rising then falling filtered noise)
    for at in [29.2, 59.2, 94.2, 134.2, 174.2, 219.2, 254.2, 299.2, 339.2, 379.2, 429.2]:
        n = int(2.6 * SR)
        t = np.arange(n) / SR
        noise = ma(rng.standard_normal(n), 10) * 6.0
        bell = np.sin(np.pi * np.clip(t / 2.6, 0, 1)) ** 2.5
        sweep = np.sin(2 * np.pi * np.cumsum(180 + 900 * (t / 2.6) ** 2) / SR) * 0.15
        add(((noise + sweep) * bell * 0.16).astype(np.float32), at, 1.0, pan=rng.uniform(-0.6, 0.6))

    # spacecraft hum (scenes 2 to 8)
    t = np.arange(N) / SR
    hum_env = np.interp(t, [25, 32, 262, 270, 300, 306], [0, 1, 1, 0.8, 0.8, 0]).astype(np.float32)
    hum = (np.sin(2 * np.pi * 60 * t) + 0.5 * np.sin(2 * np.pi * 120.4 * t) + 0.25 * np.sin(2 * np.pi * 181 * t)) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.21 * t))
    L += (0.012 * hum * hum_env).astype(np.float32)
    R += (0.012 * hum * hum_env).astype(np.float32)

    # interface blips
    def blip(freq, dur=0.09):
        n = int(dur * SR)
        tt = np.arange(n) / SR
        return (np.sin(2 * np.pi * freq * tt) * np.exp(-tt / 0.03)).astype(np.float32)
    for scene_start, scene_end, step in [(30, 60, 7.5), (135, 175, 6.0), (255, 300, 5.0)]:
        at = scene_start + 3.0
        while at < scene_end - 2:
            add(blip(1400), at, 0.05, pan=0.4)
            add(blip(1880), at + 0.14, 0.04, pan=0.4)
            at += step
    # ship clock ticks in scene 6
    tick = (ma(rng.standard_normal(int(0.06 * SR)), 2) * np.exp(-np.arange(int(0.06 * SR)) / (0.012 * SR))).astype(np.float32)
    for sec in range(178, 218):
        add(tick, float(sec), 0.55)

    # plasma crackle in scene 3
    for _ in range(int(35 * 40)):
        at = rng.uniform(60, 95)
        add((rng.standard_normal(int(0.004 * SR)) * 0.5).astype(np.float32), at, 0.03 * rng.uniform(0.3, 1), pan=rng.uniform(-1, 1))

    # clean fade-out
    fade = np.clip((duration - np.arange(N) / SR) / 8.0, 0, 1).astype(np.float32) ** 1.5
    L *= fade
    R *= fade
    st = np.stack([L, R], axis=1)
    return np.tanh(st * 1.4) * 0.8


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--rate", default="-6%")
    ap.add_argument("--skip-tts", action="store_true", help="music only (debug)")
    a = ap.parse_args()
    os.makedirs(os.path.join(BUILD, "audio"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "timeline.json")) as f:
        tl = json.load(f)
    print("synthesizing score and effects ...")
    write_wav(os.path.join(BUILD, "audio", "music.wav"), build_music(tl["duration"]))
    if not a.skip_tts:
        print("generating narration ...")
        write_wav(os.path.join(BUILD, "audio", "narration.wav"), build_narration(tl, a.voice, a.rate))
    print("done")
