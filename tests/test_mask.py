import base64

import numpy as np
import pytest
import sonore as so

from sonore_sketch import edit, mask, page

FS = 16000
STATE = {
    "mask": 1, "sonore": "0.6.0", "duration": 1.0, "fs": FS, "source": "syllables",
    "rows": mask.ROWS, "columns": mask.COLUMNS, "floor_db": mask.FLOOR_DB, "window": mask.WINDOW_S,
    "levels": mask.BLANK_LEVELS,
}


def noise_file(duration=2.0):
    samples = np.random.default_rng(1).standard_normal(int(duration * FS)) * 0.2
    pcm = base64.b64encode(np.round(np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()).decode()
    return {"name": "noise.wav", "fs": FS, "pcm16": pcm}


def band_level(sound, f_lo, f_hi, t_lo, t_hi):
    data = sound.data[int(t_lo * FS) : int(t_hi * FS), 0]
    spectrum = np.abs(np.fft.rfft(data * np.hanning(data.size))) ** 2
    f = np.fft.rfftfreq(data.size, 1 / FS)
    return 10 * np.log10(spectrum[(f >= f_lo) & (f < f_hi)].mean())


def test_the_grid_is_the_designs():
    # mask.md, F4: rows in equal steps from 0 Hz to Nyquist, 31.25 Hz each at 16 kHz
    f = mask.row_frequencies(FS)
    assert f[0] == pytest.approx(15.625) and f[-1] == pytest.approx(8000 - 15.625)


def test_the_gains_read_the_mask_bilinearly_in_amplitude():
    cut = np.zeros((mask.ROWS, mask.COLUMNS))
    cut[100:, :] = 60  # removed above row 100 (3125 Hz)
    cut[:, 128:] = np.maximum(cut[:, 128:], 20)  # -20 dB in the second half
    t = np.array([0.1, 0.9])
    g = mask.gains(cut, np.array([1000.0, 3109.375, 3125.0, 3140.625, 6000.0]), t, 1.0, FS)
    np.testing.assert_allclose(g[:, 0], [1, 1, 0.5, 0, 0])
    np.testing.assert_allclose(g[:, 1], [0.1, 0.1, 0.05, 0, 0])


def test_a_blank_mask_gives_the_source_back():
    sound = mask.synthesize(STATE)
    original = edit.source(STATE)
    np.testing.assert_allclose(sound.data[:, 0] / sound.rms, original.data[:, 0] / original.rms, atol=1e-6)


def test_a_removed_band_comes_out_removed():
    # F-M2: with the 32 ms window a removed band of noise is about 90 dB down
    cut = np.zeros((mask.ROWS, mask.COLUMNS))
    rows = (mask.row_frequencies(FS) >= 1000) & (mask.row_frequencies(FS) < 2000)
    cut[np.ix_(rows, np.arange(102, 154))] = 60  # 0.8-1.2 s of 2 s
    state = {**STATE, "duration": 2.0, "source": "file", "recording": noise_file(), "levels": mask.encode(cut)}
    sound = mask.synthesize(state)
    assert band_level(sound, 1200, 1800, 0.9, 1.1) - band_level(sound, 1200, 1800, 0.2, 0.6) < -40


def test_the_speech_source_is_the_speech_tabs_sound():
    speech = {"mode": "klatt", "params": {"F0": 120, "AV": [[0, 0.05, 0.95, 1.0], [0, 60, 60, 0]], "F1": 500}}
    state = {**STATE, "source": "speech", "speech": speech}
    np.testing.assert_allclose(mask.synthesize(state).data, edit.source(state).normalize().data, atol=1e-6)


def test_a_page_document_gives_the_mask_state_its_source():
    section = {k: v for k, v in STATE.items() if k not in ("mask", "sonore", "duration", "fs")}
    document = {"app": "sonore-sketch", "version": 2, "sonore": "0.6.0", "duration": 1.0, "fs": FS, "tab": "mask",
                "tracks": {"mode": "klatt", "params": {"F0": 120}}, "mask": {**section, "source": "file"}, "recording": noise_file(1.0)}
    state = page.tab_state(document)
    assert state["mask"] == 1 and state["recording"]["name"] == "noise.wav"
    assert page.synthesize(document).n_samples == FS


def test_the_page_result_holds_both_spectrograms_on_one_scale():
    cut = np.zeros((mask.ROWS, mask.COLUMNS))
    cut[64:128, :] = 60  # 2-4 kHz removed throughout
    state = {**STATE, "source": "file", "recording": noise_file(1.0), "levels": mask.encode(cut)}
    result = page.handle({"tab": "mask", "state": state})
    pictures = [result["source_stft"], result["result_stft"]]
    for picture in pictures:
        assert len(picture["data"]) == picture["n_freqs"] * picture["n_frames"]
        assert picture["f_max"] == FS / 2
    n = pictures[0]["n_frames"]
    source, out = (np.frombuffer(p["data"], np.uint8).reshape(-1, n).astype(float) for p in pictures)
    band = slice(80, 112)  # 2.5-3.5 kHz bins
    assert out[band].mean() < source[band].mean() - 100  # far darker: more than 30 dB down
    assert abs(out[:40].mean() - source[:40].mean()) < 5  # below 1.25 kHz, as it was


def test_a_link_without_the_recording_says_to_open_it_again():
    with pytest.raises(ValueError, match="open the file again"):
        mask.synthesize({**STATE, "source": "file"})


@pytest.mark.parametrize(
    "change, message",
    [({"source": "radio"}, "'source'"), ({"rows": 128}, "256 rows"), ({"window": 0.005}, "window"), ({"levels": "AAAA"}, "deflated")],
)
def test_bad_states_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        mask.check({**STATE, **change})


def test_erasures_on_a_recording_keep_their_seconds_with_span():
    # erase 0.75-1.5 s on a 3 s recording, then double the duration: the
    # page keeps the mask's columns over the first 3 s (span), so the same
    # seconds stay erased and the new time is not
    cut = np.zeros((mask.ROWS, mask.COLUMNS))
    cut[:, 64:128] = -mask.FLOOR_DB
    state = {**STATE, "source": "file", "recording": noise_file(3.0), "levels": mask.encode(cut)}
    at_3 = mask.synthesize({**state, "duration": 3.0})
    at_6 = mask.synthesize({**state, "duration": 6.0, "span": 3.0})
    for sound in (at_3, at_6):
        assert band_level(sound, 500, 4000, 0.85, 1.4) < band_level(sound, 500, 4000, 0.2, 0.6) - 40
    # 1.7-2.1 s was not erased (it was where the stretched erasure would land)
    assert abs(band_level(at_6, 500, 4000, 1.7, 2.1) - band_level(at_6, 500, 4000, 0.2, 0.6)) < 3
