"""Measure band-limiting the Draw modulation tab's sound (docs/design/tabs/bands.md).

This script runs sonore to measure it; it is not an independent check. A
band is a center-frequency track (breakpoints in time) and a width in
octaves; its gain is 1 within half the width of the center, falls along a
raised-cosine skirt and reaches a floor of -60 dB. Several bands combine by
taking the largest gain. Three routes put the gain on the sound:

* ``envelopes``: multiply each carrier band's envelope by the gain at its
  center before the carrier goes under it (the tones route of
  ``ModulationSpectrum.to_sound``, written out here);
* ``subbands``: synthesize as now, analyze the result with the same cosine
  filterbank, and apply a ``so.Mask`` to the subbands;
* ``stft``: the same with a 20 ms STFT and a gain per bin.

The script prints:

1. Rejection: the result's long-term level inside a static band over the
   level more than half an octave outside it, per route and carrier.
2. Whether the blobs survive: the B-M4 contrast of draw_modulation.md (drawn peak over
   the rest), leaving out |rate| < 1 Hz, measured over the whole range and
   over the band's own range, for no band, static bands of 2 and 1 octaves,
   and a band gliding 1 octave per second.
3. Speed: plain synthesis, the envelopes route (synthesis included) and
   what the subbands and stft routes add, at 3 and 10 s.
4. The measured plane analyzed within the bands, against the whole range.

    python tools/measure_bands.py
"""

import statistics
import time

import numpy as np
import sonore as so

FS = 16000
F_LO, F_HI = 100.0, 6400.0  # the Draw modulation tab's carrier range (draw_modulation.md, B9)
BPO = 12
FLOOR_DB = -60.0
SKIRT = 1 / 6  # octaves, the raised-cosine edge on each side
BLOBS = [so.ModulationBlob(4.0, 0.0), so.ModulationBlob(8.0, 1.0, level=-3.0)]
WARM_REPEATS = 3


def gain(freqs, center, width, skirt=SKIRT):
    """Amplitude gain of one band at ``freqs`` (any shape) around ``center``
    (broadcast against it), ``width`` octaves of flat top."""
    distance = np.abs(np.log2(np.maximum(freqs, 1e-3) / center)) - width / 2
    floor = 10 ** (FLOOR_DB / 20)
    edge = np.clip(distance / skirt, 0, 1)
    return floor + (1 - floor) * 0.5 * (1 + np.cos(np.pi * edge))


def centers(track, t):
    """The center track (list of (time, Hz)) at times ``t``, interpolated in
    log frequency and held at the ends."""
    times, hz = zip(*track)
    return 2 ** np.interp(t, times, np.log2(hz))


def band_gain(bands, freqs, t):
    """Largest gain over ``bands`` (list of (track, width)), shape (len(t), len(freqs))."""
    return np.max([gain(freqs[None, :], centers(track, t)[:, None], width) for track, width in bands], axis=0)


def target(duration):
    return so.ModulationSpectrum.from_blobs(BLOBS, duration, f_lo=F_LO, f_hi=F_HI, bands_per_octave=BPO)


def synth_envelopes(duration, carrier, bands, seed=1):
    """Gain on the envelopes, before the fine structure goes under them."""
    spectrum = target(duration)
    rng = np.random.default_rng(seed)
    envelopes = spectrum.to_envelopes(rng=rng)
    bank = envelopes.filterbank
    if bands:
        values = envelopes._full.copy() if hasattr(envelopes, "_full") else None
        t = (np.arange(values.shape[0]) - envelopes.pad) / envelopes.fs
        values *= band_gain(bands, bank.cfs, t)[:, :, None] if values.ndim == 3 else band_gain(bands, bank.cfs, t)
        envelopes = envelopes._new(values)
    n_audio = int(round(duration * FS))
    if carrier == "tones":
        t = np.arange(n_audio)[:, None] / FS
        tones = np.cos(2 * np.pi * bank.cfs[None, :] * t + rng.uniform(0, 2 * np.pi, bank.n_filters))
        sound = (envelopes * so.frames.filterbank.Subbands(tones[:, :, None], FS, bank)).sum()
    elif carrier == "noise":
        sound = (envelopes * bank.analyze(so.gaussian_noise(n_audio / FS, FS, rng=rng)).tfs()).to_sound()
    else:
        sound = (envelopes * bank.analyze(so.harmonic_complex(duration, FS, 100.0)).tfs()).to_sound()
    sound = so.Sound(sound.data[:n_audio], FS)
    return sound.normalize()


def plain(duration, carrier, seed=1):
    if carrier == "harmonic":
        return synth_envelopes(duration, carrier, [], seed)
    if carrier == "noise":  # sonore 0.8: a noise is passed as a Sound
        return target(duration).to_sound(carrier=so.gaussian_noise(duration, FS, rng=seed), rng=seed)
    return target(duration).to_sound(carrier="tone", fs=FS, rng=seed)


def post_subbands(sound, bands):
    bank = so.cosine_filterbank(f_lo=F_LO, f_hi=F_HI, spacing=1 / BPO, scale="octave")
    subbands = bank.analyze(sound)
    t = (np.arange(subbands._full.shape[0]) - subbands.pad) / FS
    mask = so.Mask(band_gain(bands, subbands.cfs, t)[:, :, None], subbands)
    out = (subbands * mask).to_sound()
    return so.Sound(out.data[: sound.n_samples], FS).normalize()


def post_stft(sound, bands):
    stft = so.STFT(sound, win_dur=0.02)
    g = band_gain(bands, stft.f, np.clip(stft.t, 0, sound.duration))  # (windows, bins)
    out = (stft * so.Mask(g.T[None, :, :], stft)).to_sound()
    return so.Sound(out.data[: sound.n_samples], FS).normalize()


def routes(duration, carrier, bands):
    sound = plain(duration, carrier)
    return {
        "envelopes": lambda: synth_envelopes(duration, carrier, bands),
        "subbands": lambda: post_subbands(sound, bands),
        "stft": lambda: post_stft(sound, bands),
    }


def long_term_db(sound):
    """Long-term level [dB] per 1/12-octave band over the carrier range."""
    bank = so.cosine_filterbank(f_lo=F_LO, f_hi=F_HI, spacing=1 / BPO, scale="octave")
    env = bank.analyze(sound).envelopes(fs=1000).data.mean(axis=2)
    return bank.cfs, 10 * np.log10(np.mean(env**2, axis=0) + 1e-20)


def rejection(sound, center, width):
    cfs, level = long_term_db(sound)
    distance = np.abs(np.log2(cfs / center))
    inside = distance <= width / 2
    outside = distance >= width / 2 + 0.5
    lin = 10 ** (level / 10)
    return 10 * np.log10(lin[inside].mean() / lin[outside].mean())


def contrast(sound, f_lo, f_hi, duration):
    """B-M4: measured power where the drawing is within 6 dB of its peak over
    where it is 30 dB or more below, |rate| <= 32 Hz, density <= 4, leaving
    out |rate| < 1 Hz (where a band's own spectral shape lands)."""
    drawn = so.ModulationSpectrum.from_blobs(BLOBS, duration, f_lo=f_lo, f_hi=f_hi, bands_per_octave=BPO)
    measured = so.ModulationSpectrum.octave(sound, f_lo=f_lo, f_hi=f_hi)
    near = ((np.abs(drawn.w_t) <= 32) & (np.abs(drawn.w_t) >= 1))[None, :] & (drawn.w_f <= 4)[:, None]
    inside = near & (drawn.level >= drawn.level[near].max() - 6)
    outside = near & (drawn.level <= drawn.level[near].max() - 30)
    power = 10 ** (measured.level / 10)
    return 10 * np.log10(power[inside].mean() / power[outside].mean())


def timed(function):
    start = time.perf_counter()
    function()
    return time.perf_counter() - start


print(f"sonore {so.__version__}, numpy {np.__version__}, fs {FS} Hz, {F_LO:g}-{F_HI:g} Hz, skirt {SKIRT:.3g} oct")

print("\n1. rejection: level inside a static band over the level 0.5 oct or more outside it, 3 s")
for width in (2.0, 1.0, 1 / 3):
    static = [([(0.0, 1000.0)], width)]
    for carrier in ("tones", "harmonic", "noise"):
        row = {name: rejection(f(), 1000.0, width) for name, f in routes(3.0, carrier, static).items()}
        cells = "  ".join(f"{name} {db:5.1f} dB" for name, db in row.items())
        print(f"  {width:.2f} oct at 1 kHz, {carrier:<8s}: {cells}")

print("\n2. do the blobs survive? B-M4 contrast leaving out |rate| < 1 Hz, tones, 3 s")
cases = {
    "no band": None,
    "2 oct at 1 kHz": [([(0.0, 1000.0)], 2.0)],
    "1 oct at 1 kHz": [([(0.0, 1000.0)], 1.0)],
    "1 oct gliding 500->4000 Hz (1 oct/s)": [([(0.0, 500.0), (3.0, 4000.0)], 1.0)],
    "two 1/2-oct bands, 500 and 2000 Hz": [([(0.0, 500.0)], 0.5), ([(0.0, 2000.0)], 0.5)],
}
print(f"  {'case':<40s} {'whole range':>12s} {'band only':>10s}")
for name, bands in cases.items():
    for route in ("envelopes", "subbands"):
        if bands is None and route == "subbands":
            continue
        sound = plain(3.0, "tones") if bands is None else routes(3.0, "tones", bands)[route]()
        whole = contrast(sound, F_LO, F_HI, 3.0)
        if bands is None or len(bands[0][0]) > 1 or len(bands) > 1:
            own = float("nan")
        else:
            (track, width), = bands
            own = contrast(sound, track[0][1] * 2 ** (-width / 2), track[0][1] * 2 ** (width / 2), 3.0)
        label = name if bands is None else f"{name} ({route})"
        print(f"  {label:<52s} {whole:6.1f} dB {own:8.1f} dB")

print("\n3. speed, 1 oct band, tones (warm median of 3): the envelopes route is the whole synthesis,")
print("   the post-filter routes only what they add to plain synthesis")
for duration in (3.0, 10.0):
    bands = [([(0.0, 1000.0)], 1.0)]
    for name, f in {"plain": lambda: plain(duration, "tones"), **routes(duration, "tones", bands)}.items():
        f()
        print(f"  {duration:4.1f} s {name:<10s} {statistics.median(timed(f) for _ in range(WARM_REPEATS)):6.2f} s")

print("\n4. the measured plane within the bands (sonore_sketch.draw_modulation.measured): B-M4 contrast as in 2, tones, 3 s")
from sonore_sketch import draw_modulation as tab  # noqa: E402

for name, bands in {
    "1 oct at 1 kHz": [{"points": [[0, 1000]], "width": 1, "level": 0}],
    "1 oct gliding 500->4000 Hz": [{"points": [[0, 500], [3, 4000]], "width": 1, "level": 0}],
    "2 oct gliding 300->2400 Hz": [{"points": [[0, 300], [3, 2400]], "width": 2, "level": 0}],
}.items():
    state = {"draw_modulation": 1, "duration": 3.0, "fs": FS, "f_lo": F_LO, "f_hi": F_HI, "bands_per_octave": BPO, "carrier": "tones",
             "iterations": 0, "rms_depth": 0.2, "seed": 1, "items": tab.B9_ITEMS, "bands": bands}
    drawn, sound = tab.target(state), tab.synthesize(state)
    near = ((np.abs(drawn.w_t) <= 32) & (np.abs(drawn.w_t) >= 1))[None, :] & (drawn.w_f <= 4)[:, None]
    inside = near & (drawn.level >= drawn.level[near].max() - 6)
    outside = near & (drawn.level <= drawn.level[near].max() - 30)
    cells = []
    for analyzed in ({**state, "bands": []}, state):
        power = 10 ** (tab.measured(sound, analyzed).level / 10)
        cells.append(10 * np.log10(power[inside].mean() / power[outside].mean()))
    print(f"  {name:<28s} whole range {cells[0]:5.1f} dB, within the bands {cells[1]:5.1f} dB")
