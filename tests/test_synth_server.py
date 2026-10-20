"""The synthesis server (server/synth_server.py) answers as the page's local
engine does, and refuses what a public server must."""

from __future__ import annotations

import http.client
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

import synth_server  # noqa: E402

PAGE = "https://choyun1.github.io"
REQUEST = json.dumps({"tab": "draw_speech", "state": json.loads((ROOT / "app" / "examples" / "draw_speech.json").read_text())["state"]}).encode()


@pytest.fixture
def server(monkeypatch):
    def start(workers=1, queue=1, rate=(100, 60.0)):
        monkeypatch.setattr(synth_server, "RATE", rate)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), synth_server.Handler)
        httpd.verbose = False
        httpd.limits = synth_server.Limits(workers, queue)
        httpd.versions = "sonore test"
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        started.append(httpd)
        return f"http://127.0.0.1:{httpd.server_address[1]}"

    started = []
    yield start
    for httpd in started:
        httpd.shutdown()


def ask(url, data=None, origin=PAGE, method=None):
    request = urllib.request.Request(url, data=data, method=method, headers={"Origin": origin, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def test_it_synthesizes_for_the_page_and_lets_only_the_pages_sites_read_it(server):
    base = server()
    status, headers, body = ask(f"{base}/api/synthesize", REQUEST)
    assert status == 200 and headers["Access-Control-Allow-Origin"] == PAGE
    assert {"fs", "samples", "spectrogram"} <= json.loads(body).keys()
    status, headers, _ = ask(f"{base}/api/version", origin="https://example.com")
    assert status == 200 and "Access-Control-Allow-Origin" not in headers
    status, headers, _ = ask(f"{base}/api/synthesize", method="OPTIONS")
    assert status == 204 and "POST" in headers["Access-Control-Allow-Methods"]


def test_a_drawing_it_cannot_make_is_a_400_with_the_reason(server):
    status, _, body = ask(f"{server()}/api/synthesize", json.dumps({"tab": "draw_speech", "state": {}}).encode())
    assert status == 400 and json.loads(body)["error"]


def test_it_refuses_requests_too_large_too_many_or_while_full(server):
    base = server()
    # announced too large: refused before the body is read
    connection = http.client.HTTPConnection(base.removeprefix("http://"))
    connection.putrequest("POST", "/api/synthesize")
    connection.putheader("Content-Length", str(synth_server.MAX_BODY + 1))
    connection.endheaders()
    assert connection.getresponse().status == 413
    connection.close()
    base = server(rate=(1, 60.0))
    assert ask(f"{base}/api/synthesize", REQUEST)[0] == 200
    assert ask(f"{base}/api/synthesize", REQUEST)[0] == 429
    base = server(workers=0, queue=0)
    assert ask(f"{base}/api/synthesize", REQUEST)[0] == 503
