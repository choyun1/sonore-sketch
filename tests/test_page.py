import json
import re
from pathlib import Path

import numpy as np
import pytest

from sonore_sketch import draw_speech, page

from test_draw_speech import DOCUMENT

PAGE = {
    "app": "sonore-sketch", "version": 3, "sonore": "0.10.0",
    "duration": DOCUMENT["duration"], "fs": DOCUMENT["fs"], "tab": "draw_speech",
    "draw_speech": {"mode": "klatt", "params": DOCUMENT["params"]},
}


def test_a_trackdraw_document_upgrades_to_a_page_document():
    assert page.upgrade(DOCUMENT) == PAGE


def test_the_tracks_state_of_a_page_document_is_the_trackdraw_document():
    assert page.tab_state(PAGE, "draw_speech") == DOCUMENT


def test_a_saved_page_sounds_as_its_tab_does():
    np.testing.assert_array_equal(page.synthesize(PAGE).data, draw_speech.synthesize(DOCUMENT).data)


def test_a_version_2_document_opens_with_the_tabs_renamed():
    # before 2026-10-20 the tabs had other ids, in files and links as in the code
    old = {
        "app": "sonore-sketch", "version": 2, "sonore": "0.10.0", "duration": DOCUMENT["duration"], "fs": DOCUMENT["fs"],
        "tab": "edit", "tracks": PAGE["draw_speech"], "edit": {"source": "speech", "iterations": 2},
        "quilt": {"source": "blobs", "segment": 0.06, "seed": 1}, "mask": {"source": "file"},
    }
    assert page.upgrade(old) == {
        **PAGE, "tab": "erase_modulation", "erase_modulation": {"source": "draw_speech", "iterations": 2},
        "quilt_sound": {"source": "draw_modulation", "segment": 0.06, "seed": 1}, "erase_spectrogram": {"source": "file"},
    }
    assert page.tab_state(old)["draw_speech"] == PAGE["draw_speech"]


@pytest.mark.parametrize(
    "document, message",
    [({"app": "sonore-sketch", "version": 4}, "version 3"), ({"hello": 1}, "not a sonore-sketch"), ({**PAGE, "tab": "nope"}, "unknown tab")],
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
    stamp = re.search(r'SONORE_VERSION = "([^"]+)"', (root / "app" / "draw_speech" / "model.js").read_text()).group(1)
    pin = re.search(r'"sonore([<>=][^"]+)"', (root / "pyproject.toml").read_text()).group(1)
    assert worker == stamp
    major, minor = (int(part) for part in worker.split(".")[:2])
    assert pin == f">={major}.{minor},<{major}.{minor + 1}"  # the minor version the page installs


def test_the_longest_duration_is_the_same_everywhere():
    # one limit for every tab, and the page says what it is (app.md, D10)
    from sonore_sketch import draw_modulation, draw_path, draw_spectrogram, erase_modulation, erase_spectrogram, quilt_sound, scatter_events

    root = Path(__file__).resolve().parents[1]
    longest = draw_speech.MAX_DURATION
    assert {m.MAX_DURATION for m in (draw_modulation, draw_path, draw_spectrogram, erase_modulation, erase_spectrogram, quilt_sound, scatter_events)} == {longest}
    seconds = f"{longest:g}"
    assert re.search(r"MAX_DURATION = (\S+);", (root / "app" / "draw_speech" / "model.js").read_text()).group(1) == seconds
    assert re.search(r"MAX_RECORDING_S = (\S+);", (root / "app" / "sources.js").read_text()).group(1) == seconds
    html = (root / "index.html").read_text()
    label = re.search(r'<label class="duration".*?</label>', html, re.S).group(0)
    assert f'max="{seconds}"' in label and f"up to {seconds} s" in label and f"(max {seconds})" in label
    assert f"(up to {seconds} s on every tab)" in (root / "README.md").read_text()


def test_the_page_colors_levels_with_matplotlibs_magma_as_sonore_does():
    matplotlib = pytest.importorskip("matplotlib")
    root = Path(__file__).resolve().parents[1]
    table = "".join(re.findall(r'"([0-9a-f]+)"', (root / "app" / "colormap.js").read_text()))
    colors = np.array([[int(table[6 * i + k : 6 * i + k + 2], 16) for k in (0, 2, 4)] for i in range(256)])
    expected = np.round(np.array([matplotlib.colormaps["magma"].resampled(256)(i)[:3] for i in range(256)]) * 255)
    np.testing.assert_array_equal(colors, expected)


def test_handle_steps_reports_progress_and_returns_handles_result():
    from sonore_sketch import draw_modulation

    state = {"draw_modulation": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
             "carrier": "tones", "iterations": 2, "rms_depth": 0.2, "seed": 1, "items": draw_modulation.EXAMPLE_ITEMS}
    work, fractions = page.handle_steps({"tab": "draw_modulation", "state": state}), []
    while True:
        try:
            fractions.append(next(work)[0])
        except StopIteration as done:
            result = done.value
            break
    assert fractions == sorted(fractions) and fractions[0] == 0 and fractions[-1] < 1
    expected = page.handle({"tab": "draw_modulation", "state": state})
    assert result["samples"] == expected["samples"] and "modulation" in result


def test_handle_steps_says_what_it_does_next():
    from sonore_sketch import draw_modulation

    state = {"draw_modulation": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
             "carrier": "tones", "iterations": 2, "rms_depth": 0.2, "seed": 1, "items": draw_modulation.EXAMPLE_ITEMS}
    texts = [step[1] for step in page.handle_steps({"tab": "draw_modulation", "state": state}) if len(step) == 2]
    assert texts == ["Synthesizing", "Iteration 1 of 2", "Iteration 2 of 2", "Measuring the result"]


def test_handle_steps_gives_the_sound_before_its_pictures():
    # streaming.md, L4: on the tabs whose pictures take a while, one step holds the sound alone
    from sonore_sketch import draw_modulation

    state = {"draw_modulation": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
             "carrier": "tones", "iterations": 1, "rms_depth": 0.2, "seed": 1, "items": draw_modulation.EXAMPLE_ITEMS}
    work, early = page.handle_steps({"tab": "draw_modulation", "state": state}), []
    while True:
        try:
            step = next(work)
        except StopIteration as done:
            result = done.value
            break
        if len(step) == 3:
            early.append(step)
    assert len(early) == 1
    fraction, text, sound = early[0]
    assert fraction == page.MEASURED_AFTER["draw_modulation"] and text == "Measuring the result"
    assert sound["samples"] == result["samples"] and sound["spectrogram"] == result["spectrogram"] and "modulation" not in sound
    quick = [step for step in page.handle_steps({"tab": "draw_speech", "state": DOCUMENT}) if len(step) == 3]
    assert quick == []  # the other tabs' pictures come with the sound


def test_a_document_without_its_tabs_section_says_so():
    document = {**PAGE, "tab": "draw_spectrogram"}
    document.pop("draw_spectrogram", None)
    with pytest.raises(ValueError, match="no 'draw_spectrogram' section"):
        page.synthesize(document)


def test_only_links_to_other_sites_open_a_new_tab():
    """The same rule as sonore's pages: links to sonore and within sonore-sketch (both on
    choyun1.github.io) stay in this tab; links to other sites, such as GitHub, open a new one."""
    root = Path(__file__).resolve().parents[1]
    for tag in re.findall(r"<a [^>]*>", (root / "index.html").read_text()):
        href = re.search(r'href="([^"]*)"', tag)
        outside = bool(href) and re.match(r"https?://(?!choyun1\.github\.io/)", href.group(1))
        assert ('target="_blank"' in tag) == bool(outside), tag
