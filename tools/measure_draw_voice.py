"""Measure what a Draw a voice tab would need (docs/design/tabs/draw_voice.md).

This script runs sonore to measure it; it is not an independent check. At
the page's 16 kHz, on one core (as in Pyodide, which has no threads):

1. Synthesis time: ``so.source_filter_synthesize`` on a drawn voice (an F0
   line, a spectral envelope drawn as curves at a few moments, a drawn
   breathiness) for 0.6, 2, 10 and 30 s, cold and warm, on two grids for
   the noise (512- and 1024-point FFT, a 5 ms hop).
2. Analysis time: F0 track, CheapTrick envelope and the two aperiodicities
   (D4C and sonore's harmonic residual) of the Draw speech tab's sound and
   of the Klatt syllable train, for starting a drawing from a sound.
3. Does the sound follow the drawing? Steady vowels, harmonics alone and
   noise alone: the result's spectrum against the drawn envelope, level
   removed. Then CheapTrick measuring the moving drawn voice, which is a
   check on CheapTrick as much as on the voice, and the level in a gap of
   the F0 track when an aperiodicity is given.
4. How many points a drawn curve needs: the syllable train's CheapTrick
   envelope kept at N points per time window (equally spaced on the ERB
   scale, read back in dB as sonore reads an envelope) against the full
   envelope, 100 Hz to 7 kHz.
5. Copy synthesis: the syllable train analyzed and rebuilt, and the F0 of
   the rebuilt sound against the analyzed F0 (cents, voiced windows).

    OMP_NUM_THREADS=1 python tools/measure_draw_voice.py
"""

import json
import time
from pathlib import Path

import numpy as np
import sonore as so
from scipy.signal import welch
from sonore.views.aperiodicity import Aperiodicity

from sonore_sketch import draw_speech, sources

FS = 16000
HOP = 0.005
BAND = (100.0, 7000.0)
ROOT = Path(__file__).resolve().parent.parent


def erb_number(f):
    return 21.4 * np.log10(1 + 0.00437 * np.asarray(f, dtype=float))


def erb_frequency(e):
    return (10 ** (np.asarray(e, dtype=float) / 21.4) - 1) / 0.00437


def resonances_db(f, formants, bandwidths, tilt_db_per_octave=-6.0, floor_db=-60.0):
    """A vowel's envelope in dB: second-order resonances in cascade (as a
    Klatt cascade's magnitude) and a source slope with radiation, 0 dB at
    100 Hz, held at ``floor_db`` below its peak, as a plot with that range
    would hold a drawn curve."""
    f = np.maximum(np.asarray(f, dtype=float), 1.0)
    db = tilt_db_per_octave * np.log2(f / 100.0)
    for centre, width in zip(formants, bandwidths, strict=True):
        s = 2j * np.pi * f
        pole = -np.pi * width + 2j * np.pi * centre
        h = (pole * np.conj(pole)) / ((s - pole) * (s - np.conj(pole)))
        db += 20 * np.log10(np.abs(h))
    return np.maximum(db, db.max() + floor_db)


VOWELS = {  # Peterson & Barney's male averages, Klatt's bandwidths
    "a": ((730, 1090, 2440, 3400), (90, 110, 170, 250)),
    "i": ((270, 2290, 3010, 3400), (60, 90, 150, 250)),
    "u": ((300, 870, 2240, 3400), (60, 90, 150, 250)),
}


def drawn_voice(duration, n_points=48, breathy=False, n_fft=1024):
    """A drawn voice: F0 falling 130 -> 95 Hz with a rise in the middle, the
    envelope drawn at three moments (a, i, u) and read linearly between them,
    and one noise share at every time and frequency (0.1%, or 25% breathy)."""
    f0 = (np.array([0, 0.45, 0.6, 1.0]) * duration, np.array([130.0, 115.0, 125.0, 95.0]))
    points = erb_frequency(np.linspace(erb_number(50), erb_number(FS / 2), n_points))
    moments = np.array([0.1, 0.5, 0.9]) * duration
    db = np.stack([resonances_db(points, *VOWELS[v]) for v in "aiu"], axis=1)  # (points, moments)
    envelope = so.SpectralEnvelope((10 ** (db / 10))[None], moments, points, fs=FS)
    times = np.arange(0, duration + HOP / 2, HOP)
    freqs = np.arange(n_fft // 2 + 1) * FS / n_fft
    share = 0.25 if breathy else 0.001
    ratio = np.full((1, len(freqs), len(times)), np.sqrt(share))
    return f0, envelope, Aperiodicity(ratio, times, FS, "drawn")


def timed(call, *args, **kwargs):
    start = time.perf_counter()
    value = call(*args, **kwargs)
    return value, time.perf_counter() - start


def part_1():
    print("== 1. synthesis time (s), one core")
    print("duration | n_fft | cold | warm (median of 3)")
    for n_fft in (512, 1024):
        for duration in (0.6, 2.0, 10.0, 30.0):
            f0, env, ap = drawn_voice(duration, n_fft=n_fft)
            _, cold = timed(so.source_filter_synthesize, f0, env, ap, duration=duration, rng=1)
            warm = np.median([timed(so.source_filter_synthesize, f0, env, ap, duration=duration, rng=1)[1]
                              for _ in range(3 if duration < 30 else 1)])
            print(f"{duration:5.1f} s | {n_fft} | {cold:.3f} | {warm:.3f}")


def draw_speech_sound():
    state = json.loads((ROOT / "app/examples/draw_speech.json").read_text())["state"]
    return draw_speech.synthesize(state)


def analyse(sound, f_hi=500.0):
    track = so.f0_track(sound, f_hi=f_hi)
    contour = (track.t, track.f0[0] if np.ndim(track.f0) > 1 else track.f0)
    env = so.pitch_adaptive_envelope(sound, contour)
    return contour, env


def part_2():
    print("\n== 2. analysis time (s), one core")
    for name, sound in (("Draw speech (0.6 s)", draw_speech_sound()),
                        ("syllables (2 s)", sources.syllables(2.0, FS))):
        track, t_f0 = timed(so.f0_track, sound)
        contour = (track.t, np.asarray(track.f0).reshape(-1, len(track.t))[0])
        _, t_env = timed(so.pitch_adaptive_envelope, sound, contour)
        _, t_d4c = timed(so.band_aperiodicity, sound, contour)
        _, t_res = timed(so.harmonic_aperiodicity, sound, contour)
        voiced = np.mean(contour[1] > 0)
        print(f"{name}: f0_track {t_f0:.3f}, CheapTrick {t_env:.3f}, D4C {t_d4c:.3f}, "
              f"harmonic residual {t_res:.3f} (voiced {voiced:.0%} of windows)")


def envelope_error(sound, f0, drawn):
    """The CheapTrick envelope of ``sound`` against the envelope ``drawn``,
    in voiced time windows: median and 90th percentile of |difference| in dB,
    after removing the median difference (the level)."""
    measured = so.pitch_adaptive_envelope(sound, f0)
    t = measured.t
    voiced = np.interp(t, *f0) > 0
    keep = (measured.f >= BAND[0]) & (measured.f <= BAND[1])
    got = 10 * np.log10(np.maximum(measured.data[0][keep][:, voiced], 1e-30))
    want = 10 * np.log10(np.maximum(drawn(t[voiced], measured.f[keep])[0], 1e-30))
    diff = got - want
    diff -= np.median(diff)
    return np.median(np.abs(diff)), np.percentile(np.abs(diff), 90)


def steady(vowel, share, duration=2.0, f0=130.0, n_points=48):
    """One vowel held for ``duration`` on a steady F0, drawn at ``n_points``,
    with one noise share everywhere; the drawn envelope and the sound."""
    points = erb_frequency(np.linspace(erb_number(50), erb_number(FS / 2), n_points))
    power = 10 ** (resonances_db(points, *VOWELS[vowel]) / 10)
    envelope = so.SpectralEnvelope(np.repeat(power[None, :, None], 2, axis=2), np.array([0, duration]), points, fs=FS)
    times = np.arange(0, duration + HOP / 2, HOP)
    ap = Aperiodicity(np.full((1, 513, len(times)), np.sqrt(share)), times, FS, "drawn")
    sound = so.source_filter_synthesize((np.array([0, duration]), np.array([f0, f0])), envelope, ap,
                                        duration=duration, rng=1)
    return envelope, sound


def part_3():
    print("\n== 3. the result's spectrum against the drawn envelope (dB, level removed)")
    print("steady vowels at 130 Hz, 2 s: harmonics alone (each harmonic's level, Welch 8192),")
    print("noise alone (Welch 512), 100 Hz-6 kHz; harmonic_complex fades harmonics from 6.48 kHz")
    for vowel in VOWELS:
        row = []
        for share in (0.0, 1.0):
            envelope, sound = steady(vowel, share)
            if share == 0:
                f, p = welch(sound.data[:, 0], FS, nperseg=8192)
                at = np.arange(1, int(6000 / 130) + 1) * 130.0
                got = np.array([p[np.argmin(np.abs(f - x))] for x in at])
            else:
                f, p = welch(sound.data[:, 0], FS, nperseg=512)
                at = f[(f >= 100) & (f <= 6000)]
                got = p[(f >= 100) & (f <= 6000)]
            diff = 10 * np.log10(got) - 10 * np.log10(envelope(np.array([1.0]), at)[0][:, 0])
            diff = np.abs(diff - np.median(diff))
            row.append(f"{'harmonics' if share == 0 else 'noise'} median {np.median(diff):.1f}, max {diff.max():.1f}")
        print(f"/{vowel}/: " + "; ".join(row))
    print("CheapTrick of a drawn, moving voice against the drawing (a check on CheapTrick as much as on the voice):")
    for breathy in (False, True):
        f0, env, ap = drawn_voice(2.0, breathy=breathy)
        sound = so.source_filter_synthesize(f0, env, ap, duration=2.0, rng=1)
        median, p90 = envelope_error(sound, f0, env)
        print(f"{'breathy' if breathy else 'modal'}: median {median:.2f} dB, 90th percentile {p90:.2f} dB")
    f0, env, ap = drawn_voice(2.0)
    gap = (np.array([0, 0.9, 0.9001, 1.1, 1.1001, 2.0]), np.array([130, 120, 0, 0, 110, 95.0]))
    x = so.source_filter_synthesize(gap, env, ap, duration=2.0, rng=1).data[:, 0]
    in_gap, voiced = (np.sqrt(np.mean(x[int(a * FS):int(b * FS)] ** 2)) for a, b in ((0.95, 1.05), (0.5, 0.8)))
    print(f"an F0 gap (0.9-1.1 s) with the drawn aperiodicity: RMS {in_gap:.3f} in it, {voiced:.3f} voiced")


def part_4():
    print("\n== 4. points per drawn curve: kept envelope against the full one (dB, 100 Hz-7 kHz, voiced)")
    sound = sources.syllables(2.0, FS)
    contour, env = analyse(sound)
    voiced = contour[1] > 0
    keep = (env.f >= BAND[0]) & (env.f <= BAND[1])
    full = 10 * np.log10(np.maximum(env.data[0], 1e-30))[keep][:, voiced]
    for n in (16, 24, 32, 48, 64, 96):
        points = erb_frequency(np.linspace(erb_number(50), erb_number(FS / 2), n))
        coarse = so.SpectralEnvelope(env(env.t, points), env.t, points, fs=FS)
        back = 10 * np.log10(np.maximum(coarse(env.t, env.f)[0], 1e-30))[keep][:, voiced]
        diff = np.abs(back - full)
        print(f"{n:3d} points: median {np.median(diff):.2f} dB, 90th percentile {np.percentile(diff, 90):.2f} dB, "
              f"max {diff.max():.1f} dB")


def part_5():
    print("\n== 5. copy synthesis of the syllable train: F0 of the rebuilt sound")
    sound = sources.syllables(2.0, FS)
    contour, env = analyse(sound)
    ap = so.band_aperiodicity(sound, contour)
    rebuilt = so.source_filter_synthesize(contour, env, ap, duration=sound.duration, rng=1)
    again = so.f0_track(rebuilt)
    f0_again = np.asarray(again.f0).reshape(-1, len(again.t))[0]
    n = min(len(f0_again), len(contour[1]))
    both = (contour[1][:n] > 0) & (f0_again[:n] > 0)
    cents = 1200 * np.abs(np.log2(f0_again[:n][both] / contour[1][:n][both]))
    agree = np.mean((contour[1][:n] > 0) == (f0_again[:n] > 0))
    print(f"voicing agrees in {agree:.0%} of windows; F0 median {np.median(cents):.1f} cents, "
          f"90th percentile {np.percentile(cents, 90):.1f} cents")
    median, p90 = envelope_error(rebuilt, contour, env)
    print(f"envelope of the rebuilt sound against the analyzed one: median {median:.2f} dB, 90th {p90:.2f} dB")


if __name__ == "__main__":
    print(f"sonore {so.__version__}, numpy {np.__version__}")
    part_1()
    part_2()
    part_3()
    part_4()
    part_5()
