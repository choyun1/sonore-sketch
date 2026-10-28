"""The Draw a room tab's state, and the sound it describes.

A room drawn as its RT60 curve, how long it rings at each frequency, and a
sound heard in it: sonore's ``synth_ir`` makes the room's impulse response
from the curve (Traer & McDermott, 2016), and the source is convolved with
it (docs/design/tabs/draw_room.md)::

    {"draw_room": 1, "sonore": "0.9.0", "duration": 2.0, "fs": 16000,
     "source": "syllables", "rt60": [1.05, ..., 0.62], "drr_db": 0.0, "seed": 1,
     "draw_speech": {...}, "recording": {...}, "drawing": {...}}  # the source's own, as on Quilt a sound

``rt60`` holds the curve's RT60s in seconds at the ``N_POINTS`` frequencies
:func:`points` gives, equally spaced on a log axis from 50 Hz to 8 kHz (R3,
R11); sonore reads it at each of its bands, held flat below 50 Hz. The
source is a clap or one of Quilt a sound's (R5). The room has two
independent tails, one per ear, with the same direct sound at ``drr_db``
(R6, R7), from the noise drawn from ``seed`` (R10). The result keeps the
room's tail, so it is longer than the page's duration (R8).
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so

from . import quilt_sound, shared
from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
N_POINTS = 64  # the curve's points (R11)
F_RANGE = (50.0, 8000.0)  # Hz, the first and last points (R3)
RT60_RANGE = (0.1, 10.0)  # s, the curve's axis (R3)
DRR_RANGE = (-20.0, 20.0)  # dB, the direct sound against the room's (R6)
CLAP_AT = 0.05  # s: the clap, one click, comes this long after the start
SOURCES = ("clap", *quilt_sound.SOURCES)  # R5
CHANNELS = 2  # R7


def points() -> np.ndarray:
    """The curve's ``N_POINTS`` frequencies, rounded as the page saves them (app/draw_room/model.js)."""
    return np.round(np.geomspace(*F_RANGE, N_POINTS), 1)


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("draw_room") != FORMAT:
        raise ValueError(f"not a Draw a room state of format {FORMAT}: 'draw_room' is {state.get('draw_room')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    if state.get("source") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    rt60 = state.get("rt60")
    low, high = RT60_RANGE
    if not (isinstance(rt60, (list, tuple)) and len(rt60) == N_POINTS and all(number(v) and low <= v <= high for v in rt60)):
        raise ValueError(f"'rt60' must be {N_POINTS} RT60s from {low:g} to {high:g} s")
    drr = state.get("drr_db")
    low, high = DRR_RANGE
    if not number(drr) or not low <= drr <= high:
        raise ValueError(f"'drr_db' must be a number of dB from {low:g} to {high:g}, not {drr!r}")
    seed = state.get("seed")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0):
        raise ValueError(f"'seed' must be a whole number from 0 up, not {seed!r}")


def source(state: Mapping[str, Any]) -> so.Sound:
    """The sound heard in the room, at the page's duration and rate: a clap
    (one click, ``CLAP_AT`` in) or one of Quilt a sound's sources."""
    if state["source"] != "clap":
        return quilt_sound.source(state, silent="there is nothing to hear in the room")
    duration, fs = float(state["duration"]), float(state["fs"])
    samples = np.zeros(max(1, round(duration * fs)))
    samples[min(round(CLAP_AT * fs), len(samples) - 1)] = 1.0
    return so.Sound(samples, fs)


def room(state: Mapping[str, Any]) -> so.Sound:
    """The room's impulse response: ``so.synth_ir`` from the drawn curve,
    two tails with one direct sound at the drawn ratio."""
    curve = (points(), np.asarray(state["rt60"], dtype=float))
    return so.synth_ir(curve, float(state["fs"]), drr_db=float(state["drr_db"]), n_channels=CHANNELS, rng=int(state["seed"]))


def measured(ir: so.Sound) -> dict[str, list]:
    """The room's RT60 measured back from its tail (R9): ``so.measure_rt60``
    at its band centers (``f``), with ``None`` where a band never decays
    through the fit's range. The direct sound, the unit impulse ``synth_ir``
    puts at the start, is taken out first, as ``measure_rt60`` asks."""
    tail = ir.data.copy()
    tail[0] -= 1.0
    f, rt60 = so.measure_rt60(so.Sound(tail, ir.fs), f_hi=F_RANGE[1])
    return {"f": np.round(f, 1).tolist(), "rt60": [round(float(v), 3) if np.isfinite(v) else None for v in rt60]}


def steps(state: Mapping[str, Any]) -> Iterator[shared.Step]:
    """The sound one step at a time (``shared.Step``): returns ``(sound, the
    room's impulse response)``. The sound is the source in the room, two
    channels at RMS 1, as long as the source and the room's tail together."""
    check(state)
    yield 0.0, "Making the source"
    original = source(state)
    yield 0.3, "Making the room"
    ir = room(state)
    yield 0.7, "Playing the source in the room"
    sound = original.convolve(ir)
    return (sound.normalize() if sound.rms > 0 else sound), ir


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    return shared.finish(steps(state))[0]
