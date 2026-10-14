// The page's document: what Save writes, what a link holds, and what undo
// steps through (docs/design/tabs/painted.md, "Data model"). The duration and
// sampling rate belong to the page; each tab keeps its own section, so you
// can switch tabs and come back to what you drew.
//
//   {"app": "sonore-sketch", "version": 2, "sonore": "0.7.0",
//    "duration": 2, "fs": 16000, "tab": "tracks",
//    "tracks": {"mode": "klatt", "params": {...}},
//    "painted": {"f_lo": 100, "f_hi": 6400, ..., "levels": "..."},
//    "blobs": {"carrier": "tones", ..., "items": [{"rate": 4, ...}]},
//    "edit": {"source": "syllables", ..., "levels": "..."},
//    "mask": {"source": "syllables", ..., "levels": "..."},
//    "paths": {"source": "noise", "room": "dry", "stroke": [[t, x, y], ...], "elevation": 0, "speed": null},
//    "events": {"event": "chirp", ..., "rate": 10, "regularity": 1, "seed": 0},
//    "recording": {"name": "talk.wav", "fs": 16000, "pcm16": "..."}}
//
// A recording opened on the Erase modulation or Erase spectrogram tab belongs
// to the page, so either tab can use it; it is kept in saved files but never
// in links (docs/design/tabs/edit.md, E1), which would be far too long.
//
// A tab works on its own state, the shape its Python function takes
// (sonore_sketch.page.tab_state does the same in Python). A version-1
// document, the Draw speech tab's own format from before there were other tabs,
// opens as version 2, so old files and links keep working.
//
// No DOM here, so this file runs under `node --test`.

import * as blobs from "./blobs/model.js";
import * as edit from "./edit/model.js";
import * as events from "./events/model.js";
import * as mask from "./mask/model.js";
import * as painted from "./painted/model.js";
import * as paths from "./paths/model.js";
import { MAX_RECORDING_S, checkRecording } from "./sources.js";
import * as tracks from "./tracks/model.js";

export const APP = "sonore-sketch";
export const VERSION = 2;
export const TABS = ["tracks", "painted", "mask", "blobs", "edit", "paths", "events"];

export function defaultPage() {
  const { sonore, duration, fs, mode, params } = tracks.defaultDocument();
  return {
    app: APP, version: VERSION, sonore, duration, fs, tab: "tracks",
    tracks: { mode, params }, painted: painted.defaultSection(), blobs: blobs.defaultSection(), edit: edit.defaultSection(),
    mask: mask.defaultSection(), paths: paths.defaultSection(), events: events.defaultSection(),
  };
}

// A document from a file or a link, as version 2; throws an Error saying what
// is wrong with it.
export function upgrade(opened) {
  if (opened?.trackdraw === tracks.FORMAT) {
    const { sonore, duration, fs, mode = "klatt", params = {} } = opened;
    return {
      app: APP, version: VERSION, sonore, duration, fs, tab: "tracks",
      tracks: { mode, params }, painted: painted.defaultSection(), blobs: blobs.defaultSection(), edit: edit.defaultSection(),
      mask: mask.defaultSection(), paths: paths.defaultSection(), events: events.defaultSection(),
    };
  }
  if (opened?.app !== APP || opened.version !== VERSION) {
    throw new Error(`not a sonore-sketch document of version ${VERSION}, or a TrackDraw document of format ${tracks.FORMAT}`);
  }
  // A tab added since the document was saved starts from its default.
  return {
    ...opened,
    painted: opened.painted ?? painted.defaultSection(),
    blobs: opened.blobs ?? blobs.defaultSection(),
    edit: opened.edit ?? edit.defaultSection(),
    mask: opened.mask ?? mask.defaultSection(),
    paths: opened.paths ?? paths.defaultSection(),
    events: events.withDefaults(opened.events ?? {}),
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
  if (tab === "events") {
    const { sonore, duration, fs } = page;
    return { events: events.FORMAT, sonore, duration, fs, ...page.events };
  }
  if (tab === "edit" || tab === "mask" || tab === "paths") {
    // the source's own drawing goes with the state, so a change to it is heard
    const { sonore, duration, fs } = page;
    const format = { edit: edit.FORMAT, mask: mask.FORMAT, paths: paths.FORMAT }[tab];
    const state = { [tab]: format, sonore, duration, fs, ...page[tab] };
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
  if (tab === "events") {
    const { events: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, events: section };
  }
  if (tab === "edit" || tab === "mask" || tab === "paths") {
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
  const duration = tracks.clampDuration(Math.round(Math.min(MAX_RECORDING_S, seconds) * 1000) / 1000);
  const stretched = stretchPage(page, duration);
  return { ...stretched, recording, [tab]: { ...stretched[tab], source: "file" } };
}

// Check and tidy a document from a file or a link (upgrading it if old).
export function openDocument(opened) {
  const page = upgrade(opened);
  const state = tracks.tidyDocument(tracks.check(tabState(page, "tracks")));
  painted.check(tabState(page, "painted"));
  blobs.check(tabState(page, "blobs"));
  edit.check(tabState(page, "edit"));
  mask.check(tabState(page, "mask"));
  paths.check(tabState(page, "paths"));
  events.check(tabState(page, "events"));
  if (page.recording !== undefined) checkRecording(page.recording);
  return withTabState({ ...page, tab: TABS.includes(page.tab) ? page.tab : "tracks" }, "tracks", state);
}

// Change the duration, stretching what every tab has drawn (a painting's
// columns are fractions of the duration, so it stretches by itself; blobs
// are in Hz and stay where they are, but the Draw modulation tab's bands are
// tracks in time and stretch).
export function stretchPage(page, duration) {
  const state = tracks.stretch(tabState(page, "tracks"), duration);
  const stretched = withTabState({ ...page, duration }, "tracks", state);
  const masked = page.mask ? { ...stretched, mask: mask.stretchSection(page.mask, page.duration, duration) } : stretched;
  const moved = page.paths ? { ...masked, paths: paths.stretchSection(page.paths, page.duration, duration) } : masked;
  const out = page.events ? { ...moved, events: events.stretchSection(page.events, page.duration, duration) } : moved;
  if (!page.blobs?.bands?.length) return out;
  return { ...out, blobs: { ...page.blobs, bands: blobs.stretchBands(page.blobs.bands, page.duration, duration) } };
}

// Reset: `tab` goes back to what it held in `start`, the page as it opened
// (from a link, a file or the defaults), with its duration and sampling
// rate; the other tabs keep their drawings, stretched to that duration.
export function resetTab(page, tab, start = defaultPage()) {
  const stretched = stretchPage(page, start.duration);
  return withTabState({ ...stretched, fs: start.fs, sonore: start.sonore }, tab, tabState(start, tab));
}

// Clear: `tab`'s drawing goes blank and its settings (carrier, range,
// source) stay, as does the duration. Draw speech cannot be blank, so it
// goes to a steady neutral vowel: every track flat at its default
// (tracks.DEFAULTS), a schwa on 100 Hz (F1-F5 at 500, 1500, 2500, 3500 and
// 4500 Hz, a uniform tube's resonances), voiced, no noise. The sampling rate
// goes back to its default, which nothing on the page sets but a file or link.
// Scatter events has no drawing but its rate track, which goes flat at its default.
export async function clearTab(page, tab) {
  const fresh = defaultPage();
  const cleared = { ...page, fs: fresh.fs, sonore: fresh.sonore };
  if (tab === "tracks") return { ...cleared, tracks: { mode: "klatt", params: { ...tracks.DEFAULTS } } };
  if (tab === "painted") return { ...cleared, painted: { ...page.painted, levels: await painted.encodeLevels(painted.blank(page.painted)) } };
  if (tab === "blobs") return { ...cleared, blobs: { ...page.blobs, items: [], bands: [] } };
  if (tab === "edit") return { ...cleared, edit: { ...page.edit, levels: await painted.encodeLevels(edit.blank()) } };
  if (tab === "paths") return { ...cleared, paths: { ...page.paths, stroke: [], elevation: 0, speed: null } };
  if (tab === "events") return { ...cleared, events: { ...page.events, rate: events.DEFAULT_RATE } };
  if (tab === "mask") {
    const { span: _span, ...section } = page.mask;
    return { ...cleared, mask: { ...section, levels: mask.BLANK_LEVELS } };
  }
  throw new Error(`unknown tab ${tab}`);
}
