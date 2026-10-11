import re
from pathlib import Path

import numpy as np
import pytest

from sonore_sketch import page, tracks

from test_tracks import DOCUMENT

PAGE = {
    "app": "sonore-sketch", "version": 2, "sonore": "0.6.0",
    "duration": DOCUMENT["duration"], "fs": DOCUMENT["fs"], "tab": "tracks",
    "tracks": {"mode": "klatt", "params": DOCUMENT["params"]},
}


def test_a_trackdraw_document_upgrades_to_a_page_document():
    assert page.upgrade(DOCUMENT) == PAGE


def test_the_tracks_state_of_a_page_document_is_the_trackdraw_document():
    assert page.tab_state(PAGE, "tracks") == DOCUMENT


def test_a_saved_page_sounds_as_its_tab_does():
    np.testing.assert_array_equal(page.synthesize(PAGE).data, tracks.synthesize(DOCUMENT).data)


@pytest.mark.parametrize(
    "document, message",
    [({"app": "sonore-sketch", "version": 3}, "version 2"), ({"hello": 1}, "not a sonore-sketch"), ({**PAGE, "tab": "nope"}, "unknown tab")],
)
def test_other_documents_are_refused(document, message):
    with pytest.raises(ValueError, match=message):
        page.tab_state(document)


def test_the_browser_worker_loads_every_module_of_the_package():
    # app/worker.js copies the package into Pyodide file by file; a module
    # missing from its list works locally but fails in the browser.
    root = Path(__file__).resolve().parents[1]
    listed = re.search(r"PYTHON_FILES = \[([^\]]*)\]", (root / "app" / "worker.js").read_text()).group(1)
    assert sorted(re.findall(r'"([^"]+)"', listed)) == sorted(p.name for p in (root / "src" / "sonore_sketch").glob("*.py"))


def test_the_page_colours_levels_with_matplotlibs_magma_as_sonore_does():
    matplotlib = pytest.importorskip("matplotlib")
    root = Path(__file__).resolve().parents[1]
    table = "".join(re.findall(r'"([0-9a-f]+)"', (root / "app" / "colormap.js").read_text()))
    colours = np.array([[int(table[6 * i + k : 6 * i + k + 2], 16) for k in (0, 2, 4)] for i in range(256)])
    expected = np.round(np.array([matplotlib.colormaps["magma"].resampled(256)(i)[:3] for i in range(256)]) * 255)
    np.testing.assert_array_equal(colours, expected)


def test_handle_steps_reports_progress_and_returns_handles_result():
    from sonore_sketch import blobs

    state = {"blobs": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
             "carrier": "tones", "iterations": 2, "rms_depth": 0.2, "seed": 1, "items": blobs.EXAMPLE_ITEMS}
    work, fractions = page.handle_steps({"tab": "blobs", "state": state}), []
    while True:
        try:
            fractions.append(next(work))
        except StopIteration as done:
            result = done.value
            break
    assert fractions == sorted(fractions) and 0 < fractions[0] and fractions[-1] < 1
    expected = page.handle({"tab": "blobs", "state": state})
    assert result["samples"] == expected["samples"] and "modulation" in result
