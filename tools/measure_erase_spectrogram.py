"""Measure a painted mask on a recording, as the Erase spectrogram tab would use it
(docs/design/tabs/erase_spectrogram.md).

This script runs sonore to measure it; it is not an independent check. A mask
is a grid of gains in dB over time (columns) and linear frequency (rows, 0 Hz
to Nyquist), read bilinearly onto an STFT's coefficients; the sound is
``(stft * mask).to_sound()``, sonore's least-squares resynthesis. The script
prints:

1. Speed: analysis, masking and resynthesis of 1, 3 and 10 s of noise, for a
   wideband (5 ms) and a narrowband (32 ms) Hann window, hop a quarter window.
2. Depth: a band of noise (1-2 kHz, 0.8-1.2 s of 2 s) painted at -20 dB,
   -40 dB and -60 dB; the band's level in the result relative to the same
   band outside the painted time, from the sound's own spectrum.
3. One harmonic: the 10th harmonic (1000 Hz) of a 100 Hz harmonic complex
   painted at -60 dB over the whole sound, the band 970-1030 Hz; its level
   in the result relative to its neighbors' (900 and 1100 Hz).
4. Link size: a 256 x 256 mask quantized to whole dB, deflated and
   base64-encoded, blank and with a band and a harmonic erased.

    python tools/measure_erase_spectrogram.py
"""

import base64
import statistics
import time
import zlib

import numpy as np
import sonore as so

FS = 16000
N_ROWS, N_COLUMNS = 256, 256
FLOOR_DB = -60.0
WINDOWS = {"5 ms": 0.005, "32 ms": 0.032}
WARM_REPEATS = 3


def mask_values(grid_db, stft, duration):
    """The grid read bilinearly at each coefficient's (f, t), as gains, held
    beyond the outer cell centers; shape (freqs, time windows)."""
    fc = (np.arange(N_ROWS) + 0.5) / N_ROWS * FS / 2
    tc = (np.arange(N_COLUMNS) + 0.5) / N_COLUMNS * duration
    gain = np.where(grid_db <= FLOOR_DB, 0.0, 10 ** (grid_db / 20))
    along_time = np.stack([np.interp(stft.t, tc, r) for r in gain])  # rows x time windows
    return np.stack([np.interp(stft.f, fc, along_time[:, j]) for j in range(len(stft.t))], axis=1)


def masked(grid_db, sound, win):
    stft = so.GaborFrame(win, win / 4).analyze(sound)
    return (stft * mask_values(grid_db, stft, sound.duration)).to_sound()


def level_db(sound, f_lo, f_hi, t_lo, t_hi):
    data = sound.mono().data[:, 0]
    start, stop = int(t_lo * FS), int(t_hi * FS)
    spectrum = np.abs(np.fft.rfft(data[start:stop] * np.hanning(stop - start))) ** 2
    f = np.fft.rfftfreq(stop - start, 1 / FS)
    return 10 * np.log10(spectrum[(f >= f_lo) & (f < f_hi)].mean())


def rows(f_lo, f_hi):
    """The rows whose centers lie in [f_lo, f_hi)."""
    fc = (np.arange(N_ROWS) + 0.5) / N_ROWS * FS / 2
    return (fc >= f_lo) & (fc < f_hi)


def link_chars(grid_db):
    quantized = np.clip(np.round(-grid_db), 0, -FLOOR_DB).astype(np.uint8)
    return len(base64.b64encode(zlib.compress(quantized.tobytes(), 9)))


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


print(f"sonore {so.__version__}, numpy {np.__version__}")
print(f"mask {N_ROWS} rows (0-{FS // 2} Hz, {FS / 2 / N_ROWS:g} Hz each) x {N_COLUMNS} columns, fs {FS} Hz")

print("\n1. speed of analysis, masking and resynthesis (noise)")
print(f"  {'window':<7s} {'sound':>6s} {'cold':>8s} {'warm':>8s}")
grid = np.zeros((N_ROWS, N_COLUMNS))
grid[rows(1000, 2000), 100:150] = -40
for name, win in WINDOWS.items():
    for duration in (1.0, 3.0, 10.0):
        noise = so.gaussian_noise(duration, FS, rng=1)
        cold = timed(lambda: masked(grid, noise, win))
        warm = statistics.median(timed(lambda: masked(grid, noise, win)) for _ in range(WARM_REPEATS))
        print(f"  {name:<7s} {duration:5.0f}s {cold:7.3f}s {warm:7.3f}s")

print("\n2. depth of a painted band (1-2 kHz, 0.8-1.2 s of 2 s noise), against 1-2 kHz at 0.2-0.6 s")
print(f"  {'window':<7s} " + " ".join(f"{label:>9s}" for label in ("-20 dB", "-40 dB", "removed")))
noise = so.gaussian_noise(2.0, FS, rng=1)
for name, win in WINDOWS.items():
    depths = []
    for gain in (-20.0, -40.0, FLOOR_DB):
        grid = np.zeros((N_ROWS, N_COLUMNS))
        grid[np.ix_(rows(1000, 2000), np.arange(int(0.4 * N_COLUMNS), int(0.6 * N_COLUMNS)))] = gain
        out = masked(grid, noise, win)
        depths.append(level_db(out, 1200, 1800, 0.85, 1.15) - level_db(out, 1200, 1800, 0.25, 0.55))
    print(f"  {name:<7s} " + " ".join(f"{d:8.1f} " for d in depths))

print("\n3. one harmonic removed: the 10th (1000 Hz) of a 100 Hz complex, rows over 970-1030 Hz")
complex_tone = so.harmonic_complex(1.0, FS, 100.0)
for name, win in WINDOWS.items():
    grid = np.zeros((N_ROWS, N_COLUMNS))
    grid[rows(970, 1030)] = FLOOR_DB
    out = masked(grid, complex_tone, win)
    target = level_db(out, 990, 1010, 0.2, 0.8)
    neighbors = (level_db(out, 890, 910, 0.2, 0.8) + level_db(out, 1090, 1110, 0.2, 0.8)) / 2
    print(f"  {name:<7s} the 10th harmonic is {target - neighbors:6.1f} dB against its neighbors")

print("\n4. link size (base64 of the deflated whole-dB mask)")
blank = np.zeros((N_ROWS, N_COLUMNS))
edited = blank.copy()
edited[np.ix_(rows(1000, 2000), np.arange(100, 150))] = -40
edited[rows(970, 1030)] = FLOOR_DB
print(f"  {'nothing removed':<28s} {link_chars(blank):6d} characters")
print(f"  {'a band and a harmonic':<28s} {link_chars(edited):6d} characters")
