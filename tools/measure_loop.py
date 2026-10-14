"""Measure going back and forth between the blobs and the bands.

This script runs sonore to measure it; it is not an independent check. The
Draw modulation tab applies the bands last, as a time-varying filter on the
finished sound (docs/design/tabs/bands.md, K1), so the bands always hold and
the blobs pay: the measured plane within the bands (``blobs.measured``) is
a few dB less like the drawing than with no bands (K-M2, K-M4). The
question is whether alternating between the two constraints, as Griffin &
Lim do, gets some of that back. Three ways to spend ``n`` iterations:

* ``after``: what the tab does now, ``to_sound(iterations=n)`` on the whole
  range, then the bands once;
* ``naive``: the bands, then ``n`` times: one of ``to_sound``'s iterations
  on the whole range (keep the fine structure and modulation phase,
  impose the drawn magnitudes), then the bands again;
* ``within``: the bands, then ``n`` times: the same step taken on the
  envelopes *relative to the bands' gain* (as ``blobs.measured`` reads
  them), multiplied by the gain again, then the bands again. The band's own
  shape and motion stay out of what the blobs are imposed on.

The script prints, per band case and iteration count:

1. The B-M4 contrast of blobs.md on the measured plane within the bands
   (measured power where the drawing is within 6 dB of its peak over where
   it is 30 dB or more below, |rate| from 1 to 32 Hz, density <= 4), tones
   and noise, 3 s, the drawing the tab starts with.
2. Rejection: level inside the band over the level half an octave or more
   outside it (static band only), so the bands still hold.
3. Time per iteration, warm.

    python tools/measure_loop.py
"""

import statistics
import time

import numpy as np
import sonore as so
from sonore.views.envelopes import Envelopes

from sonore_sketch import blobs as tab

FS = 16000
ITERATIONS = (0, 1, 2, 5, 10)
CASES = {
    "no band": [],
    "1 oct at 1 kHz": [{"points": [[0, 1000]], "width": 1, "level": 0}],
    "1 oct gliding 500->4000 Hz": [{"points": [[0, 500], [3, 4000]], "width": 1, "level": 0}],
    "2 oct gliding 300->2400 Hz": [{"points": [[0, 300], [3, 2400]], "width": 2, "level": 0}],
    "1/2 oct at 500 Hz and 2 kHz": [
        {"points": [[0, 500]], "width": 0.5, "level": 0},
        {"points": [[0, 2000]], "width": 0.5, "level": 0},
    ],
}


def state(bands, carrier="tones", iterations=0):
    return {"blobs": 1, "duration": 3.0, "fs": FS, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
            "carrier": carrier, "iterations": iterations, "rms_depth": 0.2, "seed": 1,
            "items": tab.B9_ITEMS, "bands": bands}


def step_whole(sound, drawn):
    """One of ``to_sound``'s iterations, written out."""
    return drawn.iterate(sound)


def step_within(sound, drawn, bands):
    """The same step on the envelopes relative to the bands' gain."""
    bank = drawn.filterbank
    subbands = bank.analyze(sound)
    env = subbands.envelopes(fs=tab.ENV_FS).data.mean(axis=2)[:, 1:-1]  # (time, band)
    t = np.arange(env.shape[0]) / tab.ENV_FS
    gain = tab.band_gain(bands, bank.cfs[1:-1], t)
    weight = gain / gain.max()
    relative = env / np.maximum(gain, 10 ** (tab.BAND_FLOOR_DB / 20))
    relative = relative / (np.sum(weight * relative) / np.sum(weight))  # mean 1 within the bands
    phase = np.angle(np.fft.fft2((weight * (relative - 1)).T))
    values = drawn.to_envelopes(phase=phase, quiet=True).data[:, :, 0].copy()  # (time, band), edge bands zero
    values[:, 1:-1] *= gain
    out = (Envelopes(values, tab.ENV_FS, bank) * subbands.tfs()).to_sound()
    return so.Sound(out.data[: sound.n_samples], sound.fs)


def run(method, s, n):
    drawn = tab.target(s)
    bands = s["bands"]
    if method == "after":
        return tab.synthesize({**s, "iterations": n})
    sound = tab.synthesize(s)
    for _ in range(n):
        sound = step_whole(sound, drawn) if method == "naive" else step_within(sound, drawn, bands)
        sound = tab.band_limit(sound, bands) if bands else sound.normalize()
    return sound


def contrast(sound, s):
    drawn = tab.target(s)
    near = ((np.abs(drawn.w_t) <= 32) & (np.abs(drawn.w_t) >= 1))[None, :] & (drawn.w_f <= 4)[:, None]
    inside = near & (drawn.level >= drawn.level[near].max() - 6)
    outside = near & (drawn.level <= drawn.level[near].max() - 30)
    power = 10 ** (tab.measured(sound, s).level / 10)
    return 10 * np.log10(power[inside].mean() / power[outside].mean())


def rejection(sound, center, width):
    stft = so.STFT(sound, win_dur=0.032)
    power = np.mean(np.abs(stft.data[0]) ** 2, axis=1)
    octaves = np.abs(np.log2(np.maximum(stft.f, 1) / center))
    return 10 * np.log10(power[octaves <= width / 2 - 1 / 12].mean() / power[octaves >= width / 2 + 0.5].mean())


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


if __name__ == "__main__":
    print(f"sonore {so.__version__}, numpy {np.__version__}, fs {FS} Hz, 3 s, the tab's starting drawing")
    for carrier in ("tones", "noise"):
        print(f"\n1. B-M4 contrast within the bands, {carrier}; columns are iterations {ITERATIONS}")
        for name, bands in CASES.items():
            s = state(bands, carrier)
            for method in ("after",) if not bands else ("after", "naive", "within"):
                cells = " ".join(f"{contrast(run(method, s, n), s):5.1f}" for n in ITERATIONS)
                print(f"  {name:<28s} {method:<6s} {cells} dB")

    print("\n2. rejection, 1 oct at 1 kHz, tones, 10 iterations")
    s = state(CASES["1 oct at 1 kHz"])
    for method in ("after", "naive", "within"):
        print(f"  {method:<6s} {rejection(run(method, s, 10), 1000, 1):5.1f} dB")

    print("\n3. time per iteration (5 iterations less none, over 5), warm median of 3, tones, 1 oct gliding")
    for duration in (3.0, 10.0):
        s = {**state([{"points": [[0, 500], [duration, 4000]], "width": 1, "level": 0}]), "duration": duration}
        for method in ("after", "naive", "within"):
            run(method, s, 5)
            five = statistics.median(timed(lambda: run(method, s, 5)) for _ in range(3))
            none = statistics.median(timed(lambda: run(method, s, 0)) for _ in range(3))
            print(f"  {duration:4.1f} s {method:<6s} {(five - none) / 5:5.2f} s per iteration")
