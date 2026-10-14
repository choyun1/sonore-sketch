import json
import re
from pathlib import Path

import numpy as np
import pytest

from sonore_sketch import page, tracks

from test_tracks import DOCUMENT

PAGE = {
    "app": "sonore-sketch", "version": 2, "sonore": "0.7.0",
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
    # app/worker.js copies the package into Pyodide file by file, as listed in
    # files.json; a module missing from it works locally but fails in the browser.
    package = Path(__file__).resolve().parents[1] / "src" / "sonore_sketch"
    assert json.loads((package / "files.json").read_text()) == sorted(p.name for p in package.glob("*.py"))


def test_the_worker_loads_every_dependency_sonore_needs_to_run():
    # The worker loads NumPy, SciPy and sonore's wheel itself, not sonore's
    # dependency list: matplotlib and soundfile are left out because sonore
    # imports them only to plot and to read files. A new dependency of sonore
    # must be added to the worker's loadPackage call, and here.
    from importlib.metadata import requires

    names = {re.match(r"[A-Za-z0-9_.-]+", r).group(0).lower() for r in requires("sonore") if "extra ==" not in r}
    assert names == {"numpy", "scipy", "matplotlib", "soundfile"}
    worker = (Path(__file__).resolve().parents[1] / "app" / "worker.js").read_text()
    assert 'loadPackage(["numpy", "scipy", SONORE_WHEEL]' in worker
    version = re.search(r'SONORE_VERSION = "([^"]+)"', worker).group(1)
    assert re.search(r'SONORE_WHEEL =\s*"https://files\.pythonhosted\.org/packages/[0-9a-f/]+/sonore-([^-]+)-py3-none-any\.whl"', worker).group(1) == version


def test_the_sonore_version_is_the_same_everywhere():
    # the worker installs it, documents are stamped with it, and pyproject.toml pins it (app.md, D5)
    root = Path(__file__).resolve().parents[1]
    worker = re.search(r'SONORE_VERSION = "([^"]+)"', (root / "app" / "worker.js").read_text()).group(1)
    stamp = re.search(r'SONORE_VERSION = "([^"]+)"', (root / "app" / "tracks" / "model.js").read_text()).group(1)
    pin = re.search(r'"sonore([<>=][^"]+)"', (root / "pyproject.toml").read_text()).group(1)
    assert worker == stamp
    major, minor = (int(part) for part in worker.split(".")[:2])
    assert pin == f">={major}.{minor},<{major}.{minor + 1}"  # the minor version the page installs


def test_the_page_colors_levels_with_matplotlibs_magma_as_sonore_does():
    matplotlib = pytest.importorskip("matplotlib")
    root = Path(__file__).resolve().parents[1]
    table = "".join(re.findall(r'"([0-9a-f]+)"', (root / "app" / "colormap.js").read_text()))
    colors = np.array([[int(table[6 * i + k : 6 * i + k + 2], 16) for k in (0, 2, 4)] for i in range(256)])
    expected = np.round(np.array([matplotlib.colormaps["magma"].resampled(256)(i)[:3] for i in range(256)]) * 255)
    np.testing.assert_array_equal(colors, expected)


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


def test_a_document_without_its_tabs_section_says_so():
    document = {**PAGE, "tab": "painted"}
    document.pop("painted", None)
    with pytest.raises(ValueError, match="no 'painted' section"):
        page.synthesize(document)


def test_only_links_to_other_sites_open_a_new_tab():
    """The same rule as sonore's pages: links to sonore and within sonore-sketch (both on
    choyun1.github.io) stay in this tab; links to other sites, such as GitHub, open a new one."""
    root = Path(__file__).resolve().parents[1]
    for tag in re.findall(r"<a [^>]*>", (root / "index.html").read_text()):
        href = re.search(r'href="([^"]*)"', tag)
        outside = bool(href) and re.match(r"https?://(?!choyun1\.github\.io/)", href.group(1))
        assert ('target="_blank"' in tag) == bool(outside), tag
