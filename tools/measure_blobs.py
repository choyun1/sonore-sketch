"""Measure modulation blobs as the Draw modulation tab would use them (docs/design/tabs/blobs.md).

This script runs sonore to measure it; it is not an independent check. A
drawing is a list of ``so.ModulationBlob`` (rate [Hz], density [cycles/octave],
two widths, level [dB]); the sound is
``so.ModulationSpectrum.from_blobs(blobs, duration, ...).to_sound(...)``, and
the picture of what came out is the result's own
``so.ModulationSpectrum.octave``. The script prints:

1. Speed: synthesis on tones and on noise, with 0 and 5 iterations, and the
   analysis of the result, for 1, 3 and 10 s.
2. Where the energy lands: one blob at (4 Hz, 0 cyc/oct) and one at
   (8 Hz, 1 cyc/oct); the result's measured modulation spectrum, its peak
   (rate, density) near each blob, for 0.6, 1, 3 and 10 s.
3. How deep a drawing can go: the largest ``rms_depth`` that fits one draw
   (sonore's own refusal names it) for one and for three blobs.

    python tools/measure_blobs.py
"""

import re
import statistics
import time

import numpy as np
import sonore as so

FS = 16000
F_LO, F_HI = 100.0, 6400.0  # the Draw spectrogram tab's range (painted.md, P3)
WARM_REPEATS = 3
BLOBS = [so.ModulationBlob(4.0, 0.0), so.ModulationBlob(8.0, 1.0, level=-3.0)]


def target(blobs, duration):
    return so.ModulationSpectrum.from_blobs(blobs, duration, f_lo=F_LO, f_hi=F_HI)


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


def peak_near(ms, rate, density, rate_span=3.0, density_span=0.6):
    """(rate, density, dB) of the loudest cell within a box around a point."""
    rows = np.abs(ms.w_f - density) <= density_span
    columns = np.abs(ms.w_t - rate) <= rate_span
    box = ms.level[np.ix_(rows, columns)]
    i, j = np.unravel_index(np.argmax(box), box.shape)
    return ms.w_t[columns][j], ms.w_f[rows][i], box[i, j]


print(f"sonore {so.__version__}, numpy {np.__version__}, fs {FS} Hz, {F_LO:g}-{F_HI:g} Hz")

print("\n1. speed")
print(f"  {'case':<28s} {'1 s':>8s} {'3 s':>8s} {'10 s':>8s}   (warm median of {WARM_REPEATS})")
cases = {
    "tones, 0 iterations": lambda d: target(BLOBS, d).to_sound(carrier="tones", fs=FS, rng=1),
    "noise, 0 iterations": lambda d: target(BLOBS, d).to_sound(carrier="noise", fs=FS, rng=1),
    "tones, 5 iterations": lambda d: target(BLOBS, d).to_sound(carrier="tones", fs=FS, rng=1, iterations=5),
}
sounds = {d: cases["tones, 0 iterations"](d) for d in (1.0, 3.0, 10.0)}
cases["analysis of the result"] = lambda d: so.ModulationSpectrum.octave(sounds[d], f_lo=F_LO, f_hi=F_HI)
for name, function in cases.items():
    cells = []
    for duration in (1.0, 3.0, 10.0):
        function(duration)  # cold call not reported
        cells.append(statistics.median(timed(lambda: function(duration)) for _ in range(WARM_REPEATS)))
    print(f"  {name:<28s} " + " ".join(f"{c:7.3f}s" for c in cells))

print("\n2. where the energy lands (measured on the result, tones carrier)")
for duration in (0.6, 1.0, 3.0, 10.0):
    sound = target(BLOBS, duration).to_sound(carrier="tones", fs=FS, rng=1)
    measured = so.ModulationSpectrum.octave(sound, f_lo=F_LO, f_hi=F_HI)
    peaks = [peak_near(measured, b.rate, b.density) for b in BLOBS]
    resolution = measured.w_t[1] - measured.w_t[0]
    text = "; ".join(f"blob ({b.rate:g} Hz, {b.density:g}) -> ({r:.2f} Hz, {d:.2f})" for b, (r, d, _) in zip(BLOBS, peaks))
    print(f"  {duration:4.1f} s (rate step {resolution:.2f} Hz): {text}")

print("\n3. the deepest drawing one draw allows (rng=1)")
for name, blobs in (("one blob", BLOBS[:1]), ("three blobs", [*BLOBS, so.ModulationBlob(-6.0, 2.0)])):
    try:
        target(blobs, 3.0).to_sound(carrier="tones", fs=FS, rng=1)  # default rms_depth 0.2
        spectrum = so.ModulationSpectrum.from_blobs(blobs, 3.0, f_lo=F_LO, f_hi=F_HI, rms_depth=0.99)
        spectrum.to_sound(carrier="tones", fs=FS, rng=1)
        print(f"  {name}: 0.99 fits")
    except ValueError as error:
        fits = re.search(r"at most ([0-9.]+) fits", str(error))
        print(f"  {name}: at most {fits.group(1) if fits else '?'} ({error})")

print("\n4. how much of the drawing comes out: blobs' peak over the rest, |rate| <= 32 Hz, density <= 4 cyc/oct, 3 s")
drawn = target(BLOBS, 3.0)
near = (np.abs(drawn.w_t) <= 32)[None, :] & (drawn.w_f <= 4)[:, None]
inside = near & (drawn.level >= drawn.level[near].max() - 6)  # within 6 dB of the drawn peak
outside = near & (drawn.level <= drawn.level[near].max() - 30)  # 30 dB or more below it
print(f"  drawn: {inside.sum()} cells within 6 dB of the peak, {outside.sum()} cells 30 dB or more below it")
for name, options in (
    ("tones", dict(carrier="tones")),
    ("noise", dict(carrier="noise")),
    ("tones, 5 iterations", dict(carrier="tones", iterations=5)),
    ("noise, 5 iterations", dict(carrier="noise", iterations=5)),
):
    sound = drawn.to_sound(fs=FS, rng=1, **options)
    measured = so.ModulationSpectrum.octave(sound, f_lo=F_LO, f_hi=F_HI)
    power = 10 ** (measured.level / 10)
    contrast = 10 * np.log10(power[inside].mean() / power[outside].mean())
    print(f"  {name:<22s} blobs stand {contrast:5.1f} dB above the rest")
