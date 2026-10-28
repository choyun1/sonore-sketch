"""Take the README's screenshots: Draw speech, Draw spectrogram and Draw path,
then Draw a voice, Draw a room and Match a texture.

Each tab is shown as it opens (its example), 1280 × 823, with the local
engine, and saved to docs/screenshots/. The themes alternate along each row
of the README's two (dark, light, dark, then light, dark, light), so it
shows both. Retake them when the header, the toolbar or a tab's example changes.

    pip install -e . playwright
    python tools/make_screenshots.py
    python tools/make_screenshots.py --chromium /path/to/chromium

It starts tools/serve.py itself on a free port.
"""

from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SETTLE_S = 12
SHOTS = {
    "draw_speech": ("draw-speech.png", "dark"),
    "draw_spectrogram": ("draw-spectrogram.png", "light"),
    "draw_path": ("draw-path.png", "dark"),
    "draw_voice": ("draw-a-voice.png", "light"),
    "draw_room": ("draw-a-room.png", "dark"),
    "match_texture": ("match-a-texture.png", "light"),
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    parser.add_argument("--out", default=str(ROOT / "docs" / "screenshots"))
    args = parser.parse_args()
    port = free_port()
    server = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "--port", str(port)])
    try:
        time.sleep(2)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium)
            for tab, (name, theme) in SHOTS.items():
                page = browser.new_page(viewport={"width": 1280, "height": 823}, color_scheme=theme)
                page.goto(f"http://127.0.0.1:{port}/?engine=local")
                page.wait_for_function("!document.querySelector('#play').disabled", timeout=120_000)
                page.click(f"button[data-tab={tab}]")
                time.sleep(SETTLE_S)  # the tab's first sound and its Result panels
                page.mouse.move(5, 5)
                page.screenshot(path=str(Path(args.out) / name))
                page.close()
                print(name)
            browser.close()
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
