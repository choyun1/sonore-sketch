"""Measure whether sonore's harmonic_complex can make sine-wave speech.

This script runs sonore 0.4.0 to measure what it does; it is not an
independent check. The reference it compares against is written out here
from the formula, with NumPy only.

Sine-wave speech (Remez, Rubin, Pisoni & Carrell, 1981), as Track-Draw's
SWSYNTH made it (Assmann et al., 1994, Equations 2 and 3): one sinusoid per
formant track, x(i) = sum_k a_k(i) cos(theta_k(i)), with the phase
accumulated sample by sample, theta_k(i) = theta_k(i-1) + 2 pi F_k(i) T. A
time window below 30 Hz drops that tone. The question is whether
``so.harmonic_complex(duration, fs, (times, F_k), harmonics=[1])`` is that
sinusoid, and what it does differently. Each line prints a measurement
number (M1-M5, as in docs/design/tabs/tracks.md) and the value.

    python tools/measure_sine_wave_route.py
"""

import numpy as np
import sonore as so

FS = 16000
DURATION = 0.6
# A drawn F2 track: a few breakpoints, rising then falling, as in "we were away".
TIMES = np.array([0.0, 0.1, 0.25, 0.4, 0.6])
F2_VALUES = np.array([800.0, 1200.0, 1700.0, 1500.0, 1100.0])


def report(label, text, value, unit=""):
    print(f"{label:4s} {text:<80s} {value:.4g}{unit}")


def interpolated(times, values, fs, duration):
    """The track at every sample, linear between breakpoints and held beyond them."""
    t = np.arange(int(round(duration * fs))) / fs
    return t, np.interp(t, times, values)


def accumulated_phase(frequency, fs, rule):
    """Equation 3 (each sample adds 2 pi F T: the rectangle rule) or the
    trapezoid rule (each sample adds the mean of two neighboring F)."""
    if rule == "rectangle":
        steps = frequency[:-1]
    else:
        steps = (frequency[1:] + frequency[:-1]) / 2
    return 2 * np.pi / fs * np.concatenate([[0.0], np.cumsum(steps)])


def unit_rms(signal):
    return signal / np.sqrt(np.mean(signal**2))


# --- M1: the carrier is the accumulated-phase cosine.
t, f2 = interpolated(TIMES, F2_VALUES, FS, DURATION)
library_tone = so.harmonic_complex(DURATION, FS, (TIMES, F2_VALUES), harmonics=[1]).data[:, 0]
for rule in ("trapezoid", "rectangle"):
    reference = unit_rms(np.cos(accumulated_phase(f2, FS, rule)))
    report("M1", f"harmonic_complex vs cos(phase), {rule} rule: max |difference|", np.max(np.abs(library_tone - reference)))
phase_gap = accumulated_phase(f2, FS, "trapezoid") - accumulated_phase(f2, FS, "rectangle")
report("M1", "trapezoid minus rectangle phase: largest gap over the track [rad]", np.max(np.abs(phase_gap)))
report("M1", "  bound pi * (F_end - F_start) / fs, over the whole glide [rad]", np.max(np.abs(np.pi * (f2 - f2[0]) / FS)))

# --- M2: tones near Nyquist are faded out (sonore's guard against aliasing
# a moving F0, 0.9 f_max to f_max with f_max = 0.45 fs by default). Measured
# as the level of a tone at F relative to one at F/2 in the same call.
for fs, frequency in ((8000, 3500.0), (10000, 4500.0), (16000, 3500.0)):
    for f_max in (None, fs / 2):
        duration = 0.2
        pair = so.harmonic_complex(
            duration, fs, ([0.0], [frequency / 2]), harmonics=[1, 2], amplitudes=[1.0, 1.0], f_max=f_max
        ).data[:, 0]
        spectrum = np.abs(np.fft.rfft(pair))
        bins = np.fft.rfftfreq(len(pair), 1 / fs)
        level = lambda f: spectrum[np.argmin(np.abs(bins - f))]  # noqa: E731
        label = "default f_max" if f_max is None else "f_max = fs/2"
        report("M2", f"fs {fs} Hz, tone at {frequency:g} Hz, {label}: level re unfaded [dB]",
               20 * np.log10(level(frequency) / level(frequency / 2)))

# --- M3: a tone's level is lost, because every call is normalized to RMS 1.
quiet = so.harmonic_complex(DURATION, FS, (TIMES, F2_VALUES), harmonics=[1], amplitudes=[0.01])
loud = so.harmonic_complex(DURATION, FS, (TIMES, F2_VALUES), harmonics=[1], amplitudes=[1.0])
report("M3", "RMS of a tone asked for at amplitude 0.01 vs one at 1.0 [dB]", 20 * np.log10(quiet.rms / loud.rms))
# A time-varying amplitude does survive, as a shape: the a(t) of Equation 2.
envelope = lambda times, frequencies: 1.0 + 0.5 * np.sin(2 * np.pi * 3 * times)  # noqa: E731
shaped = so.harmonic_complex(DURATION, FS, (TIMES, F2_VALUES), harmonics=[1], amplitudes=envelope).data[:, 0]
reference = unit_rms(envelope(t, f2) * np.cos(accumulated_phase(f2, FS, "trapezoid")))
report("M3", "time-varying amplitude a(t), shape only: max |difference| after normalizing", np.max(np.abs(shaped - reference)))

# --- M4: dropping a tone. sonore drops it where the track is 0, not below 30 Hz.
drop_times = np.array([0.0, 0.2, 0.3, 0.4, 0.6])
for low_value in (0.0, 20.0):
    values = np.array([1000.0, 1000.0, low_value, 1000.0, 1000.0])
    tone = so.harmonic_complex(DURATION, FS, (drop_times, values), harmonics=[1]).data[:, 0]
    middle = tone[int(0.29 * FS) : int(0.31 * FS)]
    report("M4", f"one breakpoint at {low_value:g} Hz (t = 0.3 s): RMS from 0.29 to 0.31 s", np.sqrt(np.mean(middle**2)))
values = np.array([1000.0, 1000.0, 0.0, 1000.0, 1000.0])
tone = so.harmonic_complex(DURATION, FS, (drop_times, values), harmonics=[1]).data[:, 0]
# The longest run of exact silence (single zero samples also occur where the cosine crosses zero).
silent = np.concatenate([[0], (np.abs(tone) < 1e-9).astype(int), [0]])
edges = np.flatnonzero(np.diff(silent))
longest_run = np.max(edges[1::2] - edges[::2])
report("M4", "  longest silent stretch, voiced breakpoints 0.1 s either side of the 0 [s]", longest_run / FS)
