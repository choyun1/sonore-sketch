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


@pytest.mark.parametrize("tab", TABS)
def test_each_example_sounds_as_sonore_makes_it(tab):
    made = example(tab)
    result = handle({"tab": tab, "state": made["state"]})
    stored = np.frombuffer(base64.b64decode(made["result"]["samples"]), dtype="<f4")
    np.testing.assert_allclose(stored, np.frombuffer(result["samples"], dtype="<f4"), atol=1e-5)
