import re
from pathlib import Path

import numpy as np
import pytest

from sonore_sketch import page, painted

ROOT = Path(__file__).resolve().parents[1]


def state(levels_db=None, **changes):
    levels_db = painted.example_levels() if levels_db is None else levels_db
    return {
        "painted": 1, "sonore": "0.6.0", "duration": 0.6, "fs": 16000,
        "f_lo": 100, "f_hi": 6400, "rows_per_octave": 12, "columns": 256, "floor_db": -60,
        "carrier": "tones", "f0": 100, "seed": 1, "levels": painted.encode_levels(levels_db),
    } | changes


def test_the_page_starts_from_the_same_example():
    page_js = (ROOT / "app" / "painted" / "model.js").read_text()
    constant = re.search(r'EXAMPLE_LEVELS =\s*"([^"]+)"', page_js).group(1)
    assert constant == painted.encode_levels(painted.example_levels())


def test_levels_round_trip_in_whole_db_with_silence_below_the_floor():
    grid = np.full((72, 256), -np.inf)
    grid[10, 20] = -12.4
    grid[11, 20] = -75
    decoded = painted.levels(state(grid))
    assert decoded.shape == (72, 256)
    assert decoded[10, 20] == -12 and np.isneginf(decoded[11, 20]) and np.isneginf(decoded[0, 0])


def test_a_painted_hole_comes_out_at_its_painted_depth():
    # painted.md, P-M2, as a test: a hole an octave wide (400-800 Hz) at -20 dB.
    grid = np.zeros((72, 256))
    grid[24:36, 102:154] = -20
    sound = painted.synthesize(state(grid, duration=2.0))
    data = sound.mono().data[:, 0]

    def level(t0, t1):
        segment = data[int(t0 * 16000) : int(t1 * 16000)]
        spectrum = np.abs(np.fft.rfft(segment * np.hanning(len(segment)))) ** 2
        f = np.fft.rfftfreq(len(segment), 1 / 16000)
        band = (f >= 100 * 2**2.25) & (f < 100 * 2**2.75)
        return 10 * np.log10(spectrum[band].mean())

    assert level(0.85, 1.15) - level(0.25, 0.55) == pytest.approx(-20, abs=1)


@pytest.mark.parametrize("carrier", ["tones", "harmonic", "noise"])
def test_every_carrier_gives_the_same_samples_twice(carrier):
    a = painted.synthesize(state(carrier=carrier))
    b = painted.synthesize(state(carrier=carrier))
    assert a.duration == pytest.approx(0.6) and np.array_equal(a.data, b.data)
    assert np.sqrt(np.mean(a.data**2)) == pytest.approx(1)


def test_a_blank_painting_says_so():
    with pytest.raises(ValueError, match="nothing painted yet"):
        painted.synthesize(state(np.full((72, 256), -np.inf)))


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"painted": 2}, "format 1"),
        ({"f_hi": 8000}, "fs/2"),
        ({"carrier": "pink"}, "carrier"),
        ({"columns": 128}, "not 72 rows x 128 columns"),
        ({"levels": "%%%"}, "base64"),
    ],
)
def test_bad_states_are_refused(changes, message):
    with pytest.raises(ValueError, match=message):
        painted.check(state(**changes))


def test_a_saved_page_on_the_painted_tab_sounds_as_the_tab_does():
    section = {k: v for k, v in state().items() if k not in ("painted", "sonore", "duration", "fs")}
    document = {
        "app": "sonore-sketch", "version": 2, "sonore": "0.6.0", "duration": 0.6, "fs": 16000,
        "tab": "painted", "tracks": {"mode": "klatt", "params": {}}, "painted": section,
    }
    assert np.array_equal(page.synthesize(document).data, painted.synthesize(state()).data)
