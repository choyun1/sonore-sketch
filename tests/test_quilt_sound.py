import numpy as np
import pytest
import sonore as so

from sonore_sketch import page, quilt_sound, sources

STATE = {"quilt_sound": 1, "sonore": "0.9.0", "duration": 2.0, "fs": 16000, "source": "syllables", "segment": 0.06, "seed": 1}


def test_the_quilt_is_sonores_of_the_source_padded_to_the_duration():
    sound, original, count = quilt_sound.shared.finish(quilt_sound.steps(STATE))
    assert sound.n_samples == original.n_samples == 32000
    assert count == 32  # all but one of the 33 whole 60 ms segments of 2 s, each once
    made = so.quilt(original, 0.06, count * 0.06, rng=1).data[:, 0]
    kept = sound.data[: made.size, 0]
    np.testing.assert_allclose(kept, made * np.sqrt(np.mean(kept**2) / np.mean(made**2)), atol=1e-6)  # only the level differs
    assert np.all(sound.data[made.size :, 0] == 0)


def test_the_seed_changes_the_order_and_the_same_seed_gives_the_same_quilt():
    one, two = quilt_sound.synthesize(STATE), quilt_sound.synthesize({**STATE, "seed": 2})
    np.testing.assert_array_equal(one.data, quilt_sound.synthesize(STATE).data)
    assert not np.array_equal(one.data, two.data)


def test_a_quilt_is_not_the_source_in_order():
    sound, original, _ = quilt_sound.shared.finish(quilt_sound.steps(STATE))
    assert abs(np.corrcoef(sound.data[:, 0], original.data[:, 0])[0, 1]) < 0.5


def test_the_quilt_has_one_segment_fewer_than_the_source_on_every_seed():
    # 2 s of 30 ms segments: 66 whole segments, and sonore keeps one spare
    state = {**STATE, "segment": 0.03}
    counts = {quilt_sound.shared.finish(quilt_sound.steps({**state, "seed": seed}))[2] for seed in range(20)}
    assert counts == {65}


def test_too_few_segments_say_what_to_change():
    with pytest.raises(ValueError, match="needs at least 3: shorten the segments or lengthen the duration"):
        quilt_sound.synthesize({**STATE, "segment": 0.96})


def test_the_page_result_holds_the_source_and_the_segments():
    result = page.handle({"tab": "quilt_sound", "state": STATE})
    picture = result["source_stft"]
    assert len(picture["data"]) == picture["n_freqs"] * picture["n_windows"]
    assert result["segments"] == 32 and result["segment_s"] == 0.06


def test_a_page_document_gives_the_quilt_state_its_source():
    tracks = {"mode": "klatt", "params": {"F0": 120}}
    section = {"source": "draw_speech", "segment": 0.06, "seed": 1}
    document = {"app": "sonore-sketch", "version": 3, "sonore": "0.9.0", "duration": 1.0, "fs": 16000, "tab": "quilt_sound",
                "draw_speech": tracks, "quilt_sound": section, "recording": {"name": "x", "fs": 16000, "pcm16": ""}}
    state = page.tab_state(document)
    assert state["draw_speech"] == tracks and "recording" not in state and state["quilt_sound"] == quilt_sound.FORMAT
    state = page.tab_state({**document, "quilt_sound": {**section, "source": "file"}})
    assert state["recording"]["name"] == "x" and "draw_speech" not in state


@pytest.mark.parametrize(
    "change, message",
    [({"quilt_sound": 2}, "format"), ({"source": "radio"}, "'source'"), ({"segment": 0.02}, "'segment'"), ({"segment": 1.0}, "'segment'"),
     ({"seed": 1.5}, "'seed'"), ({"seed": -1}, "'seed'"), ({"duration": 31}, "'duration'")],
)
def test_bad_states_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        quilt_sound.check({**STATE, **change})


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
        quilt_sound.synthesize({**STATE, "source": "file", "recording": _recording(samples)})


@pytest.mark.parametrize(
    "samples",
    [np.r_[np.zeros(16000), 1.0, np.zeros(15999)],  # one impulse in the middle
     np.ones(32000),  # DC
     np.tile([1.0, -1.0], 16000),  # the Nyquist frequency
     np.random.default_rng(0).standard_normal(1600)],  # 0.1 s of noise, padded to the 2 s
)
def test_odd_recordings_make_a_finite_quilt_at_the_page_level(samples):
    sound = quilt_sound.synthesize({**STATE, "source": "file", "recording": _recording(samples)})
    assert sound.n_samples == 32000 and np.isfinite(sound.data).all() and sound.rms == pytest.approx(1)


def test_a_source_of_exactly_three_segments_still_makes_a_quilt():
    sound, _, count = quilt_sound.shared.finish(quilt_sound.steps({**STATE, "duration": 0.18}))
    assert count == 2 and sound.rms > 0


@pytest.mark.parametrize("tab", ["draw_spectrogram", "draw_modulation", "scatter_events"])
def test_another_tabs_drawing_is_quilted_as_that_tab_sounds(tab):
    import json
    import subprocess

    dump = 'import { defaultPage } from "./app/document.js"; console.log(JSON.stringify(defaultPage("quilt_sound")))'
    document = json.loads(subprocess.run(["node", "--input-type=module", "-e", dump], check=True, capture_output=True, text=True).stdout)
    document["quilt_sound"]["source"] = tab
    state = page.tab_state(document, "quilt_sound")
    assert state["drawing"] == document[tab]
    np.testing.assert_array_equal(quilt_sound.source(state).data, page.synthesize({**document, "tab": tab}).mono().data)
    assert quilt_sound.synthesize(state).rms == pytest.approx(1)


def test_a_drawn_source_without_its_drawing_or_with_nothing_drawn_says_so():
    with pytest.raises(ValueError, match="drawing is missing"):
        quilt_sound.synthesize({**STATE, "source": "scatter_events"})
    with pytest.raises(ValueError, match="no blobs yet"):
        quilt_sound.synthesize({**STATE, "source": "draw_modulation", "drawing": {"carrier": "tones", "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
                                                                   "iterations": 0, "rms_depth": 0.2, "seed": 1, "items": []}})
