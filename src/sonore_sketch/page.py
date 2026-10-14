"""What the page asks of Python, and what it gets back.

The page's worker (``app/worker.js``, under Pyodide) and the local server
(``tools/serve.py``, in this Python) both call :func:`handle`, so the two
engines give the same result. A request names a tab and holds its state; the
result is the sound's samples and a picture of it, as bytes the page can wrap
in typed arrays without copying element by element.
"""

from __future__ import annotations

import time
from collections.abc import Iterator, Mapping
from typing import Any

import numpy as np
import sonore as so

from . import blobs, edit, events, mask, painted, paths, shared, tracks

TABS = {
    "tracks": tracks.synthesize, "painted": painted.synthesize, "mask": mask.synthesize,
    "blobs": blobs.synthesize, "edit": edit.synthesize, "paths": paths.synthesize,
    "events": events.synthesize,
}

# The page's document (docs/design/tabs/painted.md, "Data model"), as
# app/document.js writes it: duration and fs for the page, a section per tab.
APP = "sonore-sketch"
VERSION = 2


def upgrade(document: Mapping[str, Any]) -> dict[str, Any]:
    """``document`` as a version-2 page document. A TrackDraw document
    (format 1, the Draw speech tab's own) becomes its ``tracks`` section."""
    if document.get("trackdraw") == tracks.FORMAT:
        return {
            "app": APP, "version": VERSION, "sonore": document.get("sonore"),
            "duration": document["duration"], "fs": document["fs"], "tab": "tracks",
            "tracks": {"mode": document.get("mode", "klatt"), "params": dict(document.get("params", {}))},
        }
    if document.get("app") != APP or document.get("version") != VERSION:
        raise ValueError(f"not a sonore-sketch document of version {VERSION}, or a TrackDraw document of format {tracks.FORMAT}")
    return dict(document)


def tab_state(document: Mapping[str, Any], tab: str | None = None) -> dict[str, Any]:
    """The state ``tab`` (default: the tab the document was saved on) draws
    on, which is what that tab's ``synthesize`` takes."""
    page = upgrade(document)
    tab = tab or page.get("tab", "tracks")
    if tab == "tracks":
        return {"trackdraw": tracks.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["tracks"]}
    if tab == "painted" and "painted" in page:
        return {"painted": painted.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["painted"]}
    if tab == "blobs" and "blobs" in page:
        return {"blobs": blobs.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["blobs"]}
    if tab == "events" and "events" in page:
        return {"events": events.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["events"]}
    if tab == "paths" and "paths" in page:
        # the source's own drawing goes with the state, as on the Erase tabs
        state = {"paths": paths.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["paths"]}
        if state.get("source") == "speech":
            state["speech"] = page["tracks"]
        if state.get("source") == "file" and "recording" in page:
            state["recording"] = page["recording"]
        return state
    if tab in ("edit", "mask") and tab in page:
        # the source's own drawing goes with the state: the Draw speech tab's, or the page's recording
        section_format = edit.FORMAT if tab == "edit" else mask.FORMAT
        state = {tab: section_format, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page[tab]}
        if state.get("source") == "speech":
            state["speech"] = page["tracks"]
        if state.get("source") == "file" and "recording" in page:
            state["recording"] = page["recording"]
        return state
    if tab in TABS:
        raise ValueError(f"the document has no {tab!r} section to make the sound from")
    raise ValueError(f"unknown tab {tab!r}; known: {sorted(TABS)}")


def synthesize(document: Mapping[str, Any], tab: str | None = None) -> so.Sound:
    """The sound of a saved document (a file from the page's Save), as the
    page makes it for ``tab`` (default: the tab it was saved on)."""
    page = upgrade(document)
    tab = tab or page.get("tab", "tracks")
    return TABS[tab](tab_state(page, tab))

# The result's spectrogram: wideband, 5 ms Hann, as on the Seeing speech page
# (docs/design/tabs/tracks.md, "What sonore provides").
WINDOW_S = 0.005
N_FFT = 512
MAX_WINDOWS = 1200
FLOOR_DB = -70.0


def spectrogram(sound: so.Sound) -> dict[str, Any]:
    """A wideband spectrogram of ``sound`` as 8-bit levels, 0 at ``FLOOR_DB``
    below the loudest cell and 255 at it, frequency rows from 0 Hz up."""
    hop = max(0.001, sound.duration / MAX_WINDOWS)
    stft = so.GaborFrame(WINDOW_S, hop, n_fft=N_FFT).analyze(sound.mono())
    magnitude = np.abs(stft.data[0])
    level = 20 * np.log10(np.maximum(magnitude, 1e-12) / max(magnitude.max(), 1e-12))
    scaled = np.round(255 * (1 - np.clip(level, FLOOR_DB, 0) / FLOOR_DB))
    return {
        "data": np.ascontiguousarray(scaled, dtype=np.uint8).tobytes(),
        "n_freqs": int(magnitude.shape[0]),
        "n_windows": int(magnitude.shape[1]),
        "f_max": float(stft.f[-1]),
        "t_start": float(stft.t[0]),
        "t_step": float(stft.t[1] - stft.t[0]) if stft.t.size > 1 else hop,
        "floor_db": FLOOR_DB,
    }


def handle(request: Mapping[str, Any]) -> dict[str, Any]:
    """Synthesize ``request["state"]`` with the tab ``request["tab"]``.

    Returns the sampling rate, the samples as little-endian float32 bytes
    (sonore's level: RMS 1; for a sound with two channels, the Draw path
    tab's, the left ear's, and the right ear's as ``samples_right``), a
    spectrogram (:func:`spectrogram`, of the channels' mean), and the
    seconds synthesis took; on the Draw modulation tab also the result's measured
    modulation spectrum (``blobs.measured_picture``), and on the Erase
    modulation tab the source's and the result's (``edit.plane_picture``)
    and the fraction of envelope values sonore clipped; on the Erase
    spectrogram tab the source's and the result's spectrograms in the mask's
    own STFT (``mask.pictures``); on the Scatter events tab the result's
    modulation spectrogram (``events.modulation``).
    """
    return shared.finish(handle_steps(request))


def handle_steps(request: Mapping[str, Any]) -> Iterator[float]:
    """``handle`` one step at a time: yields the fraction done (synthesis
    takes most of it, the pictures the rest) and returns ``handle``'s
    result. The Pyodide worker runs it between messages, so the page can
    show progress and drop a request the drawing has outgrown."""
    tab = request.get("tab")
    if tab not in TABS:
        raise ValueError(f"unknown tab {tab!r}; known: {sorted(TABS)}")
    start = time.perf_counter()
    if tab == "blobs":
        sound = yield from shared.scaled(blobs.steps(request["state"]), 0.9)
    elif tab == "mask":
        sound, source_stft, result_stft = yield from shared.scaled(mask.steps(request["state"]), 0.9)
    elif tab == "edit":
        sound, original, clipped = yield from shared.scaled(edit.steps(request["state"]), 0.9)
    elif tab == "events":
        sound, modulation = yield from shared.scaled(events.steps(request["state"]), 0.9)
    else:
        sound = TABS[tab](request["state"])
        yield 0.9
    elapsed = time.perf_counter() - start
    result = {
        "fs": float(sound.fs),
        "samples": np.ascontiguousarray(sound.data[:, 0] if sound.n_channels == 2 else sound.mono().data[:, 0], dtype="<f4").tobytes(),
        "spectrogram": spectrogram(sound),
        "synthesis_s": elapsed,
    }
    if sound.n_channels == 2:  # the Draw path tab's two ears
        result["samples_right"] = np.ascontiguousarray(sound.data[:, 1], dtype="<f4").tobytes()
    if tab == "blobs":  # the result's measured modulation spectrum, for under the plane (blobs.md, B7)
        result["modulation"] = blobs.measured_picture(blobs.measured(sound, request["state"]))
    if tab == "edit":  # the source's modulation spectrum and the result's, on the plane (edit.md, E7, E9)
        result["source_modulation"] = edit.plane_picture(original)
        result["modulation"] = edit.plane_picture(edit.analyze(sound, request["state"]))
        result["clipped"] = clipped
    if tab == "events":  # the result's modulation spectrogram (events.md, E7)
        result["modulation_frames"], result["modulation_pooled"] = modulation["frames"], modulation["pooled"]
    if tab == "mask":  # the source's and the result's spectrograms in the mask's own STFT (mask.md)
        result["source_stft"], result["result_stft"] = mask.pictures(source_stft, result_stft)
    return result
