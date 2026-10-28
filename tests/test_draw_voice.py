import json
from pathlib import Path

import numpy as np
import pytest
from scipy.signal import welch

from sonore_sketch import draw_voice, page

ROOT = Path(__file__).resolve().parents[1]
F = draw_voice.points().tolist()


def bumps(*peaks):
    """A curve with a 0 dB peak at each frequency in ``peaks``, 1 ERB-number
    wide, on a -40 dB floor."""
    e = draw_voice.erb_number(F)
    level = -40 + sum(40 * np.exp(-0.5 * (e - draw_voice.erb_number(p)) ** 2) for p in peaks)
    return np.round(np.clip(level, -60, 0), 1).tolist()


STATE = {
    "draw_voice": 1, "sonore": "0.8.0", "duration": 1.0, "fs": 16000,
    "f0": [[0, 1.0], [120, 120]], "breathiness": [[0], [0.001]],
    "filter": {"f": F, "moments": [0.5], "db": [bumps(700, 1200)]}, "seed": 1,
}


def test_the_example_is_the_starting_voice_and_checks():
    example = json.loads((ROOT / "app" / "examples" / "draw_voice.json").read_text())["state"]
    draw_voice.check(example)
    assert example["filter"]["f"] == F  # the page's points are the Python ones
    assert len(example["filter"]["moments"]) == 3


@pytest.mark.parametrize("change, message", [
    ({"draw_voice": 2}, "format"),
    ({"f0": [[0, 1], [120, 20]]}, "'f0' must stay"),
    ({"f0": [[1, 0], [120, 120]]}, "increase"),
    ({"breathiness": [[0], [1.5]]}, "'breathiness' must stay"),
    ({"filter": {"f": F, "moments": [0.5, 0.2], "db": [bumps(500), bumps(500)]}}, "moments must increase"),
    ({"filter": {"f": F, "moments": [0.5], "db": [bumps(500)[:-1]]}}, "each of the filter's curves"),
    ({"filter": {"f": F, "moments": [0.5], "db": [[5.0] * len(F)]}}, "each of the filter's curves"),
    ({"seed": -1}, "'seed'"),
])
def test_check_rejects(change, message):
    with pytest.raises(ValueError, match=message):
        draw_voice.check({**STATE, **change})


def test_the_pitch_never_glides_to_zero():
    state = {"f0": [[0, 0.5, 0.6, 1.0, 1.2], [100, 100, 0, 0, 120]]}
    times = np.array([-1, 0.2, 0.55, 0.8, 1.1, 1.3])
    np.testing.assert_array_equal(draw_voice.pitch(state, times), [100, 100, 100, 0, 120, 120])


def test_the_voice_is_at_the_pages_duration_and_level():
    sound = draw_voice.synthesize(STATE)
    assert sound.fs == 16000 and sound.n_samples == 16000
    assert sound.rms == pytest.approx(1) and np.isfinite(sound.data).all()
    np.testing.assert_array_equal(sound.data, page.synthesize({
        "app": "sonore-sketch", "version": 3, "sonore": "0.8.0", "duration": 1.0, "fs": 16000, "tab": "draw_voice",
        "draw_voice": {key: STATE[key] for key in ("f0", "breathiness", "filter", "seed")},
    }).data)


def test_the_sound_has_the_drawn_filter():
    # draw_voice.md, V2: each harmonic's level follows the curve, here within 1.5 dB from 100 Hz to 6 kHz
    sound = draw_voice.synthesize({**STATE, "duration": 2.0, "f0": [[0], [125]]})
    f, power = welch(sound.data[:, 0], sound.fs, nperseg=8192)
    harmonics = np.arange(1, 48) * 125.0
    got = 10 * np.log10([power[np.argmin(np.abs(f - h))] for h in harmonics])
    curve = np.interp(draw_voice.erb_number(harmonics), draw_voice.erb_number(F), STATE["filter"]["db"][0])
    difference = got - curve
    assert np.max(np.abs(difference - np.median(difference))) < 1.5


def test_an_unvoiced_stretch_is_noise_and_the_pitch_moves_with_the_line():
    sound = draw_voice.synthesize({**STATE, "f0": [[0, 0.4, 0.4001, 0.6, 0.6001, 1.0], [120, 120, 0, 0, 240, 240]]})
    x = sound.data[:, 0]
    rms = [np.sqrt(np.mean(x[int(a * 16000):int(b * 16000)] ** 2)) for a, b in ((0.1, 0.35), (0.45, 0.55), (0.65, 0.9))]
    assert rms[1] > 0.3 * rms[0]  # noise carries the filter's power there, not silence
    for (a, b), f0 in (((0.1, 0.35), 120), ((0.65, 0.9), 240)):
        f, power = welch(x[int(a * 16000):int(b * 16000)], 16000, nperseg=2048)
        low = (f > 60) & (f < 1000)
        harmonic = [power[low][np.argmin(np.abs(f[low] - k * f0))] for k in (1, 2)]
        between = power[low][np.argmin(np.abs(f[low] - 1.5 * f0))]
        assert min(harmonic) > 10 * between


def test_breathiness_adds_noise_between_the_harmonics():
    def between(share):
        sound = draw_voice.synthesize({**STATE, "breathiness": [[0], [share]]})
        f, power = welch(sound.data[:, 0], 16000, nperseg=4096)
        return np.median([power[np.argmin(np.abs(f - (k + 0.5) * 120))] / power[np.argmin(np.abs(f - k * 120))] for k in range(3, 10)])

    assert between(0.5) > 30 * between(0.001)


def test_the_filter_blends_between_moments():
    two = {**STATE, "filter": {"f": F, "moments": [0.2, 0.8], "db": [bumps(300), bumps(2500)]}}
    envelope = draw_voice.parts(two)[1]
    at = np.array([300.0, 2500.0])
    db = [10 * np.log10(envelope(np.array([t]), at)[0][:, 0]) for t in (0.2, 0.5, 0.8)]
    np.testing.assert_allclose(db[1], (db[0] + db[2]) / 2, atol=0.01)  # halfway, in dB
    assert db[0][0] > db[0][1] + 30 and db[2][1] > db[2][0] + 30
