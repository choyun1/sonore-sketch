import numpy as np
import pytest
import sonore as so

from sonore_sketch import page, quilt, sources

STATE = {"quilt": 1, "sonore": "0.7.0", "duration": 2.0, "fs": 16000, "source": "syllables", "segment": 0.06, "seed": 1}


def test_the_quilt_is_sonores_of_the_source_padded_to_the_duration():
    sound, original, count = quilt.shared.finish(quilt.steps(STATE))
    assert sound.n_samples == original.n_samples == 32000
    assert count == 33  # every whole 60 ms segment of 2 s, each once
    made = so.quilt(original, 0.06, count * 0.06, rng=1).data[:, 0]
    kept = sound.data[: made.size, 0]
    np.testing.assert_allclose(kept, made * np.sqrt(np.mean(kept**2) / np.mean(made**2)), atol=1e-6)  # only the level differs
    assert np.all(sound.data[made.size :, 0] == 0)


def test_the_seed_changes_the_order_and_the_same_seed_gives_the_same_quilt():
    one, two = quilt.synthesize(STATE), quilt.synthesize({**STATE, "seed": 2})
    np.testing.assert_array_equal(one.data, quilt.synthesize(STATE).data)
    assert not np.array_equal(one.data, two.data)


def test_a_quilt_is_not_the_source_in_order():
    sound, original, _ = quilt.shared.finish(quilt.steps(STATE))
    assert abs(np.corrcoef(sound.data[:, 0], original.data[:, 0])[0, 1]) < 0.5


def test_when_sonore_runs_out_of_segments_the_quilt_has_one_fewer():
    # 2 s of 30 ms segments, seed 0: a quilt of all 66 runs out of choices near its end
    state = {**STATE, "segment": 0.03}
    counts = {quilt.shared.finish(quilt.steps({**state, "seed": seed}))[2] for seed in range(20)}
    assert counts <= {65, 66} and 66 in counts


def test_too_few_segments_say_what_to_change():
    with pytest.raises(ValueError, match="needs at least 3: shorten the segments or lengthen the duration"):
        quilt.synthesize({**STATE, "segment": 0.96})


def test_the_page_result_holds_the_source_and_the_segments():
    result = page.handle({"tab": "quilt", "state": STATE})
    picture = result["source_stft"]
    assert len(picture["data"]) == picture["n_freqs"] * picture["n_windows"]
    assert result["segments"] == 33 and result["segment_s"] == 0.06


def test_a_page_document_gives_the_quilt_state_its_source():
    tracks = {"mode": "klatt", "params": {"F0": 120}}
    section = {"source": "speech", "segment": 0.06, "seed": 1}
    document = {"app": "sonore-sketch", "version": 2, "sonore": "0.7.0", "duration": 1.0, "fs": 16000, "tab": "quilt",
                "tracks": tracks, "quilt": section, "recording": {"name": "x", "fs": 16000, "pcm16": ""}}
    state = page.tab_state(document)
    assert state["speech"] == tracks and "recording" not in state and state["quilt"] == quilt.FORMAT
    state = page.tab_state({**document, "quilt": {**section, "source": "file"}})
    assert state["recording"]["name"] == "x" and "speech" not in state


@pytest.mark.parametrize(
    "change, message",
    [({"quilt": 2}, "format"), ({"source": "radio"}, "'source'"), ({"segment": 0.02}, "'segment'"), ({"segment": 1.0}, "'segment'"),
     ({"seed": 1.5}, "'seed'"), ({"seed": -1}, "'seed'"), ({"duration": 31}, "'duration'")],
)
def test_bad_states_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        quilt.check({**STATE, **change})


def _recording(samples, fs=16000):
    import base64

    samples = np.asarray(samples, float)
    pcm = np.round(samples / max(np.max(np.abs(samples)), 1e-12) * 32767).astype("<i2")
    return {"name": "x.wav", "fs": fs, "pcm16": base64.b64encode(pcm.tobytes()).decode()}


@pytest.mark.parametrize(
    "samples, message",
    [(np.zeros(32000), "silent: there is nothing to quilt"),  # a silent file
     (np.r_[1.0, np.zeros(31999)], "the quilt came out silent"),  # one impulse at the very start, which the joins cut away
     ([1.0], "the quilt came out silent")],  # a one-sample file, padded to the duration
)
def test_sounds_with_nothing_to_quilt_say_so(samples, message):
    with pytest.raises(ValueError, match=message):
        quilt.synthesize({**STATE, "source": "file", "recording": _recording(samples)})


@pytest.mark.parametrize(
    "samples",
    [np.r_[np.zeros(16000), 1.0, np.zeros(15999)],  # one impulse in the middle
     np.ones(32000),  # DC
     np.tile([1.0, -1.0], 16000),  # the Nyquist frequency
     np.random.default_rng(0).standard_normal(1600)],  # 0.1 s of noise, padded to the 2 s
)
def test_odd_recordings_make_a_finite_quilt_at_the_page_level(samples):
    sound = quilt.synthesize({**STATE, "source": "file", "recording": _recording(samples)})
    assert sound.n_samples == 32000 and np.isfinite(sound.data).all() and sound.rms == pytest.approx(1)


def test_a_source_of_exactly_three_segments_still_makes_a_quilt():
    sound, _, count = quilt.shared.finish(quilt.steps({**STATE, "duration": 0.18}))
    assert 2 <= count <= 3 and sound.rms > 0
