"""The starting sounds made ahead of time (tools/make_examples.py) are still
what the page would make: for each tab's current starting drawing, and with
this Python's sonore. Run ``python tools/make_examples.py`` when this fails."""

from __future__ import annotations

import base64
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from make_examples import TABS, starting_states  # noqa: E402

from sonore_sketch.page import handle  # noqa: E402


def example(tab):
    return json.loads((ROOT / "app" / "examples" / f"{tab}.json").read_text())


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node to read the page's starting drawings")
def test_each_example_is_of_its_tabs_starting_drawing():
    states = starting_states()
    for tab in TABS:
        assert example(tab)["state"] == states[tab], f"app/examples/{tab}.json is of an older drawing: run tools/make_examples.py"


# Texture synthesis amplifies roundoff from iteration to iteration, so other
# NumPy and SciPy releases make a slightly different sound from the same
# state: after 10 iterations of the starting 2 s, NumPy 2.4 and SciPy 1.17
# differ from NumPy 2.5 and SciPy 1.18 by up to 1.8 at RMS 1, correlated 0.998
# (after 3 iterations, by 2e-8). There the example must sound the same, not
# match sample by sample.
ROUNDOFF_GROWS = {"match_texture"}


@pytest.mark.parametrize("tab", TABS)
def test_each_example_sounds_as_sonore_makes_it(tab):
    made = example(tab)
    result = handle({"tab": tab, "state": made["state"]})
    stored = np.frombuffer(base64.b64decode(made["result"]["samples"]), dtype="<f4")
    samples = np.frombuffer(result["samples"], dtype="<f4")
    if tab in ROUNDOFF_GROWS:
        assert stored.size == samples.size
        assert np.corrcoef(stored, samples)[0, 1] > 0.99
    else:
        np.testing.assert_allclose(stored, samples, atol=1e-5)
