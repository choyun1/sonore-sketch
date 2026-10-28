"""The Match a texture tab's state, and the sound it describes.

Measure a sound's texture statistics and push noise until it has the ones
chosen, and nothing else of the sound: McDermott & Simoncelli's (2011)
synthesis, as ``sonore.texture.synth.synthesize`` does it
(docs/design/tabs/match_texture.md)::

    {"match_texture": 1, "sonore": "0.8.0", "duration": 2.0, "fs": 16000,
     "source": "scatter_events", "keep": ["marginals", "modulation", "correlations"],
     "iterations": 10, "seed": 1,
     "draw_speech": {...}, "recording": {...}, "drawing": {...}}  # the source's own, as on Quilt a sound

The source is one of Quilt a sound's (T2), at the page's duration. ``keep``
names the groups of statistics imposed besides the spectrum (the subband
variances), which ``synthesize`` always imposes (T3): the envelope
marginals (mean, variance, skew, kurtosis), modulation power, and the
correlations (between bands' envelopes, C1 and C2). The model is sonore's
default, the paper's, at 20 kHz (T6). ``synthesize`` runs one iteration per
step, each starting from the last (V4), from Gaussian noise drawn from
``seed`` (T8); the result is brought back to the page's rate.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so
from sonore.texture import TextureStats
from sonore.texture.synth import synthesize as texture_synthesize

from . import quilt_sound, shared
from .shared import number

FORMAT = 1
MAX_DURATION = 30.0  # seconds, the whole app's limit (docs/design/app.md, D10)
SOURCES = quilt_sound.SOURCES  # T2
DRAWN = quilt_sound.DRAWN
GROUPS = {  # T3: what each checkbox imposes, in sonore's class names
    "marginals": ("env_mean", "env_var", "env_skew", "env_kurt"),
    "modulation": ("mod_power",),
    "correlations": ("env_corr", "c1", "c2"),
}
SPECTRUM = "subband_var"  # imposed whatever is kept
BARS = (SPECTRUM, *(name for names in GROUPS.values() for name in names))  # T7, in the order the page draws them
ITERATION_RANGE = (1, 30)  # T4
SNR_RANGE = (-20.0, 60.0)  # dB: the bars' axis, and where a perfect or hopeless match is clipped


def check(state: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` saying what is wrong with ``state``, if anything."""
    if state.get("match_texture") != FORMAT:
        raise ValueError(f"not a Match a texture state of format {FORMAT}: 'match_texture' is {state.get('match_texture')!r}")
    duration, fs = state.get("duration"), state.get("fs")
    if not number(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"'duration' must be a number of seconds in (0, {MAX_DURATION:g}], not {duration!r}")
    if not number(fs) or fs <= 0:
        raise ValueError(f"'fs' must be a positive sampling rate, not {fs!r}")
    if state.get("source") not in SOURCES:
        raise ValueError(f"'source' must be one of {SOURCES}, not {state.get('source')!r}")
    keep = state.get("keep")
    if not isinstance(keep, list) or any(group not in GROUPS for group in keep) or len(set(keep)) != len(keep):
        raise ValueError(f"'keep' must be a list of some of {tuple(GROUPS)}, each once, not {keep!r}")
    iterations = state.get("iterations")
    low, high = ITERATION_RANGE
    if not (isinstance(iterations, int) and not isinstance(iterations, bool) and low <= iterations <= high):
        raise ValueError(f"'iterations' must be a whole number from {low} to {high}, not {iterations!r}")
    seed = state.get("seed")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0):
        raise ValueError(f"'seed' must be a whole number from 0 up, not {seed!r}")


def classes(keep: list[str]) -> tuple[str, ...]:
    """sonore's classes for the groups kept; with none, the spectrum alone."""
    kept = tuple(name for group in GROUPS if group in keep for name in GROUPS[group])
    return kept or (SPECTRUM,)


def match(target: TextureStats, other: so.Sound) -> dict[str, float]:
    """How well ``other``'s statistics match ``target``, per class of ``BARS``:
    sonore's SNR in dB, clipped to ``SNR_RANGE``."""
    snr = target.snr(TextureStats.measure(other, model=target.model, window="uniform"), classes=BARS)
    return {name: float(np.clip(np.nan_to_num(snr[name], nan=SNR_RANGE[0]), *SNR_RANGE)) for name in BARS}


def steps(state: Mapping[str, Any]) -> Iterator[shared.Step]:
    """``synthesize`` one step at a time: yields the fraction done (with what
    comes next, ``shared.Step``) before the source, its measurement, each
    iteration and the result's measurement, and returns ``(sound, the
    source, the result's match per class of BARS)``."""
    check(state)
    iterations = int(state["iterations"])
    total = iterations + 3
    yield 0.0, "Making the source"
    original = quilt_sound.source(state, silent="there is no texture to match")
    yield 1 / total, "Measuring the source's statistics"
    target = TextureStats.measure(original)
    kept = classes(list(state["keep"]))
    made = None
    for done in range(iterations):
        yield (done + 2) / total, shared.iteration_text(done, iterations)
        # statistics of near-silent bands divide by about 0, harmlessly
        with np.errstate(divide="ignore", invalid="ignore"):
            made, _ = texture_synthesize(
                target, duration=original.duration, classes=kept, max_iter=1, rng=int(state["seed"]), init=made,
            )
    yield (iterations + 2) / total, shared.iteration_text(iterations, iterations)
    with np.errstate(divide="ignore", invalid="ignore"):
        matched = match(target, made)
    sound = made.resample(original.fs) if made.fs != original.fs else made
    samples = np.zeros(original.n_samples)
    n = min(sound.n_samples, original.n_samples)  # the model keeps whole envelope samples, so it may be a little short
    samples[:n] = sound.data[:n, 0]
    return so.Sound(samples, original.fs).normalize(), original, matched


def synthesize(state: Mapping[str, Any]) -> so.Sound:
    """The sound ``state`` describes."""
    return shared.finish(steps(state))[0]
