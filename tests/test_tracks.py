import json

import numpy as np
import pytest
import sonore as so

from sonore_sketch import page, tracks

DOCUMENT = {
    "trackdraw": 1,
    "sonore": "0.6.0",
    "duration": 0.6,
    "fs": 16000,
    "mode": "klatt",
    "params": {
        "F0": [[0, 0.6], [120, 95]],
        "AV": [[0, 0.03, 0.55, 0.6], [0, 60, 60, 0]],
        "F1": [[0, 0.2, 0.6], [300, 650, 350]],
        "F2": [[0, 0.3, 0.6], [900, 1700, 1100]],
        "F3": 2500,
        "B1": 60,
    },
}


def test_document_gives_the_same_samples_as_a_direct_call():
    # The test D5 asks for: the page's sound is so.klatt_synthesize's.
    direct = so.klatt_synthesize(
        0.6,
        16000,
        {
            "F0": ([0, 0.6], [120, 95]),
            "AV": ([0, 0.03, 0.55, 0.6], [0, 60, 60, 0]),
            "F1": ([0, 0.2, 0.6], [300, 650, 350]),
            "F2": ([0, 0.3, 0.6], [900, 1700, 1100]),
            "F3": 2500.0,
            "B1": 60.0,
        },
        rng=0,
    )
    np.testing.assert_array_equal(tracks.synthesize(DOCUMENT).data, direct.data)


def test_f0_below_the_floor_is_raised_to_it():
    low = {**DOCUMENT, "params": {**DOCUMENT["params"], "F0": [[0, 0.6], [5, 95]]}}
    floored = {**DOCUMENT, "params": {**DOCUMENT["params"], "F0": [[0, 0.6], [20, 95]]}}
    np.testing.assert_array_equal(tracks.synthesize(low).data, tracks.synthesize(floored).data)
    assert tracks.klatt_params({**DOCUMENT, "params": {"F0": 3}})["F0"] == tracks.F0_FLOOR


def test_a_document_survives_json():
    again = json.loads(json.dumps(DOCUMENT))
    np.testing.assert_array_equal(tracks.synthesize(again).data, tracks.synthesize(DOCUMENT).data)


def test_noise_sources_are_seeded():
    noisy = {**DOCUMENT, "params": {**DOCUMENT["params"], "AH": 50}}
    np.testing.assert_array_equal(tracks.synthesize(noisy).data, tracks.synthesize(noisy).data)
    other_seed = tracks.synthesize({**noisy, "seed": 1}).data
    assert not np.array_equal(other_seed, tracks.synthesize(noisy).data)


@pytest.mark.parametrize(
    "change, message",
    [
        ({"trackdraw": 2}, "format"),
        ({"duration": 0}, "duration"),
        ({"duration": 10.5}, "duration"),
        ({"fs": -1}, "fs"),
        ({"mode": "sine"}, "mode"),
        ({"params": {"F9": 100}}, "unknown"),
        ({"params": {"F1": [[0, 1], [300]]}}, "same"),
        ({"params": {"F1": [[0.5, 0.1], [300, 400]]}}, "increase"),
        ({"params": {"F0": [[0, 0.3, 0.3, 0.6], [125, 100, 140, 95]]}}, "share a time"),
        ({"params": {"F1": "high"}}, "number"),
    ],
)
def test_bad_documents_say_what_is_wrong(change, message):
    with pytest.raises(ValueError, match=message):
        tracks.check({**DOCUMENT, **change})


def test_page_result_holds_the_samples_and_a_picture():
    result = page.handle({"tab": "tracks", "state": DOCUMENT})
    samples = np.frombuffer(result["samples"], dtype="<f4")
    np.testing.assert_allclose(samples, tracks.synthesize(DOCUMENT).data[:, 0], rtol=1e-6, atol=1e-6)
    assert result["fs"] == 16000
    picture = result["spectrogram"]
    levels = np.frombuffer(picture["data"], dtype=np.uint8).reshape(picture["n_freqs"], picture["n_frames"])
    assert levels.max() == 255
    assert picture["f_max"] == 8000
    # Voicing is off at the ends (AV 0 dB), so the loudest frames are inside.
    loudness = levels.astype(float).mean(axis=0)
    middle = slice(picture["n_frames"] // 4, 3 * picture["n_frames"] // 4)
    assert loudness[middle].mean() > loudness[:5].mean()


def test_page_rejects_an_unknown_tab():
    with pytest.raises(ValueError, match="unknown tab"):
        page.handle({"tab": "radio", "state": {}})
