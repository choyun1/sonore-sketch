"""The Quilt a sound tab's state, and the sound it describes.

Cut a sound into short segments and put them back in a new order, each
next to one whose start continues the last one's end as the sound itself
went on, joined with cross-fades: a sound quilt (Overath et al., 2015)::

    {"quilt": 1, "sonore": "0.7.0", "duration": 2.0, "fs": 16000,
     "source": "syllables", "segment": 0.06, "seed": 1,
     "speech": {"mode": "klatt", "params": {...}},          # with source "speech"
     "recording": {"name": "...", "fs": 16000, "pcm16": "<base64>"}}  # with source "file"

The source is the Erase tabs' (``sources.source``): a Klatt syllable train,
the Draw speech tab's sound, or the page's recording, at the page's
duration. The quilt is ``sonore.quilt`` of it, with sonore's defaults for
everything but the segment length and the seed: it uses each segment at
most once, so it is made of as many of the source's whole segments as it
can order, and the rest of the page's duration, less than two segments,
is silent.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so

from . import shared, sources
from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
SOURCES = sources.SOURCES  # the Erase tabs'
SEGMENT_RANGE = (0.03, 0.96)  # s: the paper's shortest and longest segments
MIN_SEGMENTS = 3  # two whole segments can only come back in their own order


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("quilt") != FORMAT:
        raise ValueError(f"not a Quilt a sound state of format {FORMAT}: 'quilt' is {state.get('quilt')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    if state.get("source") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    segment = state.get("segment")
    low, high = SEGMENT_RANGE
    if not number(segment) or not low <= segment <= high:
        raise ValueError(f"'segment' must be a number of seconds from {low:g} to {high:g}, not {segment!r}")
    seed = state.get("seed")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0):
        raise ValueError(f"'seed' must be a whole number from 0 up, not {seed!r}")


def quilt(sound: so.Sound, segment: float, seed: int) -> tuple[so.Sound, int]:
    """The longest quilt of ``sound``'s whole segments that sonore can order,
    and how many segments it has. Each segment is used at most once and the
    sound's own next segment never follows, so a quilt of every segment
    sometimes runs out of choices near its end; then it has one fewer."""
    n_segment = int(round(segment * sound.fs))
    available = len(sound) // n_segment
    if available < MIN_SEGMENTS:
        raise ValueError(
            f"a {sound.duration:g} s sound holds {available} whole segments of {1000 * segment:g} ms, "
            f"and a quilt needs at least {MIN_SEGMENTS}: shorten the segments or lengthen the duration"
        )
    for count in range(available, 1, -1):
        try:
            return so.quilt(sound, n_segment / sound.fs, count * n_segment / sound.fs, rng=seed), count
        except ValueError as error:
            if "ran out" not in str(error):
                raise
    raise ValueError("sonore could not order the segments")  # two segments can always be ordered, so not reached


def steps(state: Mapping[str, Any]) -> Iterator[shared.Step]:
    """``synthesize`` one step at a time: yields the fraction done (with what
    comes next, ``shared.Step``) at the start and after the source, and
    returns ``(sound, the source, the number of segments in the quilt)``. The
    quilt is padded with silence to the page's duration."""
    check(state)
    yield 0.0, "Making the source"
    original = sources.source(state, silent="there is nothing to quilt")
    yield 1 / 3, "Quilting"
    made, count = quilt(original, float(state["segment"]), int(state["seed"]))
    samples = np.zeros(original.n_samples)
    samples[: made.n_samples] = made.data[: original.n_samples, 0]
    sound = so.Sound(samples, original.fs)
    if not sound.rms > 0:  # what the source held was cut away: in its leftover tail, or a single sample at a segment's very start
        raise ValueError("the quilt came out silent: the source's sound is too short or too sparse for its segments to carry it")
    return (sound.normalize() if sound.rms > 0 else sound), original, count


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    return shared.finish(steps(state))[0]
