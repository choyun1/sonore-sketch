"""The sound the two Erase tabs erase from (docs/design/tabs/erase_modulation.md, E1;
docs/design/tabs/erase_spectrogram.md, F2): a Klatt syllable train made here at the
page's duration, the Draw speech tab's sound, or a recording opened in the
page (its ``recording``: name, rate and 16-bit samples as base64).
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from fractions import Fraction
from typing import Any

import numpy as np
import sonore as so

from . import draw_speech
from .shared import number

SOURCES = ("syllables", "draw_speech", "file")  # E1, F2


def syllables(duration: float, fs: float) -> so.Sound:
    """A Klatt syllable train (E1, a): one syllable every 0.22 s, each a
    voicing burst whose F1 and F2 move between two vowels, F0 falling from
    130 to 90 Hz (tools/measure_erase_modulation.py measured this source)."""
    starts = np.arange(0.0, max(duration - 0.15, 1e-9), 0.22)
    times, av, f1, f2 = [0.0], [0.0], [300.0], [900.0]
    for i, start in enumerate(starts):
        vowel = (650, 1700) if i % 2 else (450, 1100)
        for offset, voicing, (f1_target, f2_target) in ((0.03, 60, vowel), (0.15, 58, vowel), (0.19, 0, (300, 900))):
            if round(start + offset, 4) < duration:
                times.append(round(start + offset, 4))
                av.append(voicing)
                f1.append(f1_target)
                f2.append(f2_target)
    times.append(duration)
    av.append(0)
    f1.append(300)
    f2.append(900)
    document = {
        "trackdraw": draw_speech.FORMAT, "sonore": so.__version__, "duration": duration, "fs": fs, "mode": "klatt",
        "params": {"F0": [[0, duration], [130, 90]], "AV": [times, av], "F1": [times, f1], "F2": [times, f2], "F3": 2500},
    }
    return draw_speech.synthesize(document)


RAIN_RATE = 300.0  # drops per second
RAIN_BED_DB = -12.0  # the distant patter under the drops, relative to them


def rain(duration: float, fs: float) -> so.Sound:
    """Rain made here, the starting source of Match a texture (Cho,
    2026-10-28): drops at random times, ``RAIN_RATE`` a second on average,
    each a burst of noise dying away in 4 ms through a 1.2-7.5 kHz band,
    their levels spread by 8 dB and their pitches by 600 cents
    (``so.event_train``), over a bed of noise from 100 Hz to 2 kHz at
    ``RAIN_BED_DB``. Always the same rain (seeds 0 and 1): a texture, unlike
    the syllable train."""
    from scipy import stats

    n = int(round(0.03 * fs))
    burst = np.random.default_rng(0).standard_normal(n) * np.exp(-np.arange(n) / fs / 0.004)
    drop = so.bandpass(so.Sound(burst, fs), 1200, min(7500, 0.45 * fs), zero_phase=False)
    drops = so.event_train(drop, duration, stats.expon(scale=1 / RAIN_RATE), level_db=stats.norm(0, 8), pitch_cents=stats.norm(0, 600),
                           lead=drop.duration, rng=0)
    bed = so.gaussian_noise(duration, fs, band=(100, min(2000, 0.45 * fs)), rng=1)
    samples = drops.normalize().data[:, 0] + bed.normalize().data[:, 0] * 10 ** (RAIN_BED_DB / 20)
    return so.Sound(samples, fs).normalize()


def recording(state: Mapping[str, Any]) -> so.Sound:
    """The recording opened in the page (E1, c), mono, at the page's rate,
    cut or padded with silence to the page's duration."""
    opened = state.get("recording")
    if not isinstance(opened, Mapping) or not isinstance(opened.get("pcm16"), str):
        raise ValueError("no recording: links do not carry recordings, so open the file again (Source, Open file…)")
    try:
        samples = np.frombuffer(base64.b64decode(opened["pcm16"], validate=True), dtype="<i2").astype(float) / 32767
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"the recording is not base64 of 16-bit samples ({error})") from None
    fs, recorded_fs = float(state["fs"]), opened.get("fs")
    if not number(recorded_fs) or recorded_fs <= 0:
        raise ValueError(f"the recording's 'fs' must be a positive sampling rate, not {recorded_fs!r}")
    if recorded_fs != fs:
        from scipy.signal import resample_poly

        ratio = Fraction(fs / recorded_fs).limit_denominator(1000)
        samples = resample_poly(samples, ratio.numerator, ratio.denominator)
    n_samples = int(round(float(state["duration"]) * fs))
    samples = np.pad(samples[:n_samples], (0, max(0, n_samples - samples.size)))
    return so.Sound(samples, fs)


def source(state: Mapping[str, Any], silent: str = "there is no modulation to erase") -> so.Sound:
    """The sound a tab erases from, at the page's duration and rate, from
    ``state["source"]``; when it is silent the error ends with ``silent``
    (the default is the Erase modulation tab's)."""
    duration, fs = float(state["duration"]), float(state["fs"])
    kind = state["source"]
    if kind == "syllables":
        sound = syllables(duration, fs)
    elif kind == "rain":  # Quilt a sound's and Match a texture's only
        sound = rain(duration, fs)
    elif kind == "draw_speech":
        speech = state.get("draw_speech")
        if not isinstance(speech, Mapping):
            raise ValueError("the Draw speech tab's drawing is missing")
        sound = draw_speech.synthesize({"trackdraw": draw_speech.FORMAT, "duration": duration, "fs": fs, **speech})
    else:
        sound = recording(state)
    if not sound.rms > 0:
        raise ValueError(f"the source ({kind}) is silent: {silent}")
    return sound
