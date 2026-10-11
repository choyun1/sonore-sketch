import base64

import numpy as np
import pytest
import sonore as so

from sonore_sketch import edit, page

STATE = {
    "edit": 1, "sonore": "0.6.0", "duration": 1.0, "fs": 16000, "source": "syllables", "carrier": "source",
    "iterations": 1, "seed": 1, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
    "columns": edit.COLUMNS, "rows": edit.ROWS, "floor_db": edit.FLOOR_DB, "levels": edit.EXAMPLE_LEVELS,
}


def band_power(spectrum, rates, densities=(0, 4)):
    r = (np.abs(spectrum.w_t) >= rates[0]) & (np.abs(spectrum.w_t) <= rates[1])
    d = (spectrum.w_f >= densities[0]) & (spectrum.w_f <= densities[1])
    return 10 * np.log10(np.mean(10 ** (spectrum.level[np.ix_(d, r)] / 10)))


def test_the_grid_is_the_designs():
    # edit.md, E4: 16 columns an octave each side from 1 to 64 Hz, a centre column, 0-6 cyc/oct in 0.125 steps
    rates = edit.column_rates()
    assert rates.size == 193 and rates[96] == 0
    assert rates[97] == pytest.approx(2 ** (0.5 / 16)) and rates[-1] == pytest.approx(64 * 2 ** (-0.5 / 16))
    np.testing.assert_allclose(rates[:96], -rates[97:][::-1])
    assert edit.row_densities()[-1] == pytest.approx(6 - 0.0625)


def test_the_gain_reads_the_mask_with_its_mirror_image():
    g = edit.gain(STATE)  # keep below 4 Hz
    assert g(0.3, 2.0) == 1 and g(3.5, 0.0) == 1 and g(-3.5, 1.0) == 1
    assert g(5.0, 0.0) == 0 and g(-20.0, 3.0) == 0 and g(200.0, 1.0) == 0
    down = {**STATE, "levels": edit.encode(edit.remove_sweeps("down"))}
    g = edit.gain(down)
    assert g(8.0, 2.0) == 0 and g(-8.0, 2.0) == 1
    # a cell at negative density is its mirror's: (-8, -2) is (8, 2), a downward sweep
    assert g(-8.0, -2.0) == 0 and g(8.0, -2.0) == 1


def test_a_partial_cut_is_an_amplitude_gain():
    cut = np.full((edit.ROWS, edit.COLUMNS), 20.0)
    g = edit.gain({**STATE, "levels": edit.encode(cut)})
    assert g(10.0, 1.0) == pytest.approx(0.1)


def test_keeping_slow_rates_removes_the_fast_ones():
    # E-M3: removing every rate above 4 Hz leaves much less power at 6-40 Hz
    state = {**STATE, "duration": 2.0, "iterations": 5}
    sound, spectrum = _run(state)
    assert band_power(spectrum, (6, 40)) - band_power(edit.analyse(sound, state), (6, 40)) > 8


def test_doing_nothing_gives_the_source_back():
    # E-M2: an unedited spectrum on the source's own fine structure rebuilds it
    state = {**STATE, "iterations": 0, "levels": edit.encode(np.zeros((edit.ROWS, edit.COLUMNS)))}
    sound, _ = _run(state)
    original = edit.source(state)
    x, y = original.data[:, 0], sound.data[: original.n_samples, 0]
    assert np.corrcoef(x, y)[0, 1] > 0.95


@pytest.mark.parametrize("carrier", ["tones", "noise"])
def test_other_carriers_are_seeded(carrier):
    state = {**STATE, "carrier": carrier, "iterations": 0}
    np.testing.assert_array_equal(edit.synthesize(state).data, edit.synthesize(state).data)


def test_the_speech_source_is_the_speech_tabs_sound():
    speech = {"mode": "klatt", "params": {"F0": 120, "AV": [[0, 0.05, 0.95, 1.0], [0, 60, 60, 0]], "F1": 500}}
    state = {**STATE, "source": "speech", "speech": speech}
    direct = so.klatt_synthesize(1.0, 16000, {"F0": 120.0, "AV": ([0, 0.05, 0.95, 1.0], [0, 60, 60, 0]), "F1": 500.0}, rng=0)
    np.testing.assert_array_equal(edit.source(state).data, direct.data)


def test_a_recording_is_cut_or_padded_to_the_duration_and_resampled():
    tone = np.sin(2 * np.pi * 440 * np.arange(8000) / 8000)  # 1 s at 8 kHz
    pcm = base64.b64encode(np.round(tone * 32767).astype("<i2").tobytes()).decode()
    state = {**STATE, "duration": 1.5, "source": "file", "recording": {"name": "a.wav", "fs": 8000, "pcm16": pcm}}
    sound = edit.source(state)
    assert sound.fs == 16000 and sound.n_samples == 24000
    assert np.all(sound.data[16100:, 0] == 0)
    assert np.max(np.abs(sound.data[:16000, 0])) == pytest.approx(1, abs=0.02)


def test_a_link_without_the_recording_says_to_open_it_again():
    with pytest.raises(ValueError, match="open the file again"):
        edit.source({**STATE, "source": "file"})


def test_a_page_document_gives_the_edit_state_its_source():
    tracks = {"mode": "klatt", "params": {"F0": 120}}
    section = {k: v for k, v in STATE.items() if k not in ("edit", "sonore", "duration", "fs")}
    document = {"app": "sonore-sketch", "version": 2, "sonore": "0.6.0", "duration": 1.0, "fs": 16000, "tab": "edit",
                "tracks": tracks, "edit": {**section, "source": "speech"}, "recording": {"name": "x", "fs": 16000, "pcm16": ""}}
    state = page.tab_state(document)
    assert state["speech"] == tracks and "recording" not in state
    state = page.tab_state({**document, "edit": {**section, "source": "file"}})
    assert state["recording"]["name"] == "x" and "speech" not in state


def test_the_page_result_holds_the_source_and_result_spectra_and_the_clipping():
    result = page.handle({"tab": "edit", "state": {**STATE, "iterations": 0}})
    for key in ("source_modulation", "modulation"):
        picture = result[key]
        assert len(picture["data"]) == picture["n_densities"] * picture["n_rates"]
        assert picture["rate_first"] == pytest.approx(-64, abs=1.01) and picture["density_step"] > 0
    # a hard cut at 4 Hz needs envelopes below zero (edit.md, E-M5: 15-31%)
    assert 0.05 < result["clipped"] < 0.5
    unedited = page.handle({"tab": "edit", "state": {**STATE, "iterations": 0, "levels": edit.encode(np.zeros((edit.ROWS, edit.COLUMNS)))}})
    assert unedited["clipped"] == 0


def test_the_clipping_warning_is_read_and_others_pass_on():
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        warnings.warn("12.5% of the rebuilt envelope values were below zero and were clipped")
        warnings.warn("something else")
    with pytest.warns(UserWarning, match="something else"):
        assert edit.clipped_fraction(caught) == 0.125


@pytest.mark.parametrize(
    "change, message",
    [({"source": "radio"}, "'source'"), ({"carrier": "harmonic"}, "'carrier'"), ({"iterations": 21}, "'iterations'"),
     ({"columns": 192}, "193 columns"), ({"levels": "AAAA"}, "deflated")],
)
def test_bad_states_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        edit.check({**STATE, **change})


def _run(state):
    work = edit.steps(state)
    fractions = []
    while True:
        try:
            fractions.append(next(work))
        except StopIteration as done:
            assert fractions == sorted(fractions) and fractions[-1] == 1
            return done.value[:2]
