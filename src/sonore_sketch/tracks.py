"""The Tracks tab's document, and the sound it describes.

A document is plain data (docs/design/tabs/tracks.md, D5)::

    {"trackdraw": 1, "sonore": "0.6.0", "duration": 0.8, "fs": 16000,
     "mode": "klatt", "params": {"F1": [[0, 0.2, 0.8], [300, 650, 350]],
                                 "B1": 60, ...}}

Each parameter is a number or ``[times, values]``, which is exactly what
``so.klatt_synthesize`` takes, so a document drawn in the page gives the same
samples here as in the browser. Parameters left out take sonore's defaults.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

import numpy as np
import sonore as so

FORMAT = 1
MAX_DURATION = 10.0  # seconds, the whole app's limit (docs/design/app.md, D10)
MODES = ("klatt",)  # sine-wave speech comes later (tracks.md, D6)
F0_FLOOR = 20.0  # Hz: lower, the voicing turns into clicks (Cho, 2026-10-05); the page draws no lower


def check(document: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``document``, if anything."""
    if document.get("trackdraw") != FORMAT:
        raise ValueError(f"not a TrackDraw document of format {FORMAT}: 'trackdraw' is {document.get('trackdraw')!r}")
    duration = document.get("duration")
    if not isinstance(duration, (int, float)) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    fs = document.get("fs")
    if not isinstance(fs, (int, float)) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    mode = document.get("mode", "klatt")
    if mode not in MODES:
        raise ValueError(f"'mode' must be one of {MODES}, not {mode!r}")
    params = document.get("params", {})
    if not isinstance(params, Mapping):
        raise ValueError("'params' must map Klatt parameter names to numbers or [times, values]")
    for name, value in params.items():
        if name not in so.KLATT_DEFAULTS:
            raise ValueError(f"unknown Klatt parameter {name!r}")
        if isinstance(value, (int, float)):
            if not math.isfinite(value):
                raise ValueError(f"{name} must be finite")
            continue
        if not (isinstance(value, (list, tuple)) and len(value) == 2):
            raise ValueError(f"{name} must be a number or [times, values]")
        times, values = (np.asarray(part, dtype=float) for part in value)
        if times.ndim != 1 or times.shape != values.shape or times.size == 0:
            raise ValueError(f"{name}: times and values must be two lists of the same, non-zero length")
        if not (np.all(np.isfinite(times)) and np.all(np.isfinite(values))):
            raise ValueError(f"{name}: times and values must be finite")
        if np.any(np.diff(times) <= 0):
            raise ValueError(f"{name}: times must increase (two breakpoints share a time, or are out of order)")


def klatt_params(document: Mapping[str, Any]) -> dict[str, Any]:
    """The ``params`` mapping to give ``so.klatt_synthesize`` for ``document``,
    with F0 raised to ``F0_FLOOR`` wherever it is below it."""
    check(document)
    params: dict[str, Any] = {}
    for name, value in document.get("params", {}).items():
        if isinstance(value, (int, float)):
            params[name] = float(value)
        else:
            times, values = value
            params[name] = (np.asarray(times, dtype=float), np.asarray(values, dtype=float))
    if "F0" in params:
        f0 = params["F0"]
        params["F0"] = max(f0, F0_FLOOR) if isinstance(f0, float) else (f0[0], np.maximum(f0[1], F0_FLOOR))
    return params


def synthesize(document: Mapping[str, Any]) -> so.Sound:
    """The sound ``document`` describes: one call of ``so.klatt_synthesize``.

    The noise sources (AH, AF, AB) use ``document["seed"]`` (default 0), so a
    document always gives the same samples.
    """
    params = klatt_params(document)
    return so.klatt_synthesize(
        float(document["duration"]), float(document["fs"]), params, rng=int(document.get("seed", 0))
    )
