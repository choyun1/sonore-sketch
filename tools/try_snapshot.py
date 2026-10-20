"""Try Pyodide's experimental memory snapshot for the page's start-up.

An experiment, not a test: it answers whether a returning visitor could skip
loading NumPy, SciPy and sonore by restoring a snapshot of Pyodide's memory
saved on an earlier visit (loadPyodide's ``_makeSnapshot`` / ``_loadSnapshot``
options, which Pyodide marks private).

In one Chromium profile, each step in a fresh browser:

1. ``baseline``: load as the page does, and run one synthesis.
2. ``make-full``: load, import sonore_sketch, snapshot, keep it in Cache Storage.
3. ``load-full``: restore that snapshot and run one synthesis.
   ``load-full-reload`` also loads the packages again after restoring.
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
FILES = json.loads((ROOT / "src" / "sonore_sketch" / "files.json").read_text())

# One synthesis that goes through sonore, NumPy and SciPy's compiled code.
RUN = """
from sonore_sketch import page, draw_modulation
state = {"draw_modulation": 1, "duration": 0.5, "fs": 16000, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
         "carrier": "tones", "iterations": 2, "rms_depth": 0.2, "seed": 1, "items": draw_modulation.EXAMPLE_ITEMS}
len(page.handle({"tab": "draw_modulation", "state": state})["samples"])
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
  // JS objects Python still holds (from loading packages) cannot go in a
  // snapshot; this keeps only their type, so restoring gets nothing for them.
  const serializer = (obj) => ({ dropped: typeof obj });
  const deserializer = () => undefined;
  const store = async (py) => {
    const snapshot = py.makeMemorySnapshot({ serializer });
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
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _loadSnapshot: bytes, _snapshotDeserializer: deserializer }));
      out.samples = await attempt("synthesis", () => py.runPython(run));
    } else if (step === "load-full-reload") {
      // The same, then load the packages again so their compiled code is back.
      const bytes = await attempt("read", restore);
      const py = await attempt("pyodide", () => loadPyodide({ indexURL, _loadSnapshot: bytes, _snapshotDeserializer: deserializer }));
      await attempt("packages", () => py.loadPackage(["numpy", "scipy", wheel]));
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


def run_step(step: str, profile: str, port: int, chromium: str | None) -> None:
    from playwright.sync_api import sync_playwright

    index_url = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE}/full/"
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(profile, headless=True, executable_path=chromium)
        try:
            page = context.new_page()
            console: list[str] = []
            page.on("console", lambda m: m.type == "error" and console.append(m.text[:300]))
            page.on("crash", lambda _: print(f"{step:16s} the page crashed", flush=True))
            page.goto(f"http://127.0.0.1:{port}/?engine=local")  # an origin to work in, with no Pyodide of its own
            result = page.evaluate(STEP, [index_url, WHEEL, FILES, RUN, step])
            if "error" in result and console:
                result["console"] = console[:3]
            print(f"{step:16s} {json.dumps(result)}", flush=True)
        finally:
            context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    parser.add_argument("--repeats", type=int, default=2, help="how many times to repeat each restoring step")
    parser.add_argument("--step", help=argparse.SUPPRESS)  # one step, in a process of its own
    parser.add_argument("--profile", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.step:
        return run_step(args.step, args.profile, args.port, args.chromium)

    port = free_port()
    server = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "--port", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    steps = ["baseline", "baseline", "make-full"] + ["load-full"] * args.repeats + ["load-full-reload", "make-boot"] + ["load-boot"] * args.repeats
    try:
        with tempfile.TemporaryDirectory() as profile:
            for step in steps:
                command = [sys.executable, __file__, "--step", step, "--profile", profile, "--port", str(port)]
                if args.chromium:
                    command += ["--chromium", args.chromium]
                try:
                    subprocess.run(command, timeout=120)
                except subprocess.TimeoutExpired:
                    print(f"{step:16s} no answer after 120 s (the restored Python hung)", flush=True)
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
