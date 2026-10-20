"""Measure modulation-spectrum editing as the Erase modulation tab would use it
(docs/design/tabs/erase_modulation.md).

This script runs sonore to measure it; it is not an independent check. The
tab's route is ``so.ModulationSpectrum.octave(source)``, a gain painted on
rate x density, ``.with_gain(g)``, and ``.to_sound(carrier=...)``. With no
recording in the repository, the source is a Klatt "syllable train" made
with the Draw speech tab's own Python (4.5 syllables per second, formants moving
from syllable to syllable, F0 falling), which has speech-like modulation.

1. Speed: analysis, and synthesis on the source's own fine structure with 0,
   5 and 20 iterations, and on tones and noise, for 1, 3 and 10 s.
2. Doing nothing: how close an unedited spectrum, synthesized on the
   source, comes back to the source.
3. How much of an edit survives: remove every rate above 4 Hz and measure
   how much less power the result has at 6-40 Hz than the source, per
   carrier and number of iterations (sonore's own docstring measures 15 dB
   on tones and 3-5 dB on a sentence's fine structure).
4. A sweep direction: remove every downward sweep (rate x density > 0).
5. Boosting and the rate-0 strip: does a gain above 1, or a cut of the
   static spectral ripple (|rate| < 1 Hz, density > 0), run?

    python tools/measure_erase_modulation.py
"""

import statistics
import sys
import time
from pathlib import Path

import numpy as np
import sonore as so

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from sonore_sketch import sources as tab_sources  # noqa: E402

FS = 16000
F_LO, F_HI = 100.0, 6400.0  # the other tabs' range
WARM_REPEATS = 3


def syllables(duration: float) -> so.Sound:
    """The tab's own syllable-train source (sonore_sketch.sources.syllables)."""
    return tab_sources.syllables(duration, FS)


def analyze(sound):
    return so.ModulationSpectrum.octave(sound, f_lo=F_LO, f_hi=F_HI)


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


def band_power(ms, rates=(6, 40), densities=(0, 4)):
    """Mean power over |rate| in `rates` and density in `densities`."""
    r = (np.abs(ms.w_t) >= rates[0]) & (np.abs(ms.w_t) <= rates[1])
    d = (ms.w_f >= densities[0]) & (ms.w_f <= densities[1])
    return 10 * np.log10(np.mean(10 ** (ms.level[np.ix_(d, r)] / 10)))


print(f"sonore {so.__version__}, numpy {np.__version__}, fs {FS} Hz, {F_LO:g}-{F_HI:g} Hz")
sources = {d: syllables(d) for d in (1.0, 3.0, 10.0)}
lowpass = lambda r, d: (np.abs(r) <= 4).astype(float)  # noqa: E731

print("\n1. speed")
print(f"  {'case':<34s} {'1 s':>8s} {'3 s':>8s} {'10 s':>8s}   (warm median of {WARM_REPEATS})")
cases = {
    "analysis (octave)": lambda d: analyze(sources[d]),
    "gain + source, 0 iterations": lambda d: analyze(sources[d]).with_gain(lowpass).to_sound(carrier=sources[d]),
    "gain + source, 5 iterations": lambda d: analyze(sources[d]).with_gain(lowpass).to_sound(carrier=sources[d], iterations=5),
    "gain + tones, 0 iterations": lambda d: analyze(sources[d]).with_gain(lowpass).to_sound(carrier="tone", fs=FS, rng=1),
    "gain + noise, 0 iterations": lambda d: analyze(sources[d]).with_gain(lowpass).to_sound(carrier=so.gaussian_noise(d, FS, rng=1), rng=1),
}
for name, function in cases.items():
    cells = []
    for duration in (1.0, 3.0, 10.0):
        function(duration)  # cold call not reported
        cells.append(statistics.median(timed(lambda: function(duration)) for _ in range(WARM_REPEATS)))
    print(f"  {name:<34s} " + " ".join(f"{c:7.3f}s" for c in cells))

source = sources[3.0]
original = analyze(source)

print("\n2. doing nothing (3 s): the unedited spectrum on the source's own fine structure")
again = original.to_sound(carrier=source)
x, y = source.mono().data[:, 0], again.mono().data[: len(source.mono().data), 0]
x, y = x / np.sqrt(np.mean(x**2)), y / np.sqrt(np.mean(y**2))
print(f"  correlation with the source {np.corrcoef(x, y)[0, 1]:.4f}; "
      f"error {10 * np.log10(np.mean((x - y) ** 2) / np.mean(x**2)):.1f} dB re the source")

print("\n3. remove every rate above 4 Hz (3 s): power at 6-40 Hz, density 0-4, below the source's")
before = band_power(original)
for name, options in (
    ("source, 0 iterations", dict(carrier=source)),
    ("source, 5 iterations", dict(carrier=source, iterations=5)),
    ("source, 20 iterations", dict(carrier=source, iterations=20)),
    ("tones, 0 iterations", dict(carrier="tone", fs=FS, rng=1)),
    ("tones, 5 iterations", dict(carrier="tone", fs=FS, rng=1, iterations=5)),
    ("noise, 0 iterations", dict(carrier=so.gaussian_noise(source.duration, FS, rng=1), rng=1)),
):
    result = original.with_gain(lowpass).to_sound(**options)
    print(f"  {name:<24s} {before - band_power(analyze(result)):5.1f} dB less")

print("\n4. remove downward sweeps (3 s): power at 2-16 Hz, density 0.5-4, down minus up")
def sweeps(ms):
    r = (np.abs(ms.w_t) >= 2) & (np.abs(ms.w_t) <= 16)
    d = (ms.w_f >= 0.5) & (ms.w_f <= 4)
    down = 10 * np.log10(np.mean(10 ** (ms.level[np.ix_(d, r & (ms.w_t > 0))] / 10)))
    up = 10 * np.log10(np.mean(10 ** (ms.level[np.ix_(d, r & (ms.w_t < 0))] / 10)))
    return down - up
print(f"  source {sweeps(original):5.1f} dB")
for name, options in (("source, 0 iterations", dict(carrier=source)), ("source, 5 iterations", dict(carrier=source, iterations=5)), ("tones, 0 iterations", dict(carrier="tone", fs=FS, rng=1))):
    result = original.with_gain(lambda r, d: (r * d <= 0).astype(float)).to_sound(**options)
    print(f"  {name:<24s} {sweeps(analyze(result)):5.1f} dB")

print("\n5. boosting, and cutting the static strip (3 s, on the source)")
for name, gain in (
    ("x2 (+6 dB) at 2-8 Hz", lambda r, d: np.where((np.abs(r) >= 2) & (np.abs(r) <= 8), 2.0, 1.0)),
    ("x4 (+12 dB) at 2-8 Hz", lambda r, d: np.where((np.abs(r) >= 2) & (np.abs(r) <= 8), 4.0, 1.0)),
    ("0 at |rate| < 1, density > 0.5", lambda r, d: np.where((np.abs(r) < 1) & (np.abs(d) > 0.5), 0.0, 1.0)),
):
    try:
        result = original.with_gain(gain).to_sound(carrier=source)
        measured = analyze(result)
        print(f"  {name:<32s} runs; power at 2-8 Hz {band_power(measured, (2, 8)) - band_power(original, (2, 8)):+5.1f} dB, "
              f"static ripple (|rate| < 1, density 0.5-4) {band_power(measured, (0, 0.9), (0.5, 4)) - band_power(original, (0, 0.9), (0.5, 4)):+5.1f} dB")
    except ValueError as error:
        print(f"  {name:<32s} refused: {error}")
