"""Measure how long sonore takes to load and to synthesize speech in a browser.

This script runs sonore to measure it; it is not an independent check. It
answers one question for the design document (docs/design/tabs/draw_speech.md):
is sonore under Pyodide fast enough to be the synthesizer behind a drawing
interface in a web page?

It opens a headless Chromium with Playwright, loads Pyodide from its CDN,
installs sonore from PyPI with micropip, and times:

- the page load: Pyodide itself, micropip, and ``import sonore`` with its
  dependencies (numpy, scipy, matplotlib, soundfile), once with an empty
  browser cache (cold) and once more in the same browser profile (warm);
- ``so.klatt_synthesize`` at 16 kHz for 1 s, 3 s and 10 s of speech, with F0, AV
  and F1-F3 given as tracks of a few breakpoints (each moving formant runs
  sonore's per-sample resonator loop), and the same with every parameter
  constant (the resonators then run through ``scipy.signal.lfilter``): the
  first call in a session (cold) and the median of the next few (warm);
- one sine-wave tone per formant through ``so.harmonic_complex`` with
  ``harmonics=[1]``, the route a sine-wave speech function would take.

``--native`` runs the same synthesis timings in this Python instead of the
browser, as a baseline; it needs ``pip install sonore==0.4.0`` and no
network.

    pip install playwright sonore==0.4.0
    playwright install chromium          # once, unless a Chromium is already set up
    python tools/measure_pyodide_latency.py
    python tools/measure_pyodide_latency.py --native

The browser run needs the Pyodide CDN (cdn.jsdelivr.net) and PyPI
(pypi.org, files.pythonhosted.org). Results are printed and also written as
JSON with ``--json PATH``.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import tempfile
import time

SONORE_VERSION = "0.4.0"
PYODIDE_VERSION = "314.0.7"  # the npm "latest" tag on 2026-10-03
WARM_REPEATS = 3
FS = 16000

# The synthesis benchmark, run as-is both in Pyodide and natively. It prints
# one JSON object. Tracks are a "we were away"-like male talker contour with
# a few breakpoints each, as a user would draw them.
BENCHMARK = r"""
import json, statistics, time
import numpy as np
import sonore as so

FS = __FS__
WARM_REPEATS = __WARM_REPEATS__

def drawn_tracks(duration):
    times = duration * np.array([0.0, 0.2, 0.5, 0.8, 1.0])
    return {
        "F0": (times, [110, 125, 115, 100, 90]),
        "AV": (times, [0, 60, 60, 60, 0]),
        "F1": (times, [300, 450, 650, 500, 350]),
        "F2": (times, [800, 1200, 1700, 1500, 1100]),
        "F3": (times, [2300, 2400, 2600, 2500, 2400]),
    }

def constant_tracks(duration):
    return {"F0": 110.0, "AV": 60.0, "F1": 500.0, "F2": 1500.0, "F3": 2500.0}

def sine_wave_tones(duration):
    tracks = drawn_tracks(duration)
    return sum(
        so.harmonic_complex(duration, FS, tracks[name], harmonics=[1]).data[:, 0]
        for name in ("F1", "F2", "F3")
    )

def klatt(make_tracks):
    return lambda duration: so.klatt_synthesize(duration, FS, make_tracks(duration))

def timed(function, duration):
    start = time.perf_counter()
    function(duration)
    return time.perf_counter() - start

cases = {
    "klatt, drawn tracks": klatt(drawn_tracks),
    "klatt, constant parameters": klatt(constant_tracks),
    "sine-wave tones (3)": sine_wave_tones,
}
results = []
for name, function in cases.items():
    for duration in (1.0, 3.0, 10.0):
        cold = timed(function, duration)
        warm = statistics.median(timed(function, duration) for _ in range(WARM_REPEATS))
        results.append({"case": name, "duration_s": duration, "cold_s": cold, "warm_s": warm})
json.dumps(results)
"""


def benchmark_code() -> str:
    return BENCHMARK.replace("__FS__", str(FS)).replace("__WARM_REPEATS__", str(WARM_REPEATS))


PAGE_SCRIPT = """
async ([indexUrl, sonoreVersion, benchmark]) => {
  const timings = {};
  let start = performance.now();
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = indexUrl + "pyodide.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("could not load " + script.src));
    document.head.appendChild(script);
  });
  const pyodide = await loadPyodide({ indexURL: indexUrl });
  timings.load_pyodide_s = (performance.now() - start) / 1000;
  start = performance.now();
  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");
  await micropip.install("sonore==" + sonoreVersion);
  timings.install_sonore_s = (performance.now() - start) / 1000;
  start = performance.now();
  pyodide.runPython("import sonore");
  timings.import_sonore_s = (performance.now() - start) / 1000;
  timings.python = pyodide.runPython("import sys; sys.version");
  timings.pyodide = pyodide.version;
  timings.browser = { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency };
  timings.synthesis = JSON.parse(pyodide.runPython(benchmark));
  return timings;
}
"""


def run_browser(index_url: str, chromium: str | None) -> list[dict]:
    from playwright.sync_api import sync_playwright

    runs = []
    with tempfile.TemporaryDirectory() as profile, sync_playwright() as playwright:
        browser = playwright.chromium.launch_persistent_context(profile, headless=True, executable_path=chromium)
        for label in ("cold cache", "warm cache"):
            page = browser.new_page()
            page.on("console", lambda message: print("  [browser]", message.text, file=sys.stderr))
            page.goto("about:blank")
            result = page.evaluate(PAGE_SCRIPT, [index_url, SONORE_VERSION, benchmark_code()])
            result["page_load"] = label
            runs.append(result)
            page.close()
        browser.close()
    return runs


def run_native() -> dict:
    namespace: dict = {}
    *body, last = benchmark_code().strip().splitlines()
    exec("\n".join(body), namespace)
    import numpy
    import scipy
    import sonore

    return {
        "python": sys.version,
        "platform": platform.platform(),
        "processor": platform.processor() or platform.machine(),
        "versions": {"sonore": sonore.__version__, "numpy": numpy.__version__, "scipy": scipy.__version__},
        "synthesis": namespace["results"],
    }


def print_synthesis(rows: list[dict]) -> None:
    print(f"  {'case':<28s} {'sound':>6s} {'cold':>8s} {'warm':>8s}")
    for row in rows:
        print(f"  {row['case']:<28s} {row['duration_s']:5.0f}s {row['cold_s']:7.3f}s {row['warm_s']:7.3f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--native", action="store_true", help="time the synthesis in this Python instead")
    parser.add_argument("--pyodide-version", default=PYODIDE_VERSION)
    parser.add_argument("--index-url", help="Pyodide's full/ folder (default: jsDelivr for --pyodide-version)")
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    parser.add_argument("--json", help="also write the results to this file")
    args = parser.parse_args()

    if args.native:
        result = run_native()
        print(f"native Python {result['python'].split()[0]} on {result['platform']}, {result['versions']}")
        print_synthesis(result["synthesis"])
    else:
        index_url = args.index_url or f"https://cdn.jsdelivr.net/pyodide/v{args.pyodide_version}/full/"
        wall_start = time.perf_counter()
        result = run_browser(index_url, args.chromium)
        for run in result:
            print(f"Pyodide {run['pyodide']} (Python {run['python'].split()[0]}), {run['page_load']}:")
            print(
                f"  load Pyodide {run['load_pyodide_s']:.2f}s, install sonore {run['install_sonore_s']:.2f}s, "
                f"import sonore {run['import_sonore_s']:.2f}s"
            )
            print_synthesis(run["synthesis"])
        print(f"total {time.perf_counter() - wall_start:.1f}s")
    if args.json:
        with open(args.json, "w") as file:
            json.dump(result, file, indent=2)


if __name__ == "__main__":
    main()
