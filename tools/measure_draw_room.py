"""Measure what a Draw a room tab would need (docs/design/tabs/draw_room.md).

This script runs sonore to measure it; it is not an independent check. At
the page's 16 kHz, on one core (as in Pyodide, which has no threads):

1. Run time of ``so.synth_ir`` for a range of RT60s, mono and with two
   decorrelated channels, and how long the IR it makes is.
2. Run time of convolving a source of the page's shortest and longest
   durations with those IRs (``Sound.convolve``).
3. A drawn curve: sonore 0.8's ``synth_ir`` takes one broadband RT60 and a
   named profile, so the drawn curves below go through ``drawn_ir``, a
   prototype of the change this tab asks of sonore (an RT60 for every band,
   interpolated from the drawn points on a log-frequency axis). Each IR's
   decay is measured back with ``so.measure_rt60`` and compared with the
   curve drawn, band by band.
4. That the prototype changes nothing for sonore's own profiles: with the
   ecological curve as the drawing, it gives ``synth_ir``'s samples.
5. Run time of ``so.measure_rt60``, for the plot that checks the curve.

    OMP_NUM_THREADS=1 python tools/measure_draw_room.py
"""

import time

import numpy as np
import sonore as so
from sonore.core.utils import as_rng, db_to_amp
from sonore.frames.filterbank import cosine_filterbank
from sonore.spatial.reverb import _model  # private: the paper's onset fit, which the prototype needs as synth_ir does
from sonore.views.temporal_envelope import TemporalEnvelope

from sonore_sketch import sources

FS = 16000
GRID = np.array([63, 125, 250, 500, 1000, 2000, 4000, 7000.0])  # where the drawn curves below are given


def best_of(fn, repeats=3):
    """The fastest of a few runs, in seconds, and the last result."""
    times = []
    for _ in range(repeats):
        start = time.perf_counter()
        out = fn()
        times.append(time.perf_counter() - start)
    return min(times), out


def drawn_ir(freqs, rt60s, fs, *, n_channels=1, rng=None, n_bands=32, f_lo=20.0, f_hi=16000.0, decay_db=60.0):
    """``synth_ir`` with an RT60 for every band, read off a drawn curve
    (``freqs``, ``rt60s``) by linear interpolation in log frequency and log
    RT60, held flat beyond its ends. The onset levels are the paper's for the
    curve's median RT60, as ``synth_ir`` uses for its own. Exponential decay
    only; the tail alone, at unit RMS."""
    fit_drr, _, fit_freqs = _model()
    rng = as_rng(rng)
    filterbank = cosine_filterbank(n_bands, f_lo, min(f_hi, fs / 2))
    cfs = filterbank.cfs
    taus = np.exp(np.interp(np.log(cfs), np.log(freqs), np.log(rt60s)))
    rt60 = float(np.median(taus))
    onset_db = fit_drr[:, 0] * np.log10(rt60) + fit_drr[:, 1]
    onset_db = np.interp(cfs, fit_freqs, onset_db - np.median(onset_db))
    noise = so.gaussian_noise(decay_db * taus.max() / 60, fs, n_channels=n_channels, rng=rng)
    envelopes = db_to_amp(onset_db)[None, :] * 10 ** (-3 * noise.t[:, None] / taus[None, :])
    return (TemporalEnvelope(envelopes, fs, filterbank) * filterbank.analyze(noise)).to_sound().normalize()


def timing():
    print("1. synth_ir at 16 kHz, one core (best of 3)")
    print(f"{'RT60':>6} {'IR length':>10} {'mono':>8} {'2 ch':>8}")
    irs = {}
    for rt60 in (0.3, 0.6, 1.0, 2.0, 4.0, 8.0):
        mono_s, ir = best_of(lambda rt60=rt60: so.synth_ir(rt60, FS, rng=1))
        stereo_s, ir2 = best_of(lambda rt60=rt60: so.synth_ir(rt60, FS, n_channels=2, rng=1))
        irs[rt60] = ir2
        print(f"{rt60:>5}s {ir.duration:>9.2f}s {mono_s:>7.3f}s {stereo_s:>7.3f}s")

    print("\n2. Convolving a source with a two-channel IR, one core (best of 3)")
    print(f"{'RT60':>6} {'2 s source':>11} {'30 s source':>12}")
    short = sources.syllables(2.0, FS)
    long = so.gaussian_noise(30.0, FS, rng=0)
    for rt60, ir in irs.items():
        short_s, _ = best_of(lambda ir=ir: short.convolve(ir))
        long_s, _ = best_of(lambda ir=ir: long.convolve(ir))
        print(f"{rt60:>5}s {short_s:>10.3f}s {long_s:>11.3f}s")


CURVES = {  # name: RT60 in seconds at GRID
    "flat 1 s": [1.0] * 8,
    "ecological 1 s": list(so.band_rt60s(1.0, GRID)),
    "inverted 1 s": list(so.band_rt60s(1.0, GRID, profile="inverted")),
    "boomy (3 s low, 0.3 s high)": [3.0, 3.0, 2.0, 1.2, 0.8, 0.5, 0.35, 0.3],
    "bright (0.4 s low, 2 s high)": [0.4, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0, 2.0],
    "notch (1 s, 0.2 s at 1 kHz)": [1.0, 1.0, 1.0, 0.5, 0.2, 0.5, 1.0, 1.0],
    "cathedral 6 s": [6.0, 7.0, 7.5, 7.0, 6.0, 4.5, 3.0, 2.0],
    "dead 0.15 s": [0.15] * 8,
}


def drawn():
    print("\n3. Drawn curves, decay measured back (measure_rt60, 30 bands 50 Hz-7 kHz, T20 x 3)")
    print("   error = measured / drawn - 1 per band; median and worst over the bands, 3 seeds")
    print(f"{'curve':<30} {'build':>7} {'median |err|':>13} {'worst |err|':>12}")
    for name, rt60s in CURVES.items():
        errs, builds = [], []
        for seed in (1, 2, 3):
            start = time.perf_counter()
            ir = drawn_ir(GRID, rt60s, FS, rng=seed)
            builds.append(time.perf_counter() - start)
            freqs, measured = so.measure_rt60(ir, f_hi=7000.0)
            wanted = np.exp(np.interp(np.log(freqs), np.log(GRID), np.log(rt60s)))
            errs.append(np.abs(measured / wanted - 1))
        errs = np.array(errs)
        print(f"{name:<30} {np.median(builds):>6.3f}s {np.nanmedian(errs):>12.1%} {np.nanmax(errs):>11.1%}")


def unchanged():
    print("\n4. The prototype with sonore's own ecological curve as the drawing")
    for rt60 in (0.3, 1.0, 3.0):
        filterbank = cosine_filterbank(32, 20.0, FS / 2)
        curve = so.band_rt60s(rt60, filterbank.cfs)
        a = so.synth_ir(rt60, FS, rng=7).data
        b = drawn_ir(filterbank.cfs, curve, FS, rng=7).data
        same = a.shape == b.shape and np.array_equal(a, b)
        diff = np.max(np.abs(a - b)) if a.shape == b.shape else float("nan")
        print(f"   RT60 {rt60} s: identical samples: {same} (largest difference {diff:.1e})")


def measuring():
    print("\n5. measure_rt60 on a two-channel IR's first channel, one core (best of 3)")
    for rt60 in (0.6, 2.0, 8.0):
        ir = so.synth_ir(rt60, FS, n_channels=2, rng=1)
        seconds, _ = best_of(lambda ir=ir: so.measure_rt60(ir))
        print(f"   RT60 {rt60} s ({ir.duration:.1f} s IR): {seconds:.3f} s")


if __name__ == "__main__":
    print(f"sonore {so.__version__}")
    timing()
    drawn()
    unchanged()
    measuring()
