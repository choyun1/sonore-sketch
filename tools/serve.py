"""Serve the page, with a local synthesis engine, for working on it.

    pip install -e .
    python tools/serve.py            # then open http://localhost:8000/

The page is static and runs sonore under Pyodide by default, so this is only
a file server. It also answers the page's ``?engine=local`` mode
(http://localhost:8000/?engine=local): synthesis then runs in this Python
through the same ``sonore_sketch.page.handle`` the Pyodide worker calls, so
the page works offline and loads at once, which is how it is tested where
the Pyodide CDN cannot be reached (tools/check_page.py).
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))


def encode(result: dict) -> dict:
    """``page.handle``'s result as JSON, its bytes in base64, as the page's
    local engine reads it (also the made-ahead sounds, tools/make_examples.py)."""
    result = dict(result, samples=base64.b64encode(result["samples"]).decode())
    if "samples_right" in result:
        result["samples_right"] = base64.b64encode(result["samples_right"]).decode()
    for key in ("spectrogram", "modulation", "source_modulation", "source_stft", "result_stft", "modulation_frames", "modulation_pooled"):
        if key in result:
            result[key] = dict(result[key], data=base64.b64encode(result[key]["data"]).decode())
    return result


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # quieter than the default
        if self.server.verbose:
            super().log_message(format, *args)

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/version":
            import platform

            import sonore

            return self.send_json(200, {"versions": f"sonore {sonore.__version__}, Python {platform.python_version()}"})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/synthesize":
            return self.send_json(404, {"error": f"no such endpoint {self.path}"})
        from sonore_sketch.page import handle

        try:
            result = handle(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        except Exception as error:  # every failure goes back to the page as JSON, as the worker's do
            status = 400 if isinstance(error, (ValueError, KeyError, TypeError)) else 500
            detail = "".join(traceback.format_exception(error)).strip()
            return self.send_json(status, {"error": f"{type(error).__name__}: {error}", "detail": detail})
        return self.send_json(200, encode(result))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(ROOT)))
    server.verbose = args.verbose
    print(f"http://{args.host}:{args.port}/  (Pyodide)   http://{args.host}:{args.port}/?engine=local  (this Python)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
