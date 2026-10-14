"""Make each tab's starting sound ahead of time, so the page can play it at once.

The page opens on each tab's starting drawing (app/document.js, defaultPage)
and has to wait for Pyodide and sonore, several seconds on every visit,
before it can make a sound (docs/design/app.md, M1). This synthesizes those
drawings here, with the same ``page.handle``, and writes what the page's
local engine would get back to app/examples/<tab>.json, with the tab's state
it was made from. The page plays these until Python is ready; any edit is
made by Python as before.

Run it again whenever a tab's starting drawing, the synthesis or the sonore
version changes (tests/test_examples.py fails until then):

    pip install -e .
    python tools/make_examples.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tools"))

TABS = ["tracks", "painted", "blobs", "edit", "mask", "paths", "events"]

DUMP = """
import { defaultPage, tabState } from "./app/document.js";
console.log(JSON.stringify(Object.fromEntries(%s.map((tab) => [tab, tabState(defaultPage(tab), tab)]))));
"""


def starting_states() -> dict[str, dict]:
    """Each tab's state for the page's starting drawing on that tab, from the page's own code."""
    out = subprocess.run(["node", "--input-type=module", "-e", DUMP % json.dumps(TABS)], cwd=ROOT, check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def main() -> None:
    from serve import encode
    from sonore_sketch.page import handle

    folder = ROOT / "app" / "examples"
    folder.mkdir(exist_ok=True)
    for tab, state in starting_states().items():
        result = encode(handle({"tab": tab, "state": state}))
        path = folder / f"{tab}.json"
        path.write_text(json.dumps({"tab": tab, "state": state, "result": result}, separators=(",", ":")) + "\n")
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1000:.0f} kB")


if __name__ == "__main__":
    main()
