"""Measure how long the candidate tabs' sonore calls take, natively.

This script runs sonore to measure it; it is not an independent check. It
times the synthesis behind three of the tabs proposed in
docs/design/app.md, at 16 kHz, for 1 s, 3 s and 10 s of sound: the first call
(cold) and the median of the next three (warm).

- Modulation blobs: ``so.ModulationSpectrum.from_blobs`` then
  ``.to_sound(carrier=...)`` on tones and on noise. These are on sonore's
  main branch after 0.4.0 and not yet released; the script reports the
  installed sonore and skips them if they are missing.
- Painted envelope: ``so.ripple_sound`` with a pattern function, as a
  painted time x log-frequency grid would be.
- Spectrogram mask: ``so.GaborFrame`` analysis of a noise, half its
  coefficients zeroed, least-squares synthesis.

    python tools/measure_tab_synthesis.py
"""

import statistics
import time

import numpy as np
import sonore as so

FS = 16000
WARM_REPEATS = 3


def blobs(carrier):
    def synthesize(duration):
        target = so.ModulationSpectrum.from_blobs([so.ModulationBlob(4.0, 0.5)], duration)
        if carrier == "noise":  # sonore 0.8: a noise is passed as a Sound
            return target.to_sound(carrier=so.gaussian_noise(duration, FS, rng=1), rng=1)
        return target.to_sound(carrier="tone", fs=FS, rng=1)

    return synthesize


def painted_envelope(duration):
    def pattern(t, x):  # a bump in time x octaves above f_lo, as a painted grid would be
        return 1 + 0.9 * np.exp(-((t - duration / 2) ** 2) / 0.01 - (x - 2) ** 2 / 0.5)

    return so.ripple_sound(pattern, duration, FS, f_hi=6000.0, rng=1)


def spectrogram_mask(duration):
    frame = so.GaborFrame(0.02, 0.005, n_fft=512)
    coefficients = frame.analyze(so.gaussian_noise(duration, FS, rng=1))
    mask = np.ones(coefficients.data.shape)
    mask[..., : mask.shape[-1] // 2] = 0.0
    return (coefficients * mask).to_sound()


def timed(function, duration):
    start = time.perf_counter()
    function(duration)
    return time.perf_counter() - start


cases = {"painted envelope (ripple_sound)": painted_envelope}
if hasattr(so.ModulationSpectrum, "from_blobs"):
    cases = {"blobs on tones": blobs("tones"), "blobs on noise": blobs("noise")} | cases
else:
    print(f"sonore {so.__version__} has no ModulationSpectrum.from_blobs; skipping the blob cases")
cases["spectrogram mask (GaborFrame)"] = spectrogram_mask

print(f"sonore {so.__version__}, numpy {np.__version__}")
print(f"  {'case':<32s} {'sound':>6s} {'cold':>8s} {'warm':>8s}")
for name, function in cases.items():
    for duration in (1.0, 3.0, 10.0):
        cold = timed(function, duration)
        warm = statistics.median(timed(function, duration) for _ in range(WARM_REPEATS))
        print(f"  {name:<32s} {duration:5.0f}s {cold:7.3f}s {warm:7.3f}s")
