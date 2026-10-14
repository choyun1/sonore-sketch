"""Time how long the page takes to get ready, on a first visit and on later ones.

It opens the page (Pyodide engine) in a headless Chromium with its own
profile, waits until it is ready, closes the browser and opens it again in
the same profile, so each later visit has the HTTP cache a returning visitor
has and nothing else. It prints, for each visit, the seconds until Play works
(the starting sound, made ahead of time) and until Python is ready for the
visitor's own drawings, and, from the page's Log, how long each part of
loading took (Pyodide, the packages, ``import sonore``).

    pip install playwright
    python tools/measure_load.py                      # this checkout, served by tools/serve.py
    python tools/measure_load.py --url https://choyun1.github.io/sonore-sketch/

Needs cdn.jsdelivr.net and files.pythonhosted.org.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from check_page import free_port  # noqa: E402


def visit(playwright, profile: str, url: str, chromium: str | None) -> tuple[float, float, str]:
    context = playwright.chromium.launch_persistent_context(profile, headless=True, executable_path=chromium)
    try:
        page = context.new_page()
        start = time.perf_counter()
        page.goto(url)
        failed = "document.getElementById('loading').classList.contains('failed')"
        page.wait_for_function(f"!document.getElementById('play').disabled || {failed}", timeout=300_000)
        playable = time.perf_counter() - start  # the starting sound, made ahead of time
        page.wait_for_function(f"document.getElementById('loading').hidden || {failed}", timeout=300_000)
        seconds = time.perf_counter() - start  # Python ready for the visitor's own drawings
        page.click("#log-toggle")
        lines = page.locator("#log-lines").inner_text()
        if page.locator("#loading").evaluate("e => e.classList.contains('failed')"):
            raise SystemExit(f"the page could not load:\n{lines}")
        timing = next((line.strip() for line in lines.splitlines() if "loaded in" in line), "")
        return playable, seconds, timing
    finally:
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="the page to time, instead of serving this checkout")
    parser.add_argument("--visits", type=int, default=3, help="visits in one profile; the first is cold")
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    args = parser.parse_args()

    from playwright.sync_api import sync_playwright

    server = None
    url = args.url
    if url is None:
        port = free_port()
        server = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "--port", str(port)], stdout=subprocess.DEVNULL)
        url = f"http://127.0.0.1:{port}/"
        time.sleep(1)
    try:
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as playwright:
            for n in range(args.visits):
                playable, seconds, timing = visit(playwright, profile, url, args.chromium)
                print(f"visit {n + 1} ({'cold' if n == 0 else 'warm'}): playable in {playable:.1f} s, ready in {seconds:.1f} s  {timing}", flush=True)
    finally:
        if server:
            server.terminate()


if __name__ == "__main__":
    main()
