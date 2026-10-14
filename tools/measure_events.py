"""Measure so.event_train as the Scatter events tab would use it (docs/design/tabs/events.md).

This script runs sonore to measure it; it is not an independent check. Each
render is 5 s at 16 kHz: one event (a chirp, a tone pip, a noise burst or a
lowpass-filtered impact, each made with sonore's own functions) copied at
gamma-distributed intervals, with a level spread, a pitch spread and a drawn
rate track. The script prints:

1. Speed: the render and the texture statistics the tab plots, for each
   event, from a sparse train to the slowest settings the sliders allow.
2. The sparsity-against-rate curve: what it costs per event.
3. What the impact's cutoff slider does to its spectral centroid.

    python tools/measure_events.py

The pitch-spread times depend on the sonore installed: sonore 0.6 resamples
each distinct pitch shift and is slow; sonore PR #195 (choyun1/sonore) reads
the event with a shared windowed sinc instead.
"""

import time

import numpy as np
import sonore as so
from scipy import stats
from sonore.texture import TextureStats

FS = 16000
DURATION = 5.0
EVENT_LENGTH = 0.03
RATES = [1, 3, 10, 30, 100, 300, 1000]


def hann(sound):
    return sound * np.hanning(sound.n_samples)[:, None]


def impact(length, fs, decay=0.008, cutoff=2000.0, seed=0):
    """A noise burst that starts at once and dies away exponentially, through a
    causal lowpass so the onset stays sharp: a clap or a knock, roughly."""
    t = np.arange(round(length * fs)) / fs
    burst = so.gaussian_noise(length, fs, rng=seed) * np.exp(-t / decay)[:, None]
    return so.butter_filter(burst, cutoff, btype="lowpass", zero_phase=False)


EVENTS = {
    "chirp 2-6 kHz": hann(so.exponential_chirp(EVENT_LENGTH, FS, 2000, 6000)),
    "tone pip 1 kHz": hann(so.pure_tone(EVENT_LENGTH, FS, 1000)),
    "noise burst": hann(so.gaussian_noise(EVENT_LENGTH, FS, rng=0)),
    "impact (8 ms, 2 kHz)": impact(0.05, FS),
}
RISING = (
    np.linspace(0, DURATION, 40),
    np.geomspace(0.1, 10, 40),
)  # a drawn track, 0.1x to 10x


def train(
    event, rate, *, regularity=1.0, level_sd=0.0, pitch_sd=0.0, rate_scale=1.0, seed=0
):
    return so.event_train(
        event,
        DURATION,
        stats.gamma(regularity, scale=1 / (rate * regularity)),
        rate_scale=rate_scale,
        level_db=stats.norm(0, level_sd) if level_sd else 0.0,
        pitch_cents=stats.norm(0, pitch_sd) if pitch_sd else 0.0,
        lead=event.duration,
        rng=seed,
    )


def timed(function, *args, **kwargs):
    start = time.perf_counter()
    result = function(*args, **kwargs)
    return time.perf_counter() - start, result


shared_sinc = hasattr(so.core.utils, "_read_between_samples")  # sonore PR #195 or later
print(
    f"sonore {so.__version__} ({'shared windowed sinc' if shared_sinc else 'resampling'} for pitch), "
    f"numpy {np.__version__}, fs {FS} Hz, {DURATION:g} s renders, one run each"
)
TextureStats.measure(so.gaussian_noise(1.0, FS, rng=0))  # warm up

print("\n1. speed: render + statistics (s)")
settings = {
    "30/s, nothing spread": {"rate": 30},
    "1000/s, nearly regular": {"rate": 1000, "regularity": 64},
    "300/s, 6 dB, 100 cents": {"rate": 300, "level_sd": 6, "pitch_sd": 100},
    "1000/s, 12 dB, 300 cents": {"rate": 1000, "level_sd": 12, "pitch_sd": 300},
    "100/s, 300 cents, rising track": {
        "rate": 100,
        "pitch_sd": 300,
        "rate_scale": RISING,
    },
}
print(f"  {'settings':<32s}" + "".join(f"{name:>24s}" for name in EVENTS))
for label, options in settings.items():
    cells = []
    for event in EVENTS.values():
        render, sound = timed(train, event, **options)
        measure, _ = timed(TextureStats.measure, sound)
        cells.append(f"{render:6.2f} + {measure:4.2f}")
    print(f"  {label:<32s}" + "".join(f"{cell:>24s}" for cell in cells))

print(
    "\n2. the sparsity-against-rate curve: seven renders and their statistics, per event"
)
for name, event in EVENTS.items():
    took, _ = timed(
        lambda e=event: [TextureStats.measure(train(e, rate)) for rate in RATES]
    )
    print(f"  {name:<22s} {took:5.2f} s")

print(
    "\n3. the impact's sliders: the event's spectral centroid (its decay is set directly)"
)
print(f"  {'decay':>8s} {'cutoff':>8s} {'centroid':>10s}")
for decay in (0.002, 0.008, 0.03):
    for cutoff in (500.0, 2000.0, 6000.0):
        x = impact(max(0.05, 8 * decay), FS, decay=decay, cutoff=cutoff).data[:, 0]
        power = np.abs(np.fft.rfft(x, 8192)) ** 2
        f = np.fft.rfftfreq(8192, 1 / FS)
        print(
            f"  {1e3 * decay:6.0f} ms {cutoff:6.0f} Hz {np.sum(f * power) / np.sum(power):8.0f} Hz"
        )
