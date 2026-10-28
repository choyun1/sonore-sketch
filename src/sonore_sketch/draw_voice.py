"""The Draw a voice tab's state, and the sound it describes.

A voice drawn as its source and its filter, separately, and put together by
``so.source_filter_synthesize`` (docs/design/tabs/draw_voice.md)::

    {"draw_voice": 1, "sonore": "0.8.0", "duration": 2.0, "fs": 16000,
     "f0": [[0, 0.9, 1.2, 2.0], [130, 115, 125, 95]],
     "breathiness": [[0, 2.0], [0.001, 0.001]],
     "filter": {"f": [50.0, ..., 8000.0], "moments": [0.2, 1.0, 1.8],
                "db": [[0.0, ..., -60.0], ...]},
     "seed": 1}

The source (S4) is the pitch, ``f0`` in Hz with 0 where it is unvoiced, and
the breathiness, the share of the power that is noise (0 to 1), the same at
every frequency. Both are ``[times, values]`` tracks, linear between
breakpoints, held before the first and after the last; between two
breakpoints at 0 the voice is unvoiced, and between a voiced one and one at
0 the voiced one's pitch is held (:func:`pitch`), so it never glides down to 0. The filter (S2, S3) is a curve of level in dB (``DB_RANGE``) at
each of its moments, at the frequencies ``f`` (saved, S11; the page draws
``N_POINTS`` of them equally spaced on the ERB scale), which sonore reads
linearly in time between moments and in dB between points.
"""

from __future__ import annotations

from collections.abc import Mapping
from itertools import pairwise
from typing import Any

import numpy as np
import sonore as so
from sonore.views.aperiodicity import Aperiodicity

from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
F0_RANGE = (50.0, 500.0)  # Hz, the pitch line's axis (S4); 0 is unvoiced
DB_RANGE = (-60.0, 0.0)  # the filter's axis (S3)
N_POINTS = 48  # points per curve, as the page draws them (S3, V3)
F_RANGE = (50.0, 8000.0)  # Hz, the page's points from the first to the last
HOP = 0.005  # s, the synthesis grid (sonore's)
MAX_BREAKPOINTS = 2000
MAX_MOMENTS = 32


def erb_number(f: Any) -> np.ndarray:
    """Glasberg & Moore's ERB-number of ``f`` Hz."""
    return 21.4 * np.log10(1 + 0.00437 * np.asarray(f, dtype=float))


def erb_frequency(e: Any) -> np.ndarray:
    """The frequency in Hz of ERB-number ``e``."""
    return (10 ** (np.asarray(e, dtype=float) / 21.4) - 1) / 0.00437


def points() -> np.ndarray:
    """The page's ``N_POINTS`` frequencies, rounded as it saves them (app/draw_voice/model.js)."""
    return np.round(erb_frequency(np.linspace(erb_number(F_RANGE[0]), erb_number(F_RANGE[1]), N_POINTS)), 1)


def _track(state: Mapping[str, Any], name: str, low: float, high: float, zero: bool = False) -> None:
    value = state.get(name)
    if not (isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(part, (list, tuple)) for part in value)):
        raise ValueError(f"{name!r} must be [times, values]")
    times, values = value
    if not 0 < len(times) == len(values) <= MAX_BREAKPOINTS or not all(map(number, [*times, *values])):
        raise ValueError(f"{name!r} must be two lists of the same length, 1 to {MAX_BREAKPOINTS} numbers")
    if any(b <= a for a, b in pairwise(times)):
        raise ValueError(f"{name!r}: times must increase")
    if not all(low <= v <= high or (zero and v == 0) for v in values):
        raise ValueError(f"{name!r} must stay from {low:g} to {high:g}{' (or 0, unvoiced)' if zero else ''}")


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("draw_voice") != FORMAT:
        raise ValueError(f"not a Draw a voice state of format {FORMAT}: 'draw_voice' is {state.get('draw_voice')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    _track(state, "f0", *F0_RANGE, zero=True)
    _track(state, "breathiness", 0.0, 1.0)
    curves = state.get("filter")
    if not isinstance(curves, Mapping):
        raise ValueError("'filter' must hold 'f', 'moments' and 'db'")
    f, moments, db = curves.get("f"), curves.get("moments"), curves.get("db")
    if not (isinstance(f, (list, tuple)) and 2 <= len(f) <= 512 and all(map(number, f)) and f[0] > 0 and all(a < b for a, b in pairwise(f))):
        raise ValueError("the filter's 'f' must be 2 to 512 increasing frequencies above 0 Hz")
    if not (isinstance(moments, (list, tuple)) and 1 <= len(moments) <= MAX_MOMENTS and all(map(number, moments))):
        raise ValueError(f"the filter's 'moments' must be 1 to {MAX_MOMENTS} times")
    if any(b <= a for a, b in pairwise(moments)):
        raise ValueError("the filter's moments must increase")
    if not (isinstance(db, (list, tuple)) and len(db) == len(moments)):
        raise ValueError("the filter needs one curve in 'db' per moment")
    low, high = DB_RANGE
    for curve in db:
        if not (isinstance(curve, (list, tuple)) and len(curve) == len(f) and all(number(v) and low <= v <= high for v in curve)):
            raise ValueError(f"each of the filter's curves must be {len(f)} levels from {low:g} to {high:g} dB")
    seed = state.get("seed")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0):
        raise ValueError(f"'seed' must be a whole number from 0 up, not {seed!r}")


def pitch(state: Mapping[str, Any], times: np.ndarray) -> np.ndarray:
    """The pitch at ``times``: the drawn line, 0 wherever it is unvoiced. A
    stretch between a voiced breakpoint and one at 0 holds the voiced one's
    pitch up to the other, so the pitch never glides down to 0."""
    t, f0 = (np.asarray(part, dtype=float) for part in state["f0"])
    after = np.searchsorted(t, times, side="right")
    before, after = f0[np.clip(after - 1, 0, len(t) - 1)], f0[np.clip(after, 0, len(t) - 1)]
    return np.where(before == 0, after, np.where(after == 0, before, np.interp(times, t, f0)))


def parts(state: Mapping[str, Any]) -> tuple[tuple[np.ndarray, np.ndarray], so.SpectralEnvelope, Aperiodicity]:
    """What ``so.source_filter_synthesize`` takes for ``state``: the pitch on
    the 5 ms grid, the filter as an envelope made by hand, and the
    breathiness as an aperiodicity made by hand, all noise where unvoiced."""
    check(state)
    duration, fs = float(state["duration"]), float(state["fs"])
    times = np.arange(0.0, duration + HOP / 2, HOP)
    f0 = pitch(state, times)
    curves = state["filter"]
    moments = np.asarray(curves["moments"], dtype=float)
    power = 10 ** (np.asarray(curves["db"], dtype=float).T / 10)  # (points, moments)
    if len(moments) == 1:  # held either side, as between two moments with the same curve
        moments, power = np.array([moments[0], moments[0] + 1.0]), np.repeat(power, 2, axis=1)
    envelope = so.SpectralEnvelope(power[None], moments, np.asarray(curves["f"], dtype=float), fs=fs)
    n_fft = int(2 ** np.ceil(np.log2(fs * 0.064)))  # 1024 at 16 kHz (V1)
    t, share = (np.asarray(part, dtype=float) for part in state["breathiness"])
    shares = np.where(f0 > 0, np.clip(np.interp(times, t, share), 0, 1), 1.0)
    ratio = np.repeat(np.sqrt(shares)[None, None, :], n_fft // 2 + 1, axis=1)
    return (times, f0), envelope, Aperiodicity(ratio, times, fs, "drawn")


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The voice ``state`` describes, at RMS 1 (silent if it has no power)."""
    f0, envelope, aperiodicity = parts(state)
    sound = so.source_filter_synthesize(f0, envelope, aperiodicity, duration=float(state["duration"]), rng=int(state["seed"]))
    return sound.normalize() if sound.rms > 0 else sound
