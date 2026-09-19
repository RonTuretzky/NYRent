#!/usr/bin/env python3
"""Assemble CDP-screencast PNG frames into an optimized palette GIF — no ffmpeg.

Input dir layout (written by the recorder spec):
    <frames_dir>/f00000.png, f00001.png, ...
    <frames_dir>/timestamps.json   # [{"file": "f00000.png", "ts": <epoch seconds>}, ...]
If timestamps.json is missing, frames are assumed evenly spaced at --capture-fps.

Pipeline: resample the timestamped stream to a constant --fps timeline (last frame
wins per tick) -> scale to --width with Lanczos -> ONE global adaptive palette
(median cut over sampled frames; keeps Pillow's inter-frame delta optimization
working, since delta cropping requires identical palettes) -> collapse runs of
identical frames into a single frame with a longer duration (GIF per-frame delay)
-> save with optimize=True, loop forever, --hold ms freeze on the final frame.
"""
import argparse, json, os, sys
from PIL import Image

def load_meta(d, capture_fps):
    tsfile = os.path.join(d, "timestamps.json")
    files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
    if os.path.exists(tsfile):
        meta = json.load(open(tsfile))
        meta.sort(key=lambda m: m["ts"])
        return [(os.path.join(d, m["file"]), m["ts"]) for m in meta]
    return [(os.path.join(d, f), i / capture_fps) for i, f in enumerate(files)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames_dir")
    ap.add_argument("out_gif")
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--width", type=int, default=900)
    ap.add_argument("--colors", type=int, default=256)
    ap.add_argument("--hold", type=int, default=1500, help="freeze on last frame, ms")
    ap.add_argument("--capture-fps", type=float, default=60)
    ap.add_argument("--max-bytes", type=int, default=4_000_000)
    a = ap.parse_args()

    meta = load_meta(a.frames_dir, a.capture_fps)
    if not meta:
        sys.exit(f"no frames in {a.frames_dir}")

    # 1. Resample to constant fps: for each output tick, the newest frame at/before it.
    t0, t1 = meta[0][1], meta[-1][1]
    step = 1.0 / a.fps
    picked, i = [], 0
    t = t0
    while t <= t1 + 1e-9:
        while i + 1 < len(meta) and meta[i + 1][1] <= t:
            i += 1
        picked.append(meta[i][0])
        t += step
    # Never drop the final captured frame: a flow that ends in a state change
    # followed by stillness has its last (and most informative) frame land
    # between ticks — force it in so the end-of-GIF hold shows the true state.
    if picked[-1] != meta[-1][0]:
        picked.append(meta[-1][0])
    # 2. Collapse consecutive duplicates (same source file) into per-frame durations.
    frames_ms = []  # (path, duration_ms)
    for p in picked:
        if frames_ms and frames_ms[-1][0] == p:
            frames_ms[-1][1] += step * 1000
        else:
            frames_ms.append([p, step * 1000])
    frames_ms[-1][1] += a.hold

    def load(p):
        im = Image.open(p).convert("RGB")
        if im.width != a.width:
            im = im.resize((a.width, round(im.height * a.width / im.width)), Image.LANCZOS)
        return im

    # 3. Global palette from a strip of sampled frames (median cut).
    sample_paths = [frames_ms[j][0] for j in range(0, len(frames_ms), max(1, len(frames_ms) // 8))]
    samples = [load(p) for p in sample_paths]
    strip = Image.new("RGB", (samples[0].width, samples[0].height * len(samples)))
    for k, s in enumerate(samples):
        strip.paste(s, (0, k * samples[0].height))
    pal = strip.quantize(colors=a.colors, method=Image.Quantize.MEDIANCUT)

    # 4. Quantize every unique frame against the SAME palette (no dither: flat UI).
    unique = {}
    for p, _ in frames_ms:
        if p not in unique:
            unique[p] = load(p).quantize(colors=a.colors, palette=pal, dither=Image.Dither.NONE)
    seq = [unique[p] for p, _ in frames_ms]
    durs = [round(d) for _, d in frames_ms]

    seq[0].save(
        a.out_gif, save_all=True, append_images=seq[1:],
        duration=durs, loop=0, optimize=True, disposal=1,
    )
    size = os.path.getsize(a.out_gif)
    print(f"{a.out_gif}: {len(seq)} stored frames ({len(picked)} ticks @ {a.fps}fps), "
          f"{size/1e6:.2f} MB{' [OVER BUDGET]' if size > a.max_bytes else ''}")
    if size > a.max_bytes:
        sys.exit(2)

if __name__ == "__main__":
    main()
