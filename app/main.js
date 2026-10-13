// The page shell: tabs, duration, synthesis engine, playback, the result,
// undo, reset, save, open, links and the log (docs/design/app.md, "One tab, one route back
// to sound"). Tabs plug in through a small contract: a document to edit, a
// `commit` callback when an edit ends, and a picture of the last result.

import { Player, wavBlob } from "./audio.js";
import { LatestOnly, createEngine } from "./engine.js";
import { History } from "./history.js";
import { Log } from "./log.js";
import { drawWaveform } from "./plot.js";
import { encodeState, stateFromHash } from "./share.js";
import { clearTab, defaultPage, forLink, openDocument, resetTab, stretchPage, tabState, withRecording, withTabState } from "./document.js";
import { createBlobsTab } from "./blobs/tab.js";
import { createEditTab } from "./edit/tab.js";
import { createMaskTab } from "./mask/tab.js";
import { createPaintedTab } from "./painted/tab.js";
import { clampDuration } from "./tracks/model.js";
import { createTracksTab } from "./tracks/tab.js";

const AUTOPLAY_MAX_S = 3; // longer sounds play on Play only (app.md, D10)

const $ = (id) => document.getElementById(id);
const ui = {
  play: $("play"), duration: $("duration"), autoplay: $("autoplay"), clear: $("clear"), reset: $("reset"), undo: $("undo"), redo: $("redo"),
  open: $("open"), save: $("save"), link: $("link"), wav: $("wav"), file: $("file"),
  status: $("status"), versions: $("versions"), waveform: $("waveform"),
  log: $("log"), logToggle: $("log-toggle"), logLines: $("log-lines"), logCopy: $("log-copy"), logClear: $("log-clear"),
};

// --- the log ---------------------------------------------------------------------

const log = new Log();
log.onchange = () => {
  ui.logLines.replaceChildren(
    ...log.entries.map(({ time, level, text, detail }) => {
      const line = document.createElement("div");
      line.className = level;
      line.textContent = `${time} ${text}${detail ? `\n${detail.replace(/^/gm, "    ")}` : ""}`;
      return line;
    }),
  );
  ui.logLines.scrollTop = ui.logLines.scrollHeight;
  ui.logToggle.textContent = log.errors ? `Log (${log.errors})` : "Log";
  ui.logToggle.classList.toggle("has-errors", log.errors > 0);
};
window.addEventListener("error", (event) => log.error(`page error: ${event.message}`, event.error?.stack ?? ""));
window.addEventListener("unhandledrejection", (event) =>
  log.error(`page error: ${event.reason?.message ?? event.reason}`, event.reason?.stack ?? ""),
);

// Loading the synthesizer takes several seconds on every visit (docs/design/app.md, M1): say so under the header, with a clock
const loadStart = performance.now();
const loadClock = setInterval(() => {
  $("loading-time").textContent = `${((performance.now() - loadStart) / 1000).toFixed(0)} s`;
}, 1000);
function loading(text, failed = false) {
  $("loading-step").textContent = text.replace(/ \(\d+(\.\d+)? s\)$/, "");
  $("loading").classList.toggle("failed", failed);
  if (failed) {
    clearInterval(loadClock);
    ui.play.textContent = "▶ Play";
  }
}

const engineKind = new URLSearchParams(location.search).get("engine") ?? "pyodide";
log.info(`page opened, engine: ${engineKind}`, navigator.userAgent);
let ready = false;
const engine = new LatestOnly(
  createEngine(engineKind, {
    onProgress: (text) => {
      loading(text);
      status(text);
      log.info(text);
    },
    onReady: (versions, timing) => {
      ready = true;
      log.info(`ready: ${versions}`, timing);
      ui.versions.textContent = versions;
      ui.play.disabled = false;
      ui.play.textContent = "▶ Play";
      clearInterval(loadClock);
      $("loading").hidden = true;
      status("Ready. Draw, then press Play.");
      synthesize({ play: false });
    },
    onFailed: (message) => {
      loading(`Could not start the synthesizer: ${message} (see Log)`, true);
      status(`Could not start the synthesizer: ${message} (see Log)`, true);
      log.error(`could not start the synthesizer: ${message}`);
    },
  }),
);

const player = new Player();
let result = null; // {key, doc, sound}: the last sound made, from which tab's state

function status(text, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
}

// --- the document and its history ----------------------------------------------

let initial = defaultPage();
try {
  const linked = stateFromHash(location.hash);
  if (linked) initial = openDocument(linked);
} catch (error) {
  log.error(`ignored the drawing in the link: ${error.message}`);
}
const history = new History(initial);
// What Reset goes back to: the page as it opened, or as a file or link last opened it.
let opened = initial;
const hasRecording = () => Boolean(history.present.recording);
const commitFrom = (id) => (state) => change(withTabState(history.present, id, state));
const tabs = {
  tracks: createTracksTab($("tab-tracks"), { commit: commitFrom("tracks") }),
  painted: createPaintedTab($("tab-painted"), { commit: commitFrom("painted"), log }),
  mask: createMaskTab($("tab-mask"), {
    commit: commitFrom("mask"),
    openRecording: (recording, seconds) => change(withRecording(history.present, recording, seconds, "mask")),
    hasRecording,
    log,
  }),
  blobs: createBlobsTab($("tab-blobs"), { commit: commitFrom("blobs") }),
  edit: createEditTab($("tab-edit"), {
    commit: commitFrom("edit"),
    // a recording belongs to the page, and sets its duration (edit.md, E1)
    openRecording: (recording, seconds) => change(withRecording(history.present, recording, seconds)),
    hasRecording,
    log,
  }),
};
// The tab shown is not an edit (undo does not switch tabs); it is saved with
// the document, so a link opens on the tab it was made on.
let tab = tabs[initial.tab] ?? tabs.tracks;
const tabButtons = [...document.querySelectorAll(".tabs [data-tab]")];

function showTab() {
  for (const button of tabButtons) {
    const active = button.dataset.tab === tab.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const id of Object.keys(tabs)) $(`tab-${id}`).hidden = id !== tab.id;
  // a tab that draws the result's waveform itself (the Draw modulation tab, in its Result box)
  document.querySelector("main > .result").hidden = Boolean(tab.ownWaveform);
  $("tab-caption").textContent = tabButtons.find((b) => b.dataset.tab === tab.id)?.dataset.caption ?? "";
}

function switchTab(id) {
  if (!tabs[id] || tabs[id] === tab) return;
  player.stop();
  tab.setPlayhead(null);
  tab = tabs[id];
  showTab();
  show();
  showResult();
  log.info(`switched to the ${id} tab`);
  if (ready) synthesize({ play: false });
}
for (const button of tabButtons) button.addEventListener("click", () => switchTab(button.dataset.tab));

// The document as saved and linked: with the tab shown (a link without the recording).
const saved = () => ({ ...history.present, tab: tab.id });
const linked = () => forLink(saved());

function show() {
  const doc = history.present;
  tab.setDocument(tabState(doc, tab.id));
  ui.duration.value = doc.duration;
  ui.undo.disabled = !history.past.length;
  ui.redo.disabled = !history.future.length;
  window.history.replaceState(null, "", `${location.pathname}${location.search}#state=${encodeState(linked())}`);
}

// An edit has ended: keep it, and hear it if it is short enough.
function change(doc) {
  history.push(doc);
  show();
  afterChange();
}

function afterChange() {
  const short = history.present.duration <= AUTOPLAY_MAX_S;
  if (ready && short) synthesize({ play: ui.autoplay.checked });
  // a synthesis under way for the old drawing starts again on the new one
  else if (ready && running) synthesize({ play: running.play });
  else if (ready) status("Press Play to hear the change.");
}

// --- synthesis progress, over the tab's main figure ------------------------------

const progress = document.createElement("div");
progress.className = "synth-progress";
progress.innerHTML = `<div class="bar"></div><span class="label"></span>`;
let requests = 0; // counts synthesize() calls: only the newest shows its progress
let running = null; // {play, key, made} while a synthesis is under way

// fraction from 0 to 1, undefined while it is not known yet, null to hide
function showProgress(fraction) {
  const figure = tab.figure;
  if (fraction === null || !figure) return progress.remove();
  if (progress.parentNode !== figure) figure.appendChild(progress);
  const known = typeof fraction === "number";
  progress.classList.toggle("unknown", !known);
  progress.querySelector(".bar").style.width = known ? `${Math.round(100 * fraction)}%` : "";
  progress.querySelector(".label").textContent = known ? `Synthesizing… ${Math.round(100 * fraction)}%` : "Synthesizing…";
}

// --- synthesis and playback ----------------------------------------------------

async function synthesize({ play }) {
  const doc = history.present;
  const asked = tab;
  const state = tabState(doc, tab.id);
  const key = `${tab.id} ${JSON.stringify(state)}`;
  if (running?.key === key) {
    // this drawing is already being made: hear it when it comes, rather than start over
    running.play ||= play;
    return running.made.catch(() => null);
  }
  const mine = ++requests;
  if (result?.key === key) {
    running = null;
    showProgress(null);
    if (play) start(result.sound);
    return result.sound;
  }
  const blocked = await tab.blocked?.();
  if (mine !== requests) return null; // a newer drawing came while this tab read its own
  if (blocked) {
    running = null;
    showProgress(null);
    result = null;
    showResult();
    status(blocked);
    return null;
  }
  status(doc.duration > 1 ? `Synthesizing ${doc.duration} s…` : "Synthesizing…");
  const made = engine.synthesize({ tab: tab.id, state }, (fraction) => mine === requests && showProgress(fraction));
  const asking = (running = { play, key, made });
  showProgress(undefined);
  let sound;
  try {
    sound = await made;
  } catch (error) {
    if (mine !== requests) return null; // a newer drawing is being made; this one's failure no longer matters
    running = null;
    showProgress(null);
    status(`Synthesis failed: ${error.message} (see Log; Reset starts again)`, true);
    log.error(`synthesis failed: ${error.message}`, error.detail ?? "");
    if (tab === asked && history.present === doc) tab.failed?.(error.message);
    return null;
  }
  if (mine === requests) {
    running = null;
    showProgress(null);
  }
  if (!sound) return null; // a newer drawing replaced this request
  // The drawing changed while this was made, to one that asks for no sound
  // (nothing drawn) or to another tab: this sound is no longer what is shown.
  if (tab !== asked || history.present !== doc) return null;
  result = { key, doc, sound };
  showResult();
  status(`Made ${doc.duration} s in ${sound.synthesisSeconds.toFixed(2)} s.`);
  log.info(`made ${doc.duration} s in ${sound.synthesisSeconds.toFixed(2)} s`);
  if (asking.play && history.present === doc) start(sound);
  return sound;
}

function showResult() {
  if (result && !result.key.startsWith(`${tab.id} `)) result = null;
  const sound = result?.sound;
  const duration = result?.doc.duration ?? history.present.duration;
  tab.setResult(sound);
  drawWaveform(ui.waveform, sound?.samples, sound?.fs, duration);
  ui.wav.disabled = !sound;
}

let ticking = false; // one playhead loop, however often a sound is restarted

function start(sound) {
  player.play(sound.samples, sound.fs);
  ui.play.textContent = "■ Stop";
  if (ticking) return;
  ticking = true;
  const tick = () => {
    const t = player.position;
    tab.setPlayhead(t);
    if (t !== null) requestAnimationFrame(tick);
    else ticking = false;
  };
  requestAnimationFrame(tick);
}

player.onended = () => {
  ui.play.textContent = "▶ Play";
  tab.setPlayhead(null);
};

async function togglePlay() {
  if (player.playing) return player.stop();
  if (!ready) return status("Still loading; Play will work once sonore is ready.");
  await synthesize({ play: true });
}

// --- controls --------------------------------------------------------------------

ui.play.addEventListener("click", togglePlay);

ui.duration.addEventListener("change", () => {
  const typed = ui.duration.value.trim() === "" ? NaN : Number(ui.duration.value);
  // to the millisecond, as times on the tabs are
  const duration = clampDuration(Math.round((Number.isFinite(typed) ? typed : history.present.duration) * 1000) / 1000);
  if (duration === history.present.duration) return (ui.duration.value = duration);
  change(stretchPage(history.present, duration));
});

function undo() {
  if (history.undo()) {
    show();
    afterChange();
  }
}
function redo() {
  if (history.redo()) {
    show();
    afterChange();
  }
}
ui.undo.addEventListener("click", undo);
// Clear and Reset are edits like any other, so Undo brings the drawing back.
ui.clear.addEventListener("click", async () => {
  const id = tab.id;
  const cleared = await clearTab(history.present, id);
  change(cleared);
  log.info(`cleared the ${id} tab`);
  if (!ready) status("Cleared.");
});
ui.reset.addEventListener("click", () => {
  change(resetTab(history.present, tab.id, opened));
  log.info(`reset the ${tab.id} tab to the drawing it opened with`);
  if (!ready) status("Reset to the drawing the page opened with.");
});
ui.redo.addEventListener("click", redo);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

ui.save.addEventListener("click", () => {
  const text = JSON.stringify(saved(), null, 1);
  download(new Blob([text], { type: "application/json" }), "sketch.json");
});
// The sound of the drawing shown: made first if the last one is of an older drawing.
ui.wav.addEventListener("click", async () => {
  const sound = result?.doc === history.present ? result.sound : await synthesize({ play: false });
  if (sound) download(wavBlob(sound.samples, sound.fs), "sketch.wav");
});
ui.open.addEventListener("click", () => ui.file.click());
ui.file.addEventListener("change", async () => {
  const file = ui.file.files[0];
  ui.file.value = "";
  if (!file) return;
  try {
    const doc = openDocument(JSON.parse(await file.text()));
    opened = doc;
    change(doc);
    switchTab(doc.tab); // as a link does, the drawing opens on the tab it was saved on
    status(`Opened ${file.name}.`);
    log.info(`opened ${file.name}`);
  } catch (error) {
    status(`Could not open ${file.name}: ${error.message}`, true);
    log.error(`could not open ${file.name}: ${error.message}`);
  }
});
// A link pasted into the address bar of the open page changes only the hash,
// which does not reload it: open the drawing it holds, as a load would.
// (The page's own replaceState does not fire this.)
window.addEventListener("hashchange", () => {
  try {
    const linkedDoc = stateFromHash(location.hash);
    if (!linkedDoc) return;
    const doc = openDocument(linkedDoc);
    opened = doc;
    change(doc);
    switchTab(doc.tab);
    status("Opened the drawing in the link.");
  } catch (error) {
    status(`Could not open the drawing in the link: ${error.message}`, true);
    log.error(`could not open the drawing in the link: ${error.message}`);
  }
});
ui.link.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    status("Link copied: it opens this drawing.");
  } catch {
    status("The address bar holds the link to this drawing.");
  }
});

ui.logToggle.addEventListener("click", () => {
  ui.log.hidden = !ui.log.hidden;
  ui.logToggle.setAttribute("aria-expanded", String(!ui.log.hidden));
  if (!ui.log.hidden) ui.logLines.scrollTop = ui.logLines.scrollHeight;
});
ui.logClear.addEventListener("click", () => log.clear());
ui.logCopy.addEventListener("click", async () => {
  const report = [
    `sonore-sketch log, ${new Date().toISOString()}`,
    `versions: ${ui.versions.textContent || "(not loaded)"}`,
    `engine: ${engineKind}`,
    `browser: ${navigator.userAgent}`,
    "",
    log.text(),
    "",
    "current drawing:",
    JSON.stringify(saved()),
  ].join("\n");
  try {
    await navigator.clipboard.writeText(report);
    status("Log copied, with the versions and the current drawing.");
  } catch {
    status("Could not copy; select the log text instead.", true);
  }
});

document.addEventListener("keydown", (event) => {
  // keys typed into a field, a list or a slider are theirs (radios and checkboxes leave Space to Play)
  if (event.target.closest?.("select, textarea, input:not([type=radio]):not([type=checkbox])")) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    return event.shiftKey ? redo() : undo();
  }
  if (mod && event.key.toLowerCase() === "y") {
    event.preventDefault();
    return redo();
  }
  if (mod || event.altKey) return;
  if (event.key === " ") {
    event.preventDefault();
    return event.repeat ? undefined : togglePlay();
  }
  if (tab.key(event)) event.preventDefault();
});

new ResizeObserver(showResult).observe(ui.waveform);
showTab();
show();
