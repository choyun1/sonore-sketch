"""Check the page in a headless Chromium: it loads, draws, plays and undoes.

This drives the real page (index.html) the way a person would, with
Playwright, and fails on any error in the browser console. By default it uses
the local engine (``?engine=local``: sonore in this Python, through
tools/serve.py), which needs no network; ``--engine pyodide`` loads Pyodide
and sonore from their CDNs in the browser, as visitors to the page do.

    pip install -e . playwright
    python tools/check_page.py                     # local engine
    python tools/check_page.py --engine pyodide    # needs cdn.jsdelivr.net and PyPI
    python tools/check_page.py --screenshot page.png

It starts tools/serve.py itself on a free port.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# The Draw speech example before it said "sonore": an /aɪ/-like glide, as a
# TrackDraw link, which the page still opens.
GLIDE = {
    "trackdraw": 1, "sonore": "0.8.0", "duration": 0.6, "fs": 16000, "mode": "klatt",
    "params": {
        "F0": [[0, 0.6], [125, 95]], "AV": [[0, 0.03, 0.55, 0.6], [0, 60, 60, 0]],
        "F1": [[0, 0.15, 0.45, 0.6], [700, 700, 400, 380]], "F2": [[0, 0.15, 0.45, 0.6], [1100, 1100, 2000, 2100]],
        "F3": [[0, 0.6], [2500, 2700]], "F4": 3500, "F5": 4500, "B1": 60, "B2": 90, "B3": 150, "B4": 200, "B5": 250,
    },
}


def page_document_in(page) -> dict:
    """The page's document, read back from its link (#state=...)."""
    state = page.evaluate("location.hash").split("state=")[1]
    return json.loads(base64.urlsafe_b64decode(state + "=" * (-len(state) % 4)))


def document_in(page) -> dict:
    """The Draw speech tab's drawing, as a TrackDraw document (sonore_sketch.page.tab_state)."""
    document = page_document_in(page)
    assert document.get("app") == "sonore-sketch" and document.get("version") == 3, document
    return {"trackdraw": 1, "sonore": document["sonore"], "duration": document["duration"], "fs": document["fs"], **document["draw_speech"]}


def edit_tab_state(document: dict) -> dict:
    """The Erase modulation tab's state of a saved document (sonore_sketch.page.tab_state)."""
    sys.path.insert(0, str(ROOT / "src"))
    from sonore_sketch import page as page_module

    return page_module.tab_state(document, "erase_modulation")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", choices=["local", "pyodide"], default="local")
    parser.add_argument("--pyodide-url", help="Pyodide's full/ folder, instead of jsDelivr (with --engine pyodide)")
    parser.add_argument("--chromium", help="path to a Chromium to use instead of Playwright's own")
    parser.add_argument("--screenshot", help="save a screenshot of the page here at the end")
    parser.add_argument("--headed", action="store_true", help="show the browser")
    args = parser.parse_args()

    from playwright.sync_api import expect, sync_playwright

    port = free_port()
    server = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "--port", str(port)], stdout=subprocess.DEVNULL)
    errors: list[str] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed, executable_path=args.chromium)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.on("console", lambda m: m.type == "error" and errors.append(m.text))
            page.on("pageerror", lambda e: errors.append(str(e)))
            for attempt in range(50):
                try:
                    extra = f"&pyodide={args.pyodide_url}" if args.pyodide_url else ""
                    page.goto(f"http://127.0.0.1:{port}/?engine={args.engine}{extra}")
                    break
                except Exception:
                    time.sleep(0.1)
            start = time.perf_counter()
            status = page.locator("#status")
            expect(status).to_contain_text("Made", timeout=180_000)
            print(f"ready and first sound made in {time.perf_counter() - start:.1f} s: {page.locator('#versions').inner_text()}")

            # Draw speech starts at its word's 0.6 s, the other tabs at 2 s,
            # while nothing is drawn yet (app.md, "Starting duration").
            expect(page.locator("#duration")).to_have_value("0.6")
            page.click(".tabs [data-tab=draw_spectrogram]")
            expect(page.locator("#duration")).to_have_value("2")
            expect(status).to_contain_text("Made", timeout=60_000)
            page.click(".tabs [data-tab=draw_speech]")
            expect(page.locator("#duration")).to_have_value("0.6")
            expect(status).to_contain_text("Made", timeout=60_000)
            print("starting duration: 0.6 s on Draw speech, 2 s on Draw spectrogram")

            # The page starts by saying "sonore"; the drawing checks below are
            # written for the earlier /aɪ/ example, so they start from it.
            default = document_in(page)
            assert "AF" in default["params"] and "FNZ" in default["params"], "the default is not sonore's word"

            def open_link(state):
                encoded = base64.urlsafe_b64encode(json.dumps(state).encode()).decode().rstrip("=")
                page.goto(f"http://127.0.0.1:{port}/?engine={args.engine}{extra}#state={encoded}")
                page.reload()

            open_link(GLIDE)
            expect(status).to_contain_text("Made", timeout=180_000)
            formants = page.locator(".panel-formants svg")
            box = formants.bounding_box()
            doc = document_in(page)
            x_of = lambda t: box["x"] + 52 + t / doc["duration"] * (box["width"] - 62)  # noqa: E731
            y_of = lambda hz: box["y"] + box["height"] - 8 - hz / 5000 * (box["height"] - 16)  # noqa: E731

            # Point: drag F2's breakpoint at 0.45 s from 2000 Hz up to 2300 Hz.
            page.keyboard.press("2")
            page.keyboard.press("p")
            page.mouse.move(x_of(0.45), y_of(2000))
            page.mouse.down()
            page.mouse.move(x_of(0.45), y_of(2300), steps=5)
            page.mouse.up()
            f2 = document_in(page)["params"]["F2"]
            assert abs(f2[1][2] - 2300) < 30, f"F2 breakpoint not dragged: {f2}"
            print(f"point: F2 at 0.45 s dragged to {f2[1][2]:.0f} Hz")

            # Line: F3 replaced between 0.1 s and 0.5 s.
            page.keyboard.press("3")
            page.keyboard.press("l")
            page.mouse.move(x_of(0.1), y_of(2400))
            page.mouse.down()
            page.mouse.move(x_of(0.5), y_of(3000), steps=5)
            page.mouse.up()
            f3 = document_in(page)["params"]["F3"]
            assert len(f3[0]) == 4 and abs(f3[1][1] - 2400) < 30 and abs(f3[1][2] - 3000) < 30, f3
            print(f"line: F3 is now {f3}")

            # With the Line tool still on, a press on a breakpoint's circle
            # drags that breakpoint instead of starting a new line.
            page.mouse.move(x_of(0.5), y_of(3000))
            page.mouse.down()
            page.mouse.move(x_of(0.5), y_of(3300), steps=5)
            page.mouse.up()
            dragged = document_in(page)["params"]["F3"]
            assert len(dragged[0]) == len(f3[0]) and abs(dragged[1][2] - 3300) < 30, f"circle not dragged: {dragged}"
            print(f"line tool on a circle: dragged to {dragged[1][2]:.0f} Hz, no new breakpoint")
            page.keyboard.press("Control+z")
            assert document_in(page)["params"]["F3"] == f3

            # Track keys go by physical key: 0 and the key left of 1 select F0.
            active = lambda: page.locator(".track-group button.active").text_content().split()[0]  # noqa: E731
            page.keyboard.press("0")
            assert active() == "F0", active()
            page.keyboard.press("4")
            page.keyboard.press("Backquote")
            assert active() == "F0", active()
            print("track keys: 0 and ` select F0")

            # Freehand on the F0 strip: a rise and fall becomes a few breakpoints.
            strip = page.locator(".panel-F0 svg").bounding_box()
            sx = lambda t: strip["x"] + 52 + t / doc["duration"] * (strip["width"] - 62)  # noqa: E731
            # The F0 strip is in octaves from 20 to 800 Hz.
            sy = lambda hz: strip["y"] + strip["height"] - 8 - math.log2(hz / 20) / math.log2(40) * (strip["height"] - 16)  # noqa: E731
            page.keyboard.press("f")
            page.mouse.move(sx(0.05), sy(110))
            page.mouse.down()
            for i in range(1, 41):
                t = 0.05 + 0.5 * i / 40
                page.mouse.move(sx(t), sy(110 + 60 * (1 - abs(2 * i / 40 - 1))))
            page.mouse.up()
            f0 = document_in(page)["params"]["F0"]
            assert 3 <= len(f0[0]) <= 12 and max(f0[1]) > 150, f"freehand F0 not simplified as expected: {f0}"
            print(f"freehand: F0 has {len(f0[0])} breakpoints, peak {max(f0[1]):.0f} Hz")
            # The F0 axis can be switched to linear and back; the drawing stays.
            log_top = page.locator(".panel-F0 .tick").last.text_content()
            page.locator('input[name="draw-speech-f0-scale"][value="linear"]').check()
            ticks = page.locator(".panel-F0 .tick").all_text_contents()
            assert ticks == ["0", "200", "400", "600", "800"] and log_top == "800", ticks
            assert document_in(page)["params"]["F0"] == f0, "switching the F0 axis changed the drawing"
            page.locator('input[name="draw-speech-f0-scale"][value="log"]').check()
            assert page.locator(".panel-F0 .tick").first.text_content() == "25"
            print("F0 axis: switched to linear and back to log")
            # The formants panel can reach 8 kHz, for the hiss of /s/, and back.
            page.locator('input[name="draw-speech-formant-top"][value="8000"]').check()
            assert page.locator(".panel-formants .tick").last.text_content() == "8k"
            page.locator('input[name="draw-speech-formant-top"][value="4000"]').check()
            assert page.locator(".panel-formants .tick").last.text_content() == "4k"
            page.locator('input[name="draw-speech-formant-top"][value="5000"]').check()
            assert page.locator(".panel-formants .tick").last.text_content() == "5k"
            print("formants up to: 8 kHz, 4 kHz and back to 5 kHz")
            expect(status).to_contain_text("Made", timeout=60_000)

            # Formant tracks can be hidden: no lines, presses on the panel do
            # nothing, and selecting a formant brings them back.
            page.uncheck(".show-formants")
            assert page.locator(".panel-formants .track").count() == 0, "formants still drawn"
            before = document_in(page)["params"]
            box = page.locator(".panel-formants svg").bounding_box()
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            assert document_in(page)["params"] == before, "a press on hidden formants changed the drawing"
            page.keyboard.press("2")
            assert page.locator(".show-formants").is_checked() and page.locator(".panel-formants .track").count() == 6
            print("formant tracks: hidden and shown again")

            # Noise: a line drawn on AF in the Noise strip is frication, and the
            # glide (no parallel formants on) gets the /s/'s settings with it.
            page.keyboard.press("h")  # H selects AH
            assert "active" in page.locator(".track-group button", has_text="AH").get_attribute("class")
            page.keyboard.press("s")  # S selects AF
            assert "active" in page.locator(".track-group button", has_text="AF").get_attribute("class")
            page.keyboard.press("l")
            page.locator(".panel-noise svg").scroll_into_view_if_needed()
            noise = page.locator(".panel-noise svg").bounding_box()
            nx = lambda t: noise["x"] + 52 + t / doc["duration"] * (noise["width"] - 62)  # noqa: E731
            ny = lambda db: noise["y"] + noise["height"] - 8 - db / 80 * (noise["height"] - 16)  # noqa: E731
            page.mouse.move(nx(0.05), ny(50))
            page.mouse.down()
            page.mouse.move(nx(0.2), ny(50), steps=5)
            page.mouse.up()
            params = document_in(page)["params"]
            assert abs(params["AF"][1][1] - 50) < 3 and params["A5"] == 50, params
            page.keyboard.press("Control+z")
            assert "AF" not in document_in(page)["params"], "undo did not take the frication away"
            page.keyboard.press("p")
            print("noise: AF drawn at 50 dB, with the /s/'s parallel formants, and undone")

            # Bandwidths: the strip shows the selected formant's, here B1.
            page.check(".show-bandwidths")
            page.keyboard.press("1")
            page.keyboard.press("l")
            page.locator(".panel-bandwidths svg").scroll_into_view_if_needed()
            bw = page.locator(".panel-bandwidths svg").bounding_box()
            bx = lambda t: bw["x"] + 52 + t / doc["duration"] * (bw["width"] - 62)  # noqa: E731
            by = lambda hz: bw["y"] + bw["height"] - 8 - hz / 600 * (bw["height"] - 16)  # noqa: E731
            page.mouse.move(bx(0), by(60))
            page.mouse.down()
            page.mouse.move(bx(0.6), by(300), steps=5)
            page.mouse.up()
            b1 = document_in(page)["params"]["B1"]
            assert abs(b1[1][0] - 60) < 10 and abs(b1[1][-1] - 300) < 10, b1
            print(f"bandwidth: B1 is now {b1}")
            page.keyboard.press("Control+z")
            page.uncheck(".show-bandwidths")

            # Undo the stroke, then redo it.
            page.keyboard.press("Control+z")
            assert document_in(page)["params"]["F0"] == doc["params"]["F0"], "undo did not restore F0"
            page.keyboard.press("Control+Shift+z")
            assert document_in(page)["params"]["F0"] == f0, "redo did not bring F0 back"
            print("undo and redo: ok")

            # Duration: stretching scales every breakpoint time.
            page.fill("#duration", "1.2")
            page.press("#duration", "Enter")
            stretched = document_in(page)
            assert stretched["duration"] == 1.2 and stretched["params"]["F3"][0] == [round(2 * t, 4) for t in f3[0]]
            print("duration: stretched to 1.2 s")

            # Play makes a sound and shows Stop while it plays.
            page.click("#play")
            expect(page.locator("#play")).to_have_text("■ Stop", timeout=60_000)
            expect(page.locator("#play")).to_have_text("▶ Play", timeout=10_000)
            print("play: played and ended")

            # The waveform is the only result picture; the spectrogram is drawn
            # in magma under the formants, which then sit on a pale halo.
            expect(page.locator("#spectrogram")).to_have_count(0)
            expect(page.locator(".panel-formants")).to_have_class(re.compile(r"\bon-spectrogram\b"))
            drawn = page.evaluate(
                """() => ['#waveform', '.panel-formants canvas.background'].map((selector) => {
                    const c = document.querySelector(selector);
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    const colors = new Set(); let n = 0;
                    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { n++; colors.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); }
                    return [n, colors.size]; })"""
            )
            assert drawn[0][0] and drawn[1][1] > 50, f"result pictures are empty or not in color: {drawn}"
            print(f"waveform drawn ({drawn[0][0]} pixels); spectrogram under the formants in {drawn[1][1]} colors")

            # A link from before breakpoint times were kept increasing (two F0
            # points at 0.3 s) is tidied on opening, and synthesizes.
            repeated = {**doc, "params": {**doc["params"], "F0": [[0, 0.3, 0.3, 0.6], [125, 100, 140, 95]]}}
            open_link(repeated)
            expect(status).to_contain_text("Made", timeout=180_000)
            assert document_in(page)["params"]["F0"] == [[0, 0.3, 0.6], [125, 140, 95]], document_in(page)["params"]["F0"]
            print("repeated breakpoint times in a link: tidied and synthesized")

            # A drawing sonore refuses (F1 above Nyquist at fs = 1000 Hz) puts
            # the error and its traceback in the log, and Clear recovers (at the
            # default sampling rate, on a steady schwa).
            before_failure = len(errors)
            open_link({**doc, "fs": 1000})
            expect(status).to_contain_text("Synthesis failed", timeout=180_000)
            expect(page.locator("#log-toggle")).to_have_text("Log (1)")
            page.click("#log-toggle")
            expect(page.locator("#log-lines .error")).to_contain_text("synthesis failed")
            assert "Traceback" in page.locator("#log-lines .error").inner_text(), "no traceback in the log"
            print("error: shown in the log with its traceback")
            page.click("#clear")
            expect(status).to_contain_text("Made", timeout=60_000)
            cleared = document_in(page)
            assert cleared["fs"] == 16000 and cleared["params"]["F1"] == 500 and cleared["params"]["AH"] == 0, cleared
            page.keyboard.press("Control+z")
            assert document_in(page)["fs"] == 1000, "Undo did not bring the drawing back after Clear"
            print("clear: a steady schwa at 16 kHz, and undo brings the old one back")
            # Reset goes back to what the page opened with: here, that link.
            page.keyboard.press("Control+Shift+z")
            page.click("#reset")
            assert document_in(page)["fs"] == 1000, "Reset did not go back to the drawing the page opened with"
            print("reset: back to the drawing in the link the page opened with")
            # The local server answers the refused drawing (twice: opened, then
            # undone back to) with HTTP 400, which the browser reports in its
            # console; those are expected.
            page.wait_for_timeout(500)
            errors[before_failure:] = [e for e in errors[before_failure:] if "400 (Bad Request)" not in e]
            open_link(default)
            expect(status).to_contain_text("Made", timeout=180_000)

            # The Draw spectrogram tab: the example plays; a stroke changes the painting
            # and is heard; Clear leaves nothing to hear; Undo brings it back.
            page.click(".tabs [data-tab=draw_spectrogram]")
            expect(page.locator("#tab-draw_spectrogram")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["tab"] == "draw_spectrogram"
            example = page_document_in(page)["draw_spectrogram"]["levels"]
            canvas = page.locator("canvas.paint").bounding_box()
            px = lambda fraction: canvas["x"] + 52 + fraction * (canvas["width"] - 62)  # noqa: E731
            py = lambda f: canvas["y"] + canvas["height"] - 22 - math.log2(f / 100) / 6 * (canvas["height"] - 30)  # noqa: E731
            page.locator("#tab-draw_spectrogram .level").fill("-6")
            before = page.evaluate("location.hash")
            page.mouse.move(px(0.05), py(5000))
            page.mouse.down()
            page.mouse.move(px(0.4), py(5000), steps=12)
            page.mouse.up()
            page.wait_for_function("(before) => location.hash !== before", arg=before, timeout=10_000)
            expect(status).to_contain_text("Made", timeout=60_000)
            painted = page_document_in(page)["draw_spectrogram"]
            assert painted["levels"] != example, "the stroke did not change the painting"
            from sonore_sketch import draw_spectrogram  # the Python half reads what the page wrote

            grid = draw_spectrogram.levels({**painted, "duration": 0.6, "fs": 16000})
            row, column = round(math.log2(5000 / 100) * 12 - 0.5), round(0.2 * 256 - 0.5)
            assert grid[row, column] == -6, grid[row - 2 : row + 3, column]
            print(f"Draw spectrogram: a stroke at 5 kHz painted at {grid[row, column]:g} dB and was heard")
            page.click("#clear")
            expect(status).to_contain_text("Nothing painted yet", timeout=10_000)
            page.mouse.move(px(0.5), canvas["y"] - 30)  # off the canvas, so keys go to the page
            page.keyboard.press("Control+z")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_spectrogram"]["levels"] == painted["levels"], "undo did not restore the painting"
            page.click("#reset")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_spectrogram"]["levels"] == example, "Reset did not bring the example painting back"
            print("Draw spectrogram: Clear, Undo and Reset work")
            page.select_option("#tab-draw_spectrogram .carrier", "noise")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_spectrogram"]["carrier"] == "noise"
            page.click(".tabs [data-tab=draw_speech]")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert document_in(page) == default, "the Tracks drawing changed while painting"
            print("Draw spectrogram: Clear, Undo, the noise carrier and switching tabs work")
            # The arrow keys, Home and End move between the tabs (the WAI-ARIA tabs
            # pattern), and only the tab shown is in the Tab order.
            page.keyboard.press("ArrowLeft")  # from the first tab round to the last
            expect(page.locator("#tab-quilt_sound")).to_be_visible()
            assert page.evaluate("document.activeElement.dataset.tab") == "quilt_sound"
            page.keyboard.press("Home")
            expect(page.locator("#tab-draw_speech")).to_be_visible()
            assert page.locator(".tabs [tabindex='0']").get_attribute("data-tab") == "draw_speech"
            assert page.locator(".tabs [role=tab][tabindex='-1']").count() == 7
            expect(status).to_contain_text("Made", timeout=60_000)
            print("tabs: the arrow keys and Home move between the tabs")

            # The Draw path tab: the example plays; a stroke on the top view
            # replaces the path and is heard; a stroke on the elevation track
            # lifts it; a stroke on the speed track and Even speed set the
            # speed; Clear leaves nothing to hear; Undo brings it back.
            page.click(".tabs [data-tab=draw_path]")
            expect(page.locator("#tab-draw_path")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            example_path = page_document_in(page)["draw_path"]
            view = page.locator("canvas.top-view").bounding_box()
            middle_x, middle_y = view["x"] + view["width"] / 2, view["y"] + view["height"] / 2
            page.mouse.move(middle_x - 120, middle_y - 60)
            page.mouse.down()
            for step in range(1, 31):
                page.mouse.move(middle_x - 120 + 8 * step, middle_y - 60 - 2 * step)
                page.wait_for_timeout(10)
            page.mouse.up()
            drawn = page_document_in(page)["draw_path"]["stroke"]
            assert len(drawn) >= 20 and drawn != example_path["stroke"], drawn[:3]
            assert drawn[0][1] < 0 < drawn[-1][1] and drawn[-1][2] > drawn[0][2] > 0, (drawn[0], drawn[-1])  # left to right, ahead, moving away
            assert all(later[0] >= earlier[0] for earlier, later in zip(drawn, drawn[1:]))
            expect(status).to_contain_text("Made", timeout=120_000)
            lift = page.locator("canvas.elevation").bounding_box()
            page.mouse.move(lift["x"] + 60, lift["y"] + lift["height"] - 40)
            page.mouse.down()
            page.mouse.move(lift["x"] + lift["width"] / 2, lift["y"] + 12, steps=10)
            page.mouse.up()
            elevation = page_document_in(page)["draw_path"]["elevation"]
            assert isinstance(elevation, list) and max(elevation[1]) > 45, elevation
            expect(status).to_contain_text("Made", timeout=120_000)
            # the speed track: a stroke across its second half makes that half fast
            assert page_document_in(page)["draw_path"]["speed"] is None
            speed = page.locator("canvas.speed").bounding_box()
            page.mouse.move(speed["x"] + speed["width"] * 0.55, speed["y"] + 14)
            page.mouse.down()
            page.mouse.move(speed["x"] + speed["width"] + 20, speed["y"] + 14, steps=10)  # past its end, which holds it at the end
            page.mouse.up()
            shaped = page_document_in(page)["draw_path"]["speed"]
            assert shaped and shaped[1][-1] > 2 * shaped[1][0], shaped
            expect(status).to_contain_text("Made", timeout=120_000)
            page.click("#tab-draw_path .even")
            assert len(set(page_document_in(page)["draw_path"]["speed"][1])) == 1
            expect(status).to_contain_text("Made", timeout=120_000)
            from sonore_sketch import page as page_module  # the Python half hears what the page wrote

            heard = page_module.handle({"tab": "draw_path", "state": page_module.tab_state(page_document_in(page), "draw_path")})
            assert "samples_right" in heard and heard["fs"] == 32000
            page.click("#clear")
            expect(status).to_contain_text("No path yet")
            page.keyboard.press("Control+z")
            assert page_document_in(page)["draw_path"]["stroke"] == drawn
            expect(status).to_contain_text("Made", timeout=120_000)
            page.click(".tabs [data-tab=draw_speech]")
            expect(status).to_contain_text("Made", timeout=60_000)
            print("Draw path: a stroke, a speed and an elevation are drawn and heard in two ears; Clear and Undo work")

            # The Scatter events tab: the example plays; a stroke on the rate
            # track makes the rate rise, and is heard; a slider applies when
            # let go; New draw changes the seed; Clear makes the rate flat.
            page.click(".tabs [data-tab=scatter_events]")
            expect(page.locator("#tab-scatter_events")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            rate_box = page.locator("canvas.rate").bounding_box()
            page.mouse.move(rate_box["x"] + 60, rate_box["y"] + rate_box["height"] - 30)
            page.mouse.down()
            page.mouse.move(rate_box["x"] + rate_box["width"] - 20, rate_box["y"] + 15, steps=20)
            page.mouse.up()
            rate = page_document_in(page)["scatter_events"]["rate"]
            drawn_rate = rate[1][1:-1]  # the ends outside the stroke keep the starting 10 per second
            assert isinstance(rate, list) and max(drawn_rate) > 100 and drawn_rate[-1] > 10 * drawn_rate[0], rate
            expect(status).to_contain_text("Made", timeout=120_000)
            # a stroke drawn back and forth keeps only its newest pass, not a
            # zigzag between passes: back and forth at two heights, ending low
            page.mouse.move(rate_box["x"] + 100, rate_box["y"] + 20)
            page.mouse.down()
            for i, (x, steps) in enumerate([(300, 15), (100, 11), (300, 13), (100, 17)]):  # passes interleave in time
                page.mouse.move(rate_box["x"] + x, rate_box["y"] + (20 if i < 3 else rate_box["height"] - 30), steps=steps)
            page.mouse.up()
            redrawn = page_document_in(page)["scatter_events"]["rate"]
            rises = [later > earlier for earlier, later in zip(redrawn[1], redrawn[1][1:]) if later != earlier]
            turns = sum(a != b for a, b in zip(rises, rises[1:]))
            assert turns <= 4, redrawn  # a zigzag between passes turns at nearly every breakpoint
            expect(status).to_contain_text("Made", timeout=120_000)
            regularity = page.locator("#tab-scatter_events .knob[data-knob=regularity] input[type=range]")
            regularity.fill("1000")
            regularity.dispatch_event("change")
            assert page_document_in(page)["scatter_events"]["regularity"] == 64
            expect(status).to_contain_text("Made", timeout=120_000)
            # a value typed in the box beside a slider applies, kept to the slider's range and step
            typed = page.locator("#tab-scatter_events .knob[data-knob=length] .slider-value")
            typed.fill("250.4")
            typed.press("Enter")
            assert page_document_in(page)["scatter_events"]["length"] == 0.25
            assert typed.input_value() == "250"
            expect(status).to_contain_text("Made", timeout=120_000)
            page.click("#tab-scatter_events .draw")
            assert page_document_in(page)["scatter_events"]["seed"] != 0  # a random seed, never the one in use
            expect(status).to_contain_text("Made", timeout=120_000)
            page.click("#clear")
            assert page_document_in(page)["scatter_events"]["rate"] == 10
            expect(status).to_contain_text("Made", timeout=120_000)
            page.select_option("#tab-scatter_events select.event", "pip")
            expect(status).to_contain_text("Made", timeout=120_000)
            page.select_option("#tab-scatter_events select.tone", "harmonic")
            expect(page.locator("#tab-scatter_events .knob[data-knob=harmonics]")).to_be_visible()
            assert page_document_in(page)["scatter_events"]["tone"] == "harmonic"
            expect(status).to_contain_text("Made", timeout=120_000)
            assert page.evaluate("[...document.querySelector('#tab-scatter_events canvas.mod-frame').getContext('2d').getImageData(80, 60, 1, 1).data].some((v) => v > 0)")
            page.select_option("#tab-scatter_events select.event", "impact")
            assert page.locator("#tab-scatter_events .knob[data-knob=cutoff]").is_visible()
            assert not page.locator("#tab-scatter_events .knob[data-knob=length]").is_visible()
            expect(status).to_contain_text("Made", timeout=120_000)
            page.click(".tabs [data-tab=draw_speech]")
            expect(status).to_contain_text("Made", timeout=60_000)
            print("Scatter events: a rate track, a slider, New draw, Clear, a harmonic pip and the impact are made and heard; the modulation picture is drawn")

            # The Quilt a sound tab: the quilt is made and both spectrograms
            # drawn; a typed segment length applies, too few segments say so,
            # New order changes the seed; there is nothing to Clear.
            page.click(".tabs [data-tab=quilt_sound]")
            expect(page.locator("#tab-quilt_sound")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            expect(page.locator("#clear")).to_be_disabled()
            duration = page_document_in(page)["duration"]
            expect(page.locator("#tab-quilt_sound .quilt-note")).to_contain_text("The quilt is")
            for canvas_name in ("source-stft", "quilt-stft"):
                assert page.evaluate(f"[...document.querySelector('#tab-quilt_sound canvas.{canvas_name}').getContext('2d').getImageData(120, 80, 1, 1).data].some((v) => v > 0)"), canvas_name
            segment_box = page.locator("#tab-quilt_sound .slider-value")
            segment_box.fill(str(round(1000 * duration / 2)))  # two segments: too few
            segment_box.press("Enter")
            expect(status).to_contain_text("Too few segments", timeout=10_000)
            expect(page.locator("#tab-quilt_sound .quilt-note")).to_contain_text("needs at least 3")
            segment_box.fill("30")
            segment_box.press("Enter")
            assert page_document_in(page)["quilt_sound"]["segment"] == 0.03
            expect(status).to_contain_text("Made", timeout=60_000)
            page.click("#tab-quilt_sound .reorder")
            assert page_document_in(page)["quilt_sound"]["seed"] != 1  # a random seed, never the one in use
            expect(status).to_contain_text("Made", timeout=60_000)
            # another tab's drawing as the source: Scatter events' starting chirps
            page.select_option("#tab-quilt_sound select.source", "scatter_events")
            assert page_document_in(page)["quilt_sound"]["source"] == "scatter_events"
            expect(status).to_contain_text("Made", timeout=60_000)
            page.click(".tabs [data-tab=draw_speech]")
            expect(status).to_contain_text("Made", timeout=60_000)
            print("Quilt a sound: the quilt and its source are drawn; a typed segment, too few segments, New order and Scatter events as the source work")

            # The Draw modulation tab: the example plays; clicking adds a blob,
            # dragging moves it across the seam and resizes it; a depth sonore
            # refuses offers the depth that fits; New draw, Delete, Clear, Undo.
            page.click(".tabs [data-tab=draw_modulation]")
            expect(page.locator("#tab-draw_modulation")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["tab"] == "draw_modulation"
            example = page_document_in(page)["draw_modulation"]
            start = example["items"]
            assert len(start) == 1 and start[0]["rate"] > 0 and start[0]["density"] > 0, start  # one blob, upper right
            expect(page.locator("#tab-draw_modulation .coarse")).to_be_visible()  # 0.6 s (the duration the page was left at) is under 2 s
            # The example keeps to one band round 500 Hz; the steps below start
            # from the same blob with no bands.
            assert example["bands"] == [{"points": [[0, 500]], "width": 2, "level": 0}], example["bands"]
            linked_blobs = {**example, "bands": []}  # what Reset goes back to from here
            open_link({**page_document_in(page), "draw_modulation": linked_blobs})
            expect(status).to_contain_text("Made", timeout=60_000)
            plane = page.locator("canvas.plane").bounding_box()
            left, right = plane["x"] + 52, plane["x"] + plane["width"] - 10
            top, bottom = plane["y"] + 8, plane["y"] + plane["height"] - 36
            center, half = (left + right) / 2, (right - left) / 2 - 7

            def bx(rate):
                side = 1 if rate > 0 else -1
                return center + side * (7 + math.log2(abs(rate)) / 6 * half)

            def by(density):
                return bottom - density / 6 * (bottom - top)

            def blobs_now():
                return page_document_in(page)["draw_modulation"]["items"]

            def gesture(points):
                before = page.evaluate("location.hash")
                page.mouse.move(*points[0])
                page.mouse.down()
                for point in points[1:]:
                    page.mouse.move(*point, steps=6)
                page.mouse.up()
                page.wait_for_function("(before) => location.hash !== before", arg=before, timeout=10_000)

            page.evaluate(
                """() => { window.progressSeen = false;
                    new MutationObserver(() => { if (document.querySelector('#tab-draw_modulation .synth-progress')) window.progressSeen = true; })
                        .observe(document.querySelector('#tab-draw_modulation'), { childList: true, subtree: true }); }"""
            )
            gesture([(bx(-16), by(3))])
            added = blobs_now()[-1]
            assert len(blobs_now()) == 2 and abs(math.log2(-added["rate"] / 16)) < 0.1 and abs(added["density"] - 3) < 0.1, added
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page.evaluate("window.progressSeen"), "no progress shown over the plane while synthesizing"
            expect(page.locator("#tab-draw_modulation .synth-progress")).to_have_count(0)
            print("modulation: progress shown over the plane while synthesizing, gone when made")
            gesture([(bx(added["rate"]), by(added["density"])), (bx(16), by(2))])
            moved = blobs_now()[-1]
            assert moved["rate"] > 0 and abs(math.log2(moved["rate"] / 16)) < 0.1 and abs(moved["density"] - 2) < 0.1, moved
            gesture([(bx(moved["rate"] * 2**0.5), by(moved["density"])), (bx(moved["rate"] * 2), by(moved["density"]))])
            assert abs(blobs_now()[-1]["rate_width"] - 1) < 0.1, blobs_now()[-1]
            print(f"modulation: added a blob, moved it to {moved['rate']} Hz across the seam, widened it to {blobs_now()[-1]['rate_width']} octave")
            expect(status).to_contain_text("Made", timeout=60_000)

            # A new draw first: at the depth offered below, another draw may not fit.
            page.click("#tab-draw_modulation .new-draw")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_modulation"]["seed"] != 1  # a random seed, never the one in use
            before_failure = len(errors)
            page.locator("#tab-draw_modulation .depth").fill("0.95")
            page.locator("#tab-draw_modulation .depth").press("Enter")
            expect(status).to_contain_text("Synthesis failed", timeout=60_000)
            use = page.locator("#tab-draw_modulation .use-depth")
            expect(use).to_be_visible()
            offered = float(use.inner_text().split()[-1])
            use.click()
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_modulation"]["rms_depth"] == offered < 0.95
            expect(use).to_be_hidden()
            page.wait_for_timeout(300)
            errors[before_failure:] = [e for e in errors[before_failure:] if "400 (Bad Request)" not in e]
            print(f"modulation: a depth of 0.95 was refused and {offered} offered and used")

            page.mouse.move(center, plane["y"] - 30)  # off the plane, so keys go to the page
            page.keyboard.press("Delete")
            assert len(blobs_now()) == 1
            page.click("#clear")
            expect(status).to_contain_text("No blobs yet", timeout=10_000)
            page.keyboard.press("Control+z")
            page.keyboard.press("Control+z")
            assert len(blobs_now()) == 2
            expect(status).to_contain_text("Made", timeout=60_000)
            page.locator("#tab-draw_modulation .iterations").fill("2")
            page.locator("#tab-draw_modulation .iterations").press("Enter")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_modulation"]["iterations"] == 2
            print("modulation: 2 iterations set and heard")
            page.select_option("#tab-draw_modulation .carrier", "harmonic")
            expect(page.locator("#tab-draw_modulation .f0-field")).to_be_visible()
            expect(page.locator("#tab-draw_modulation .iterations-field")).to_be_hidden()
            assert page_document_in(page)["draw_modulation"]["iterations"] == 0  # the harmonic carrier takes none
            page.locator("#tab-draw_modulation .f0").fill("150")
            page.locator("#tab-draw_modulation .f0").press("Enter")
            expect(status).to_contain_text("Made", timeout=60_000)
            section = page_document_in(page)["draw_modulation"]
            assert section["carrier"] == "harmonic" and section["f0"] == 150, section
            colors = page.evaluate(
                """() => { const c = document.querySelector('canvas.stft');
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    const seen = new Set(); for (let i = 0; i < d.length; i += 4) seen.add(d[i] * 65536 + d[i + 1] * 256 + d[i + 2]);
                    return seen.size; }"""
            )
            assert colors > 50, f"the spectrogram under the plane looks empty ({colors} colors)"
            measured_colors = page.evaluate(
                """() => { const c = document.querySelector('canvas.measured');
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    const seen = new Set(); for (let i = 0; i < d.length; i += 4) seen.add(d[i] * 65536 + d[i + 1] * 256 + d[i + 2]);
                    return seen.size; }"""
            )
            assert measured_colors > 30, f"the measured plane looks empty ({measured_colors} colors)"
            print(f"modulation: the measured modulation spectrum is drawn under the plane ({measured_colors} colors)")
            print(f"modulation: the harmonic carrier on 150 Hz plays, and the spectrogram under the plane is drawn ({colors} colors)")

            # Bands (bands.md): Add band puts a flat band at 500 Hz; dragging
            # its last breakpoint bends it up; a click on its line adds a
            # breakpoint, Delete removes it, Delete band removes the band.
            def bands_now():
                return page_document_in(page)["draw_modulation"].get("bands", [])

            # On the harmonic carrier, Iterations is offered only with bands (bands.md, K-M5b).
            iterations_field = page.locator("#tab-draw_modulation .iterations-field")
            page.click("#tab-draw_modulation .add-band")
            expect(status).to_contain_text("Made", timeout=60_000)
            expect(iterations_field).to_be_visible()
            page.locator("#tab-draw_modulation .iterations").fill("1")
            page.locator("#tab-draw_modulation .iterations").press("Enter")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_modulation"]["iterations"] == 1
            page.click("#tab-draw_modulation .delete-band")
            expect(iterations_field).to_be_hidden()
            assert page_document_in(page)["draw_modulation"]["iterations"] == 0 and bands_now() == []
            expect(status).to_contain_text("Made", timeout=60_000)
            print("modulation: on the harmonic carrier, Iterations shows with a band and goes with it")
            page.select_option("#tab-draw_modulation .carrier", "tones")
            expect(status).to_contain_text("Made", timeout=60_000)
            page.click("#tab-draw_modulation .add-band")
            expect(status).to_contain_text("Made", timeout=60_000)
            span = page_document_in(page)["duration"]  # the page's starting duration
            assert bands_now() == [{"points": [[0, 500], [span, 500]], "width": 1, "level": 0}], bands_now()
            stft = page.locator("#tab-draw_modulation canvas.stft").bounding_box()
            s_left, s_right = stft["x"] + 52, stft["x"] + stft["width"] - 10
            s_top, s_bottom = stft["y"] + 6, stft["y"] + stft["height"] - 20

            def sx(t):
                return s_left + t / span * (s_right - s_left)

            def sy(hz):
                return s_bottom - math.log2(hz / 100) / 6 * (s_bottom - s_top)

            gesture([(sx(span), sy(500)), (sx(span), sy(2000))])
            end = bands_now()[0]["points"][-1]
            assert end[0] == span and abs(math.log2(end[1] / 2000)) < 0.1, bands_now()
            expect(page.locator("#tab-draw_modulation .band-motion")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=60_000)
            gesture([(sx(span / 2), sy(1000))])
            assert len(bands_now()[0]["points"]) == 3, bands_now()
            expect(status).to_contain_text("Made", timeout=60_000)
            page.mouse.move(sx(span / 2), stft["y"] - 30)
            page.keyboard.press("Delete")
            assert len(bands_now()[0]["points"]) == 2, bands_now()
            expect(status).to_contain_text("Made", timeout=60_000)
            page.click("#tab-draw_modulation .delete-band")
            assert bands_now() == []
            expect(status).to_contain_text("Made", timeout=60_000)
            # Freehand: a stroke outside every band draws a new band along it.
            page.check("#tab-draw_modulation input[name=band-tool][value=freehand]")
            gesture([(sx(0.1), sy(300)), (sx(0.3), sy(600)), (sx(0.5), sy(1200))])
            drawn = bands_now()
            assert len(drawn) == 1 and len(drawn[0]["points"]) >= 2, drawn
            assert abs(math.log2(drawn[0]["points"][0][1] / 300)) < 0.15 and abs(math.log2(drawn[0]["points"][-1][1] / 1200)) < 0.15, drawn
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page.locator("main > .result").is_hidden(), "the page's own waveform strip shows on the Draw modulation tab"
            print(f"modulation: a freehand stroke drew a new band {drawn[0]['points']}")
            page.mouse.move(sx(0.3), stft["y"] - 30)
            page.keyboard.press("p")
            page.keyboard.press("Control+z")
            assert bands_now() == []
            print(f"modulation: added a band, bent it up to {end[1]} Hz, added and removed a breakpoint, removed the band")
            page.click("#reset")
            expect(status).to_contain_text("Made", timeout=60_000)
            assert page_document_in(page)["draw_modulation"] == linked_blobs, "Reset did not restore the blobs the link opened with"
            print("modulation: New draw, Delete, Clear, Undo and Reset work")

            # The Erase modulation tab (erase_modulation.md): it starts on the syllable
            # train with "keep below 4 Hz", and the source's spectrum is drawn
            # on the plane once heard; a stroke, a preset, Clear and Undo
            # change the mask and are heard; the Draw speech tab's sound and a
            # recording opened from a file are sources too; a recording sets
            # the duration, goes in saved files and never in the link.
            page.click(".tabs [data-tab=erase_modulation]")
            expect(page.locator("#tab-erase_modulation")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=120_000)
            section = page_document_in(page)["erase_modulation"]
            assert page_document_in(page)["tab"] == "erase_modulation" and section["source"] == "syllables" and section["iterations"] == 5, section
            assert page.locator("main > .result").is_hidden(), "the page's own waveform strip shows on the Erase modulation tab"
            colors = page.evaluate(
                """() => { const c = document.querySelector('#tab-erase_modulation canvas.mask-plane');
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    const s = new Set(); for (let i = 0; i < d.length; i += 4) s.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return s.size; }"""
            )
            assert colors > 100, f"the source's spectrum is not drawn on the plane ({colors} colors)"
            measured = page.evaluate(
                """() => { const c = document.querySelector('#tab-erase_modulation canvas.measured-plane');
                    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    const s = new Set(); for (let i = 0; i < d.length; i += 4) s.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return s.size; }"""
            )
            assert measured > 100, f"the result's measured spectrum is not drawn ({measured} colors)"
            # a hard cut clips envelopes, which a note says (E9)
            expect(page.locator("#tab-erase_modulation .clip-note")).to_contain_text("% of the envelopes were clipped")
            print(f"Erase modulation: the source's spectrum ({colors} colors), the result's ({measured}) and the clipping note are shown")
            plane = page.locator("#tab-erase_modulation canvas.mask-plane").bounding_box()
            p_left, p_right = plane["x"] + 52, plane["x"] + plane["width"] - 10
            p_top, p_bottom = plane["y"] + 8, plane["y"] + plane["height"] - 36
            p_center = (p_left + p_right) / 2
            # erase the cut at about -16 Hz, density 3, with a right-drag
            ex = p_center - 8 - (4 / 6) * ((p_right - p_left) / 2 - 8)
            ey = p_bottom - 0.5 * (p_bottom - p_top)
            before = page.evaluate("location.hash")
            page.mouse.move(ex, ey)
            page.mouse.down(button="right")
            page.mouse.move(ex + 20, ey + 10, steps=4)
            page.mouse.up(button="right")
            page.wait_for_function("h => location.hash !== h", arg=before)  # the mask is encoded asynchronously
            erased = page_document_in(page)["erase_modulation"]["levels"]
            assert erased != section["levels"], "the stroke did not change the mask"
            expect(status).to_contain_text("Made", timeout=120_000)
            from sonore_sketch import erase_modulation, sources  # the Python half reads what the page wrote

            cut = erase_modulation.cuts({**section, "levels": erased})
            column = int(round(erase_modulation.SIDE - 1 - (math.log2(16) * 16 - 0.5)))
            assert cut[24, column] < 30 and cut[24, 0] == 60, (cut[24, column], cut[24, 0])
            print(f"Erase modulation: a right-drag erased the cut at -16 Hz (now {cut[24, column]:g} dB) and was heard")
            before = page.evaluate("location.hash")
            page.click("#tab-erase_modulation .no-down")
            page.wait_for_function("h => location.hash !== h", arg=before)
            expect(status).to_contain_text("Made", timeout=120_000)
            assert (erase_modulation.cuts(page_document_in(page)["erase_modulation"]) == erase_modulation.remove_sweeps("down")).all()
            page.keyboard.press("Control+z")
            assert page_document_in(page)["erase_modulation"]["levels"] == erased, "Undo did not bring the mask back"
            before = page.evaluate("location.hash")
            page.click("#clear")
            page.wait_for_function("h => location.hash !== h", arg=before)
            expect(status).to_contain_text("Made", timeout=120_000)
            assert not erase_modulation.cuts(page_document_in(page)["erase_modulation"]).any()
            expect(page.locator("#tab-erase_modulation .clip-note")).to_be_hidden()  # nothing cut, nothing clipped
            page.locator("#tab-erase_modulation .iterations").fill("0")
            page.locator("#tab-erase_modulation .iterations").press("Enter")
            page.select_option("#tab-erase_modulation .carrier", "tones")
            expect(status).to_contain_text("Made", timeout=120_000)
            page.select_option("#tab-erase_modulation .source", "draw_speech")
            expect(status).to_contain_text("Made", timeout=120_000)
            assert page_document_in(page)["erase_modulation"]["source"] == "draw_speech"
            print("Erase modulation: a preset, Undo, Clear, iterations, the tones carrier and the Draw speech tab's sound work")
            # a recording: 1.5 s of a tone pulsing at 4 Hz, as a WAV file
            import io
            import wave

            import numpy as np

            t = np.arange(int(1.5 * 22050)) / 22050
            tone = 0.5 * np.sin(2 * np.pi * 440 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(22050)
                w.writeframes((tone * 32767).astype("<i2").tobytes())
            before = page.evaluate("location.hash")
            page.locator("#tab-erase_modulation .audio-file").set_input_files(files=[{"name": "pulse.wav", "mimeType": "audio/wav", "buffer": buffer.getvalue()}])
            page.wait_for_function("h => location.hash !== h", arg=before)  # decoded by the browser
            expect(status).to_contain_text("Made", timeout=120_000)
            linked = page_document_in(page)
            assert linked["duration"] == 1.5 and linked["erase_modulation"]["source"] == "file" and "recording" not in linked, {k: linked[k] for k in ("duration", "erase_modulation")}
            expect(page.locator("#tab-erase_modulation .recording-note")).to_contain_text("pulse.wav: 1.50 s")
            with page.expect_download() as download:
                page.click("#save")
            saved = json.loads(Path(download.value.path()).read_text())
            assert saved["recording"]["name"] == "pulse.wav" and saved["recording"]["fs"] == 16000, saved.get("recording", {}).keys()
            heard = sources.recording({**edit_tab_state(saved), "source": "file"})
            assert heard.n_samples == 24000 and abs(np.corrcoef(heard.data[:, 0], np.interp(np.arange(24000) / 16000, t, tone))[0, 1]) > 0.99
            print("Erase modulation: a WAV file opened as the source, set the duration to 1.5 s, was heard, saved, and left out of the link")
            page.keyboard.press("Control+z")
            assert page_document_in(page)["duration"] == 0.6 and page_document_in(page)["erase_modulation"]["source"] == "draw_speech"
            print("Erase modulation: Undo takes the recording away again")

            # The Erase spectrogram tab (erase_spectrogram.md): it starts on the syllable
            # train with nothing erased, and draws the source's spectrogram
            # once heard; an Erase stroke along 2 kHz and a Restore stroke
            # change the mask and are heard; a recording opened here is this
            # tab's source only.
            page.click(".tabs [data-tab=erase_spectrogram]")
            expect(page.locator("#tab-erase_spectrogram")).to_be_visible()
            expect(status).to_contain_text("Made", timeout=120_000)
            section = page_document_in(page)["erase_spectrogram"]
            from sonore_sketch import erase_spectrogram

            assert section["source"] == "syllables" and not erase_spectrogram.cuts(section).any(), section["source"]
            assert page.locator("main > .result").is_hidden(), "the page's own waveform strip shows on the Erase spectrogram tab"
            for name in ("filter-plane", "filter-result"):
                colors = page.evaluate(
                    """name => { const c = document.querySelector('#tab-erase_spectrogram canvas.' + name);
                        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                        const s = new Set(); for (let i = 0; i < d.length; i += 4) s.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return s.size; }""",
                    name,
                )
                assert colors > 100, f"the {name} spectrogram is not drawn ({colors} colors)"
            plane = page.locator("#tab-erase_spectrogram canvas.filter-plane").bounding_box()
            m_left, m_right = plane["x"] + 52, plane["x"] + plane["width"] - 10
            m_top, m_bottom = plane["y"] + 8, plane["y"] + plane["height"] - 22
            y_2k = m_bottom - (2000 / 8000) * (m_bottom - m_top)
            before = page.evaluate("location.hash")
            page.mouse.move(m_left + 0.1 * (m_right - m_left), y_2k)
            page.mouse.down()
            page.mouse.move(m_left + 0.9 * (m_right - m_left), y_2k, steps=12)
            page.mouse.up()
            page.wait_for_function("h => location.hash !== h", arg=before)
            expect(status).to_contain_text("Made", timeout=120_000)
            cut = erase_spectrogram.cuts(page_document_in(page)["erase_spectrogram"])
            assert cut[64, 128] == 60 and cut[64, 5] == 0 and cut[20, 128] == 0, (cut[64, 128], cut[64, 5], cut[20, 128])
            print("Erase spectrogram: an Erase stroke along 2 kHz removed it there and was heard")
            page.keyboard.press("r")
            before = page.evaluate("location.hash")
            page.mouse.move(m_left + 0.45 * (m_right - m_left), y_2k)
            page.mouse.down()
            page.mouse.move(m_left + 0.55 * (m_right - m_left), y_2k, steps=4)
            page.mouse.up()
            page.wait_for_function("h => location.hash !== h", arg=before)
            restored = erase_spectrogram.cuts(page_document_in(page)["erase_spectrogram"])
            assert restored[64, 128] == 0 and restored[64, 40] == 60, (restored[64, 128], restored[64, 40])
            page.keyboard.press("Control+z")
            assert (erase_spectrogram.cuts(page_document_in(page)["erase_spectrogram"]) == cut).all(), "Undo did not bring the erasing back"
            before = page.evaluate("location.hash")
            page.click("#clear")
            page.wait_for_function("h => location.hash !== h", arg=before)
            assert not erase_spectrogram.cuts(page_document_in(page)["erase_spectrogram"]).any()
            print("Erase spectrogram: Restore (R), Undo and Clear work")
            before = page.evaluate("location.hash")
            page.locator("#tab-erase_spectrogram .audio-file").set_input_files(files=[{"name": "pulse.wav", "mimeType": "audio/wav", "buffer": buffer.getvalue()}])
            page.wait_for_function("h => location.hash !== h", arg=before)
            expect(status).to_contain_text("Made", timeout=120_000)
            linked = page_document_in(page)
            assert linked["duration"] == 1.5 and linked["erase_spectrogram"]["source"] == "file" and linked["erase_modulation"]["source"] == "draw_speech", (linked["erase_spectrogram"], linked["erase_modulation"]["source"])
            expect(page.locator("#tab-erase_spectrogram .recording-note")).to_contain_text("pulse.wav: 1.50 s")
            print("Erase spectrogram: a WAV file opened here is this tab's source, set the duration and was heard")
            if args.screenshot:
                page.screenshot(path=args.screenshot)
            browser.close()
    finally:
        server.terminate()
    if errors:
        sys.exit("errors in the browser console:\n" + "\n".join(errors))
    print("page check passed")


if __name__ == "__main__":
    main()
