"""Numerical checks for the claims in docs/design/tabs/draw_speech.md (C1-C3).

Independent of sonore and of TrackDraw: only NumPy and SciPy, with each
filter written out from its formula in Klatt (1980) and Assmann et al.
(1994). Each line prints the claim number and the number that supports it.

    python tools/check_trackdraw_claims.py

It runs in well under a second.
"""

import numpy as np
from scipy.interpolate import CubicSpline


def report(claim, text, value, unit=""):
    print(f"{claim:4s} {text:<84s} {value:.4g}{unit}")


def resonator_response(f_res, bw, f, fs):
    """|H(f)| of Klatt's resonator y[n] = A x[n] + B y[n-1] + C y[n-2]."""
    c = -np.exp(-2 * np.pi * bw / fs)
    b = 2 * np.exp(-np.pi * bw / fs) * np.cos(2 * np.pi * f_res / fs)
    a = 1 - b - c
    z_inv = np.exp(-2j * np.pi * np.asarray(f, float) / fs)
    return np.abs(a / (1 - b * z_inv - c * z_inv**2))


def radiation_response(f, fs):
    """|1 - z^-1|, the first difference used for lip radiation."""
    return np.abs(1 - np.exp(-2j * np.pi * np.asarray(f, float) / fs))


def db(x):
    return 20 * np.log10(x)


# --- C1: the paper's voiced source is G(f) R(f), lowpassed by an antiresonance
# at 1.5 kHz, 6 kHz wide. sonore's SS = 1 source is G(f) R(f) without it.
for fs in (8000, 16000):
    low, high = 400.0, 3200.0 if fs == 8000 else 6400.0
    source = lambda f: resonator_response(0, 100, f, fs) * radiation_response(f, fs)  # noqa: E731
    octaves = np.log2(high / low)
    report("C1", f"fs {fs}: G(f) R(f) slope from {low:g} to {high:g} Hz [dB/octave]",
           (db(source(high)) - db(source(low))) / octaves)
    # The antiresonator is the inverse of the resonator with the same F and BW.
    antiresonance = lambda f: 1 / resonator_response(1500, 6000, f, fs)  # noqa: E731
    for f in (500.0, 1000.0, 2000.0, 3000.0):
        if f < fs / 2:
            report("C1", f"fs {fs}: antiresonance (1.5 kHz, 6 kHz wide) at {f:g} Hz re 100 Hz [dB]",
                   db(antiresonance(f)) - db(antiresonance(100.0)))

# --- C2: Klatt's resonator gain at its own frequency, which sets the level of
# each tone in sine-wave speech (a_k = |S(F_k)|), depends on F and BW, so the
# bandwidth tracks still set tone levels in SWSYNTH. At 16 kHz:
fs = 16000
for f_res, bw in ((500, 60), (1500, 90), (2500, 150)):
    report("C2", f"fs {fs}: resonator gain at its own F = {f_res} Hz, BW = {bw} Hz [dB]",
           db(resonator_response(f_res, bw, f_res, fs)))

# --- C3: time-stretching a drawn track. The paper resampled 5 ms time windows with
# a cubic spline; with breakpoints, stretching scales the times, exactly.
window_hop = 0.005
window_times = np.arange(0, 0.2 + window_hop / 2, window_hop)
# A line-drawn F2 transition: 1200 Hz held, then 1700 Hz over 40 ms, then held.
breakpoint_times = np.array([0.0, 0.05, 0.09, 0.2])
breakpoint_values = np.array([1200.0, 1200.0, 1700.0, 1700.0])
window_values = np.interp(window_times, breakpoint_times, breakpoint_values)
stretch = 1.5
fine_times = np.linspace(0, 0.2 * stretch, 3001)
splined = CubicSpline(window_times * stretch, window_values)(fine_times)  # not-a-knot ends, as MATLAB's spline
target = np.interp(fine_times, breakpoint_times * stretch, breakpoint_values)
report("C3", "spline-stretched 5 ms time windows (x1.5): overshoot above 1700 Hz [Hz]", splined.max() - 1700)
report("C3", "spline-stretched 5 ms time windows (x1.5): undershoot below 1200 Hz [Hz]", 1200 - splined.min())
report("C3", "spline-stretched time windows vs the stretched line: max |difference| [Hz]", np.max(np.abs(splined - target)))
# Breakpoints: scale the times and interpolate. The same piecewise-linear
# function as stretching the original in time, to rounding.
direct = np.interp(fine_times / stretch, breakpoint_times, breakpoint_values)
report("C3", "scaled breakpoints vs the stretched line: max |difference| [Hz]", np.max(np.abs(target - direct)))
