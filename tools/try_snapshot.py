"""Try Pyodide's experimental memory snapshot for the page's start-up.

An experiment, not a test: it answers whether a returning visitor could skip
loading NumPy, SciPy and sonore by restoring a snapshot of Pyodide's memory
saved on an earlier visit (loadPyodide's ``_makeSnapshot`` / ``_loadSnapshot``
options, which Pyodide marks private).

In one Chromium profile, each step in a fresh browser:

1. ``baseline``: load as the page does, and run one synthesis.
2. ``make-full``: load, import sonore_sketch, snapshot, keep it in Cache Storage.
3. ``load-full``: restore that snapshot and run one synthesis.
4. ``make-boot`` / ``load-boot``: the same with a snapshot taken right after
   Pyodide starts, before any package; the packages are loaded after restoring.

    pip install -e . playwright
    python tools/try_snapshot.py

Needs cdn.jsdelivr.net and files.pythonhosted.org.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from check_page import free_port  # noqa: E402

WORKER = (ROOT / "app" / "worker.js").read_text()
PYODIDE = re.search(r'PYODIDE_VERSION = "([^"]+)"', WORKER).group(1)
WHEEL = re.search(r'SONORE_WHEEL =\s*"([^"]+)"', WORKER).group(1)
FILES = re.findall(r'"([^"]+\.py)"', re.search(r"PYTHON_FILES = \[([^\]]*)\]", WORKER).group(1))

# One synthesis that goes through sonore, NumPy and SciPy's compiled code.
RUN = """
from sonore_sketch import page, blobs
state = {"blobs": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
         "carrier": "tones", "iterations": 2, "rms_depth": 0.2, "seed": 1, "items": blobs.EXAMPLE_ITEMS}
len(page.handle({"tab": "blobs", "state": state})["samples"])
"""

STEP = r"""
async ([indexURL, wheel, files, run, step]) => {
  const t0 = performance.now();
  const out = {};
  const mark = (name) => (out[name] = +((performance.now() - t0) / 1000).toFixed(2));
  const attempt = async (name, f) => {
    try {
      const value = await f();
      mark(name);
      return value;
    } catch (error) {
      out.error = `${name}: ${String(error).slice(-1200)}`;
      throw error;
    }
  };
  const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
  const sources = files.map(async (name) => [name, await (await fetch(`src/sonore_sketch/${name}`)).text()]);
  const packages = async (py) => {
    await py.loadPackage(["numpy", "scipy", wheel]);
    py.FS.mkdirTree("/home/pyodide/sonore_sketch");
    for (const [name, text] of await Promise.all(sources)) py.FS.writeFile(`/home/pyodide/sonore_sketch/${name}`, text);
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  };
  const imports = (py) => py.runPython("import sonore, sonore_sketch.page");
  const store = async (py) => {
    const snapshot = py.makeMemorySnapshot();
    out.megabytes = +(snapshot.length / 1e6).toFixed(1);
    await (await caches.open("snapshot")).put(`/${step.split("-")[1]}`, new Response(snapshot));
  };
  const restore = async () => {
    const response = await (await caches.open("snapshot")).match(`/${step.split("-")[1]}`);
    if (!response) throw new Error("no snapshot stored");
    const bytes = new Uint8Array(await response.arrayBuffer());
    out.megabytes = +(bytes.length / 1e6).toFixed(1);
    return bytes;
  };
  try {
    if (step === "baseline") {
      const py = await attempt("pyodide", () => loadPyodide({ indexURL }));
      await attempt("packages", () => packages(py));
      await attempt("import", () => imports(py));
      out.samples = await attempt("synthesis", () => py.runPython(run));
    } else if (step === "make-full") {
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _makeSnapshot: true }));
      await attempt("packages", () => packages(py));
      await attempt("import", () => imports(py));
      await attempt("snapshot", () => store(py));
      out.samples = await attempt("synthesis", () => py.runPython(run));
    } else if (step === "load-full") {
      const bytes = await attempt("read", restore);
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _loadSnapshot: bytes }));
      out.samples = await attempt("synthesis", () => py.runPython(run));
    } else if (step === "make-boot") {
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _makeSnapshot: true }));
      await attempt("snapshot", () => store(py));
    } else if (step === "load-boot") {
      const bytes = await attempt("read", restore);
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _loadSnapshot: bytes }));
      await attempt("packages", () => packages(py));
      await attempt("import", () => imports(py));
      out.samples = await attempt("synthesis", () => py.runPython(run));
    }
  } catch {}
  return out;
}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    parser.add_argument("--repeats", type=int, default=2, help="how many times to repeat each restoring step")
    args = parser.parse_args()

    from playwright.sync_api import sync_playwright

    port = free_port()
    server = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "--port", str(port)], stdout=subprocess.DEVNULL)
    time.sleep(1)
    index_url = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE}/full/"
    steps = ["baseline", "baseline", "make-full"] + ["load-full"] * args.repeats + ["make-boot"] + ["load-boot"] * args.repeats
    try:
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as playwright:
            for step in steps:
                context = playwright.chromium.launch_persistent_context(profile, headless=True, executable_path=args.chromium)
                try:
                    page = context.new_page()
                    console: list[str] = []
                    page.on("console", lambda m: m.type == "error" and console.append(m.text[:300]))
                    page.goto(f"http://127.0.0.1:{port}/?engine=local")
                    result = page.evaluate(STEP, [index_url, WHEEL, FILES, RUN, step])
                    if "error" in result and console:
                        result["console"] = console[:3]
                    print(f"{step:10s} {json.dumps(result)}", flush=True)
                finally:
                    context.close()
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
