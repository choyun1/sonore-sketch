"""The synthesis server: sonore-sketch's Python, run natively for the page.

The page makes its sounds with Python in the browser (Pyodide), which takes
several seconds to start on every visit (docs/design/app.md, M1). Natively,
the same ``sonore_sketch.page.handle`` answers in a fraction of a second with
no start-up, so the page asks this server first and loads Pyodide only when
the server cannot be reached (app/engine.js, FallbackEngine).

It answers the same two requests as tools/serve.py's local engine:

    GET  /api/version      {"versions": "sonore 0.7.0, Python 3.12.3"}
    POST /api/synthesize   {"tab": ..., "state": ...}  ->  page.handle's result as JSON

and adds what a public server needs: CORS for the page's own sites only, a
cap on request size, a few syntheses at a time with a short queue (503 when
full, and the page then makes that sound itself), and a per-address rate
limit (429). The drawing's own limits (duration, sampling rate) are checked
by ``page.handle``, as in the browser.

It speaks plain HTTP on 127.0.0.1; a reverse proxy in front of it (Caddy in
server/README.md) provides HTTPS.

    pip install -e .
    python server/synth_server.py --port 8100
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tools"))

from serve import encode  # noqa: E402

# The sites whose pages may call this server (CORS). Anything else is refused
# by the visitor's browser, though not by this server: CORS is no access control.
ORIGINS = {"https://choyun1.github.io", "http://127.0.0.1:8000", "http://localhost:8000"}
MAX_BODY = 4_000_000  # bytes; a 30 s recording at 16 kHz is about 1.3 MB in a request
RATE = (60, 60.0)  # at most 60 syntheses per address per 60 s: a busy person drawing makes about one a second


class Limits:
    """How many syntheses run at once, how many wait, and each address's recent requests."""

    def __init__(self, workers: int, queue: int):
        self.running = threading.BoundedSemaphore(workers)
        self.slots = threading.BoundedSemaphore(workers + queue)  # running or waiting
        self.recent: dict[str, deque[float]] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, address: str) -> bool:
        count, seconds = RATE
        now = time.monotonic()
        with self.lock:
            times = self.recent[address]
            while times and now - times[0] > seconds:
                times.popleft()
            if len(times) >= count:
                return False
            times.append(now)
            if len(self.recent) > 10_000:  # forget addresses that have gone quiet
                for key in [key for key, value in self.recent.items() if not value or now - value[-1] > seconds]:
                    del self.recent[key]
            return True


class Handler(BaseHTTPRequestHandler):
    server_version = "sonore-sketch"
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # one line per request, without the visitor's address
        if self.server.verbose:
            sys.stderr.write(f"{self.log_date_time_string()} {format % args}\n")

    def address(self) -> str:
        # The proxy in front adds the visitor's address last; only it can reach this port.
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[-1].strip()

    def cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path != "/api/version":
            return self.send_json(404, {"error": f"no such endpoint {self.path}"})
        return self.send_json(200, {"versions": self.server.versions})

    def do_POST(self):
        if self.path != "/api/synthesize":
            return self.send_json(404, {"error": f"no such endpoint {self.path}"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            self.close_connection = True
            return self.send_json(413, {"error": f"a request must be 1 to {MAX_BODY} bytes"})
        body = self.rfile.read(length)
        limits = self.server.limits
        if not limits.allow(self.address()):
            return self.send_json(429, {"error": "too many requests from this address; try again in a minute"})
        if not limits.slots.acquire(blocking=False):
            return self.send_json(503, {"error": "the server is busy"})
        try:
            with limits.running:
                from sonore_sketch.page import handle

                try:
                    result = handle(json.loads(body))
                except Exception as error:  # the drawing's own errors go back as the local engine's do
                    status = 400 if isinstance(error, (ValueError, KeyError, TypeError)) else 500
                    detail = "".join(traceback.format_exception(error)).strip()
                    return self.send_json(status, {"error": f"{type(error).__name__}: {error}", "detail": detail})
        finally:
            limits.slots.release()
        return self.send_json(200, encode(result))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--host", default="127.0.0.1", help="where to listen; keep it local, behind the proxy")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 1, help="syntheses at once")
    parser.add_argument("--queue", type=int, default=8, help="syntheses waiting before the server says it is busy")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args()

    import platform

    import sonore
    from sonore_sketch import page  # noqa: F401  (imported now, so the first request does not wait for it)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.verbose = args.verbose
    server.limits = Limits(args.workers, args.queue)
    server.versions = f"sonore {sonore.__version__}, Python {platform.python_version()}"
    print(f"http://{args.host}:{args.port}/api/version  ({server.versions}, {args.workers} at once)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
