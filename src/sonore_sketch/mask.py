"""The Erase spectrogram tab's state, and the sound it describes.

Take a sound, paint over parts of its spectrogram to turn them down or
remove them, and hear what is left (docs/design/tabs/mask.md)::

    {"mask": 1, "sonore": "0.6.0", "duration": 1.8, "fs": 16000,
     "source": "syllables", "rows": 256, "columns": 256, "floor_db": -60,
     "window": 0.032, "levels": "<base64 of deflated bytes>",
     "speech": {"mode": "klatt", "params": {...}},          # with source "speech"
     "recording": {"name": "...", "fs": 16000, "pcm16": "<base64>"}}  # with source "file"

The source (F2) is the Erase modulation tab's: a Klatt syllable train, the
Draw speech tab's sound, or the page's recording (``edit.source``). The mask is a
grid of cuts in dB, one byte a cell, stored as the other tabs store theirs:
0 keeps a cell and ``-floor_db`` removes it. Its rows are equal steps of
frequency from 0 Hz to Nyquist (F4), its columns equal fractions of
``span`` seconds (the duration when absent): erasures on a recording or the
syllable train keep their seconds when the duration changes, and time past
``span`` is not erased. The sound is
``(stft * gains).to_sound()``, sonore's least-squares resynthesis, with a
32 ms Hann window and a hop of a quarter of it (F5).
"""

from __future__ import annotations

import base64
import binascii
import math
import zlib
from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so

from . import edit

FORMAT = 1
SOURCES = edit.SOURCES  # F2: the Erase modulation tab's
ROWS, COLUMNS = 256, 256
FLOOR_DB = -60.0  # a cut this deep removes the cell
WINDOW_S = 0.032  # F5: only a long window lets a painted cut come out as painted (F-M2, F-M3)
PICTURE_FLOOR_DB = -80.0  # the pictures' range below the source's loudest cell


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("mask") != FORMAT:
        raise ValueError(f"not an Erase spectrogram state of format {FORMAT}: 'mask' is {state.get('mask')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not edit._number(duration) or not 0 < duration <= edit.MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {edit.MAX_DURATION:g}], not {duration!r}")
    if not edit._number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    if state.get("source") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    shape = (state.get("rows"), state.get("columns"), state.get("floor_db"), state.get("window"))
    if shape != (ROWS, COLUMNS, FLOOR_DB, WINDOW_S):
        raise ValueError(f"the mask must be {ROWS} rows x {COLUMNS} columns with a floor of {FLOOR_DB:g} dB and a {WINDOW_S:g} s window")
    span = state.get("span")
    if span is not None and not (edit._number(span) and span > 0):
        raise ValueError(f"'span' must be a positive number of seconds, not {span!r}")
    cuts(state)  # decodes, and checks the size


# --- the mask ---------------------------------------------------------------------


def cuts(state: Mapping[str, Any]) -> np.ndarray:
    """The mask as cuts in dB, shape (rows, columns), rows from 0 Hz up: 0
    keeps, ``-floor_db`` removes."""
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


def row_frequencies(fs: float) -> np.ndarray:
    """Each row's centre frequency [Hz]: equal steps from 0 Hz to Nyquist (F4)."""
    return (np.arange(ROWS) + 0.5) / ROWS * fs / 2


def _weights(x: np.ndarray, centres: np.ndarray) -> np.ndarray:
    """Linear interpolation from values at ``centres`` to ``x`` as a matrix
    (len(x), len(centres)), holding the ends beyond the outer centres."""
    position = np.clip(np.interp(x, centres, np.arange(centres.size)), 0, centres.size - 1)
    i0 = np.minimum(np.floor(position).astype(int), centres.size - 2)
    w = position - i0
    out = np.zeros((x.size, centres.size))
    out[np.arange(x.size), i0] = 1 - w
    out[np.arange(x.size), i0 + 1] += w
    return out


def gains(cut_db: np.ndarray, f: np.ndarray, t: np.ndarray, span: float, fs: float) -> np.ndarray:
    """The mask read bilinearly, in amplitude, at each STFT coefficient
    (frequencies ``f`` x frames ``t``), its columns over ``span`` seconds,
    held beyond the outer ones; a removed cell is a gain of 0."""
    amplitude = np.where(cut_db >= -FLOOR_DB, 0.0, 10 ** (-cut_db / 20))
    columns = (np.arange(COLUMNS) + 0.5) / COLUMNS * span
    return _weights(np.asarray(f, float), row_frequencies(fs)) @ amplitude @ _weights(np.asarray(t, float), columns).T


# --- the sound -------------------------------------------------------------------------


def frame() -> so.GaborFrame:
    return so.GaborFrame(WINDOW_S, WINDOW_S / 4)


def steps(state: Mapping[str, Any]) -> Iterator[float]:
    """``synthesize`` one step at a time: yields the fraction done after the
    source and after the resynthesis, and returns ``(sound, the source's
    STFT, the result's STFT)``, both with the mask's window and on one
    scale (the result's before it is normalized to RMS 1)."""
    check(state)
    original = edit.source(state, silent="there is nothing to filter")
    yield 1 / 3
    analysis = frame().analyze(original)
    duration, fs = float(state["duration"]), float(state["fs"])
    span = float(state.get("span", duration))
    gain = gains(cuts(state), analysis.f, analysis.t, span, fs)
    if span < duration:  # the erasures kept their seconds; what came after them is not erased
        gain[:, np.asarray(analysis.t) >= span] = 1.0
    out = (analysis * gain).to_sound()
    sound = so.Sound(out.data[: original.n_samples], original.fs)
    yield 2 / 3
    # the result's STFT before it is normalized, so it is on the source's scale
    return (sound.normalize() if sound.rms > 0 else sound), analysis, frame().analyze(sound)


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    work = steps(state)
    while True:
        try:
            next(work)
        except StopIteration as done:
            return done.value[0]


def pictures(source: so.STFT, result: so.STFT, max_frames: int = 1200) -> tuple[dict[str, Any], dict[str, Any]]:
    """The source's and the result's spectrograms (the mask's own STFT, so a
    cut shows as it was made) as 8-bit levels, rows from 0 Hz to Nyquist, 0
    at ``PICTURE_FLOOR_DB`` below the loudest of the two and 255 at it:
    both on one scale, so what was taken out is darker in the result."""
    def magnitude(stft):
        m = np.abs(stft.data[0])
        step = max(1, math.ceil(m.shape[1] / max_frames))
        return m[:, ::step], step

    (a, step), (b, _) = magnitude(source), magnitude(result)
    peak = max(a.max(), b.max(), 1e-12)

    def picture(m, stft):
        level = 20 * np.log10(np.maximum(m, 1e-12) / peak)
        scaled = np.round(255 * (1 - np.clip(level, PICTURE_FLOOR_DB, 0) / PICTURE_FLOOR_DB))
        return {
            "data": np.ascontiguousarray(scaled, dtype=np.uint8).tobytes(),
            "n_freqs": int(m.shape[0]),
            "n_frames": int(m.shape[1]),
            "f_max": float(stft.f[-1]),
            "t_start": float(stft.t[0]),
            "t_step": float(stft.t[step] - stft.t[0]) if stft.t.size > step else float(stft.t[1] - stft.t[0]),
            "floor_db": PICTURE_FLOOR_DB,
        }

    return picture(a, source), picture(b, result)


# The mask the tab starts from: nothing cut, so the first Play is the source.
BLANK_LEVELS = encode(np.zeros((ROWS, COLUMNS)))
