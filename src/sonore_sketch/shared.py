"""What more than one tab's module needs: checking a number, running a tab's
steps, one of ``to_sound``'s iterations, and a mask of cuts stored as text.
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


def number(value: Any) -> bool:
    """Whether ``value`` is a finite number (and not a bool)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# --- a tab's steps ---------------------------------------------------------------------


def scaled(steps: Iterator[float], factor: float) -> Iterator[float]:
    """Run ``steps`` (a tab's ``steps``, or ``page.handle_steps``) through,
    yielding each fraction done times ``factor``, and return what it returns."""
    while True:
        try:
            fraction = next(steps)
        except StopIteration as done:
            return done.value
        yield factor * fraction


def finish(steps: Iterator[float]) -> Any:
    """Run ``steps`` through and return what it returns."""
    while True:
        try:
            next(steps)
        except StopIteration as done:
            return done.value


# --- to_sound's iterations ---------------------------------------------------------------


def toward(sound: so.Sound, target: so.ModulationSpectrum) -> so.Sound:
    """One of ``to_sound``'s own iterations (sonore, ``iterations``): keep the
    sound's fine structure and modulation phase, impose the target's
    magnitudes again. The tabs take them here one at a time so the page can
    show its progress; the result is the same as ``to_sound(iterations=n)``.

    It reads sonore's private analysis, rebuild and modulation phase (0.5 and
    0.6), which ``to_sound`` uses for its own iterations; they go once sonore
    makes them public."""
    subbands = target._analysis.filterbank.analyze(sound)
    envelopes = target._rebuild(target._modulation_phase(subbands), quiet=True)
    out = (envelopes * subbands.tfs()).to_sound()
    return so.Sound(out.data[: sound.n_samples], sound.fs)


# --- a mask of cuts --------------------------------------------------------------------


def cuts(state: Mapping[str, Any], rows: int, columns: int, floor_db: float) -> np.ndarray:
    """``state``'s mask (its ``levels``) as cuts in dB, shape (rows, columns):
    0 keeps, ``-floor_db`` removes."""
    try:
        # at most one cell too many, so a small text cannot inflate to fill the memory
        raw = zlib.decompressobj().decompress(base64.b64decode(state.get("levels", ""), validate=True), rows * columns + 1)
    except (binascii.Error, zlib.error, TypeError) as error:
        raise ValueError(f"'levels' is not base64 of zlib-deflated bytes ({error})") from None
    if len(raw) != rows * columns:
        raise ValueError(f"'levels' holds {len(raw)} cells, not {rows} rows x {columns} columns")
    return np.minimum(np.frombuffer(raw, dtype=np.uint8).reshape(rows, columns).astype(float), -floor_db)


def encode_cuts(cut_db: np.ndarray, floor_db: float) -> str:
    """``levels`` for a grid of cuts in dB, (rows, columns)."""
    below = np.clip(np.round(np.asarray(cut_db, dtype=float)), 0, -floor_db)
    return base64.b64encode(zlib.compress(below.astype(np.uint8).tobytes(), 9)).decode()
