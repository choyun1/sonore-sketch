"""Measure a painted grid as the Painted tab would use it (docs/design/tabs/painted.md).

This script runs sonore to measure it; it is not an independent check. A
painting is a grid of levels in dB over time (columns) and octaves above
``F_LO`` (rows), read between cells by bilinear interpolation and given to
``so.ripple_sound`` as its ``pattern(t, x)``. The script prints:

1. Speed: ``ripple_sound`` on a 256 x 60 grid for 1, 3 and 10 s with each
   carrier, cold (first call) and warm (median of the next three).
2. Depth: how deep a painted hole comes out. A flat field at 0 dB with a
   hole one octave wide and 0.4 s long painted at -20 dB, -40 dB and
   silence; the depth is the hole's level in the result relative to the
   same band outside the hole, from the sound's own octave-band envelopes.
3. Link size: the grid quantized to whole dB (one byte per cell), deflated
   and base64url-encoded, for a blank grid, a typical painting of a dozen
   soft strokes, and the worst case (independent random cells).

    python tools/measure_paint_grid.py
"""

import base64
import statistics
import time
import zlib

import numpy as np
import sonore as so

FS = 16000
F_LO, F_HI = 100.0, 6400.0  # exactly 6 octaves, below 16 kHz Nyquist (P3, decided)
N_COLUMNS, ROWS_PER_OCTAVE = 256, 12
OCTAVES = np.log2(F_HI / F_LO)
N_ROWS = int(round(OCTAVES * ROWS_PER_OCTAVE))
FLOOR_DB = -60.0  # painting at or below this is silence
WARM_REPEATS = 3


def pattern_from_grid(grid_db, duration):
    """``pattern(t, x)`` reading ``grid_db`` (rows x columns) bilinearly, in dB.

    Cell centers sit at ``(i + 0.5) / n`` of the axis; outside the outer
    centers the edge value holds.
    """
    n_rows, n_columns = grid_db.shape
    tc = (np.arange(n_columns) + 0.5) / n_columns * duration
    xc = (np.arange(n_rows) + 0.5) / n_rows * OCTAVES
    amplitude = np.where(grid_db <= FLOOR_DB, 0.0, 10 ** (grid_db / 20))

    def pattern(t, x):
        t = np.asarray(t, float).ravel()
        x = np.asarray(x, float).ravel()
        along_time = np.stack([np.interp(t, tc, row) for row in amplitude])  # rows x len(t)
        # then across rows, for every requested x
        i = np.clip(np.searchsorted(xc, x) - 1, 0, n_rows - 2)
        w = np.clip((x - xc[i]) / (xc[i + 1] - xc[i]), 0.0, 1.0)
        out = along_time[i] * (1 - w)[:, None] + along_time[i + 1] * w[:, None]
        return out  # shape (len(x), len(t)), as _evaluate's broadcast expects

    return pattern


def synthesize(grid_db, duration, carrier, rng=1):
    return so.ripple_sound(pattern_from_grid(grid_db, duration), duration, FS, f_lo=F_LO, f_hi=F_HI, carrier=carrier, rng=rng)


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


def soft_disc(grid, row, column, radius, level_db):
    """Paint toward ``level_db`` with a Gaussian brush, as the brush would."""
    rr, cc = np.mgrid[0 : grid.shape[0], 0 : grid.shape[1]]
    weight = np.exp(-((rr - row) ** 2 + (cc - column) ** 2) / (2 * radius**2))
    grid += weight * (level_db - grid)


def typical_painting(seed=0):
    rng = np.random.default_rng(seed)
    grid = np.full((N_ROWS, N_COLUMNS), FLOOR_DB)
    for _ in range(12):  # a dozen strokes, each a short drag of a soft brush
        row, column = rng.uniform(0, N_ROWS), rng.uniform(0, N_COLUMNS)
        d_row, d_column = rng.normal(0, 0.5), rng.normal(1.5, 0.5)
        level, radius = rng.uniform(-30, 0), rng.uniform(1.5, 4)
        for _ in range(int(rng.uniform(10, 60))):
            soft_disc(grid, row, column, radius, level)
            row, column = row + d_row, column + d_column
    return grid


def link_bytes(grid_db):
    quantized = np.clip(np.round(-grid_db), 0, -FLOOR_DB).astype(np.uint8)  # 0 dB -> 0, floor -> 60
    packed = zlib.compress(quantized.tobytes(), 9)
    return len(base64.urlsafe_b64encode(packed).rstrip(b"="))


def band_level_db(sound, octave_lo, octave_hi, t_lo, t_hi):
    """RMS level (dB) of ``sound`` between two octaves above F_LO and two times."""
    data = sound.mono().data[:, 0]
    start, stop = int(t_lo * FS), int(t_hi * FS)
    spectrum = np.abs(np.fft.rfft(data[start:stop] * np.hanning(stop - start))) ** 2
    f = np.fft.rfftfreq(stop - start, 1 / FS)
    band = (f >= F_LO * 2**octave_lo) & (f < F_LO * 2**octave_hi)
    return 10 * np.log10(spectrum[band].mean())


print(f"sonore {so.__version__}, numpy {np.__version__}")
print(f"grid {N_ROWS} rows ({ROWS_PER_OCTAVE}/octave, {F_LO:g}-{F_HI:g} Hz) x {N_COLUMNS} columns, fs {FS} Hz")

print("\n1. speed of ripple_sound on a typical painting")
print(f"  {'carrier':<10s} {'sound':>6s} {'cold':>8s} {'warm':>8s}")
grid = typical_painting()
for carrier in ("tones", "harmonic", "noise"):
    for duration in (1.0, 3.0, 10.0):
        cold = timed(lambda: synthesize(grid, duration, carrier))
        warm = statistics.median(timed(lambda: synthesize(grid, duration, carrier)) for _ in range(WARM_REPEATS))
        print(f"  {carrier:<10s} {duration:5.0f}s {cold:7.3f}s {warm:7.3f}s")

print("\n2. depth of a painted hole (octaves 2-3, 0.8-1.2 s of 2 s), measured against octaves 2-3 at 0.2-0.6 s")
print(f"  {'carrier':<10s} " + " ".join(f"{label:>9s}" for label in ("-20 dB", "-40 dB", "silence")))
duration = 2.0
for carrier in ("tones", "harmonic", "noise"):
    depths = []
    for hole in (-20.0, -40.0, FLOOR_DB):
        grid = np.zeros((N_ROWS, N_COLUMNS))
        rows = slice(2 * ROWS_PER_OCTAVE, 3 * ROWS_PER_OCTAVE)
        columns = slice(int(0.4 * N_COLUMNS), int(0.6 * N_COLUMNS))
        grid[rows, columns] = hole
        sound = synthesize(grid, duration, carrier)
        inside = band_level_db(sound, 2.25, 2.75, 0.85, 1.15)
        outside = band_level_db(sound, 2.25, 2.75, 0.25, 0.55)
        depths.append(inside - outside)
    print(f"  {carrier:<10s} " + " ".join(f"{d:8.1f} " for d in depths))

print("\n3. link size (base64url of deflated whole-dB grid)")
for name, grid in (
    ("blank", np.full((N_ROWS, N_COLUMNS), FLOOR_DB)),
    ("typical (12 soft strokes)", typical_painting()),
    ("worst case (random cells)", np.random.default_rng(0).uniform(FLOOR_DB, 0, (N_ROWS, N_COLUMNS))),
):
    print(f"  {name:<28s} {link_bytes(grid):6d} characters")
