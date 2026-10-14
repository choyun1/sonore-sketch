"""The Scatter events tab's state, the sound it describes, and its sparsity.

One short event is copied at random times by ``so.event_train``, at a drawn
rate, with sliders for how regular the timing is and how much each copy's
level and pitch vary (docs/design/tabs/events.md)::

    {"events": 1, "sonore": "0.7.0", "duration": 3.0, "fs": 16000,
     "event": "chirp", "length": 0.03, "f_low": 2000, "f_high": 6000,
     "frequency": 1000, "decay": 0.008, "cutoff": 2000,
     "rate": 10 or [times, events per second],
     "regularity": 1, "level_sd": 0, "pitch_sd": 0, "seed": 0}

``event`` is one of ``chirp`` (``f_low`` to ``f_high``), ``pip`` (a tone
at ``frequency``) and ``noise``, each ``length`` seconds under a Hann
window, or ``impact``: a noise burst dying away with time constant
``decay``, through a causal lowpass at ``cutoff`` (E2). The knobs of the
other events are kept, so switching back finds them as they were.

``rate`` is the rate itself, in events per second at each moment of the
page's time (E3); the intervals are gamma-distributed with mean 1 s and
shape ``regularity`` (1 is Poisson timing, 64 nearly regular), and the rate
is ``event_train``'s ``rate_scale``. Levels and pitch shifts are drawn from
normal distributions with standard deviations ``level_sd`` (dB) and
``pitch_sd`` (cents). ``seed`` draws the train; the impact's noise always
uses seed 0, so a new draw moves the events, not their shape.

The plots under the sound (E7) read one statistic of sonore's texture
model, the envelope variance over the squared mean of each band
(``TextureStats.env_var``), here called sparsity. It is a one-way view: it
keeps how peaky each band's envelope is and drops the events' timing.
"""

from __future__ import annotations

import functools
from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so
from scipy import stats
from sonore.texture import TextureStats

from .shared import number

FORMAT = 1
MAX_DURATION = 10.0  # seconds, the whole app's limit (docs/design/app.md, D10)
EVENTS = ("chirp", "pip", "noise", "impact")
RATE_RANGE = (1.0, 1000.0)  # events per second, the rate track's axis (E3)
REGULARITY_RANGE = (1.0, 64.0)  # the gamma shape (E4)
LEVEL_SD_MAX = 12.0  # dB (E4)
PITCH_SD_MAX = 300.0  # cents (E4)
LENGTH_RANGE = (0.01, 0.1)  # s, the chirp's, tone pip's and noise burst's length (E2)
DECAY_RANGE = (0.002, 0.05)  # s, the impact's time constant (E2)
CUTOFF_RANGE = (300.0, 8000.0)  # Hz, the impact's lowpass (E2)
IMPACT_DECAYS = 8  # the impact lasts this many time constants,
IMPACT_MIN_LENGTH = 0.05  # and at least this long, in seconds
FREQUENCY_RANGE = (50.0, 7500.0)  # Hz, the chirp's and tone pip's, under the page's 8 kHz
MAX_BREAKPOINTS = 2000

# The sparsity-against-rate curve (E7): renders of this length at each rate,
# Poisson timing, nothing spread, seed 0; made once per event and kept.
CURVE_RATES = (1, 3, 10, 30, 100, 300, 1000)
CURVE_S = 3.0
# A band is one of the event's own when the event's power in it is within
# this much of its strongest band; the curve and the dot average over those.
EVENT_BANDS_DB = 10.0


DEFAULTS: dict[str, Any] = {
    "event": "chirp", "length": 0.03, "f_low": 2000.0, "f_high": 6000.0, "frequency": 1000.0,
    "decay": 0.008, "cutoff": 2000.0, "rate": 10.0, "regularity": 1.0, "level_sd": 0.0, "pitch_sd": 0.0,
    "seed": 0,
}


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("events") != FORMAT:
        raise ValueError(f"not a Scatter events state of format {FORMAT}: 'events' is {state.get('events')!r}")
    duration = state.get("duration")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    fs = state.get("fs")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    if state.get("event", "chirp") not in EVENTS:
        raise ValueError(f"'event' must be one of {EVENTS}, not {state.get('event')!r}")
    ranges = {
        "length": LENGTH_RANGE, "f_low": FREQUENCY_RANGE, "f_high": FREQUENCY_RANGE,
        "frequency": FREQUENCY_RANGE, "decay": DECAY_RANGE, "cutoff": CUTOFF_RANGE,
        "regularity": REGULARITY_RANGE, "level_sd": (0.0, LEVEL_SD_MAX), "pitch_sd": (0.0, PITCH_SD_MAX),
    }
    for name, (low, high) in ranges.items():
        value = state.get(name, DEFAULTS[name])
        if not number(value) or not low <= value <= high:
            raise ValueError(f"'{name}' must be a number from {low:g} to {high:g}, not {value!r}")
    if not isinstance(state.get("seed", 0), int) or isinstance(state.get("seed", 0), bool):
        raise ValueError(f"'seed' must be a whole number, not {state.get('seed')!r}")
    rate = state.get("rate", DEFAULTS["rate"])
    if number(rate):
        values = [rate]
    else:
        valid = (
            isinstance(rate, list) and len(rate) == 2 and all(isinstance(part, list) for part in rate)
            and 0 < len(rate[0]) == len(rate[1]) <= MAX_BREAKPOINTS
            and all(number(value) for part in rate for value in part)
        )
        if not valid:
            raise ValueError("'rate' must be a number of events per second or [times, events per second]")
        if any(later <= earlier for earlier, later in zip(rate[0], rate[0][1:])):
            raise ValueError("the rate track's times must increase")
        values = rate[1]
    if not all(RATE_RANGE[0] <= value <= RATE_RANGE[1] for value in values):
        raise ValueError(f"the rate must stay from {RATE_RANGE[0]:g} to {RATE_RANGE[1]:g} events per second")


def _knobs(state: Mapping[str, Any]) -> tuple:
    """The event's own settings, with the sampling rate: what the event, and
    so its sparsity curve, depends on."""
    kind = state.get("event", DEFAULTS["event"])
    names = {"chirp": ("length", "f_low", "f_high"), "pip": ("length", "frequency"), "noise": ("length",),
             "impact": ("decay", "cutoff")}[kind]
    return (kind, float(state["fs"]), *(float(state.get(name, DEFAULTS[name])) for name in names))


@functools.lru_cache(maxsize=8)
def _event(knobs: tuple) -> so.Sound:
    kind, fs, *values = knobs
    if kind == "impact":
        decay, cutoff = values
        length = max(IMPACT_MIN_LENGTH, IMPACT_DECAYS * decay)
        t = np.arange(round(length * fs)) / fs
        burst = so.gaussian_noise(length, fs, rng=0) * np.exp(-t / decay)[:, None]
        return so.butter_filter(burst, min(cutoff, 0.45 * fs), btype="lowpass", zero_phase=False)
    length = values[0]
    match kind:
        case "chirp":
            sound = so.exponential_chirp(length, fs, values[1], values[2])
        case "pip":
            sound = so.pure_tone(length, fs, values[1])
        case _:
            sound = so.gaussian_noise(length, fs, rng=0)
    return sound * np.hanning(sound.n_samples)[:, None]


def event(state: Mapping[str, Any]) -> so.Sound:
    """The one event ``state`` copies, at the page's rate, as sonore makes it."""
    return _event(_knobs(state))


def rate_track(state: Mapping[str, Any]) -> float | tuple[np.ndarray, np.ndarray]:
    """The rate in events per second: a number, or ``(times, values)``."""
    rate = state.get("rate", DEFAULTS["rate"])
    if number(rate):
        return float(rate)
    return np.asarray(rate[0], dtype=float), np.asarray(rate[1], dtype=float)


def train(one: so.Sound, duration: float, rate: Any, *, regularity: float = 1.0, level_sd: float = 0.0,
          pitch_sd: float = 0.0, seed: int = 0) -> so.Sound:
    """``one`` copied by ``so.event_train`` at ``rate`` events per second (E3, E4)."""
    return so.event_train(
        one,
        duration,
        stats.gamma(regularity, scale=1 / regularity),  # mean 1 s; the rate track sets the rate
        rate_scale=rate,
        level_db=stats.norm(0, level_sd) if level_sd else 0.0,
        pitch_cents=stats.norm(0, pitch_sd) if pitch_sd else 0.0,
        lead=one.duration,
        rng=seed,
    )


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes, brought to RMS 1 (its power grows with
    the rate) unless no event falls in it."""
    check(state)
    sound = train(
        event(state), float(state["duration"]), rate_track(state),
        regularity=float(state.get("regularity", DEFAULTS["regularity"])),
        level_sd=float(state.get("level_sd", 0.0)), pitch_sd=float(state.get("pitch_sd", 0.0)),
        seed=int(state.get("seed", 0)),
    )
    return sound.normalize() if sound.rms > 0 else sound


# --- sparsity (E7) ---------------------------------------------------------------------


def band_sparsity(sound: so.Sound) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The texture model's bands under the sound's Nyquist frequency: their
    center frequencies, each band's envelope variance over its squared mean
    (``TextureStats.env_var``), and each band's power (``subband_var``)."""
    measured = TextureStats.measure(sound)
    cfs = measured.model.filterbank.cfs
    inside = (cfs < 0.45 * sound.fs) & (np.arange(cfs.size) > 0) & (np.arange(cfs.size) < cfs.size - 1)
    return cfs[inside], measured.env_var[inside], measured.subband_var[inside]


@functools.lru_cache(maxsize=4)
def _reference(knobs: tuple) -> dict[str, Any]:
    """What the plots compare a sound with, for one event: Gaussian noise
    with the event's spectrum (the limit as the rate grows, as on sonore's
    Sound textures page), which bands are the event's own, and the curve of
    sparsity against rate."""
    one = _event(knobs)
    fs = one.fs
    noise = so.gaussian_noise(CURVE_S, fs, rng=0).convolve(one)[:CURVE_S]
    cfs, noise_sparsity, power = band_sparsity(noise)
    own = power >= power.max() * 10 ** (-EVENT_BANDS_DB / 10)
    curve = [float(band_sparsity(train(one, CURVE_S, float(rate)))[1][own].mean()) for rate in CURVE_RATES]
    return {"cfs": cfs, "noise": noise_sparsity, "own": own, "curve": curve,
            "noise_mean": float(noise_sparsity[own].mean())}


def sparsity(sound: so.Sound, state: Mapping[str, Any]) -> dict[str, Any]:
    """The tab's plots of ``sound`` (E7), as plain lists for the page: each
    band's sparsity and Gaussian noise's, which bands are the event's own,
    the curve of the mean over those bands against rate, and this sound's
    mean with its rate when the rate track is flat (else ``rate`` is None)."""
    reference = _reference(_knobs(state))
    _, values, _ = band_sparsity(sound) if sound.rms > 0 else (None, np.zeros_like(reference["cfs"]), None)
    rate = rate_track(state)
    if not number(rate) and np.all(rate[1] == rate[1][0]):
        rate = float(rate[1][0])
    return {
        "cfs": reference["cfs"].tolist(),
        "values": values.tolist(),
        "noise": reference["noise"].tolist(),
        "own": reference["own"].tolist(),
        "curve_rates": list(CURVE_RATES),
        "curve": reference["curve"],
        "noise_mean": reference["noise_mean"],
        "mean": float(values[reference["own"]].mean()),
        "rate": rate if number(rate) else None,
    }


def steps(state: Mapping[str, Any]) -> Iterator[float]:
    """Synthesize ``state`` and measure its sparsity, yielding the fraction
    done; the curve against rate (made once per event, then kept) takes
    most of the first request for an event."""
    sound = synthesize(state)
    yield 0.2
    return sound, sparsity(sound, state)
