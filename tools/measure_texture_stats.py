"""Measure what a Match a texture tab would need (docs/design/tabs/match_texture.md).

This script runs sonore to measure it; it is not an independent check. For
two sources made here (a rain-like train of impacts from the Scatter events
tab, and the Klatt syllable train the Erase tabs use), at 2 s:

1. Run time: measuring the statistics, and one synthesis iteration, on one
   core (as in Pyodide, which has no threads), at the model's 20 kHz.
2. Convergence: the average SNR over the imposed classes after each of 30
   iterations of the full set (``so.texture.synthesize``'s ``callback``),
   to choose the tab's number of iterations.
3. Each step of the paper's ladder (McDermott & Simoncelli, 2011, Fig. 3):
   spectrum only (no class imposed beyond subband variance), then adding
   marginal moments, modulation power, and the correlations; the SNR each
   step reaches on every class, imposed or not, after 20 iterations.
4. Stepping: ten calls of one iteration each, each starting from the last
   (``init=``), against one call of ten, in time and average SNR, so the
   tab can report progress between iterations.

    OMP_NUM_THREADS=1 python tools/measure_texture_stats.py
"""

import time

import numpy as np
import sonore as so
from sonore.texture.stats import PAPER_CLASSES, TextureStats
from sonore.texture.synth import synthesize

from sonore_sketch import scatter_events, sources

DURATION = 2.0
FS = 16000
LADDER = {
    "spectrum": (),
    "+ marginals": ("env_mean", "env_var", "env_skew", "env_kurt"),
    "+ modulation power": ("env_mean", "env_var", "env_skew", "env_kurt", "mod_power"),
    "+ correlations (all)": PAPER_CLASSES,
}


def rain() -> so.Sound:
    state = {"scatter_events": 1, "duration": DURATION, "fs": FS, "event": "impact", "decay": 0.004,
             "cutoff": 6000, "rate": 300, "regularity": 1, "level_sd": 8, "pitch_sd": 0, "seed": 1}
    return scatter_events.synthesize(state)


def snr_of(sound: so.Sound, target: TextureStats) -> dict[str, float]:
    return target.snr(TextureStats.measure(sound, window="uniform"), classes=PAPER_CLASSES + ("subband_var",))


def report(name: str, sound: so.Sound) -> None:
    print(f"\n== {name} ({sound.duration:.1f} s at {sound.fs:.0f} Hz)")
    start = time.perf_counter()
    target = TextureStats.measure(sound)
    print(f"measure: {time.perf_counter() - start:.2f} s")

    stamps, curve = [time.perf_counter()], []

    def watch(i, x, snr):
        stamps.append(time.perf_counter())
        curve.append(np.mean([snr[c] for c in PAPER_CLASSES]))

    synthesize(target, duration=DURATION, max_iter=30, stop_db=np.inf, rng=0, callback=watch)
    steps = np.diff(stamps)
    print(f"one iteration: median {np.median(steps):.2f} s (first {steps[0]:.2f} s)")
    print("average SNR [dB] after iteration " + ", ".join(
        f"{i}: {curve[i - 1]:.1f}" for i in (1, 2, 5, 10, 15, 20, 30) if i <= len(curve)))

    print("ladder, SNR [dB] after 20 iterations, per class:")
    print("  " + " ".join(f"{c[:9]:>9}" for c in PAPER_CLASSES + ("subband_v",)))
    for step, classes in LADDER.items():
        out, _ = synthesize(target, duration=DURATION, classes=classes or ("subband_var",),
                                 max_iter=20, stop_db=np.inf, rng=0)
        snr = snr_of(out, target)
        print(f"  {' '.join(f'{snr[c]:9.1f}' for c in PAPER_CLASSES + ('subband_var',))}  {step}")

    def average(x):
        snr = snr_of(x, target)
        return np.mean([snr[c] for c in PAPER_CLASSES])

    start = time.perf_counter()
    whole, _ = synthesize(target, duration=DURATION, max_iter=10, stop_db=np.inf, rng=0)
    whole_s = time.perf_counter() - start
    start, stepped = time.perf_counter(), None
    for _ in range(10):
        stepped, _ = synthesize(target, duration=DURATION, max_iter=1, stop_db=np.inf, rng=0, init=stepped)
    stepped_s = time.perf_counter() - start
    print(f"10 iterations in one call: {whole_s:.1f} s, average SNR {average(whole):.1f} dB; "
          f"one at a time: {stepped_s:.1f} s, {average(stepped):.1f} dB")


def main() -> None:
    so.set_fft_workers(1)
    report("rain", rain())
    report("syllables", sources.syllables(DURATION, FS))


if __name__ == "__main__":
    main()
