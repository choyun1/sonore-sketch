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


def test_sparsity_falls_toward_noise_as_the_rate_rises():
    sparse = events.sparsity(events.synthesize(state(rate=3)), state(rate=3))
    dense = events.sparsity(events.synthesize(state(rate=1000)), state(rate=1000))
    assert sparse["mean"] > 10 * dense["mean"]
    assert dense["mean"] < 5 * dense["noise_mean"]
    curve = np.asarray(sparse["curve"])
    assert curve[0] > curve[-1] and np.all(np.diff(curve[2:]) < 0)  # falling from 10/s on
    assert sparse["rate"] == 3 and len(sparse["cfs"]) == len(sparse["values"]) == len(sparse["noise"])
    assert max(sparse["cfs"]) < 8000  # the bands under the page's Nyquist frequency


def test_the_chirps_own_bands_are_where_it_sweeps():
    sparsity = events.sparsity(events.synthesize(state()), state())
    own = np.asarray(sparsity["cfs"])[np.asarray(sparsity["own"])]
    assert own.min() > 1500 and own.max() < 7000


def test_a_drawn_rate_has_no_dot_but_a_flat_one_does():
    drawn = state(rate=[[0, 2], [10, 100]])
    assert events.sparsity(events.synthesize(drawn), drawn)["rate"] is None
    flat = state(rate=[[0, 2], [30, 30]])
    assert events.sparsity(events.synthesize(flat), flat)["rate"] == 30


def test_handle_returns_the_sparsity():
    result = handle({"tab": "events", "state": state()})
    assert set(result["sparsity"]) >= {"cfs", "values", "noise", "own", "curve_rates", "curve", "noise_mean", "mean", "rate"}
    assert np.frombuffer(result["samples"], dtype="<f4").size == 32000


@pytest.mark.parametrize("changes, message", [
    ({"events": 2}, "format"),
    ({"event": "drum"}, "'event'"),
    ({"length": 0.5}, "'length'"),
    ({"cutoff": 20}, "'cutoff'"),
    ({"regularity": 0.5}, "'regularity'"),
    ({"pitch_sd": 400}, "'pitch_sd'"),
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
