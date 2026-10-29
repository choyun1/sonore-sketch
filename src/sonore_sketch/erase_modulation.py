"""The Erase modulation tab's state, and the sound it describes.

Take a sound, analyze its modulation spectrum, cut parts of it with a mask
painted on rate x density, and hear the sound rebuilt from what is left
(docs/design/tabs/erase_modulation.md)::

    {"erase_modulation": 1, "sonore": "0.10.0", "duration": 3.0, "fs": 16000,
     "source": "syllables", "carrier": "source", "iterations": 5, "seed": 1,
     "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
     "columns": 193, "rows": 48, "floor_db": -60, "levels": "<base64 of deflated bytes>",
     "draw_speech": {"mode": "klatt", "params": {...}},          # with source "draw_speech"
     "recording": {"name": "...", "fs": 16000, "pcm16": "<base64>"}}  # with source "file"

The source (E1) is a Klatt syllable train made here at the page's duration,
the Draw speech tab's sound, or a recording opened in the page (``sources``). The mask (E4) is
a grid of cuts in dB, one byte a cell like the Draw spectrogram tab's painting:
0 keeps a cell, ``-floor_db`` and more removes it. Its columns are 16 per
octave of rate from 1 to 64 Hz on each side of the plane plus one center
column for |rate| < 1 Hz (the static spectral shape); its rows are density
from 0 to 6 cyc/oct in steps of 0.125. The sound is
``ModulationSpectrum.octave(source).with_gain(mask).to_sound(carrier, iterations)``.
"""

from __future__ import annotations

import math
import re
import warnings
from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so

from . import shared
from .shared import number
from .sources import SOURCES, source

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
CARRIERS = ("source", "tones", "noise")  # E5
MAX_ITERATIONS = 20  # E5
RATE_MIN, RATE_MAX = 1.0, 64.0  # the plane's rate axis on each side (E2, as draw_modulation.md B1)
COLUMNS_PER_OCTAVE = 16
SIDE = COLUMNS_PER_OCTAVE * round(math.log2(RATE_MAX / RATE_MIN))  # 96 columns a side
COLUMNS = 2 * SIDE + 1  # and the center column (E4)
DENSITY_STEP = 0.125
ROWS = 48  # density 0 to 6 cyc/oct
FLOOR_DB = -60.0  # a cut this deep removes the cell (E3)


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("erase_modulation") != FORMAT:
        raise ValueError(f"not an Erase modulation state of format {FORMAT}: 'erase_modulation' is {state.get('erase_modulation')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    f_lo, f_hi = state.get("f_lo"), state.get("f_hi")
    if not (number(f_lo) and number(f_hi) and 0 < f_lo < f_hi < fs / 2):
        raise ValueError(f"the frequency range must have 0 < f_lo < f_hi < fs/2 = {fs / 2:g} Hz, not {f_lo!r}-{f_hi!r}")
    if not (isinstance(state.get("bands_per_octave"), int) and state["bands_per_octave"] >= 1):
        raise ValueError("'bands_per_octave' must be a whole number of at least 1")
    if state.get("source") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    if state.get("carrier") not in CARRIERS:
        raise ValueError(f"'carrier' must be one of {CARRIERS}, not {state.get('carrier')!r}")
    iterations = state.get("iterations")
    if not (isinstance(iterations, int) and not isinstance(iterations, bool) and 0 <= iterations <= MAX_ITERATIONS):
        raise ValueError(f"'iterations' must be a whole number from 0 to {MAX_ITERATIONS}, not {iterations!r}")
    if not isinstance(state.get("seed", 1), int):
        raise ValueError("'seed' must be a whole number")
    if (state.get("columns"), state.get("rows"), state.get("floor_db")) != (COLUMNS, ROWS, FLOOR_DB):
        raise ValueError(f"the mask must be {COLUMNS} columns x {ROWS} rows with a floor of {FLOOR_DB:g} dB")
    cuts(state)  # decodes, and checks the size


# --- the mask ---------------------------------------------------------------------


def cuts(state: Mapping[str, Any]) -> np.ndarray:
    """The mask as cuts in dB, shape (rows, columns): 0 keeps, ``-floor_db`` removes."""
    return shared.cuts(state, ROWS, COLUMNS, FLOOR_DB)


def encode(cut_db: np.ndarray) -> str:
    """``levels`` for a grid of cuts in dB, (rows, columns)."""
    return shared.encode_cuts(cut_db, FLOOR_DB)


def column_rates() -> np.ndarray:
    """Each column's center rate [Hz]: negative side, center (0), positive side."""
    side = RATE_MIN * 2 ** ((np.arange(SIDE) + 0.5) / COLUMNS_PER_OCTAVE)
    return np.concatenate([-side[::-1], [0.0], side])


def row_densities() -> np.ndarray:
    return (np.arange(ROWS) + 0.5) * DENSITY_STEP


def keep_below(rate: float) -> np.ndarray:
    """The "keep rates below N Hz" preset (E6): cut every column faster than ``rate``."""
    cut = np.where(np.abs(column_rates()) > rate, -FLOOR_DB, 0.0)
    return np.broadcast_to(cut, (ROWS, COLUMNS)).copy()


def remove_sweeps(direction: str) -> np.ndarray:
    """The "remove downward/upward sweeps" presets (E6): cut one side of the
    plane above the first row (density 0 has no direction). Positive rates
    sweep down, as on the Draw modulation tab."""
    side = column_rates() > 0 if direction == "down" else column_rates() < 0
    cut = np.zeros((ROWS, COLUMNS))
    cut[1:, side] = -FLOOR_DB
    return cut


def gain(state: Mapping[str, Any]):
    """``g(rate, density)`` for ``with_gain``: the mask read bilinearly in dB
    at each cell (E4), as an amplitude gain. A cell at negative density reads
    the mask at (-rate, -density), its mirror image, where the plane shows
    it; rates under 1 Hz read the center column, and the axes hold their
    ends beyond the plane."""
    cut_db = cuts(state)
    side_octaves = math.log2(RATE_MAX / RATE_MIN)

    def g(rate, density):
        rate, density = np.broadcast_arrays(np.asarray(rate, float), np.asarray(density, float))
        rate = np.where(density < 0, -rate, rate)
        density = np.abs(density)
        # fractional row, and fractional column along the rate's own side
        row = np.clip(density / DENSITY_STEP - 0.5, 0, ROWS - 1)
        along = np.clip(np.log2(np.maximum(np.abs(rate), RATE_MIN) / RATE_MIN) / side_octaves * SIDE - 0.5, 0, SIDE - 1)
        column = np.where(rate > 0, SIDE + 1 + along, SIDE - 1 - along)
        row_below = np.floor(row).astype(int)
        row_above = np.minimum(row_below + 1, ROWS - 1)
        row_weight = row - row_below
        column_below = np.floor(column).astype(int)
        column_above = np.where(rate > 0, np.minimum(column_below + 1, COLUMNS - 1), np.minimum(column_below + 1, SIDE - 1))
        column_weight = column - column_below
        cut_here = (1 - row_weight) * (
            (1 - column_weight) * cut_db[row_below, column_below] + column_weight * cut_db[row_below, column_above]
        ) + row_weight * ((1 - column_weight) * cut_db[row_above, column_below] + column_weight * cut_db[row_above, column_above])
        center_cut = (1 - row_weight) * cut_db[row_below, SIDE] + row_weight * cut_db[row_above, SIDE]
        cut_here = np.where(np.abs(rate) < RATE_MIN, center_cut, cut_here)
        return np.where(cut_here >= -FLOOR_DB - 1e-9, 0.0, 10 ** (-cut_here / 20))

    return g


# --- the sound -------------------------------------------------------------------------


def analyze(sound: so.Sound, state: Mapping[str, Any]) -> so.ModulationSpectrum:
    """The modulation spectrum the mask is painted on (``octave``, as the
    Draw modulation tab's plane)."""
    return so.ModulationSpectrum.octave(
        sound, bands_per_octave=int(state["bands_per_octave"]), f_lo=float(state["f_lo"]), f_hi=float(state["f_hi"])
    )


def steps(state: Mapping[str, Any]) -> Iterator[shared.Step]:
    """``synthesize`` one step at a time: yields the fraction done (with
    what comes next, ``shared.Step``) before the source and after the
    source, its analysis, the first synthesis and each iteration, and returns
    ``(sound, the source's modulation spectrum, the fraction of envelope
    values sonore clipped)``. An edit that would need envelopes below zero
    is clipped, and sonore warns (E9); the page shows the fraction as a
    note, not an error."""
    check(state)
    iterations = int(state["iterations"])
    total = iterations + 3
    yield 0.0, "Making the source"
    original = source(state)
    yield 1 / total, "Measuring the source's modulation"
    spectrum = analyze(original, state)
    yield 2 / total, "Synthesizing the edited sound"
    edited = spectrum.with_gain(gain(state))
    carrier = state["carrier"]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        if carrier == "source":
            sound = edited.to_sound(carrier=original)
        else:
            fs, seed = float(state["fs"]), int(state.get("seed", 1))
            carried = shared.modulation_carrier(carrier, original.duration, fs, seed)
            sound = edited.to_sound(carrier=carried, fs=fs, rng=seed)
    clipped = clipped_fraction(caught)
    yield 3 / total, shared.iteration_text(0, iterations)
    for i in range(iterations):  # to_sound's own iterations, one at a time (as on the Draw modulation tab)
        sound = edited.iterate(sound)
        yield (i + 4) / total, shared.iteration_text(i + 1, iterations)
    return (sound.normalize() if sound.rms > 0 else sound), spectrum, clipped


def clipped_fraction(caught) -> float:
    """The fraction of envelope values sonore says it clipped, from its
    warning ("12.3% of the rebuilt envelope values were below zero ..."),
    or 0; other warnings are passed on."""
    clipped = 0.0
    for warning in caught:
        match = re.match(r"([0-9.]+)% of the rebuilt envelope values", str(warning.message))
        if match:
            clipped = max(clipped, float(match.group(1)) / 100)
        else:
            warnings.warn_explicit(warning.message, warning.category, warning.filename, warning.lineno)
    return clipped


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    return shared.finish(steps(state))[0]


def plane_picture(spectrum: so.ModulationSpectrum) -> dict[str, Any]:
    """The source's modulation spectrum on the plane (E7) as 8-bit levels,
    rows densities from 0 to 6 cyc/oct, columns rates from -64 to 64 Hz with
    rate 0 among them (the plane's center column), 0 at ``PICTURE_FLOOR_DB``
    below the peak away from rate 0 and 255 at it."""
    rate_shown = np.abs(spectrum.w_t) <= RATE_MAX
    density_shown = spectrum.w_f <= ROWS * DENSITY_STEP + 1e-9
    level = spectrum.level[np.ix_(density_shown, rate_shown)]
    rates = spectrum.w_t[rate_shown]
    moving = np.abs(rates) >= RATE_MIN
    peak = level[:, moving].max() if moving.any() else level.max()
    scaled = np.round(255 * (1 - np.clip(level - peak, PICTURE_FLOOR_DB, 0) / PICTURE_FLOOR_DB))
    return {
        "data": np.ascontiguousarray(scaled, dtype=np.uint8).tobytes(),
        "n_densities": int(level.shape[0]),
        "n_rates": int(level.shape[1]),
        "rate_first": float(rates[0]),
        "rate_step": float(rates[1] - rates[0]) if rates.size > 1 else 1.0,
        "density_step": float(spectrum.w_f[1]),
        "floor_db": PICTURE_FLOOR_DB,
    }


PICTURE_FLOOR_DB = -40.0

# The mask the tab starts from (E8): keep rates below 4 Hz.
EXAMPLE_LEVELS = encode(keep_below(4))
