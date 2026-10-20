"""Measure what a Draw path tab would need (docs/design/tabs/draw_path.md).

This script runs sonore to measure it; it is not an independent check. A
drawn stroke is modelled as a hand moving along minimum-jerk segments
between waypoints on a top view of the listener, 8 m across. The page sees
it as pointer events, one per screen frame (60 per second), at whole
pixels of a 600-pixel canvas, stamped with the frame's time while the hand
was really there at a time that varies by a couple of milliseconds
(standard deviation 2 ms, an estimate of event delivery jitter).

The script prints:

1. Speed: the stroke's peak speed as the events give it, raw and after
   smoothing, against the hand's true peak speed.
2. Pitch wobble: a 1 kHz tone moved along each version of the stroke by
   ``so.move_sound``; the left ear's instantaneous frequency, with its slow
   part (below 10 Hz, the Doppler of the motion itself) taken out, as an
   RMS and a peak in cents, leaving out the first and last half second.
   A still source and the true path are the references.
3. Faster than sound: of 200 fast flicks (8 m in 0.15-0.4 s), how many
   ``move_sound`` refuses, raw and smoothed.
4. How close to the head a path may come with a one-distance HRIR set,
   as distributed and with the travel time from its sources put back.
5. Elevation cues per frequency band: the spread across elevation (standard
   deviation in dB) of the median-plane HRTF of MIT KEMAR, left ear, in
   bands up to and above 8 kHz, the Nyquist frequency of the other tabs.
6. Size of the HRIRs as the page would fetch them, and render time.

    python tools/measure_draw_path.py path/to/MIT_KEMAR_normal_pinna.sofa
"""

import io
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import sonore as so
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, hilbert, sosfiltfilt

FS = 16000
CANVAS_PX = 600
CANVAS_M = 8.0  # the canvas spans -4..4 m on both axes, listener at the center
EVENT_RATE = 60.0
JITTER = 2e-3
SMOOTH_STEP = 0.01  # s; the stroke is resampled on this grid before smoothing
SMOOTHINGS = [0.015, 0.03, 0.06]  # Gaussian standard deviations [s]
RNG = np.random.default_rng(1)


def minimum_jerk(waypoints, durations, t):
    """Positions (len(t), 2) of a hand moving through ``waypoints``, each
    segment a minimum-jerk movement lasting its duration."""
    starts = np.concatenate([[0.0], np.cumsum(durations)])
    out = np.empty((len(t), 2))
    for i, (a, b) in enumerate(zip(waypoints[:-1], waypoints[1:])):
        inside = (t >= starts[i]) & (t <= starts[i + 1])
        s = (t[inside] - starts[i]) / durations[i]
        shape = 10 * s**3 - 15 * s**4 + 6 * s**5
        out[inside] = np.asarray(a) + (np.asarray(b) - np.asarray(a)) * shape[:, None]
    return out, starts[-1]


def as_events(waypoints, durations):
    """What the page sees: frame times and whole-pixel positions [m]."""
    _, total = minimum_jerk(waypoints, durations, np.array([0.0]))
    frames = np.arange(0, total, 1 / EVENT_RATE)
    true_times = np.clip(frames + RNG.normal(0, JITTER, len(frames)), 0, total)
    positions, _ = minimum_jerk(waypoints, durations, true_times)
    meters_per_px = CANVAS_M / CANVAS_PX
    return frames, np.round(positions / meters_per_px) * meters_per_px


def smoothed(times, points, sd):
    grid = np.arange(times[0], times[-1], SMOOTH_STEP)
    resampled = np.column_stack([np.interp(grid, times, points[:, k]) for k in range(2)])
    return grid, gaussian_filter1d(resampled, sd / SMOOTH_STEP, axis=0, mode="nearest")


def peak_speed(times, points):
    return np.max(np.linalg.norm(np.diff(points, axis=0), axis=1) / np.diff(times))


def to_3d(points):
    """Top view (x right, y front) to sonore's Cartesian points, at ear height."""
    return np.column_stack([points, np.zeros(len(points))])


def wobble_cents(times, points, hrirs, duration):
    tone = so.pure_tone(duration, FS, 1000.0)
    out = so.move_sound(tone, (times, to_3d(points)), hrirs).data[:, 0]
    phase = np.unwrap(np.angle(hilbert(out)))
    freq = np.diff(phase) * FS / (2 * np.pi)
    edge = int(0.5 * FS)  # the tone's onset and the filter's edges
    cents = 1200 * np.log2(np.clip(freq, 1, None) / 1000.0)
    fast = cents - sosfiltfilt(butter(4, 10, "low", fs=FS, output="sos"), cents)
    fast = fast[edge:-edge]
    return np.sqrt(np.mean(fast**2)), np.max(np.abs(fast))


def with_travel_time(hrirs):
    """The set with the travel time from its sources put back in front of the
    IRs (MIT KEMAR's files start just before the sound reaches the ears)."""
    radius = np.median(np.linalg.norm(hrirs.positions, axis=1))
    pad = int(round(radius / so.SPEED_OF_SOUND * hrirs.fs))
    return so.HRIRSet(np.pad(hrirs.irs, ((0, 0), (0, 0), (pad, 0))), hrirs.positions, hrirs.fs)


def closest_approach(hrirs):
    tone = so.pure_tone(1.0, FS, 1000.0)
    for radius in [0.05, 0.1, 0.2, 0.5, 1.0, 1.2, 1.3]:
        line = to_3d(np.array([(-1.0, radius), (1.0, radius)]))
        try:
            so.move_sound(tone, (np.array([0.0, 1.0]), line), hrirs)
            print(f"  passing {100 * radius:>4.0f} cm in front: rendered")
        except ValueError as error:
            print(f"  passing {100 * radius:>4.0f} cm in front: refused ({str(error)[:50]}...)")


def main(sofa_path):
    as_measured = so.HRIRSet.from_sofa(sofa_path)
    onsets = as_measured._onset_times(as_measured.positions)
    print(f"sonore {so.__version__}; {as_measured}; IR onsets {1e3 * onsets.min():.2f}-"
          f"{1e3 * onsets.max():.2f} ms\n")
    print("4. Closest approach to the head center that move_sound accepts")
    print(" the set as distributed:")
    closest_approach(as_measured)
    hrirs = with_travel_time(as_measured)
    print(" with the travel time put back:")
    closest_approach(hrirs)
    print()

    # A slow stroke in front of the listener, left to right with two turns.
    waypoints = [(-3.0, 1.5), (-1.0, 3.0), (0.5, 1.5), (2.0, 3.0), (3.0, 1.5)]
    durations = [1.0, 1.0, 1.0, 1.0]
    fine = np.arange(0, sum(durations), 1e-3)
    true_points, total = minimum_jerk(waypoints, durations, fine)
    times, points = as_events(waypoints, durations)
    still = np.array([[0.0, 2.0]] * 2)
    versions = {"still source": (np.array([0.0, total]), still), "true path": (fine, true_points),
                "raw events": (times, points)}
    for sd in SMOOTHINGS:
        versions[f"smoothed {1000 * sd:.0f} ms"] = smoothed(times, points, sd)

    print("1-2. Slow stroke, 4 s, true peak speed "
          f"{peak_speed(fine, true_points):.2f} m/s")
    print(f"{'version':<20}{'peak speed m/s':>16}{'wobble RMS c':>14}{'wobble peak c':>15}")
    for name, (t, p) in versions.items():
        rms, peak = wobble_cents(t, p, hrirs, total)
        print(f"{name:<20}{peak_speed(t, p):>16.2f}{rms:>14.2f}{peak:>15.2f}")

    print("\n3. Fast flicks across the canvas, 8 m in 0.15-0.4 s")
    refused = {"raw events": 0, "smoothed 30 ms": 0}
    true_peaks = []
    tone = so.pure_tone(0.5, FS, 1000.0)
    for _ in range(200):
        y = RNG.uniform(0.5, 3.0)
        flick = [(-4.0, y), (4.0, y + RNG.uniform(-1, 1))]
        duration = [RNG.uniform(0.15, 0.4)]
        fine_t = np.arange(0, duration[0], 1e-4)
        true_peaks.append(peak_speed(fine_t, minimum_jerk(flick, duration, fine_t)[0]))
        t, p = as_events(flick, duration)
        for name, (tt, pp) in {"raw events": (t, p), "smoothed 30 ms": smoothed(t, p, 0.03)}.items():
            try:
                so.move_sound(tone, (tt, to_3d(pp)), hrirs)
            except ValueError:
                refused[name] += 1
    print(f"true peak speeds {min(true_peaks):.0f}-{max(true_peaks):.0f} m/s; refused: "
          + ", ".join(f"{k} {v}/200" for k, v in refused.items()))

    print("\n5. Elevation cues, median plane, left ear, MIT KEMAR")
    hcc = np.array(so.rect_to_hcc(*hrirs.positions.T)).T
    front = np.flatnonzero(np.isclose(hcc[:, 2] % 360, 0))
    freqs = np.fft.rfftfreq(4096, 1 / hrirs.fs)
    level = 20 * np.log10(np.abs(np.fft.rfft(hrirs.irs[front, 0, :], 4096)) + 1e-12)
    spread = np.std(level, axis=0)
    print("  elevations: " + ", ".join(f"{e:.0f}" for e in np.sort(hcc[front, 1])))
    for lo, hi in [(0.5e3, 2e3), (2e3, 4e3), (4e3, 8e3), (8e3, 12e3), (12e3, 16e3)]:
        band = (freqs >= lo) & (freqs < hi)
        print(f"  {lo / 1e3:>4.1f}-{hi / 1e3:<4.0f} kHz: spread across elevation {np.mean(spread[band]):.1f} dB")

    print("\n6. Size and render time")
    print(f"  SOFA file as distributed: {Path(sofa_path).stat().st_size / 1e6:.2f} MB")
    for name, fs, taps in [("float32, 44.1 kHz, 512 taps", hrirs.fs, 512),
                           ("float32, 32 kHz, 256 taps", 32000, 256),
                           ("float32, 16 kHz, 128 taps", 16000, 128)]:
        full = as_measured._resampled(as_measured.irs, fs)
        irs = full[..., :taps].astype(np.float32)
        kept = np.sum(irs.astype(float) ** 2) / np.sum(full**2)
        buffer = io.BytesIO()
        np.savez_compressed(buffer, irs=irs, positions=as_measured.positions.astype(np.float32))
        print(f"  {name}: {buffer.tell() / 1e6:.2f} MB compressed .npz, "
              f"energy kept {100 * kept:.3f} %")
    for fs in [16000, 32000]:
        for duration in [3.0, 10.0]:
            sound = so.pure_tone(duration, fs, 1000.0)
            path = (np.array([0.0, duration]), to_3d(np.array([(-3.0, 1.0), (3.0, 1.0)])))
            runs = []
            for _ in range(4):
                start = time.perf_counter()
                so.move_sound(sound, path, hrirs)
                runs.append(time.perf_counter() - start)
            print(f"  move_sound {duration:.0f} s at {fs / 1000:.0f} kHz: first {runs[0]:.2f} s, "
                  f"then median {statistics.median(runs[1:]):.2f} s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa")
