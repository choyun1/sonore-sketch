// The page's document: what Save writes, what a link holds, and what undo
// steps through (docs/design/tabs/draw_spectrogram.md, "Data model"). The duration and
// sampling rate belong to the page; each tab keeps its own section, so you
// can switch tabs and come back to what you drew.
//
//   {"app": "sonore-sketch", "version": 3, "sonore": "0.8.0",
//    "duration": 0.6, "fs": 16000, "tab": "draw_speech",
//    "draw_speech": {"mode": "klatt", "params": {...}},
//    "draw_spectrogram": {"f_lo": 100, "f_hi": 6400, ..., "levels": "..."},
//    "draw_modulation": {"carrier": "tones", ..., "items": [{"rate": 4, ...}]},
//    "erase_modulation": {"source": "syllables", ..., "levels": "..."},
//    "erase_spectrogram": {"source": "syllables", ..., "levels": "..."},
//    "draw_path": {"source": "noise", "room": "dry", "stroke": [[t, x, y], ...], "elevation": 0, "speed": null},
//    "scatter_events": {"event": "chirp", ..., "rate": 10, "regularity": 1, "seed": 0},
//    "quilt_sound": {"source": "syllables", "segment": 0.06, "seed": 1},
//    "match_texture": {"source": "scatter_events", "keep": ["marginals", ...], "iterations": 10, "seed": 1},
//    "recording": {"name": "talk.wav", "fs": 16000, "pcm16": "..."}}
//
// A recording opened on the Erase modulation, Erase spectrogram, Quilt a
// sound or Match a texture tab belongs to the page, so any of them can use it; it is kept in saved files but never
// in links (docs/design/tabs/erase_modulation.md, E1), which would be far too long.
//
// A tab works on its own state, the shape its Python function takes
// (sonore_sketch.page.tab_state does the same in Python). Older documents
// open as version 3, so old files and links keep working: a version-1
// document is the Draw speech tab's own format from before there were other
// tabs, and a version-2 document names the tabs by their old ids (OLD_TAB_IDS).
//
// No DOM here, so this file runs under `node --test`.

import * as drawModulation from "./draw_modulation/model.js";
import * as eraseModulation from "./erase_modulation/model.js";
import * as scatterEvents from "./scatter_events/model.js";
import * as eraseSpectrogram from "./erase_spectrogram/model.js";
import * as drawSpectrogram from "./draw_spectrogram/model.js";
import * as drawPath from "./draw_path/model.js";
import * as quiltSound from "./quilt_sound/model.js";
import * as matchTexture from "./match_texture/model.js";
import { MAX_RECORDING_S, checkRecording } from "./sources.js";
import * as drawSpeech from "./draw_speech/model.js";

export const APP = "sonore-sketch";
export const VERSION = 3;
export const TABS = ["draw_speech", "draw_spectrogram", "erase_spectrogram", "draw_modulation", "erase_modulation", "draw_path", "scatter_events", "quilt_sound", "match_texture"];

// The tabs' ids in version-2 documents (before 2026-10-20), each with the id
// it has now; a source naming a tab used the same ids, but "speech" for Draw
// speech (sonore_sketch.page.OLD_TAB_IDS is the same).
export const OLD_TAB_IDS = {
  tracks: "draw_speech", painted: "draw_spectrogram", mask: "erase_spectrogram", blobs: "draw_modulation",
  edit: "erase_modulation", paths: "draw_path", events: "scatter_events", quilt: "quilt_sound", speech: "draw_speech",
};

// A version-2 document as version 3: its sections, the tab it was saved on
// and every source that names a tab, under the tabs' ids of now.
function renameOldTabs(opened) {
  const renamed = { ...opened, version: VERSION, tab: OLD_TAB_IDS[opened.tab] ?? opened.tab };
  for (const [old, id] of Object.entries(OLD_TAB_IDS)) {
    if (!(old in opened) || old === "speech") continue;
    const section = opened[old];
    delete renamed[old];
    renamed[id] = section?.source in OLD_TAB_IDS ? { ...section, source: OLD_TAB_IDS[section.source] } : section;
  }
  return renamed;
}

// The page's starting duration [s] on every tab but Draw speech, which starts
// at its word's own 0.6 s (Cho, 2026-10-14).
export const START_DURATION = 2;

// The page as it opens on `tab`: every tab's starting drawing, at that tab's
// starting duration. On the other tabs the Draw speech word is stretched to
// the 2 s, as any change of duration would, so going back to 0.6 s gives the
// word back as it was spoken.
export function defaultPage(tab = "draw_speech") {
  const word = drawSpeech.defaultDocument();
  const { sonore, duration, fs, mode, params } = tab === "draw_speech" ? word : drawSpeech.stretch(word, START_DURATION);
  return {
    app: APP, version: VERSION, sonore, duration, fs, tab,
    draw_speech: { mode, params }, draw_spectrogram: drawSpectrogram.defaultSection(), draw_modulation: drawModulation.defaultSection(), erase_modulation: eraseModulation.defaultSection(),
    erase_spectrogram: eraseSpectrogram.defaultSection(), draw_path: drawPath.defaultSection(), scatter_events: scatterEvents.defaultSection(), quilt_sound: quiltSound.defaultSection(),
    match_texture: matchTexture.defaultSection(),
  };
}

// Whether `page` is still the starting page of `tab`: nothing drawn or set
// yet. Until then the duration follows the tab shown (main.js, switchTab).
export const isStartingPage = (page, tab) => JSON.stringify({ ...page, tab }) === JSON.stringify(defaultPage(tab));

// A document from a file or a link, as version 3; throws an Error saying what
// is wrong with it.
export function upgrade(opened) {
  if (opened?.app === APP && opened.version === 2) return upgrade(renameOldTabs(opened));
  if (opened?.trackdraw === drawSpeech.FORMAT) {
    const { sonore, duration, fs, mode = "klatt", params = {} } = opened;
    return {
      app: APP, version: VERSION, sonore, duration, fs, tab: "draw_speech",
      draw_speech: { mode, params }, draw_spectrogram: drawSpectrogram.defaultSection(), draw_modulation: drawModulation.defaultSection(), erase_modulation: eraseModulation.defaultSection(),
      erase_spectrogram: eraseSpectrogram.defaultSection(), draw_path: drawPath.defaultSection(), scatter_events: scatterEvents.defaultSection(), quilt_sound: quiltSound.defaultSection(),
      match_texture: matchTexture.defaultSection(),
    };
  }
  if (opened?.app !== APP || opened.version !== VERSION) {
    throw new Error(`not a sonore-sketch document of version ${VERSION}, or a TrackDraw document of format ${drawSpeech.FORMAT}`);
  }
  // A tab added since the document was saved starts from its default.
  return {
    ...opened,
    draw_spectrogram: opened.draw_spectrogram ?? drawSpectrogram.defaultSection(),
    draw_modulation: opened.draw_modulation ?? drawModulation.defaultSection(),
    erase_modulation: opened.erase_modulation ?? eraseModulation.defaultSection(),
    erase_spectrogram: opened.erase_spectrogram ?? eraseSpectrogram.defaultSection(),
    draw_path: opened.draw_path ?? drawPath.defaultSection(),
    scatter_events: scatterEvents.withDefaults(opened.scatter_events ?? {}),
    quilt_sound: opened.quilt_sound ?? quiltSound.defaultSection(),
    match_texture: opened.match_texture ?? matchTexture.defaultSection(),
  };
}

// The state a tab draws on and its Python function takes.
export function tabState(page, tab) {
  if (tab === "draw_speech") {
    const { sonore, duration, fs } = page;
    return { trackdraw: drawSpeech.FORMAT, sonore, duration, fs, ...page.draw_speech };
  }
  if (tab === "draw_spectrogram") {
    const { sonore, duration, fs } = page;
    return { draw_spectrogram: drawSpectrogram.FORMAT, sonore, duration, fs, ...page.draw_spectrogram };
  }
  if (tab === "draw_modulation") {
    const { sonore, duration, fs } = page;
    return { draw_modulation: drawModulation.FORMAT, sonore, duration, fs, ...page.draw_modulation };
  }
  if (tab === "scatter_events") {
    const { sonore, duration, fs } = page;
    return { scatter_events: scatterEvents.FORMAT, sonore, duration, fs, ...page.scatter_events };
  }
  if (tab === "erase_modulation" || tab === "erase_spectrogram" || tab === "draw_path" || tab === "quilt_sound" || tab === "match_texture") {
    // the source's own drawing goes with the state, so a change to it is heard
    const { sonore, duration, fs } = page;
    const format = { erase_modulation: eraseModulation.FORMAT, erase_spectrogram: eraseSpectrogram.FORMAT, draw_path: drawPath.FORMAT, quilt_sound: quiltSound.FORMAT,
      match_texture: matchTexture.FORMAT }[tab];
    const state = { [tab]: format, sonore, duration, fs, ...page[tab] };
    if (state.source === "draw_speech") state.draw_speech = page.draw_speech;
    if (state.source === "file" && page.recording) state.recording = page.recording;
    if ((tab === "quilt_sound" || tab === "match_texture") && quiltSound.DRAWN.includes(state.source)) state.drawing = page[state.source]; // that tab's drawing, made into its sound
    return state;
  }
  throw new Error(`unknown tab ${tab}`);
}

// A new page with a tab's state put back.
export function withTabState(page, tab, state) {
  if (tab === "draw_speech") {
    const { mode, params } = state;
    return { ...page, draw_speech: { mode, params } };
  }
  if (tab === "draw_spectrogram") {
    const { draw_spectrogram: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, draw_spectrogram: section };
  }
  if (tab === "draw_modulation") {
    const { draw_modulation: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, draw_modulation: section };
  }
  if (tab === "scatter_events") {
    const { scatter_events: _format, sonore: _sonore, duration: _duration, fs: _fs, ...section } = state;
    return { ...page, scatter_events: section };
  }
  if (tab === "erase_modulation" || tab === "erase_spectrogram" || tab === "draw_path" || tab === "quilt_sound" || tab === "match_texture") {
    const { [tab]: _format, sonore: _sonore, duration: _duration, fs: _fs, draw_speech: _speech, recording: _recording, drawing: _drawing, ...section } = state;
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
export function withRecording(page, recording, seconds, tab = "erase_modulation") {
  const duration = drawSpeech.clampDuration(Math.round(Math.min(MAX_RECORDING_S, seconds) * 1000) / 1000);
  const stretched = stretchPage(page, duration);
  return { ...stretched, recording, [tab]: { ...stretched[tab], source: "file" } };
}

// Check and tidy a document from a file or a link (upgrading it if old).
export function openDocument(opened) {
  const page = upgrade(opened);
  const state = drawSpeech.tidyDocument(drawSpeech.check(tabState(page, "draw_speech")));
  drawSpectrogram.check(tabState(page, "draw_spectrogram"));
  drawModulation.check(tabState(page, "draw_modulation"));
  eraseModulation.check(tabState(page, "erase_modulation"));
  eraseSpectrogram.check(tabState(page, "erase_spectrogram"));
  drawPath.check(tabState(page, "draw_path"));
  scatterEvents.check(tabState(page, "scatter_events"));
  quiltSound.check(tabState(page, "quilt_sound"));
  matchTexture.check(tabState(page, "match_texture"));
  if (page.recording !== undefined) checkRecording(page.recording);
  return withTabState({ ...page, tab: TABS.includes(page.tab) ? page.tab : "draw_speech" }, "draw_speech", state);
}

// Change the duration, stretching what every tab has drawn (a painting's
// columns are fractions of the duration, so it stretches by itself; blobs
// are in Hz and stay where they are, but the Draw modulation tab's bands are
// tracks in time and stretch).
export function stretchPage(page, duration) {
  const state = drawSpeech.stretch(tabState(page, "draw_speech"), duration);
  const stretched = withTabState({ ...page, duration }, "draw_speech", state);
  const masked = page.erase_spectrogram ? { ...stretched, erase_spectrogram: eraseSpectrogram.stretchSection(page.erase_spectrogram, page.duration, duration) } : stretched;
  const moved = page.draw_path ? { ...masked, draw_path: drawPath.stretchSection(page.draw_path, page.duration, duration) } : masked;
  const out = page.scatter_events ? { ...moved, scatter_events: scatterEvents.stretchSection(page.scatter_events, page.duration, duration) } : moved;
  if (!page.draw_modulation?.bands?.length) return out;
  return { ...out, draw_modulation: { ...page.draw_modulation, bands: drawModulation.stretchBands(page.draw_modulation.bands, page.duration, duration) } };
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
// (drawSpeech.DEFAULTS), a schwa on 100 Hz (F1-F5 at 500, 1500, 2500, 3500 and
// 4500 Hz, a uniform tube's resonances), voiced, no noise. The sampling rate
// goes back to its default, which nothing on the page sets but a file or link.
// Scatter events has no drawing but its rate track, which goes flat at its
// default; Quilt a sound and Match a texture have none at all, and keep their settings.
export async function clearTab(page, tab) {
  const fresh = defaultPage();
  const cleared = { ...page, fs: fresh.fs, sonore: fresh.sonore };
  if (tab === "draw_speech") return { ...cleared, draw_speech: { mode: "klatt", params: { ...drawSpeech.DEFAULTS } } };
  if (tab === "draw_spectrogram") return { ...cleared, draw_spectrogram: { ...page.draw_spectrogram, levels: await drawSpectrogram.encodeLevels(drawSpectrogram.blank(page.draw_spectrogram)) } };
  if (tab === "draw_modulation") return { ...cleared, draw_modulation: { ...page.draw_modulation, items: [], bands: [] } };
  if (tab === "erase_modulation") return { ...cleared, erase_modulation: { ...page.erase_modulation, levels: await drawSpectrogram.encodeLevels(eraseModulation.blank()) } };
  if (tab === "draw_path") return { ...cleared, draw_path: { ...page.draw_path, stroke: [], elevation: 0, speed: null } };
  if (tab === "scatter_events") return { ...cleared, scatter_events: { ...page.scatter_events, rate: scatterEvents.DEFAULT_RATE } };
  if (tab === "quilt_sound" || tab === "match_texture") return cleared;
  if (tab === "erase_spectrogram") {
    const { span: _span, ...section } = page.erase_spectrogram;
    return { ...cleared, erase_spectrogram: { ...section, levels: eraseSpectrogram.BLANK_LEVELS } };
  }
  throw new Error(`unknown tab ${tab}`);
}
