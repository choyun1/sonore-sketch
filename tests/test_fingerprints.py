"""Every tab's sound stays what it was, unless a change means it not to.

Each case below is a tab state, mostly the tab's own example; its fingerprint
is the sound's length, its level in 16 equal stretches of time and its level
in 24 frequency bands, in dB. A change to sonore-sketch or a new sonore that
moves any of them by more than ``TOLERANCE_DB`` fails here, so a change in
what people hear is never silent (sonore's design philosophy, "Do not
silently change existing output"). When the change is meant, write the
fixture again and say why in the pull request:

    python tests/test_fingerprints.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

from sonore_sketch import blobs, edit, mask, page, painted, tracks

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "sound_fingerprints.json"
TOLERANCE_DB = 0.01
FS = 16000
DURATION = 1.0
N_STRETCHES = 16
BAND_EDGES_HZ = np.geomspace(50, FS / 2, 25)
FLOOR_POWER = 1e-20  # -200 dB: below it is roundoff, which differs between NumPy versions


def _speech_params() -> dict:
    """A few Klatt syllables, with aspiration so that the seeded noise is heard too."""
    times = [0.0, 0.05, 0.2, 0.25, 0.45, 0.5, 0.7, 0.75, DURATION]
    return {
        "F0": [[0, DURATION], [130, 90]],
        "AV": [times, [0, 60, 58, 0, 60, 58, 0, 60, 0]],
        "F1": [times, [300, 650, 650, 300, 450, 450, 300, 650, 300]],
        "F2": [times, [900, 1700, 1700, 900, 1100, 1100, 900, 1700, 900]],
        "AH": [[0, 0.4, 0.5, DURATION], [0, 0, 45, 0]],
    }


def _cases() -> dict[str, dict]:
    common = {"sonore": "0.8.0", "duration": DURATION, "fs": FS}
    painting = {
        "painted": painted.FORMAT, **common, "f_lo": 100, "f_hi": 6400, "rows_per_octave": 12, "columns": 256,
        "floor_db": -60, "f0": painted.EXAMPLE_F0, "seed": 1, "levels": painted.encode_levels(painted.example_levels()),
    }
    drawing = {
        "blobs": blobs.FORMAT, **common, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12, "carrier": "tones",
        "f0": 100, "iterations": 0, "rms_depth": 0.2, "seed": 1, "items": blobs.EXAMPLE_ITEMS,
    }
    band = [{"points": [[0, 500], [DURATION, 1000]], "width": 1, "level": 0}]
    erased_band = np.zeros((mask.ROWS, mask.COLUMNS))
    erased_band[40:60, 64:192] = -mask.FLOOR_DB  # 1.25-1.9 kHz over the middle half
    filtering = {
        "mask": mask.FORMAT, **common, "source": "syllables", "rows": mask.ROWS, "columns": mask.COLUMNS,
        "floor_db": mask.FLOOR_DB, "window": mask.WINDOW_S, "levels": mask.encode(erased_band),
    }
    editing = {
        "edit": edit.FORMAT, **common, "source": "syllables", "carrier": "source", "iterations": 2, "seed": 1,
        "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12, "columns": edit.COLUMNS, "rows": edit.ROWS,
        "floor_db": edit.FLOOR_DB, "levels": edit.EXAMPLE_LEVELS,
    }
    return {
        "tracks": ("tracks", {"trackdraw": tracks.FORMAT, **common, "mode": "klatt", "seed": 3, "params": _speech_params()}),
        "painted, tones": ("painted", {**painting, "carrier": "tones"}),
        "painted, harmonic": ("painted", {**painting, "carrier": "harmonic"}),
        "painted, noise": ("painted", {**painting, "carrier": "noise"}),
        "mask, syllables": ("mask", filtering),
        "blobs, tones": ("blobs", drawing),
        "blobs, noise, B9, 2 iterations": ("blobs", {**drawing, "carrier": "noise", "items": blobs.B9_ITEMS, "iterations": 2}),
        "blobs, harmonic": ("blobs", {**drawing, "carrier": "harmonic", "f0": 100}),
        "blobs, tones, band, 2 iterations": ("blobs", {**drawing, "bands": band, "iterations": 2}),
        "blobs, harmonic, band, 1 iteration": ("blobs", {**drawing, "carrier": "harmonic", "bands": band, "iterations": 1}),
        "edit, source, 2 iterations": ("edit", editing),
        "edit, tones": ("edit", {**editing, "carrier": "tones", "iterations": 0}),
    }


def fingerprint(samples: np.ndarray, fs: float) -> dict:
    """The sound's length, and its level in dB in each of ``N_STRETCHES``
    stretches of time and each band between ``BAND_EDGES_HZ``."""
    stretches = np.array_split(samples, N_STRETCHES)
    power = np.abs(np.fft.rfft(samples)) ** 2
    frequencies = np.fft.rfftfreq(samples.size, 1 / fs)
    bands = [power[(frequencies >= lo) & (frequencies < hi)].mean() for lo, hi in zip(BAND_EDGES_HZ, BAND_EDGES_HZ[1:])]
    return {
        "n_samples": int(samples.size),
        "stretch_db": [round(float(10 * np.log10(np.mean(part**2) + FLOOR_POWER)), 4) for part in stretches],
        "band_db": [round(float(10 * np.log10(level + FLOOR_POWER)), 4) for level in bands],
    }


def _sound_of(tab: str, state: dict) -> dict:
    sound = page.TABS[tab](state)
    return fingerprint(sound.mono().data[:, 0], sound.fs)


def _write_fixture() -> None:
    prints = {name: _sound_of(tab, state) for name, (tab, state) in _cases().items()}
    FIXTURE.write_text(json.dumps(prints, indent=1) + "\n")
    print(f"wrote {len(prints)} fingerprints to {FIXTURE.relative_to(ROOT)}")


@pytest.mark.parametrize("name", list(_cases()))
def test_the_sound_is_what_it_was(name):
    expected = json.loads(FIXTURE.read_text())[name]
    tab, state = _cases()[name]
    found = _sound_of(tab, state)
    assert found["n_samples"] == expected["n_samples"]
    np.testing.assert_allclose(found["stretch_db"], expected["stretch_db"], atol=TOLERANCE_DB, err_msg=f"{name}: level over time")
    np.testing.assert_allclose(found["band_db"], expected["band_db"], atol=TOLERANCE_DB, err_msg=f"{name}: level per band")


def test_every_case_has_a_fingerprint():
    assert sorted(json.loads(FIXTURE.read_text())) == sorted(_cases())


if __name__ == "__main__":
    sys.exit(_write_fixture())
