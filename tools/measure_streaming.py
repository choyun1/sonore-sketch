"""Measure what sonore 0.10's streams could change on the page, natively.

This script runs sonore to measure it; it is not an independent check. The
numbers are for docs/design/streaming.md. Four parts, each printed as a table:

1. ``import sonore``: 0.9.0 against 0.10.0, best of 3 fresh interpreters
   (``--old`` names a folder holding sonore 0.9.0, made with
   ``pip install --no-deps --target <folder> sonore==0.9.0``; skipped without it).
2. Sound before pictures: for each tab's starting drawing at 2 s and at
   30 s, the seconds until the sound exists (``synthesis_s``) and until
   ``page.handle`` returns everything (the sound and its pictures).
3. Live views: how long sonore's streams take per 10 ms of sound, in 10 ms
   and 50 ms blocks, on 30 s of the Syllables source (under 10 ms keeps up
   with a microphone, natively; Pyodide is slower), and whether the streamed
   spectrogram equals the batch one.
4. ``f0_track`` on 30 s of syllables (Draw a voice, "Take from a sound"),
   0.9.0 against 0.10.0, best of 3.

    python tools/measure_streaming.py --old /tmp/sonore09
    python tools/measure_streaming.py --skip-tabs    # parts 1, 3 and 4 only

Pyodide timings are not here: the browser is about 2 to 4 times slower than
this (docs/design/app.md, D10) and is left to tools/measure_load.py.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import sonore as so

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "src"))

FS = 16000
LONG_S = 30.0
REPEATS = 3
BLOCKS = (160, 800)  # 10 ms and 50 ms at 16 kHz


def best_subprocess(code: str, path: str | None) -> float:
    """Best of ``REPEATS`` fresh interpreters running ``code``, which prints seconds."""
    env = dict(os.environ)
    if path:
        env["PYTHONPATH"] = path
    times = []
    for _ in range(REPEATS):
        out = subprocess.run([sys.executable, "-c", code], env=env, check=True, capture_output=True, text=True)
        times.append(float(out.stdout.split()[-1]))
    return min(times)


IMPORT = "import time; t = time.perf_counter(); import sonore; print(sonore.__version__, time.perf_counter() - t)"
F0 = (
    "import time, sys; sys.path.insert(0, %r); import sonore as so; from sonore_sketch.sources import syllables; "
    "s = syllables(%r, %r); so.f0_track(syllables(1.0, %r)); t = time.perf_counter(); so.f0_track(s); print(time.perf_counter() - t)"
)


def versions_table(old: str | None) -> str:
    rows = [f"{'':32s}{'0.9.0':>10s}{'0.10.0':>10s}"]
    code = F0 % (str(ROOT / "src"), LONG_S, FS, FS)
    for name, snippet in (("import sonore", IMPORT), (f"f0_track, {LONG_S:.0f} s of syllables", code)):
        new = best_subprocess(snippet, None)
        before = f"{best_subprocess(snippet, old):8.2f} s" if old else "       --"
        rows.append(f"{name:32s}{before:>10s}{new:8.2f} s")
    return "\n".join(rows)


def tabs_table() -> str:
    from make_examples import starting_states
    from sonore_sketch.page import handle

    rows = [f"{'':20s}{'2 s: sound':>12s}{'all':>10s}{'30 s: sound':>13s}{'all':>10s}"]
    for tab, state in starting_states().items():
        cells = []
        for duration in (None, LONG_S):
            request = {"tab": tab, "state": json.loads(json.dumps(state))}
            if duration:
                request["state"]["duration"] = duration
            started = time.perf_counter()
            result = handle(request)
            whole = time.perf_counter() - started
            cells.append(f"{result['synthesis_s']:9.2f} s{whole:8.2f} s")
        rows.append(f"{tab:20s}{cells[0]}  {cells[1]}")
        print(rows[-1], flush=True)
    return "\n".join(rows)


def live_views() -> dict:
    def cochleagram(blocks):
        bank = so.gammatone_filterbank(n_bands=32, edges=False)
        pooling = so.EnvelopePooling(25e-3, 10e-3, bank)
        return so.stream(pooling, (part.envelopes() for part in so.stream(bank, blocks)))

    return {
        "spectrogram, 5 ms windows every 2.5 ms": lambda blocks: so.stream(so.GaborFrame(0.005, 0.0025, n_fft=512), blocks),
        "F0 track, decided 50 ms late": lambda blocks: so.stream(so.F0TrackStream(), blocks),
        "cochleagram, 32 gammatones, 10 ms": cochleagram,
    }


def live_table() -> str:
    from sonore_sketch.sources import syllables

    sound = syllables(LONG_S, FS)
    tens_of_ms = sound.duration / 0.01
    rows = [f"{'':42s}{'10 ms blocks':>14s}{'50 ms blocks':>14s}"]
    for name, pipeline in live_views().items():
        cells = []
        for size in BLOCKS:
            best = float("inf")
            for _ in range(REPEATS):
                started = time.perf_counter()
                for _part in pipeline(so.blocks(sound, size)):
                    pass
                best = min(best, time.perf_counter() - started)
            cells.append(f"{1e3 * best / tens_of_ms:9.2f} ms")
        rows.append(f"{name:42s}{cells[0]:>14s}{cells[1]:>14s}")
    frame = so.GaborFrame(0.005, 0.0025, n_fft=512)
    parts = [part for part in so.stream(frame, so.blocks(sound, 160)) if part is not None]
    joined, batch = so.STFT.concatenate(parts), frame.analyze(sound)
    same = joined.data.shape == batch.data.shape and np.array_equal(joined.data, batch.data)
    rows.append(f"streamed spectrogram equals the batch one: {same} ({batch.data.shape[-1]} windows)")
    return "\n".join(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--old", help="a folder holding sonore 0.9.0 (pip install --target)")
    parser.add_argument("--skip-tabs", action="store_true", help="skip part 2 (several minutes at 30 s)")
    args = parser.parse_args()
    print(f"sonore {so.__version__}, Python {sys.version.split()[0]}, {FS} Hz, one process\n")
    print("1 and 4. sonore 0.9.0 against 0.10.0 (best of 3)\n" + versions_table(args.old) + "\n")
    print("3. Live views, per 10 ms of sound (best of 3)\n" + live_table() + "\n")
    if not args.skip_tabs:
        print("2. Sound before pictures: seconds until the sound exists, and until the pictures do too")
        tabs_table()


if __name__ == "__main__":
    main()
