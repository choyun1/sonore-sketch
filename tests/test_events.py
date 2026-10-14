"""The Scatter events tab's Python half (docs/design/tabs/events.md)."""

from __future__ import annotations

import numpy as np
import pytest

from sonore_sketch import events
from sonore_sketch.page import handle


def state(**changes):
    return {"events": 1, "sonore": "0.7.0", "duration": 2.0, "fs": 16000, **events.DEFAULTS, **changes}


@pytest.mark.parametrize("kind", events.EVENTS)
def test_each_event_renders_at_the_pages_rate_and_length(kind):
    sound = events.synthesize(state(event=kind))
    assert sound.fs == 16000 and sound.n_samples == 32000
    assert sound.rms == pytest.approx(1.0)


def test_the_impact_lasts_eight_time_constants_and_at_least_50_ms():
    assert events.event(state(event="impact", decay=0.002)).duration == pytest.approx(0.05)
    assert events.event(state(event="impact", decay=0.02)).duration == pytest.approx(0.16)


def test_the_impacts_cutoff_sets_its_color():
    def centroid(cutoff):
        x = events.event(state(event="impact", cutoff=cutoff)).data[:, 0]
        power = np.abs(np.fft.rfft(x, 8192)) ** 2
        return np.sum(np.fft.rfftfreq(8192, 1 / 16000) * power) / np.sum(power)

    # about 300, 950 and 2600 Hz (events.md, V3)
    assert centroid(500.0) < 500 < centroid(2000.0) < 2000 < centroid(6000.0)


def test_the_track_is_the_rate():
    # 2 events per second for the first half, 50 for the second (a step drawn as two points)
    sparse = events.synthesize(state(event="pip", length=0.01, regularity=64, rate=[[0, 0.999, 1.0, 2.0], [2, 2, 50, 50]]))
    loud = np.abs(sparse.data[:, 0]) > 1e-3 * np.abs(sparse.data).max()
    first, second = loud[:16000].mean(), loud[16000:].mean()
    assert first < 0.1 and second > 0.3  # a 10 ms pip: 2% of the time at 2/s, about 50% at 50/s


def test_a_new_seed_is_a_new_draw_of_the_same_settings():
    one, other = events.synthesize(state(seed=0)), events.synthesize(state(seed=1))
    assert not np.allclose(one.data, other.data)
    assert np.allclose(one.data, events.synthesize(state(seed=0)).data)


def test_a_short_sound_with_no_event_is_silent_not_an_error():
    sound = events.synthesize(state(duration=0.05, rate=1, event="impact", seed=3))
    assert sound.n_samples == 800 and np.all(np.isfinite(sound.data))


def test_the_tone_pip_is_a_pure_tone_or_a_harmonic_complex():
    def peaks(sound):
        spectrum = np.abs(np.fft.rfft(sound.data[:, 0], 16000))  # 1 Hz bins
        return np.flatnonzero(spectrum > 0.2 * spectrum.max())

    pure = peaks(events.event(state(event="pip", frequency=500.0, length=0.1)))
    assert np.all(np.abs(pure - 500) < 20)
    harmonic = peaks(events.event(state(event="pip", tone="harmonic", frequency=200.0, harmonics=5, length=0.1)))
    assert {round(f / 200) for f in harmonic} == {1, 2, 3, 4, 5}


def test_a_harmonic_complex_keeps_its_harmonics_under_the_nyquist_frequency():
    sound = events.event(state(event="pip", tone="harmonic", frequency=3000.0, harmonics=30))
    spectrum = np.abs(np.fft.rfft(sound.data[:, 0], 16000))
    assert spectrum[7300:].max() < 1e-3 * spectrum.max()  # 3 and 6 kHz only


def test_the_noise_burst_is_a_band_of_noise():
    x = events.event(state(event="noise", noise_low=1000.0, noise_high=2000.0, length=0.1)).data[:, 0]
    power = np.abs(np.fft.rfft(x, 16000)) ** 2
    assert power[1000:2001].sum() > 0.9 * power.sum()


def test_a_pitch_spread_of_600_cents_renders():
    sound = events.synthesize(state(pitch_sd=600.0, rate=300))
    assert np.all(np.isfinite(sound.data)) and sound.rms == pytest.approx(1.0)


def test_the_modulation_spectrogram_shows_a_regular_rate():
    # a train at 8 per second, nearly regular: the pooled depth peaks near 8 Hz
    sound = events.synthesize(state(duration=3.0, event="impact", rate=8, regularity=64))
    pooled = events.modulation(sound)["pooled"]
    levels = np.frombuffer(pooled["data"], dtype=np.uint8).reshape(pooled["n_rates"], pooled["n_windows"])
    middle = levels[:, pooled["n_windows"] // 3 : 2 * pooled["n_windows"] // 3].astype(float)
    measured = middle > 0  # 0: not valid
    profile = np.sum(middle, axis=1) / np.maximum(np.sum(measured, axis=1), 1)
    assert 5 <= pooled["rates"][int(np.argmax(profile))] <= 12


def test_the_modulation_pictures_have_their_stated_shapes():
    modulation = events.modulation(events.synthesize(state()))
    frames, pooled = modulation["frames"], modulation["pooled"]
    assert len(frames["data"]) == frames["n_windows"] * frames["n_bands"] * frames["n_rates"]
    assert len(pooled["data"]) == pooled["n_windows"] * pooled["n_rates"]
    assert len(frames["bands"]) == frames["n_bands"] == 16 and max(frames["bands"]) < 7200
    assert 60 <= frames["rates"][-1] <= 64


@pytest.mark.parametrize(("duration", "slowest"), [(0.6, 10.0), (3.0, 2.0), (6.0, 2.0)])
def test_the_modulation_window_is_a_third_of_the_sound_at_most_1_s(duration, slowest):
    # the slowest rate shown holds two cycles in the window
    pooled = events.modulation(events.synthesize(state(duration=duration)))["pooled"]
    assert pooled["rates"][0] == pytest.approx(slowest)


def test_the_modulation_pictures_gray_edges_are_the_same_at_every_rate():
    # one window for every rate: half a second at each end cannot be measured, whatever the rate
    pooled = events.modulation(events.synthesize(state(duration=3.0)))["pooled"]
    levels = np.frombuffer(pooled["data"], dtype=np.uint8).reshape(pooled["n_rates"], pooled["n_windows"])
    times = pooled["t_start"] + pooled["t_step"] * np.arange(pooled["n_windows"])
    for row in levels:
        measured = times[row > 0]
        assert measured[0] == pytest.approx(0.5, abs=0.03) and measured[-1] == pytest.approx(2.5, abs=0.03)


def test_every_measured_moment_is_measured_in_every_band_and_rate():
    # the band x rate picture has no gray cells: no rate is faster than a band is wide
    frames = events.modulation(events.synthesize(state(duration=3.0)))["frames"]
    levels = np.frombuffer(frames["data"], dtype=np.uint8).reshape(frames["n_windows"], -1)
    measured = levels.any(axis=1)
    assert measured.sum() > 0 and np.all(levels[measured] > 0)


def test_handle_returns_the_modulation_spectrogram():
    result = handle({"tab": "events", "state": state()})
    assert {"modulation_frames", "modulation_pooled"} <= set(result)
    assert np.frombuffer(result["samples"], dtype="<f4").size == 32000


@pytest.mark.parametrize("changes, message", [
    ({"events": 2}, "format"),
    ({"event": "drum"}, "'event'"),
    ({"length": 0.5}, "'length'"),
    ({"cutoff": 20}, "'cutoff'"),
    ({"regularity": 0.5}, "'regularity'"),
    ({"pitch_sd": 700}, "'pitch_sd'"),
    ({"tone": "square"}, "'tone'"),
    ({"harmonics": 2.5}, "'harmonics'"),
    ({"noise_low": 3000, "noise_high": 2000}, "below its highest"),
    ({"seed": 1.5}, "'seed'"),
    ({"rate": 0.5}, "the rate must stay"),
    ({"rate": [[0, 1], [10, 2000]]}, "the rate must stay"),
    ({"rate": [[1, 0], [10, 20]]}, "must increase"),
    ({"rate": [[0], [10, 20]]}, "'rate'"),
    ({"duration": 20}, "'duration'"),
])
def test_bad_states_are_refused(changes, message):
    with pytest.raises(ValueError, match=message):
        events.synthesize(state(**changes))
