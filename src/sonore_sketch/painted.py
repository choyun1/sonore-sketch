"""The Draw spectrogram tab's state, and the sound it describes.

A painting is a grid of levels over time and log-frequency
(docs/design/tabs/painted.md)::

    {"painted": 1, "sonore": "0.7.0", "duration": 0.6, "fs": 16000,
     "f_lo": 100, "f_hi": 6400, "rows_per_octave": 12, "columns": 256,
     "floor_db": -60, "carrier": "tones", "f0": 100, "seed": 1,
     "levels": "<base64 of zlib-deflated bytes>"}

``levels`` holds one byte per cell, rows from ``f_lo`` up and columns from
time 0, row after row. A byte is the cell's level in dB below 0 dB: 0 is
0 dB and ``-floor_db`` (or more) is silence. Rows are equal steps in octaves
and columns equal fractions of the duration, so a painting stretches with
the duration. Between cell centers the envelope is read bilinearly, in
amplitude, and the result is ``so.ripple_sound``'s, normalized to RMS 1.
"""

from __future__ import annotations

import base64
import binascii
import math
import zlib
from collections.abc import Mapping
from typing import Any

import numpy as np
import sonore as so

FORMAT = 1
MAX_DURATION = 10.0  # seconds, the whole app's limit (docs/design/app.md, D10)
CARRIERS = ("tones", "harmonic", "noise")  # painted.md, P4
MAX_CELLS = 1 << 20  # the page's grid is 72 x 256; a file asking for more is refused (app/painted/model.js)


def rows(state: Mapping[str, Any]) -> int:
    """The grid's number of rows: ``rows_per_octave`` per octave from
    ``f_lo`` to ``f_hi``, rounded, at least 2."""
    return max(2, round(math.log2(state["f_hi"] / state["f_lo"]) * state["rows_per_octave"]))


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("painted") != FORMAT:
        raise ValueError(f"not a Painted state of format {FORMAT}: 'painted' is {state.get('painted')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not isinstance(duration, (int, float)) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not isinstance(fs, (int, float)) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    f_lo, f_hi = state.get("f_lo"), state.get("f_hi")
    if not (isinstance(f_lo, (int, float)) and isinstance(f_hi, (int, float)) and 0 < f_lo < f_hi < fs / 2):
        raise ValueError(f"the frequency range must have 0 < f_lo < f_hi < fs/2 = {fs / 2:g} Hz, not {f_lo!r}-{f_hi!r}")
    for name in ("rows_per_octave", "columns"):
        if not (isinstance(state.get(name), int) and state[name] >= 2):
            raise ValueError(f"'{name}' must be a whole number of at least 2")
    if rows(state) * state["columns"] > MAX_CELLS:
        raise ValueError(f"the painting may hold at most {MAX_CELLS} cells")
    floor_db = state.get("floor_db")
    if not (isinstance(floor_db, (int, float)) and -255 <= floor_db < 0):
        raise ValueError(f"'floor_db' must be a negative number of dB, at least -255, not {floor_db!r}")
    if state.get("carrier", "tones") not in CARRIERS:
        raise ValueError(f"'carrier' must be one of {CARRIERS}, not {state.get('carrier')!r}")
    f0 = state.get("f0", 100)
    if state.get("carrier") == "harmonic" and not (isinstance(f0, (int, float)) and 0 < f0 <= f_hi):
        raise ValueError(f"'f0' must be a positive frequency up to f_hi for the harmonic carrier, not {f0!r}")
    levels(state)  # decodes, and checks the size


def levels(state: Mapping[str, Any]) -> np.ndarray:
    """The painting as levels in dB, shape (rows, columns), rows from ``f_lo``
    up; silent cells are ``-inf``."""
    try:
        # at most one cell too many, so a small text cannot inflate to fill the memory
        raw = zlib.decompressobj().decompress(base64.b64decode(state.get("levels", ""), validate=True), rows(state) * state["columns"] + 1)
    except (binascii.Error, zlib.error, TypeError) as error:
        raise ValueError(f"'levels' is not base64 of zlib-deflated bytes ({error})") from None
    shape = (rows(state), state["columns"])
    if len(raw) != shape[0] * shape[1]:
        raise ValueError(f"'levels' holds {len(raw)} cells, not {shape[0]} rows x {shape[1]} columns")
    below = np.frombuffer(raw, dtype=np.uint8).reshape(shape).astype(float)
    return np.where(below >= -state["floor_db"], -np.inf, -below)


def encode_levels(levels_db: np.ndarray, floor_db: float = -60) -> str:
    """``levels`` for a grid of dB (rows from ``f_lo`` up): whole dB below
    0 dB, the floor and below as silence."""
    below = np.clip(np.round(-np.asarray(levels_db, dtype=float)), 0, -floor_db)
    return base64.b64encode(zlib.compress(below.astype(np.uint8).tobytes(), 9)).decode()


def pattern(state: Mapping[str, Any]):
    """``pattern(t, x)`` for ``so.ripple_sound``: the painting read
    bilinearly between cell centers (held beyond the outer ones), as an
    amplitude, for ``t`` in seconds and ``x`` in octaves above ``f_lo``."""
    amplitude = 10 ** (levels(state) / 20)  # -inf dB -> 0
    n_rows, n_columns = amplitude.shape
    octaves = math.log2(state["f_hi"] / state["f_lo"])
    column_times = (np.arange(n_columns) + 0.5) / n_columns * float(state["duration"])
    row_octaves = (np.arange(n_rows) + 0.5) / n_rows * octaves

    def envelope(t, x):
        t, x = np.ravel(t).astype(float), np.ravel(x).astype(float)
        along_time = np.stack([np.interp(t, column_times, row) for row in amplitude])
        row_below = np.clip(np.searchsorted(row_octaves, x) - 1, 0, n_rows - 2)
        weight = np.clip((x - row_octaves[row_below]) / (row_octaves[row_below + 1] - row_octaves[row_below]), 0.0, 1.0)
        return along_time[row_below] * (1 - weight)[:, None] + along_time[row_below + 1] * weight[:, None]

    return envelope


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes: one call of ``so.ripple_sound``.

    Tones' phases and noise use ``state["seed"]`` (default 1), so a painting
    always gives the same samples.
    """
    check(state)
    if np.all(np.isneginf(levels(state))):
        raise ValueError("nothing painted yet: paint something to hear it")
    return so.ripple_sound(
        pattern(state),
        float(state["duration"]),
        float(state["fs"]),
        f_lo=float(state["f_lo"]),
        f_hi=float(state["f_hi"]),
        carrier=state.get("carrier", "tones"),
        f0=float(state.get("f0", 100)),
        rng=int(state.get("seed", 1)),
    )


# The starting painting writes "sonore" by hand: each letter a few strokes,
# slanted like handwriting, so that a stroke is a glide or a held tone and
# little sounds at once. Strokes are polylines in a letter's box, x (time) and
# y (frequency) from 0 to 1; a letter's x height spans EXAMPLE_ROWS, about
# 180 Hz to 1.4 kHz on the default range. The harmonic carrier at EXAMPLE_F0
# keeps a harmonic within a few rows of every stroke there.
EXAMPLE_F0 = 50
EXAMPLE_ROWS = (10, 46)  # the letters' bottom and top rows
EXAMPLE_SLANT = 0.3  # of a letter's width, leaned over its height


def _arc(center_x, center_y, radius_x, radius_y, start, stop, n_points=24):
    angles = np.linspace(math.radians(start), math.radians(stop), n_points)
    return [(center_x + radius_x * math.cos(angle), center_y + radius_y * math.sin(angle)) for angle in angles]


EXAMPLE_STROKES = {
    "s": [[(0.9, 0.85), (0.65, 1.0), (0.3, 0.97), (0.1, 0.78), (0.25, 0.57), (0.7, 0.45), (0.9, 0.25), (0.75, 0.04), (0.4, 0.0), (0.08, 0.15)]],
    "o": [_arc(0.5, 0.5, 0.42, 0.5, 90, 450, 40)],
    "n": [[(0.1, 0.0), (0.1, 1.0)], [(0.1, 0.7), (0.3, 0.95), (0.6, 1.0), (0.85, 0.82), (0.9, 0.5), (0.9, 0.0)]],
    "r": [[(0.1, 0.0), (0.1, 1.0)], [(0.1, 0.7), (0.35, 0.95), (0.65, 1.0), (0.9, 0.88)]],
    "e": [[(0.1, 0.5), (0.9, 0.5), (0.85, 0.8), (0.6, 1.0), (0.3, 0.96), (0.1, 0.72), (0.1, 0.3), (0.3, 0.04), (0.6, 0.0), (0.9, 0.15)]],
}


def example_levels(f_lo: float = 100, f_hi: float = 6400, rows_per_octave: int = 12, columns: int = 256) -> np.ndarray:
    """The painting the tab starts from (painted.md, P7): "sonore" written by
    hand across the plane at 0 dB, strokes with soft edges, in dB, shape
    (rows, columns)."""
    n_rows = max(2, round(math.log2(f_hi / f_lo) * rows_per_octave))
    low, high = EXAMPLE_ROWS
    word = "sonore"
    pitch = (columns - 16) / len(word)  # columns per letter, with a margin of 8 each side
    width = 0.72 * pitch  # the rest is the space between letters
    row_index = np.arange(n_rows)[:, None]
    column_index = np.arange(columns)[None, :]
    level = np.full((n_rows, columns), -np.inf)
    for i, letter in enumerate(word):
        left = 8 + i * pitch + (pitch - width) / 2 - EXAMPLE_SLANT * width / 2
        for stroke in EXAMPLE_STROKES[letter]:
            # points along the stroke about a quarter cell apart, in grid units
            points = []
            for (x0, y0), (x1, y1) in zip(stroke, stroke[1:]):
                n_points = max(2, int(4 * math.hypot((x1 - x0) * width, (y1 - y0) * (high - low))))
                for fraction in np.linspace(0, 1, n_points, endpoint=False):
                    x, y = x0 + fraction * (x1 - x0), y0 + fraction * (y1 - y0)
                    points.append((left + (x + EXAMPLE_SLANT * y) * width, low + y * (high - low)))
            points.append((left + (stroke[-1][0] + EXAMPLE_SLANT * stroke[-1][1]) * width, low + stroke[-1][1] * (high - low)))
            for column, row in points:
                # a soft round nib: -10 dB a column and a half or a row away
                distance = ((column_index - column) / 1.5) ** 2 + ((row_index - row) / 1.0) ** 2
                level = np.maximum(level, -10.0 * distance)
    return np.where(level < -60, -np.inf, np.round(level))
