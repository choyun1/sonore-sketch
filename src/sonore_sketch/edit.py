"""The Erase modulation tab's state, and the sound it describes.

Take a sound, analyse its modulation spectrum, cut parts of it with a mask
painted on rate x density, and hear the sound rebuilt from what is left
(docs/design/tabs/edit.md)::

    {"edit": 1, "sonore": "0.6.0", "duration": 3.0, "fs": 16000,
     "source": "syllables", "carrier": "source", "iterations": 5, "seed": 1,
     "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
     "columns": 193, "rows": 48, "floor_db": -60, "levels": "<base64 of deflated bytes>",
     "speech": {"mode": "klatt", "params": {...}},          # with source "speech"
     "recording": {"name": "...", "fs": 16000, "pcm16": "<base64>"}}  # with source "file"

The source (E1) is a Klatt syllable train made here at the page's duration,
the Draw speech tab's sound, or a recording opened in the page. The mask (E4) is
a grid of cuts in dB, one byte a cell like the Paint spectrogram tab's painting:
0 keeps a cell, ``-floor_db`` and more removes it. Its columns are 16 per
octave of rate from 1 to 64 Hz on each side of the plane plus one centre
column for |rate| < 1 Hz (the static spectral shape); its rows are density
from 0 to 6 cyc/oct in steps of 0.125. The sound is
``ModulationSpectrum.octave(source).with_gain(mask).to_sound(carrier, iterations)``.
"""

from __future__ import annotations

import base64
import binascii
import math
import re
import warnings
import zlib
from collections.abc import Iterator, Mapping
from fractions import Fraction
from typing import Any

import numpy as np
import sonore as so

from . import tracks

FORMAT = 1
MAX_DURATION = 10.0  # seconds, the whole app's limit (docs/design/app.md, D10)
SOURCES = ("syllables", "speech", "file")  # E1
CARRIERS = ("source", "tones", "noise")  # E5
MAX_ITERATIONS = 20  # E5
RATE_MIN, RATE_MAX = 1.0, 64.0  # the plane's rate axis on each side (E2, as blobs.md B1)
COLUMNS_PER_OCTAVE = 16
SIDE = COLUMNS_PER_OCTAVE * round(math.log2(RATE_MAX / RATE_MIN))  # 96 columns a side
COLUMNS = 2 * SIDE + 1  # and the centre column (E4)
DENSITY_STEP = 0.125
ROWS = 48  # density 0 to 6 cyc/oct
FLOOR_DB = -60.0  # a cut this deep removes the cell (E3)


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("edit") != FORMAT:
        raise ValueError(f"not an Erase modulation state of format {FORMAT}: 'edit' is {state.get('edit')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not _number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not _number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    f_lo, f_hi = state.get("f_lo"), state.get("f_hi")
    if not (_number(f_lo) and _number(f_hi) and 0 < f_lo < f_hi < fs / 2):
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
    try:
        raw = zlib.decompress(base64.b64decode(state.get("levels", ""), validate=True))
    except (binascii.Error, zlib.error, TypeError) as error:
        raise ValueError(f"'levels' is not base64 of zlib-deflated bytes ({error})") from None
    if len(raw) != ROWS * COLUMNS:
        raise ValueError(f"'levels' holds {len(raw)} cells, not {ROWS} rows x {COLUMNS} columns")
    return np.minimum(np.frombuffer(raw, dtype=np.uint8).reshape(ROWS, COLUMNS).astype(float), -FLOOR_DB)


def encode(cut_db: np.ndarray) -> str:
    """``levels`` for a grid of cuts in dB, (rows, columns)."""
    below = np.clip(np.round(np.asarray(cut_db, dtype=float)), 0, -FLOOR_DB)
    return base64.b64encode(zlib.compress(below.astype(np.uint8).tobytes(), 9)).decode()


def column_rates() -> np.ndarray:
    """Each column's centre rate [Hz]: negative side, centre (0), positive side."""
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
    it; rates under 1 Hz read the centre column, and the axes hold their
    ends beyond the plane."""
    cut = cuts(state)
    span = math.log2(RATE_MAX / RATE_MIN)

    def g(rate, density):
        rate, density = np.broadcast_arrays(np.asarray(rate, float), np.asarray(density, float))
        rate = np.where(density < 0, -rate, rate)
        density = np.abs(density)
        # fractional row, and fractional column along the rate's own side
        row = np.clip(density / DENSITY_STEP - 0.5, 0, ROWS - 1)
        along = np.clip(np.log2(np.maximum(np.abs(rate), RATE_MIN) / RATE_MIN) / span * SIDE - 0.5, 0, SIDE - 1)
        column = np.where(rate > 0, SIDE + 1 + along, SIDE - 1 - along)
        r0 = np.floor(row).astype(int)
        r1 = np.minimum(r0 + 1, ROWS - 1)
        wr = row - r0
        c0 = np.floor(column).astype(int)
        c1 = np.where(rate > 0, np.minimum(c0 + 1, COLUMNS - 1), np.minimum(c0 + 1, SIDE - 1))
        wc = column - c0
        db = (1 - wr) * ((1 - wc) * cut[r0, c0] + wc * cut[r0, c1]) + wr * ((1 - wc) * cut[r1, c0] + wc * cut[r1, c1])
        centre = (1 - wr) * cut[r0, SIDE] + wr * cut[r1, SIDE]
        db = np.where(np.abs(rate) < RATE_MIN, centre, db)
        return np.where(db >= -FLOOR_DB - 1e-9, 0.0, 10 ** (-db / 20))

    return g


# --- the source ----------------------------------------------------------------------


def syllables(duration: float, fs: float) -> so.Sound:
    """A Klatt syllable train (E1, a): one syllable every 0.22 s, each a
    voicing burst whose F1 and F2 move between two vowels, F0 falling from
    130 to 90 Hz (tools/measure_edit.py measured this source)."""
    starts = np.arange(0.0, max(duration - 0.15, 1e-9), 0.22)
    times, av, f1, f2 = [0.0], [0.0], [300.0], [900.0]
    for i, t in enumerate(starts):
        hi = (650, 1700) if i % 2 else (450, 1100)
        for dt, a, (g1, g2) in ((0.03, 60, hi), (0.15, 58, hi), (0.19, 0, (300, 900))):
            if round(t + dt, 4) < duration:
                times.append(round(t + dt, 4))
                av.append(a)
                f1.append(g1)
                f2.append(g2)
    times.append(duration)
    av.append(0)
    f1.append(300)
    f2.append(900)
    document = {
        "trackdraw": tracks.FORMAT, "sonore": so.__version__, "duration": duration, "fs": fs, "mode": "klatt",
        "params": {"F0": [[0, duration], [130, 90]], "AV": [times, av], "F1": [times, f1], "F2": [times, f2], "F3": 2500},
    }
    return tracks.synthesize(document)


def recording(state: Mapping[str, Any]) -> so.Sound:
    """The recording opened in the page (E1, c), mono, at the page's rate,
    cut or padded with silence to the page's duration."""
    held = state.get("recording")
    if not isinstance(held, Mapping) or not isinstance(held.get("pcm16"), str):
        raise ValueError("no recording: links do not carry recordings, so open the file again (Source, Open file…)")
    try:
        samples = np.frombuffer(base64.b64decode(held["pcm16"], validate=True), dtype="<i2").astype(float) / 32767
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"the recording is not base64 of 16-bit samples ({error})") from None
    fs, rate = float(state["fs"]), held.get("fs")
    if not _number(rate) or rate <= 0:
        raise ValueError(f"the recording's 'fs' must be a positive sampling rate, not {rate!r}")
    if rate != fs:
        from scipy.signal import resample_poly

        ratio = Fraction(fs / rate).limit_denominator(1000)
        samples = resample_poly(samples, ratio.numerator, ratio.denominator)
    n = int(round(float(state["duration"]) * fs))
    samples = np.pad(samples[:n], (0, max(0, n - samples.size)))
    return so.Sound(samples, fs)


def source(state: Mapping[str, Any], silent: str = "there is no modulation to edit") -> so.Sound:
    """The sound the tab edits, at the page's duration and rate (the Filter
    recording tab takes its source here too, saying ``silent`` when it is)."""
    duration, fs = float(state["duration"]), float(state["fs"])
    kind = state["source"]
    if kind == "syllables":
        sound = syllables(duration, fs)
    elif kind == "speech":
        speech = state.get("speech")
        if not isinstance(speech, Mapping):
            raise ValueError("the Draw speech tab's drawing is missing")
        sound = tracks.synthesize({"trackdraw": tracks.FORMAT, "duration": duration, "fs": fs, **speech})
    else:
        sound = recording(state)
    if not sound.rms > 0:
        raise ValueError(f"the source ({kind}) is silent: {silent}")
    return sound


# --- the sound -------------------------------------------------------------------------


def analyse(sound: so.Sound, state: Mapping[str, Any]) -> so.ModulationSpectrum:
    """The modulation spectrum the mask is painted on (``octave``, as the
    Draw modulation tab's plane)."""
    return so.ModulationSpectrum.octave(
        sound, bands_per_octave=int(state["bands_per_octave"]), f_lo=float(state["f_lo"]), f_hi=float(state["f_hi"])
    )


def steps(state: Mapping[str, Any]) -> Iterator[float]:
    """``synthesize`` one step at a time: yields the fraction done after the
    source, its analysis, the first synthesis and each iteration, and returns
    ``(sound, the source's modulation spectrum, the fraction of envelope
    values sonore clipped)``. An edit that would need envelopes below zero
    is clipped, and sonore warns (E9); the page shows the fraction as a
    note, not an error."""
    check(state)
    iterations = int(state["iterations"])
    total = iterations + 3
    original = source(state)
    yield 1 / total
    spectrum = analyse(original, state)
    yield 2 / total
    edited = spectrum.with_gain(gain(state))
    carrier = state["carrier"]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        if carrier == "source":
            sound = edited.to_sound(carrier=original)
        else:
            sound = edited.to_sound(carrier=carrier, fs=float(state["fs"]), rng=int(state.get("seed", 1)))
    clipped = clipped_fraction(caught)
    yield 3 / total
    for i in range(iterations):  # to_sound's own iterations, one at a time (as blobs._toward_drawn)
        sound = _toward(sound, edited)
        yield (i + 4) / total
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


def _toward(sound: so.Sound, target: so.ModulationSpectrum) -> so.Sound:
    """One of ``to_sound``'s iterations: keep the sound's fine structure and
    modulation phase, impose the target's magnitudes again."""
    subbands = target._analysis.filterbank.analyze(sound)
    envelopes = target._rebuild(target._modulation_phase(subbands), quiet=True)
    out = (envelopes * subbands.tfs()).to_sound()
    return so.Sound(out.data[: sound.n_samples], sound.fs)


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    work = steps(state)
    while True:
        try:
            next(work)
        except StopIteration as done:
            return done.value[0]


def plane_picture(spectrum: so.ModulationSpectrum) -> dict[str, Any]:
    """The source's modulation spectrum on the plane (E7) as 8-bit levels,
    rows densities from 0 to 6 cyc/oct, columns rates from -64 to 64 Hz with
    rate 0 among them (the plane's centre column), 0 at ``PICTURE_FLOOR_DB``
    below the peak away from rate 0 and 255 at it."""
    rates = np.abs(spectrum.w_t) <= RATE_MAX
    densities = spectrum.w_f <= ROWS * DENSITY_STEP + 1e-9
    level = spectrum.level[np.ix_(densities, rates)]
    w_t = spectrum.w_t[rates]
    moving = np.abs(w_t) >= RATE_MIN
    peak = level[:, moving].max() if moving.any() else level.max()
    scaled = np.round(255 * (1 - np.clip(level - peak, PICTURE_FLOOR_DB, 0) / PICTURE_FLOOR_DB))
    return {
        "data": np.ascontiguousarray(scaled, dtype=np.uint8).tobytes(),
        "n_densities": int(level.shape[0]),
        "n_rates": int(level.shape[1]),
        "rate_first": float(w_t[0]),
        "rate_step": float(w_t[1] - w_t[0]) if w_t.size > 1 else 1.0,
        "density_step": float(spectrum.w_f[1]),
        "floor_db": PICTURE_FLOOR_DB,
    }


PICTURE_FLOOR_DB = -40.0

# The mask the tab starts from (E8): keep rates below 4 Hz.
EXAMPLE_LEVELS = encode(keep_below(4))
