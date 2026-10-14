"""What more than one tab's module needs: checking a number, running a tab's
steps, and a mask of cuts stored as text.
"""

from __future__ import annotations

import base64
import binascii
import math
import zlib
from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np


def number(value: Any) -> bool:
    """Whether ``value`` is a finite number (and not a bool)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# --- a tab's steps ---------------------------------------------------------------------


# A tab's steps yield ``(fraction done, what it does next)``, such as
# ``(0.4, "Iteration 2 of 5")``; the page shows both while it waits.
Step = tuple[float, str]


def scaled(steps: Iterator[Step], factor: float) -> Iterator[Step]:
    """Run ``steps`` (a tab's ``steps``, or ``page.handle_steps``) through,
    yielding each fraction done times ``factor`` with its text, and return
    what it returns."""
    while True:
        try:
            fraction, text = next(steps)
        except StopIteration as done:
            return done.value
        yield factor * fraction, text


def iteration_text(done: int, iterations: int) -> str:
    """What comes after ``done`` of ``iterations``: the next one, or measuring the result."""
    return f"Iteration {done + 1} of {iterations}" if done < iterations else "Measuring the result"


def finish(steps: Iterator[Step]) -> Any:
    """Run ``steps`` through and return what it returns."""
    while True:
        try:
            next(steps)
        except StopIteration as done:
            return done.value


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
