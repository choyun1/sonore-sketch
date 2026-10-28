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

from . import (
    draw_modulation, draw_path, draw_spectrogram, draw_speech, draw_voice, erase_modulation, erase_spectrogram, match_texture, quilt_sound, scatter_events, shared,
)

TABS = {
    "draw_speech": draw_speech.synthesize, "draw_voice": draw_voice.synthesize, "draw_spectrogram": draw_spectrogram.synthesize, "erase_spectrogram": erase_spectrogram.synthesize,
    "draw_modulation": draw_modulation.synthesize, "erase_modulation": erase_modulation.synthesize, "draw_path": draw_path.synthesize,
    "scatter_events": scatter_events.synthesize, "quilt_sound": quilt_sound.synthesize, "match_texture": match_texture.synthesize,
}

# The page's document (docs/design/tabs/draw_spectrogram.md, "Data model"), as
# app/document.js writes it: duration and fs for the page, a section per tab.
APP = "sonore-sketch"
VERSION = 3

# The tabs' ids in version-2 documents (before 2026-10-20), each with the id
# it has now; a source naming a tab used the same ids, but "speech" for Draw
# speech (app/document.js, OLD_TAB_IDS).
OLD_TAB_IDS = {
    "tracks": "draw_speech", "painted": "draw_spectrogram", "mask": "erase_spectrogram", "blobs": "draw_modulation",
    "edit": "erase_modulation", "paths": "draw_path", "events": "scatter_events", "quilt": "quilt_sound", "speech": "draw_speech",
}


def rename_old_tabs(document: Mapping[str, Any]) -> dict[str, Any]:
    """A version-2 ``document`` as version 3: its sections, the tab it was
    saved on and every source that names a tab, under the tabs' ids of now."""
    renamed = {**document, "version": VERSION, "tab": OLD_TAB_IDS.get(document.get("tab"), document.get("tab"))}
    for old, new in OLD_TAB_IDS.items():
        if old not in document or old == "speech":
            continue
        section = renamed.pop(old)
        if isinstance(section, Mapping) and section.get("source") in OLD_TAB_IDS:
            section = {**section, "source": OLD_TAB_IDS[section["source"]]}
        renamed[new] = section
    return renamed


def upgrade(document: Mapping[str, Any]) -> dict[str, Any]:
    """``document`` as a version-3 page document. A TrackDraw document
    (format 1, the Draw speech tab's own) becomes its ``draw_speech``
    section, and a version-2 one has its tabs renamed (:func:`rename_old_tabs`)."""
    if document.get("app") == APP and document.get("version") == 2:
        return upgrade(rename_old_tabs(document))
    if document.get("trackdraw") == draw_speech.FORMAT:
        return {
            "app": APP, "version": VERSION, "sonore": document.get("sonore"),
            "duration": document["duration"], "fs": document["fs"], "tab": "draw_speech",
            "draw_speech": {"mode": document.get("mode", "klatt"), "params": dict(document.get("params", {}))},
        }
    if document.get("app") != APP or document.get("version") != VERSION:
        raise ValueError(f"not a sonore-sketch document of version {VERSION}, or a TrackDraw document of format {draw_speech.FORMAT}")
    return dict(document)


def tab_state(document: Mapping[str, Any], tab: str | None = None) -> dict[str, Any]:
    """The state ``tab`` (default: the tab the document was saved on) draws
    on, which is what that tab's ``synthesize`` takes."""
    page = upgrade(document)
    tab = tab or page.get("tab", "draw_speech")
    if tab == "draw_speech":
        return {"trackdraw": draw_speech.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["draw_speech"]}
    if tab == "draw_spectrogram" and "draw_spectrogram" in page:
        return {"draw_spectrogram": draw_spectrogram.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["draw_spectrogram"]}
    if tab == "draw_modulation" and "draw_modulation" in page:
        return {"draw_modulation": draw_modulation.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["draw_modulation"]}
    if tab == "draw_voice" and "draw_voice" in page:
        return {"draw_voice": draw_voice.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["draw_voice"]}
    if tab == "scatter_events" and "scatter_events" in page:
        return {"scatter_events": scatter_events.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["scatter_events"]}
    if tab == "draw_path" and "draw_path" in page:
        # the source's own drawing goes with the state, as on the Erase tabs
        state = {"draw_path": draw_path.FORMAT, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page["draw_path"]}
        if state.get("source") == "draw_speech":
            state["draw_speech"] = page["draw_speech"]
        if state.get("source") == "file" and "recording" in page:
            state["recording"] = page["recording"]
        return state
    if tab in ("erase_modulation", "erase_spectrogram", "quilt_sound", "match_texture") and tab in page:
        # the source's own drawing goes with the state: the Draw speech tab's, or the page's recording
        section_format = {
            "erase_modulation": erase_modulation.FORMAT, "erase_spectrogram": erase_spectrogram.FORMAT, "quilt_sound": quilt_sound.FORMAT,
            "match_texture": match_texture.FORMAT,
        }[tab]
        state = {tab: section_format, "sonore": page.get("sonore"), "duration": page["duration"], "fs": page["fs"], **page[tab]}
        if state.get("source") == "draw_speech":
            state["draw_speech"] = page["draw_speech"]
        if state.get("source") == "file" and "recording" in page:
            state["recording"] = page["recording"]
        if tab in ("quilt_sound", "match_texture") and state.get("source") in quilt_sound.DRAWN and state["source"] in page:
            state["drawing"] = page[state["source"]]  # the tab's own drawing, made into its sound
        return state
    if tab in TABS:
        raise ValueError(f"the document has no {tab!r} section to make the sound from")
    raise ValueError(f"unknown tab {tab!r}; known: {sorted(TABS)}")


def synthesize(document: Mapping[str, Any], tab: str | None = None) -> so.Sound:
    """The sound of a saved document (a file from the page's Save), as the
    page makes it for ``tab`` (default: the tab it was saved on)."""
    page = upgrade(document)
    tab = tab or page.get("tab", "draw_speech")
    return TABS[tab](tab_state(page, tab))

# The result's spectrogram: wideband, 5 ms Hann, as on the Seeing speech page
# (docs/design/tabs/draw_speech.md, "What sonore provides").
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
    modulation spectrum (``draw_modulation.measured_picture``), and on the Erase
    modulation tab the source's and the result's (``erase_modulation.plane_picture``)
    and the fraction of envelope values sonore clipped; on the Erase
    spectrogram tab the source's and the result's spectrograms in the mask's
    own STFT (``erase_spectrogram.pictures``); on the Scatter events tab the result's
    modulation spectrogram (``scatter_events.modulation``); on the Quilt a sound tab
    the source's spectrogram (:func:`spectrogram`, as ``source_stft``) and
    how many segments the quilt has (``segments``), each ``segment_s`` long;
    on the Match a texture tab the source's spectrogram (``source_stft``) and
    how well the result's statistics match the source's (``match``: dB per
    class of ``match_texture.BARS``, in that order) with which were imposed
    (``imposed``). A Draw a voice request with ``"measure": true`` makes the
    source's sound instead and measures its voice (``voice``:
    ``draw_voice.measure_steps``).
    """
    return shared.finish(handle_steps(request))


def handle_steps(request: Mapping[str, Any]) -> Iterator[shared.Step]:
    """``handle`` one step at a time: yields the fraction done with what
    comes next (``shared.Step``; synthesis takes most of it, the pictures
    the rest) and returns ``handle``'s result. The Pyodide worker runs it between messages, so the page can
    show progress and drop a request the drawing has outgrown."""
    tab = request.get("tab")
    if tab not in TABS:
        raise ValueError(f"unknown tab {tab!r}; known: {sorted(TABS)}")
    start = time.perf_counter()
    if tab == "draw_modulation":  # its measured modulation spectrum takes about a third of the time
        sound = yield from shared.scaled(draw_modulation.steps(request["state"]), 0.65)
    elif tab == "erase_spectrogram":
        sound, source_stft, result_stft = yield from shared.scaled(erase_spectrogram.steps(request["state"]), 0.9)
    elif tab == "erase_modulation":
        sound, original, clipped = yield from shared.scaled(erase_modulation.steps(request["state"]), 0.9)
    elif tab == "scatter_events":
        sound, modulation = yield from shared.scaled(scatter_events.steps(request["state"]), 0.9)
    elif tab == "quilt_sound":
        sound, original, segments = yield from shared.scaled(quilt_sound.steps(request["state"]), 0.9)
    elif tab == "match_texture":
        sound, original, matched = yield from shared.scaled(match_texture.steps(request["state"]), 0.95)
    elif tab == "draw_voice" and request.get("measure"):  # the source's voice, to take or copy from (draw_voice.md, S6)
        sound, voice = yield from shared.scaled(draw_voice.measure_steps(request["state"]), 0.9)
    else:
        yield 0.0, "Synthesizing"
        sound = TABS[tab](request["state"])
        yield 0.9, "Drawing the result"
    elapsed = time.perf_counter() - start
    result = {
        "fs": float(sound.fs),
        "samples": np.ascontiguousarray(sound.data[:, 0] if sound.n_channels == 2 else sound.mono().data[:, 0], dtype="<f4").tobytes(),
        "spectrogram": spectrogram(sound),
        "synthesis_s": elapsed,
    }
    if sound.n_channels == 2:  # the Draw path tab's two ears
        result["samples_right"] = np.ascontiguousarray(sound.data[:, 1], dtype="<f4").tobytes()
    if tab == "draw_modulation":  # the result's measured modulation spectrum, for under the plane (draw_modulation.md, B7)
        result["modulation"] = draw_modulation.measured_picture(draw_modulation.measured(sound, request["state"]))
    if tab == "erase_modulation":  # the source's modulation spectrum and the result's, on the plane (erase_modulation.md, E7, E9)
        result["source_modulation"] = erase_modulation.plane_picture(original)
        result["modulation"] = erase_modulation.plane_picture(erase_modulation.analyze(sound, request["state"]))
        result["clipped"] = clipped
    if tab == "scatter_events":  # the result's modulation spectrogram (scatter_events.md, E7)
        result["modulation_frames"], result["modulation_pooled"] = modulation["frames"], modulation["pooled"]
    if tab == "quilt_sound":  # the source, to compare the quilt with, and the segments the quilt is made of
        result["source_stft"], result["segments"] = spectrogram(original), segments
        result["segment_s"] = round(float(request["state"]["segment"]) * sound.fs) / sound.fs
    if tab == "match_texture":  # the source, to compare with, and how well each class of statistics matches it (match_texture.md, T7)
        kept = match_texture.classes(list(request["state"]["keep"])) + (match_texture.SPECTRUM,)
        result["source_stft"] = spectrogram(original)
        result["match"] = [round(matched[name], 2) for name in match_texture.BARS]
        result["imposed"] = [name in kept for name in match_texture.BARS]
    if tab == "draw_voice" and request.get("measure"):
        result["voice"] = voice
    if tab == "erase_spectrogram":  # the source's and the result's spectrograms in the mask's own STFT (erase_spectrogram.md)
        result["source_stft"], result["result_stft"] = erase_spectrogram.pictures(source_stft, result_stft)
    return result
