"""The Draw path tab's state, and the sound it describes.

A path is a stroke drawn on a top view of the listener, and an elevation
track over the same time (docs/design/tabs/paths.md)::

    {"paths": 1, "sonore": "0.8.0", "duration": 3.0, "fs": 16000,
     "source": "noise", "room": "dry",
     "stroke": [[t, x, y], ...], "elevation": 0 or [times, degrees],
     "speed": null or [fractions, speeds], "smoothing": 0.15}

``stroke`` holds the pointer's positions as drawn: ``t`` in seconds from
the start of the stroke, ``x`` to the listener's right and ``y`` ahead, in
meters. The stroke keeps its own timing, stretched to the page's duration
(W6), so how fast you drew each part is how fast the sound moves there. Its
points are first put every 10 ms and smoothed with a 30 ms Gaussian (W3),
which takes out the speed changes the pointer's events add at every screen
frame; ``tools/measure_paths.py`` measured both. A speed track, when
drawn, replaces the drawing's timing: relative speeds at fractions of the
path's length from its start (W7), scaled so the trip takes the duration,
none slower than 1/20 of the fastest (W8). The top view gives each
point its direction around the listener and its distance; the elevation
track lifts it on the sphere of that distance, from -40 to 90 degrees, the
measured range.

The sound is rendered at 32 kHz whatever the page's rate (W5), since the
cues that change most with elevation lie above the 8 kHz the page's 16 kHz
reaches, through the MIT KEMAR HRIRs (W2) with the travel time from their
1.4 m put back (W4). It has two channels, one per ear, for headphones.
"""

from __future__ import annotations

import functools
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
import sonore as so
from scipy.ndimage import gaussian_filter1d

from . import sources
from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
FS = 32000  # the tab's own rate (W5)
SOURCES = ("noise", "syllables", "speech", "file")
ROOMS = ("dry", "room")
ROOM_RT60 = 0.6  # s, a living room's (an estimate, as in sonore's moving-sound gallery)
HALF_WIDTH = 4.0  # m: the top view spans -4..4 m on both axes
MIN_DISTANCE = 0.25  # m from the head's center; a path is kept at least this far out
ELEVATION_RANGE = (-40.0, 90.0)  # degrees, the measured range
MAX_POINTS = 20000  # a stroke of 30 s at 120 events a second is 3600
SLOWEST = 1 / 20  # of the speed track's fastest (W8)
STEP = 0.01  # s, the spacing the stroke is put on before smoothing (W3)
SMOOTHING = 0.03  # s, the Gaussian's standard deviation (W3)
SHAPE_SMOOTHING = 0.15  # m, the default width of a second Gaussian along the path, for the hand's wobble
MAX_SHAPE_SMOOTHING = 0.5  # m, the widest the page offers
SHAPE_STEP = 0.01  # m, the spacing the path is put on for it
HRIR_FILE = Path(__file__).resolve().parent / "data" / "mit_kemar.npz"


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("paths") != FORMAT:
        raise ValueError(f"not a Draw path state of format {FORMAT}: 'paths' is {state.get('paths')!r}")
    duration = state.get("duration")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if state.get("source", "noise") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    if state.get("room", "dry") not in ROOMS:
        raise ValueError(f"'room' must be one of {ROOMS}, not {state.get('room')!r}")
    stroke = state.get("stroke", [])
    if not isinstance(stroke, list) or len(stroke) > MAX_POINTS:
        raise ValueError(f"'stroke' must be a list of at most {MAX_POINTS} [t, x, y] points")
    for point in stroke:
        if not (isinstance(point, list) and len(point) == 3 and all(number(value) for value in point)):
            raise ValueError(f"each point of 'stroke' must be [t, x, y], numbers, not {point!r}")
    if any(later[0] < earlier[0] for earlier, later in zip(stroke, stroke[1:])):
        raise ValueError("the stroke's times must not go back")
    shape = state.get("smoothing", SHAPE_SMOOTHING)
    if not number(shape) or not 0 <= shape <= MAX_SHAPE_SMOOTHING:
        raise ValueError(f"'smoothing' must be a width in meters from 0 to {MAX_SHAPE_SMOOTHING:g}, not {shape!r}")
    speed = state.get("speed")
    if speed is not None:
        valid = (
            isinstance(speed, list) and len(speed) == 2 and all(isinstance(part, list) for part in speed)
            and len(speed[0]) == len(speed[1]) > 0 and all(number(value) for part in speed for value in part)
            and all(0 <= fraction <= 1 for fraction in speed[0]) and all(value > 0 for value in speed[1])
        )
        if not valid:
            raise ValueError("'speed' must be null or [fractions, speeds]: fractions of the path from 0 to 1, speeds above 0")
    elevation = state.get("elevation", 0)
    if number(elevation):
        return
    valid = (
        isinstance(elevation, list) and len(elevation) == 2 and all(isinstance(part, list) for part in elevation)
        and len(elevation[0]) == len(elevation[1]) > 0 and all(number(value) for part in elevation for value in part)
    )
    if not valid:
        raise ValueError("'elevation' must be a number of degrees or [times, degrees]")


def smoothed(stroke: list[list[float]], shape: float = SHAPE_SMOOTHING) -> tuple[np.ndarray, np.ndarray]:
    """The stroke put every ``STEP`` seconds and smoothed with a Gaussian of
    ``SMOOTHING`` seconds (W3), which takes out the pointer's steps, then its
    shape smoothed along the path with a Gaussian ``shape`` meters wide
    (``SHAPE_SMOOTHING`` unless the state says), which takes out the hand's wobble and leaves each point's time:
    its times from 0 and its (x, y) points."""
    drawn = np.asarray(stroke, dtype=float)
    times = drawn[:, 0] - drawn[0, 0]
    if times[-1] <= 0:
        return np.array([0.0]), drawn[-1:, 1:]
    # where the pointer reported two positions at one time, the later one stands
    keep = np.append(np.diff(times) > 0, True)
    times, points = times[keep], drawn[keep, 1:]
    grid = np.arange(0.0, times[-1] + STEP / 2, STEP)
    resampled = np.column_stack([np.interp(grid, times, points[:, k]) for k in range(2)])
    return grid, smooth_shape(gaussian_filter1d(resampled, SMOOTHING / STEP, axis=0, mode="nearest"), shape)


def smooth_shape(points: np.ndarray, width: float) -> np.ndarray:
    """``points`` moved to a Gaussian average of the path around them,
    ``width`` meters wide along it, each at the same distance along the
    path as before."""
    along = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(points, axis=0).T))])
    if not (along[-1] > 0 and width > 0):
        return points
    # evenly spaced from end to end, at most SHAPE_STEP apart
    grid = np.linspace(0.0, along[-1], int(np.ceil(along[-1] / SHAPE_STEP)) + 1)
    spacing = grid[1] - grid[0]
    even = np.column_stack([np.interp(grid, along, points[:, k]) for k in range(2)])
    # mirrored through each end point, so a straight end stays where it was drawn
    pad = min(len(even) - 1, int(4 * width / spacing + 0.5))
    padded = np.concatenate([2 * even[0] - even[pad:0:-1], even, 2 * even[-1] - even[-2 : -2 - pad : -1]])
    shape = gaussian_filter1d(padded, width / spacing, axis=0, mode="nearest")[pad : pad + len(even)]
    return np.column_stack([np.interp(along, grid, shape[:, k]) for k in range(2)])


def speed_times(state: Mapping[str, Any], points: np.ndarray) -> np.ndarray | None:
    """Times from 0 to 1 at which the path passes ``points`` (the smoothed
    stroke) under the speed track, or None when there is no track or no
    distance to cover. Speeds are interpolated on a log scale, as the track
    shows them, and kept at least ``SLOWEST`` of the fastest (W8)."""
    speed = state.get("speed")
    steps = np.hypot(*np.diff(points, axis=0).T)
    if speed is None or not steps.sum() > 0:
        return None
    along = np.concatenate([[0.0], np.cumsum(steps)]) / steps.sum()
    fractions, speeds = np.asarray(speed[0], dtype=float), np.log2(np.asarray(speed[1], dtype=float))
    order = np.argsort(fractions, kind="stable")
    middles = (along[:-1] + along[1:]) / 2
    relative = 2 ** np.interp(middles, fractions[order], speeds[order])
    relative = np.maximum(relative, SLOWEST * 2 ** speeds.max())
    times = np.concatenate([[0.0], np.cumsum(steps / relative)])
    return times / times[-1]


def elevation_at(state: Mapping[str, Any], times: np.ndarray) -> np.ndarray:
    """The elevation track at ``times`` (page time), linear between
    breakpoints and held beyond them, kept within the measured range."""
    elevation = state.get("elevation", 0)
    if number(elevation):
        values = np.full(len(times), float(elevation))
    else:
        values = np.interp(times, np.asarray(elevation[0], dtype=float), np.asarray(elevation[1], dtype=float))
    return np.clip(values, *ELEVATION_RANGE)


def trajectory(state: Mapping[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """``(times, points)`` for ``so.move_sound``: the smoothed stroke stretched
    to the page's duration, each point at its drawn direction and distance
    (at least ``MIN_DISTANCE``), lifted to the elevation track's angle;
    Cartesian, meters, x right, y ahead, z up."""
    duration = float(state["duration"])
    stroke_times, flat = smoothed(state["stroke"], float(state.get("smoothing", SHAPE_SMOOTHING)))
    along = speed_times(state, flat)
    if along is not None:
        # points the pointer reported at one place take no time; keep the first
        keep = np.append(True, np.diff(along) > 0)
        times, flat = along[keep] * duration, flat[keep]
    elif stroke_times[-1] > 0:
        times = stroke_times / stroke_times[-1] * duration
    else:
        times = np.array([0.0, duration])
    if len(flat) < len(times):
        flat = np.repeat(flat, len(times), axis=0)
    distance = np.maximum(np.hypot(flat[:, 0], flat[:, 1]), MIN_DISTANCE)
    azimuth = np.degrees(np.arctan2(flat[:, 0], flat[:, 1]))
    points = np.column_stack(so.hcc_to_rect(100 * distance, elevation_at(state, times), azimuth))
    return times, points


@functools.cache
def hrirs() -> so.HRIRSet:
    """MIT KEMAR (W2), with the 1.4 m travel time its files leave out put back
    in front of every IR (W4), so paths nearer than 1.4 m render."""
    with np.load(HRIR_FILE) as data:
        irs, positions, fs = data["irs"].astype(float), data["positions"].astype(float), float(data["fs"])
    radius = float(np.median(np.linalg.norm(positions, axis=1)))
    travel = int(round(radius / so.SPEED_OF_SOUND * fs))
    return so.HRIRSet(np.pad(irs, ((0, 0), (0, 0), (travel, 0))), positions, fs)


def source(state: Mapping[str, Any]) -> so.Sound:
    """The sound that moves, at the tab's rate, RMS 1."""
    if state.get("source", "noise") == "noise":
        noise = so.gaussian_noise(float(state["duration"]), FS, rng=int(state.get("seed", 1)))
        return noise / noise.rms
    sound = sources.source({**state, "fs": FS}, silent="there is nothing to move")
    return sound / sound.rms


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes: its source moved along the path by
    ``so.move_sound``, two channels at 32 kHz."""
    check(state)
    if not state.get("stroke"):
        raise ValueError("no path drawn yet: draw one on the top view to hear it")
    room = None
    if state.get("room", "dry") == "room":
        room = so.synth_ir(ROOM_RT60, FS, n_channels=2, rng=int(state.get("seed", 1)))
    try:
        return so.move_sound(source(state), trajectory(state), hrirs(), room=room)
    except ValueError as error:
        if "faster" in str(error):
            raise ValueError("this path moves faster than sound somewhere: draw it more slowly or lengthen the duration") from None
        raise
