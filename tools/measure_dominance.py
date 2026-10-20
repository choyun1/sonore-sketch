"""Measure which dominates the Draw modulation tab's result: the blobs or the bands.

This script runs sonore to measure it; it is not an independent check. With
bands drawn, the result's modulation spectrum over the whole range holds
two things: the blobs' modulation, and the modulation the bands add by
their own shape and motion (a moving band is a sweep; bands.md, K-M2). To
split them, the script synthesizes each alone, on the same tones carrier
and seed:

* blobs alone: the drawing with no bands;
* bands alone: the bands on an all-but-unmodulated sound (the drawing at
  ``rms_depth`` 1e-4, tones), so only the bands' gain moves the envelopes;

and fits the result's measured power as ``a * blobs + b * bands`` (non-
negative least squares, cell by cell, over the plane the tab shows:
|rate| from 1 to 64 Hz, density up to 6 cyc/oct). The blobs' share is
``a * sum(blobs) / (a * sum(blobs) + b * sum(bands))``; the fit's residual
says how well the two parts explain the result. A band also blurs the
blobs along density (fewer carrier bands, K-M2), which the fit cannot
express, so its residual is large for static bands. The plainer
measure is first: the bands-alone power over the result's power is the
bands' share (both are RMS 1 through the same bands, so their envelope
means match), and the rest is the blobs'. Rate 0 is left out: a
band's static shape lands there (the long-term spectrum), which the plane
does not show.

It prints the share per band case, for the drawing the tab starts with at
its default depth (0.2) and at a shallow one (0.05), and for the result as
the tab makes it now (bands last) and after 10 iterations of the
``within`` loop (tools/measure_loop.py).

    python tools/measure_dominance.py
"""

import numpy as np
import sonore as so
from scipy.optimize import nnls

from sonore_sketch import draw_modulation as tab

FS = 16000
DURATION = 3.0


def glide(lo, octaves_per_s, width):
    return [{"points": [[0, lo], [DURATION, lo * 2 ** (octaves_per_s * DURATION)]], "width": width, "level": 0}]


CASES = {
    "1 oct static at 1 kHz": [{"points": [[0, 1000]], "width": 1, "level": 0}],
    "1/2 oct at 500 Hz and 2 kHz": [
        {"points": [[0, 500]], "width": 0.5, "level": 0},
        {"points": [[0, 2000]], "width": 0.5, "level": 0},
    ],
    "1 oct gliding 1/3 oct/s": glide(700, 1 / 3, 1),
    "1 oct gliding 1 oct/s": glide(500, 1, 1),
    "2 oct gliding 1 oct/s": glide(300, 1, 2),
    "1/2 oct up and down 2 oct/s": [
        {"points": [[0, 500], [1, 2000], [2, 500], [3, 2000]], "width": 0.5, "level": 0}
    ],
}


def state(bands, depth=0.2):
    return {"draw_modulation": 1, "duration": DURATION, "fs": FS, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
            "carrier": "tones", "iterations": 0, "rms_depth": depth, "seed": 1,
            "items": tab.B9_ITEMS, "bands": bands}


def power(sound, s):
    """Measured power over the whole range, on the plane's cells."""
    spectrum = tab.measured(sound, {**s, "bands": []})
    rates = (np.abs(spectrum.w_t) >= 1) & (np.abs(spectrum.w_t) <= tab.MEASURED_RATE_MAX)
    densities = spectrum.w_f <= tab.MEASURED_DENSITY_MAX + 1e-9
    return (10 ** (spectrum.level / 10))[np.ix_(densities, rates)].ravel()


def within_loop(s, n=10):
    import measure_loop  # noqa: PLC0415  (run from tools/)

    return measure_loop.run("within", s, n)


def share(s, result):
    """The blobs' share two ways: by the bands-alone sound's power against
    the result's (both RMS 1 through the same bands, so their envelopes'
    means match and the powers compare), and by the fit."""
    blobs_alone = power(tab.synthesize({**s, "bands": []}), s)
    bands_alone = power(tab.synthesize({**s, "rms_depth": 1e-4}), s)
    mix = power(result, s)
    by_power = 1 - min(bands_alone.sum() / mix.sum(), 1)
    (a, b), residual = nnls(np.column_stack([blobs_alone, bands_alone]), mix)
    blob_part, band_part = a * blobs_alone.sum(), b * bands_alone.sum()
    return by_power, blob_part / (blob_part + band_part), residual / np.linalg.norm(mix)


print(f"sonore {so.__version__}, numpy {np.__version__}, fs {FS} Hz, {DURATION:g} s, tones, the tab's starting drawing")
print("blobs' share of the result's modulation power over the whole range, |rate| 1-64 Hz: by power / by fit (fit residual)")
print(f"  {'case':<30s} {'depth 0.2, now':>18s} {'0.2, loop x10':>18s} {'depth 0.05, now':>18s}")
for name, bands in CASES.items():
    cells = []
    for depth, loop in ((0.2, False), (0.2, True), (0.05, False)):
        s = state(bands, depth)
        by_power, by_fit, residual = share(s, within_loop(s) if loop else tab.synthesize(s))
        cells.append(f"{100 * by_power:3.0f}% / {100 * by_fit:3.0f}% ({100 * residual:2.0f}%)")
    print(f"  {name:<30s} " + " ".join(f"{c:>18s}" for c in cells))
