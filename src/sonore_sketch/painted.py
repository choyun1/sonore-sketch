"""The Painted tab's state, and the sound it describes.

A painting is a grid of levels over time and log-frequency
(docs/design/tabs/painted.md)::

    {"painted": 1, "sonore": "0.6.0", "duration": 0.6, "fs": 16000,
     "f_lo": 100, "f_hi": 6400, "rows_per_octave": 12, "columns": 256,
     "floor_db": -60, "carrier": "tones", "f0": 100, "seed": 1,
     "levels": "<base64 of zlib-deflated bytes>"}

``levels`` holds one byte per cell, rows from ``f_lo`` up and columns from
time 0, row after row. A byte is the cell's level in dB below 0 dB: 0 is
0 dB and ``-floor_db`` (or more) is silence. Rows are equal steps in octaves
and columns equal fractions of the duration, so a painting stretches with
the duration. Between cell centres the envelope is read bilinearly, in
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
    floor = state.get("floor_db")
    if not (isinstance(floor, (int, float)) and -255 <= floor < 0):
        raise ValueError(f"'floor_db' must be a negative number of dB, at least -255, not {floor!r}")
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
        raw = zlib.decompress(base64.b64decode(state.get("levels", ""), validate=True))
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
    bilinearly between cell centres (held beyond the outer ones), as an
    amplitude, for ``t`` in seconds and ``x`` in octaves above ``f_lo``."""
    amplitude = 10 ** (levels(state) / 20)  # -inf dB -> 0
    n_rows, n_columns = amplitude.shape
    octaves = math.log2(state["f_hi"] / state["f_lo"])
    tc = (np.arange(n_columns) + 0.5) / n_columns * float(state["duration"])
    xc = (np.arange(n_rows) + 0.5) / n_rows * octaves

    def envelope(t, x):
        t, x = np.ravel(t).astype(float), np.ravel(x).astype(float)
        along_time = np.stack([np.interp(t, tc, row) for row in amplitude])
        i = np.clip(np.searchsorted(xc, x) - 1, 0, n_rows - 2)
        w = np.clip((x - xc[i]) / (xc[i + 1] - xc[i]), 0.0, 1.0)
        return along_time[i] * (1 - w)[:, None] + along_time[i + 1] * w[:, None]

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


# The starting painting's chord: fundamentals (Hz) and onsets (fractions of
# the duration). All are harmonics of EXAMPLE_F0, so on the harmonic carrier
# every painted partial is one the carrier has: A3, E4, A4, C#5 (just tuned).
EXAMPLE_F0 = 110
EXAMPLE_NOTES = ((220, 0.0), (330, 0.14), (440, 0.28), (550, 0.42))


def example_levels(f_lo: float = 100, f_hi: float = 6400, rows_per_octave: int = 12, columns: int = 256) -> np.ndarray:
    """The painting the tab starts from (painted.md, P7): a slow arpeggio of
    harmonic tones, each note's partials fading, the higher ones sooner, in
    dB, shape (rows, columns)."""
    n_rows = max(2, round(math.log2(f_hi / f_lo) * rows_per_octave))
    octaves = math.log2(f_hi / f_lo)
    x = ((np.arange(n_rows) + 0.5) / n_rows * octaves)[:, None]  # octaves above f_lo
    t = ((np.arange(columns) + 0.5) / columns)[None, :]  # fraction of the duration
    row = octaves / n_rows
    level = np.full((n_rows, columns), -np.inf)
    for fundamental, onset in EXAMPLE_NOTES:
        since = t - onset
        for k in range(1, 7):
            f = k * fundamental
            if not f_lo <= f <= f_hi:
                continue
            # each partial a ridge about a row wide, 4 dB below the one under it,
            # rising over 4 % of the duration and fading by 8 + 4k dB per half
            across = -12.0 * ((x - math.log2(f / f_lo)) / row) ** 2
            over_time = np.where(since < 0, -np.inf, np.minimum(0.0, -30 + since / 0.04 * 30) - (8 + 4 * k) * since / 0.5)
            level = np.maximum(level, across + over_time - 4 * (k - 1))
    # the last 6 % fades out, so the sound ends softly
    level = level - np.clip((t - 0.94) / 0.06, 0, 1) * 30
    return np.where(level < -60, -np.inf, np.round(level))
