// The page's document: what Save writes, what a link holds, and what undo
// steps through (docs/design/tabs/painted.md, "Data model"). The duration and
// sampling rate belong to the page; each tab keeps its own section, so you
// can switch tabs and come back to what you drew.
//
//   {"app": "sonore-sketch", "version": 2, "sonore": "0.6.0",
//    "duration": 0.6, "fs": 16000, "tab": "tracks",
//    "tracks": {"mode": "klatt", "params": {...}},
//    "painted": {"f_lo": 100, "f_hi": 6400, ..., "levels": "..."},
//    "blobs": {"carrier": "tones", ..., "items": [{"rate": 4, ...}]},
//    "edit": {"source": "syllables", ..., "levels": "..."},
//    "mask": {"source": "syllables", ..., "levels": "..."},
//    "recording": {"name": "talk.wav", "fs": 16000, "pcm16": "..."}}
//
// A recording opened on the Erase modulation or Erase spectrogram tab belongs
// to the page, so either tab can use it; it is kept in saved files but never
// in links (docs/design/tabs/edit.md, E1), which would be far too long.
//
// A tab works on its own state, the shape its Python function takes
// (sonore_sketch.page.tab_state does the same in Python). A version-1
// document, the Tracks tab's own format from before there were other tabs,
// opens as version 2, so old files and links keep working.
//
// No DOM here, so this file runs under `node --test`.

import * as blobs from "./blobs/model.js";
import * as edit from "./edit/model.js";
import * as mask from "./mask/model.js";
import * as painted from "./painted/model.js";
import * as tracks from "./tracks/model.js";

export const APP = "sonore-sketch";
export const VERSION = 2;
export const TABS = ["tracks", "painted", "mask", "blobs", "edit"];

export function defaultPage() {
  const { sonore, duration, fs, mode, params } = tracks.defaultDocument();
  return {
    app: APP, version: VERSION, sonore, duration, fs, tab: "tracks",
    tracks: { mode, params }, painted: painted.defaultSection(), blobs: blobs.defaultSection(), edit: edit.defaultSection(),
    mask: mask.defaultSection(),
  };
}

// A document from a file or a link, as version 2; throws an Error saying what
// is wrong with it.
export function upgrade(doc) {
  if (doc?.trackdraw === tracks.FORMAT) {
    const { sonore, duration, fs, mode = "klatt", params = {} } = doc;
    return {
      app: APP, version: VERSION, sonore, duration, fs, tab: "tracks",
      tracks: { mode, params }, painted: painted.defaultSection(), blobs: blobs.defaultSection(), edit: edit.defaultSection(),
      mask: mask.defaultSection(),
    };
  }
  if (doc?.app !== APP || doc.version !== VERSION) {
    throw new Error(`not a sonore-sketch document of version ${VERSION}, or a TrackDraw document of format ${tracks.FORMAT}`);
  }
  // A tab added since the document was saved starts from its default.
  return {
    ...doc,
    painted: doc.painted ?? painted.defaultSection(),
    blobs: doc.blobs ?? blobs.defaultSection(),
    edit: doc.edit ?? edit.defaultSection(),
    mask: doc.mask ?? mask.defaultSection(),
  };
}

// The state a tab draws on and its Python function takes.
export function tabState(page, tab) {
  if (tab === "tracks") {
    const { sonore, duration, fs } = page;
    return { trackdraw: tracks.FORMAT, sonore, duration, fs, ...page.tracks };
  }
  if (tab === "painted") {
    const { sonore, duration, fs } = page;
    return { painted: painted.FORMAT, sonore, duration, fs, ...page.painted };
  }
  if (tab === "blobs") {
    const { sonore, duration, fs } = page;
    return { blobs: blobs.FORMAT, sonore, duration, fs, ...page.blobs };
  }
  if (tab === "edit" || tab === "mask") {
    // the source's own drawing goes with the state, so a change to it is heard
    const { sonore, duration, fs } = page;
    const state = { [tab]: tab === "edit" ? edit.FORMAT : mask.FORMAT, sonore, duration, fs, ...page[tab] };
    if (state.source === "speech") state.speech = page.tracks;
    if (state.source === "file" && page.recording) state.recording = page.recording;
    return state;
  }
  throw new Error(`unknown tab ${tab}`);
}

// A new page with a tab's state put back.
export function withTabState(page, tab, state) {
  if (tab === "tracks") {
    const { mode, params } = state;
    return { ...page, tracks: { mode, params } };
  }
  if (tab === "painted") {
    const { painted: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, painted: section };
  }
  if (tab === "blobs") {
    const { blobs: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, blobs: section };
  }
  if (tab === "edit" || tab === "mask") {
    const { [tab]: _format, sonore: _sonore, duration: _duration, fs: _fs, speech: _speech, recording: _recording, ...section } = state;
    return { ...page, [tab]: section };
  }
  throw new Error(`unknown tab ${tab}`);
}

// The document as a link holds it: without a recording (E1).
export function forLink(page) {
  const { recording: _recording, ...rest } = page;
  return rest;
}

// A recording opened in the page on `tab` (which takes it as its source),
// which sets the duration to its own (up to the page's limit; F6),
// stretching what the other tabs have drawn.
export function withRecording(page, recording, seconds, tab = "edit") {
  const duration = tracks.clampDuration(Math.round(Math.min(edit.MAX_RECORDING_S, seconds) * 1000) / 1000);
  const stretched = stretchPage(page, duration);
  return { ...stretched, recording, [tab]: { ...stretched[tab], source: "file" } };
}

// Check and tidy a document from a file or a link (upgrading it if old).
export function openDocument(doc) {
  const page = upgrade(doc);
  const state = tracks.tidyDocument(tracks.check(tabState(page, "tracks")));
  painted.check(tabState(page, "painted"));
  blobs.check(tabState(page, "blobs"));
  edit.check(tabState(page, "edit"));
  mask.check(tabState(page, "mask"));
  if (page.recording !== undefined) edit.checkRecording(page.recording);
  return withTabState({ ...page, tab: TABS.includes(page.tab) ? page.tab : "tracks" }, "tracks", state);
}

// Change the duration, stretching what every tab has drawn (a painting's
// columns are fractions of the duration, so it stretches by itself; blobs
// are in Hz and stay where they are, but the Draw modulation tab's bands are
// tracks in time and stretch).
export function stretchPage(page, duration) {
  const state = tracks.stretch(tabState(page, "tracks"), duration);
  const stretched = withTabState({ ...page, duration }, "tracks", state);
  const out = page.mask ? { ...stretched, mask: mask.stretchSection(page.mask, page.duration, duration) } : stretched;
  if (!page.blobs?.bands?.length) return out;
  return { ...out, blobs: { ...page.blobs, bands: blobs.stretchBands(page.blobs.bands, page.duration, duration) } };
}

// Reset: the duration, sampling rate and `tab`'s drawing go back to their
// defaults; the other tabs keep their drawings, stretched to the duration.
export function resetTab(page, tab) {
  const fresh = defaultPage();
  const stretched = stretchPage(page, fresh.duration);
  return withTabState({ ...stretched, fs: fresh.fs, sonore: fresh.sonore }, tab, tabState(fresh, tab));
}
