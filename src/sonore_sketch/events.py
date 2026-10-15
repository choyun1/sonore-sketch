"""The Scatter events tab's state, the sound it describes, and its
modulation spectrogram.

One short event is copied at random times by ``so.event_train``, at a drawn
rate, with sliders for how regular the timing is and how much each copy's
level and pitch vary (docs/design/tabs/events.md)::

    {"events": 1, "sonore": "0.7.0", "duration": 3.0, "fs": 16000,
     "event": "chirp", "length": 0.03, "f_low": 2000, "f_high": 6000,
     "tone": "pure", "frequency": 1000, "harmonics": 8,
     "noise_low": 100, "noise_high": 7500, "decay": 0.008, "cutoff": 2000,
     "rate": 10 or [times, events per second],
     "regularity": 1, "level_sd": 0, "pitch_sd": 0, "seed": 0}

``event`` is one of ``chirp`` (``f_low`` to ``f_high``), ``pip`` (a pure
tone at ``frequency``, or with ``tone`` ``"harmonic"`` a harmonic complex
on that F0 with its first ``harmonics`` harmonics) and ``noise`` (noise
from ``noise_low`` to ``noise_high``), each ``length`` seconds under a Hann
window, or ``impact``: a noise burst dying away with time constant
``decay``, through a causal lowpass at ``cutoff`` (E2). The knobs of the
other events are kept, so switching back finds them as they were.

``rate`` is the rate itself, in events per second at each moment of the
page's time (E3); the intervals are gamma-distributed with mean 1 s and
shape ``regularity`` (1 is Poisson timing, 64 nearly regular), and the rate
is ``event_train``'s ``rate_scale``. Levels and pitch shifts are drawn from
normal distributions with standard deviations ``level_sd`` (dB) and
``pitch_sd`` (cents). ``seed`` draws the train; the noise in the noise
burst and the impact always uses seed 0, so a new draw moves the events,
not their shape.

Under the sound, the tab shows its modulation spectrogram
(``so.ModulationSpectrogram``, as on sonore's gallery page of that name),
which is a one-way view: it keeps how deeply each band's envelope is
modulated at each rate over time and drops the fine structure and the
modulation phase.
"""

from __future__ import annotations

import functools
from collections.abc import Callable, Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so
from scipy import stats

from . import shared
from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
EVENTS = ("chirp", "pip", "noise", "impact")
TONES = ("pure", "harmonic")  # the tone pip's
RATE_RANGE = (1.0, 1000.0)  # events per second, the rate track's axis (E3)
REGULARITY_RANGE = (1.0, 64.0)  # the gamma shape (E4)
LEVEL_SD_MAX = 12.0  # dB (E4)
PITCH_SD_MAX = 1200.0  # cents (E4; widened from 300 to 600, then 1200, by Cho, 2026-10-14 and 10-15)
LENGTH_RANGE = (0.01, 0.5)  # s, the chirp's, tone pip's and noise burst's length (E2; up to 0.5 by Cho, 2026-10-15)
DECAY_RANGE = (0.002, 0.05)  # s, the impact's time constant (E2)
CUTOFF_RANGE = (300.0, 8000.0)  # Hz, the impact's lowpass (E2)
IMPACT_DECAYS = 8  # the impact lasts this many time constants,
IMPACT_MIN_LENGTH = 0.05  # and at least this long, in seconds
FREQUENCY_RANGE = (50.0, 7500.0)  # Hz, the chirp's, tone pip's and noise burst's, under the page's 8 kHz
HARMONICS_RANGE = (1, 30)  # the harmonic complex's number of harmonics
MAX_BREAKPOINTS = 2000

# The modulation spectrogram under the sound: 16 cosine bands from 100 Hz,
# envelopes at 1 kHz, every 20 ms, depth shown over its top 30 dB. One window
# for every rate, as in an STFT, so the cells that cannot be measured are the
# same half window at each end at every rate (a window of three cycles of each
# rate leaves nothing below 1 Hz of a 3 s sound, and draws a U). The window is
# a third of the sound, at most 1 s, and holds two cycles of its slowest rate:
# 2 Hz, about the rate of a musical beat, from a 3 s sound on.
MOD_BANDS = 16  # the lowest kept band is 72 Hz wide, so no rate up to 64 Hz is faster than a band is wide
MOD_F_LOW = 100.0
MOD_F_HIGH = 7000.0
MOD_ENV_FS = 1000.0
MOD_HOP = 0.02
MOD_RANGE_DB = 30.0
MOD_WINDOW = 1.0  # s, the longest window
MOD_WINDOW_SHARE = 1 / 3  # of the sound
MOD_RATE_HIGH = 64.0  # Hz


DEFAULTS: dict[str, Any] = {
    "event": "chirp", "length": 0.03, "f_low": 2000.0, "f_high": 6000.0, "tone": "pure", "frequency": 1000.0,
    "harmonics": 8, "noise_low": 100.0, "noise_high": 7500.0, "decay": 0.008, "cutoff": 2000.0, "rate": 10.0, "regularity": 1.0, "level_sd": 0.0, "pitch_sd": 0.0,
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
    if state.get("tone", "pure") not in TONES:
        raise ValueError(f"'tone' must be one of {TONES}, not {state.get('tone')!r}")
    harmonics = state.get("harmonics", DEFAULTS["harmonics"])
    if not (isinstance(harmonics, int) and not isinstance(harmonics, bool) and HARMONICS_RANGE[0] <= harmonics <= HARMONICS_RANGE[1]):
        raise ValueError(f"'harmonics' must be a whole number from {HARMONICS_RANGE[0]} to {HARMONICS_RANGE[1]}, not {harmonics!r}")
    ranges = {
        "length": LENGTH_RANGE, "f_low": FREQUENCY_RANGE, "f_high": FREQUENCY_RANGE,
        "frequency": FREQUENCY_RANGE, "noise_low": FREQUENCY_RANGE, "noise_high": FREQUENCY_RANGE, "decay": DECAY_RANGE, "cutoff": CUTOFF_RANGE,
        "regularity": REGULARITY_RANGE, "level_sd": (0.0, LEVEL_SD_MAX), "pitch_sd": (0.0, PITCH_SD_MAX),
    }
    for name, (low, high) in ranges.items():
        value = state.get(name, DEFAULTS[name])
        if not number(value) or not low <= value <= high:
            raise ValueError(f"'{name}' must be a number from {low:g} to {high:g}, not {value!r}")
    if state.get("noise_low", DEFAULTS["noise_low"]) >= state.get("noise_high", DEFAULTS["noise_high"]):
        raise ValueError("the noise burst's lowest frequency must be below its highest")
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
    """The event's own settings, with the sampling rate: what the event depends on."""
    kind = state.get("event", DEFAULTS["event"])
    names = {"chirp": ("length", "f_low", "f_high"), "pip": ("length", "frequency", "tone", "harmonics"),
             "noise": ("length", "noise_low", "noise_high"), "impact": ("decay", "cutoff")}[kind]
    return (kind, float(state["fs"]), *(state.get(name, DEFAULTS[name]) for name in names))


@functools.lru_cache(maxsize=8)
def _event(knobs: tuple) -> so.Sound:
    return _event_at(knobs, 1.0)


def _event_at(knobs: tuple, ratio: float) -> so.Sound:
    """The event ``ratio`` times higher and ``ratio`` times shorter, as a tape
    played faster is, made at that pitch rather than resampled: what
    ``so.event_train`` would make by reading the event every ``ratio``
    samples, at a fraction of the cost (each distinct pitch is a resampling
    of its own there). What would rise above what the sampling rate holds
    is left out, as that reading filters it out: the part of a chirp above
    it, a tone or harmonics above it, the part of a noise band above it."""
    kind, fs, *values = knobs
    # the event itself draws its own noise; its copies at other pitches cut theirs from one long draw
    noise = (lambda duration: so.gaussian_noise(duration, fs, rng=0).data) if ratio == 1 else (
        lambda duration: _noise(round(duration * fs), fs))
    if kind == "impact":
        decay, cutoff = values[0] / ratio, values[1] * ratio
        length = max(IMPACT_MIN_LENGTH, IMPACT_DECAYS * values[0]) / ratio
        t = np.arange(round(length * fs)) / fs
        # noise read faster keeps its power over a wider band; fresh noise over that band has ratio times more
        burst = so.Sound(noise(length) * (np.exp(-t / decay) / np.sqrt(ratio))[:, None], fs)
        return so.butter_filter(burst, min(cutoff, 0.45 * fs), btype="lowpass", zero_phase=False)
    length = values[0] / ratio
    n = round(length * fs)
    silent = so.Sound(np.zeros((n, 1)), fs)
    match kind:
        case "chirp":
            sound = _chirp_below(length, fs, values[1] * ratio, values[2] * ratio, fs / 2) or silent
        case "pip" if values[2] == "harmonic":
            f0 = values[1] * ratio
            # the harmonics under 0.45 times the sampling rate, and at least the fundamental while it is
            count = min(int(values[3]), int(0.45 * fs // f0))
            if ratio == 1:
                count = max(1, count)
            sound = so.harmonic_complex(length, fs, f0, harmonics=np.arange(1, count + 1), ramp=0.0) if count else silent
        case "pip":
            frequency = values[1] * ratio
            sound = so.pure_tone(length, fs, frequency) if frequency < fs / 2 else silent
        case _:
            band = (values[1] * ratio, min(values[2] * ratio, 0.45 * fs))
            burst = so.Sound(noise(length) / np.sqrt(ratio), fs)  # as for the impact
            sound = so.butter_filter(burst, band, btype="bandpass") if band[0] < band[1] else silent
    return sound * np.hanning(sound.n_samples)[:, None]


@functools.lru_cache(maxsize=2)
def _white(fs: float) -> np.ndarray:
    """White noise (seed 0) long enough for nearly every copy: the longest
    event five of the widest pitch spreads down."""
    longest = max(LENGTH_RANGE[1], IMPACT_DECAYS * DECAY_RANGE[1]) * 2 ** (5 * PITCH_SD_MAX / 1200)
    return so.gaussian_noise(longest, fs, rng=0).data


def _noise(n: int, fs: float) -> np.ndarray:
    """``n`` samples of white noise for a copy's noise burst or impact, cut
    from one long draw rather than drawn for each pitch."""
    white = _white(fs)
    return white[:n] if n <= len(white) else so.gaussian_noise(n / fs, fs, rng=0).data


def _chirp_below(length: float, fs: float, f_start: float, f_end: float, ceiling: float) -> so.Sound | None:
    """An exponential chirp from ``f_start`` to ``f_end`` over ``length``
    seconds, silent while it is at or above ``ceiling``; None if it always is."""
    if max(f_start, f_end) < ceiling:
        return so.exponential_chirp(length, fs, f_start, f_end)
    if min(f_start, f_end) >= ceiling:
        return None
    # f(t) = f_start * (f_end / f_start) ** (t / length): the time it crosses the ceiling
    crossing = length * np.log(ceiling / f_start) / np.log(f_end / f_start)
    n = round(length * fs)
    if f_start < f_end:  # rising: heard up to the crossing
        part = so.exponential_chirp(crossing, fs, f_start, ceiling)
        data = np.concatenate([part.data, np.zeros((n - part.n_samples, part.n_channels))])
    else:  # falling: heard from the crossing on
        part = so.exponential_chirp(length - crossing, fs, ceiling, f_end)
        data = np.concatenate([np.zeros((n - part.n_samples, part.n_channels)), part.data])
    return so.Sound(data, fs)


def event(state: Mapping[str, Any]) -> so.Sound:
    """The one event ``state`` copies, at the page's rate, as sonore makes it."""
    return _event(_knobs(state))


def rate_track(state: Mapping[str, Any]) -> float | tuple[np.ndarray, np.ndarray]:
    """The rate in events per second: a number, or ``(times, values)``."""
    rate = state.get("rate", DEFAULTS["rate"])
    if number(rate):
        return float(rate)
    return np.asarray(rate[0], dtype=float), np.asarray(rate[1], dtype=float)


def train(one: so.Sound | Callable[[float], so.Sound], duration: float, rate: Any, *, regularity: float = 1.0,
          level_sd: float = 0.0, pitch_sd: float = 0.0, seed: int = 0) -> so.Sound:
    """``one`` copied by ``so.event_train`` at ``rate`` events per second (E3,
    E4): a sound, or a function of the pitch ratio that makes each copy."""
    first = one(1.0) if callable(one) else one
    return so.event_train(
        one,
        duration,
        stats.gamma(regularity, scale=1 / regularity),  # mean 1 s; the rate track sets the rate
        rate_scale=rate,
        level_db=stats.norm(0, level_sd) if level_sd else 0.0,
        pitch_cents=stats.norm(0, pitch_sd) if pitch_sd else 0.0,
        lead=first.duration,
        rng=seed,
    )


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes, brought to RMS 1 (its power grows with
    the rate) unless no event falls in it."""
    check(state)
    knobs = _knobs(state)
    # each copy made at its own pitch: far cheaper than sonore resampling the event for each one
    sound = train(
        lambda ratio: _event(knobs) if ratio == 1 else _event_at(knobs, ratio), float(state["duration"]), rate_track(state),
        regularity=float(state.get("regularity", DEFAULTS["regularity"])),
        level_sd=float(state.get("level_sd", 0.0)), pitch_sd=float(state.get("pitch_sd", 0.0)),
        seed=int(state.get("seed", 0)),
    )
    return sound.normalize() if sound.rms > 0 else sound


# --- the modulation spectrogram ---------------------------------------------------------


def _levels(db: np.ndarray) -> tuple[np.ndarray, float]:
    """Depth in dB as 8-bit levels: 1 at ``MOD_RANGE_DB`` below the top, 255
    at the top, 0 where the cell is not valid; and the top in dB."""
    top = float(np.nanmax(db)) if np.any(np.isfinite(db)) else 0.0
    scaled = 1 + np.round(254 * np.clip((db - top) / MOD_RANGE_DB + 1, 0, 1))
    return np.where(np.isfinite(db), scaled, 0).astype(np.uint8), top


def modulation(sound: so.Sound) -> dict[str, Any]:
    """``sound``'s modulation spectrogram as pictures for the page: the band
    x rate depth at each time window (``frames``, window by window, each
    band by band, each band's rates in order) and the depth pooled over the
    bands, rate by time (``pooled``, rate by rate), both in dB over their top
    ``MOD_RANGE_DB``, with the bands' and rates' centers and the windows'
    times."""
    bank = so.cosine_filterbank(n_bands=MOD_BANDS, f_lo=MOD_F_LOW, f_hi=min(MOD_F_HIGH, 0.45 * sound.fs))
    window = max(2 / MOD_RATE_HIGH, min(MOD_WINDOW, MOD_WINDOW_SHARE * sound.duration))  # two cycles of 64 Hz at least
    envelopes = bank.analyze(sound.mono()).envelopes(fs=MOD_ENV_FS)
    spectrogram = so.ModulationSpectrogram(envelopes, f_lo=2 / window, f_hi=MOD_RATE_HIGH, window=window, hop=MOD_HOP)
    with np.errstate(divide="ignore", invalid="ignore"):
        depth = np.where(spectrogram.valid, 20 * np.log10(spectrogram.depth[0]), np.nan)  # (band, rate, window)
        pooled = 20 * np.log10(spectrogram.pooled_depth()[0])  # (rate, window)
    frames, top = _levels(depth)
    pooled_levels, pooled_top = _levels(pooled)
    times = spectrogram.t
    common = {
        "n_rates": int(spectrogram.fm.size), "n_windows": int(times.size),
        "rates": [float(rate) for rate in spectrogram.fm],
        "t_start": float(times[0]), "t_step": float(times[1] - times[0]) if times.size > 1 else MOD_HOP,
        "range_db": MOD_RANGE_DB,
    }
    return {
        "frames": {
            "data": np.ascontiguousarray(frames.transpose(2, 0, 1)).tobytes(),
            "n_bands": int(spectrogram.f.size), "bands": [float(f) for f in spectrogram.f], "top_db": top, **common,
        },
        "pooled": {"data": np.ascontiguousarray(pooled_levels).tobytes(), "top_db": pooled_top, **common},
    }


def steps(state: Mapping[str, Any]) -> Iterator[shared.Step]:
    """Synthesize ``state`` and make its modulation spectrogram, yielding
    the fraction done with what comes next (``shared.Step``)."""
    yield 0.0, "Scattering the events"
    sound = synthesize(state)
    yield 0.1, "Measuring the result"  # the modulation spectrogram takes most of the time
    return sound, modulation(sound)
