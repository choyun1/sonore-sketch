import numpy as np
import pytest
from sonore.texture import TextureStats

from sonore_sketch import match_texture, page

STATE = {
    "match_texture": 1, "sonore": "0.8.0", "duration": 1.0, "fs": 16000, "source": "syllables",
    "keep": ["marginals", "modulation", "correlations"], "iterations": 2, "seed": 1,
}


def test_the_result_is_noise_at_the_pages_duration_and_level():
    sound, original, matched = match_texture.shared.finish(match_texture.steps(STATE))
    assert sound.fs == original.fs == 16000 and sound.n_samples == original.n_samples == 16000
    assert sound.rms == pytest.approx(1) and np.isfinite(sound.data).all()
    assert list(matched) == list(match_texture.BARS)
    assert abs(np.corrcoef(sound.data[:, 0], original.data[:, 0])[0, 1]) < 0.2  # nothing of the source but its statistics


def test_the_seed_changes_the_noise_and_the_same_seed_gives_the_same_sound():
    one = match_texture.synthesize({**STATE, "iterations": 1})
    np.testing.assert_array_equal(one.data, match_texture.synthesize({**STATE, "iterations": 1}).data)
    assert not np.array_equal(one.data, match_texture.synthesize({**STATE, "iterations": 1, "seed": 2}).data)


def test_the_classes_follow_the_groups_kept():
    assert match_texture.classes([]) == ("subband_var",)
    assert match_texture.classes(["correlations", "marginals"]) == ("env_mean", "env_var", "env_skew", "env_kurt", "env_corr", "c1", "c2")


def test_a_group_kept_matches_better_than_when_it_is_not():
    # match_texture.md, V3: the classes not imposed stay near 0 dB
    def matched(keep):
        return match_texture.shared.finish(match_texture.steps({**STATE, "keep": keep, "iterations": 3}))[2]

    spectrum, marginals, modulation = matched([]), matched(["marginals"]), matched(["modulation"])
    assert marginals["env_skew"] > spectrum["env_skew"] + 5 and marginals["env_kurt"] > spectrum["env_kurt"] + 5
    assert modulation["mod_power"] > spectrum["mod_power"] + 5
    assert spectrum["subband_var"] > 10


def test_one_iteration_at_a_time_is_sonores_synthesis_from_the_last():
    from sonore.texture.synth import synthesize

    sound, original, _ = match_texture.shared.finish(match_texture.steps({**STATE, "iterations": 2}))
    target = TextureStats.measure(original)
    made, _ = synthesize(target, duration=1.0, classes=match_texture.classes(STATE["keep"]), max_iter=1, rng=1)
    made, _ = synthesize(target, duration=1.0, classes=match_texture.classes(STATE["keep"]), max_iter=1, init=made)
    expected = made.resample(16000).data[:, 0]
    np.testing.assert_allclose(sound.data[:, 0], expected / np.sqrt(np.mean(expected**2)), atol=1e-6)


def test_the_page_result_holds_the_source_and_the_match():
    result = page.handle({"tab": "match_texture", "state": {**STATE, "keep": ["modulation"], "iterations": 1}})
    picture = result["source_stft"]
    assert len(picture["data"]) == picture["n_freqs"] * picture["n_windows"]
    assert len(result["match"]) == len(match_texture.BARS)
    assert all(match_texture.SNR_RANGE[0] <= db <= match_texture.SNR_RANGE[1] for db in result["match"])
    assert result["imposed"] == [name in ("subband_var", "mod_power") for name in match_texture.BARS]


def test_a_page_document_gives_the_state_its_source():
    tracks = {"mode": "klatt", "params": {"F0": 120}}
    section = {"source": "draw_speech", "keep": [], "iterations": 1, "seed": 1}
    document = {"app": "sonore-sketch", "version": 3, "sonore": "0.8.0", "duration": 1.0, "fs": 16000, "tab": "match_texture",
                "draw_speech": tracks, "match_texture": section, "scatter_events": {"event": "chirp"}}
    state = page.tab_state(document)
    assert state["draw_speech"] == tracks and "drawing" not in state and state["match_texture"] == match_texture.FORMAT
    state = page.tab_state({**document, "match_texture": {**section, "source": "scatter_events"}})
    assert state["drawing"] == {"event": "chirp"} and "draw_speech" not in state


@pytest.mark.parametrize(
    "change, message",
    [({"match_texture": 2}, "format"), ({"source": "radio"}, "'source'"), ({"keep": ["spectrum"]}, "'keep'"),
     ({"keep": ["marginals", "marginals"]}, "'keep'"), ({"keep": "marginals"}, "'keep'"), ({"iterations": 0}, "'iterations'"),
     ({"iterations": 31}, "'iterations'"), ({"iterations": 2.5}, "'iterations'"), ({"seed": -1}, "'seed'"), ({"duration": 31}, "'duration'")],
)
def test_bad_states_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        match_texture.check({**STATE, **change})


def test_a_silent_source_says_so():
    import base64

    recording = {"name": "x.wav", "fs": 16000, "pcm16": base64.b64encode(np.zeros(16000, "<i2").tobytes()).decode()}
    with pytest.raises(ValueError, match="silent: there is no texture to match"):
        match_texture.synthesize({**STATE, "source": "file", "recording": recording})
