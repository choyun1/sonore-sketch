// The page shell: tabs, duration, synthesis engine, playback, the result,
// undo, reset, save, open, links and the log (docs/design/app.md, "One tab, one route back
// to sound"). Tabs plug in through a small contract: a document to edit, a
// `commit` callback when an edit ends, and a picture of the last result.

import { Player, wavBlob } from "./audio.js";
import { LatestOnly, createEngine, readResult } from "./engine.js";
import { History } from "./history.js";
import { Log } from "./log.js";
import { drawWaveform } from "./plot.js";
import { encodeState, stateFromHash, tabFromHash } from "./share.js";
import { clearTab, defaultPage, forLink, isStartingPage, openDocument, resetTab, stretchPage, tabState, withRecording, withTabState } from "./document.js";
import { createBlobsTab } from "./blobs/tab.js";
import { createEditTab } from "./edit/tab.js";
import { createEventsTab } from "./events/tab.js";
import { createMaskTab } from "./mask/tab.js";
import { createPaintedTab } from "./painted/tab.js";
import { createPathsTab } from "./paths/tab.js";
import { SONORE_VERSION, clampDuration } from "./tracks/model.js";
import { createTracksTab } from "./tracks/tab.js";

const AUTOPLAY_MAX_S = 3; // longer sounds play on Play only (app.md, D10)

const byId = (id) => document.getElementById(id);
const ui = {
  play: byId("play"), duration: byId("duration"), autoplay: byId("autoplay"), clear: byId("clear"), reset: byId("reset"), undo: byId("undo"), redo: byId("redo"),
  open: byId("open"), save: byId("save"), link: byId("link"), wav: byId("wav"), file: byId("file"),
  status: byId("status"), versions: byId("versions"), waveform: byId("waveform"),
  log: byId("log"), logToggle: byId("log-toggle"), logLines: byId("log-lines"), logCopy: byId("log-copy"), logClear: byId("log-clear"),
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
  byId("loading-time").textContent = `${((performance.now() - loadStart) / 1000).toFixed(0)} s`;
}, 1000);
function loading(text, failed = false) {
  byId("loading-step").textContent = text.replace(/ \(\d+(\.\d+)? s\)$/, "");
  byId("loading").classList.toggle("failed", failed);
  if (failed) {
    clearInterval(loadClock);
    ui.play.textContent = "▶ Play";
  }
}

const engineKind = new URLSearchParams(location.search).get("engine") ?? "auto"; // "auto": the synthesis server, else Pyodide (engine.js)
log.info(`page opened, engine: ${engineKind}`, navigator.userAgent);
let ready = false;
let failed = null; // why the synthesizer could not start, if it could not
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
      byId("loading").hidden = true;
      status("Ready. Draw, then press Play.");
      synthesize({ play: false });
    },
    onFailed: (message) => {
      failed = `Could not start the synthesizer: ${message} (see Log)`;
      loading(`Could not start the synthesizer: ${message} (see Log)`, true);
      status(`Could not start the synthesizer: ${message} (see Log)`, true);
      log.error(`could not start the synthesizer: ${message}`);
    },
  }),
);

const player = new Player();
let result = null; // {key, page, sound}: the last sound made, from which tab's state

function status(text, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
}

// --- the document and its history ----------------------------------------------

let initial = defaultPage();
let fromLink = false;
try {
  const linked = stateFromHash(location.hash);
  if (linked) [initial, fromLink] = [openDocument(linked), true];
  else initial = defaultPage(tabFromHash(location.hash) ?? initial.tab);
} catch (error) {
  log.error(`ignored the drawing in the link: ${error.message}`);
}
const history = new History(initial);
// What Reset goes back to: the page as a file or link last opened it, or
// else the tab's starting page (null).
let opened = fromLink ? initial : null;
const hasRecording = () => Boolean(history.present.recording);
// `play`: hear this edit whatever its length and Auto-play (New draw asks to hear another draw)
const commitFrom = (id) => (state, { play = false } = {}) => change(withTabState(history.present, id, state), { play });
const tabs = {
  tracks: createTracksTab(byId("tab-tracks"), { commit: commitFrom("tracks") }),
  painted: createPaintedTab(byId("tab-painted"), { commit: commitFrom("painted"), log }),
  mask: createMaskTab(byId("tab-mask"), {
    commit: commitFrom("mask"),
    openRecording: (recording, seconds) => change(withRecording(history.present, recording, seconds, "mask")),
    hasRecording,
    log,
  }),
  blobs: createBlobsTab(byId("tab-blobs"), { commit: commitFrom("blobs") }),
  edit: createEditTab(byId("tab-edit"), {
    commit: commitFrom("edit"),
    // a recording belongs to the page, and sets its duration (edit.md, E1)
    openRecording: (recording, seconds) => change(withRecording(history.present, recording, seconds)),
    hasRecording,
    log,
  }),
  paths: createPathsTab(byId("tab-paths"), { commit: commitFrom("paths"), hasRecording }),
  events: createEventsTab(byId("tab-events"), { commit: commitFrom("events") }),
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
    button.tabIndex = active ? 0 : -1; // Tab reaches the tab shown; the arrow keys reach the others
  }
  for (const id of Object.keys(tabs)) byId(`tab-${id}`).hidden = id !== tab.id;
  // a tab that draws the result's waveform itself (the Draw modulation tab, in its Result box)
  document.querySelector("main > .result").hidden = Boolean(tab.ownWaveform);
  document.querySelector("main").dataset.tab = tab.id; // the waveform's width follows the tab's plots (style.css)
  byId("tab-caption").textContent = tabButtons.find((button) => button.dataset.tab === tab.id)?.dataset.caption ?? "";
}

function switchTab(id, { synthesizes = true } = {}) {
  if (!tabs[id] || tabs[id] === tab) return;
  player.stop();
  tab.setPlayhead(null);
  // Until something is drawn, set or opened, the page starts over at the new
  // tab's starting duration (0.6 s on Draw speech, 2 s elsewhere). Showing a
  // tab is not an edit, so this is not one either.
  if (isStartingPage(history.present, tab.id)) history.present = defaultPage(id);
  tab = tabs[id];
  showTab();
  show();
  showResult();
  log.info(`switched to the ${id} tab`);
  if (synthesizes) synthesize({ play: false });
}
for (const button of tabButtons) button.addEventListener("click", () => switchTab(button.dataset.tab));
// The arrow keys, Home and End move between the tabs, as in the WAI-ARIA
// tabs pattern: the tab focused is the tab shown.
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  const index = tabButtons.indexOf(event.target);
  if (index < 0 || event.ctrlKey || event.metaKey || event.altKey) return;
  const last = tabButtons.length - 1;
  const moves = { ArrowLeft: index ? index - 1 : last, ArrowRight: index < last ? index + 1 : 0, Home: 0, End: last };
  if (!(event.key in moves)) return;
  event.preventDefault();
  const button = tabButtons[moves[event.key]];
  button.focus();
  switchTab(button.dataset.tab);
});

// The document as saved and linked: with the tab shown (a link without the recording).
// stamped with the sonore that makes its sound now, not the one of the file it was opened from
const saved = () => ({ ...history.present, sonore: SONORE_VERSION, tab: tab.id });
const linked = () => forLink(saved());

function show() {
  const page = history.present;
  tab.setDocument(tabState(page, tab.id));
  ui.duration.value = page.duration;
  ui.undo.disabled = !history.past.length;
  ui.redo.disabled = !history.future.length;
  window.history.replaceState(null, "", `${location.pathname}${location.search}#state=${encodeState(linked())}`);
}

// An edit has ended: keep it, and hear it if it is short enough (or if asked to).
function change(page, { play = false } = {}) {
  history.push(page);
  show();
  afterChange({ play });
}

// A drawing from a file or a link: it opens on the tab it was saved on, and is synthesized once, there.
function openOnItsTab(page) {
  opened = page;
  history.push(page);
  switchTab(page.tab, { synthesizes: false });
  show();
  afterChange();
}

function afterChange({ play = false } = {}) {
  // the sound playing is the old drawing's: stop it rather than let it play under the new pictures
  player.stop();
  const short = history.present.duration <= AUTOPLAY_MAX_S;
  if (play) synthesize({ play: true });
  else if (short) synthesize({ play: ui.autoplay.checked });
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

let progressStarted = 0; // when the shown synthesis started (performance.now())
let progressStep = { fraction: undefined, text: "Synthesizing" };
let progressClock = null; // updates the seconds while it runs

// Like "Iteration 2 of 5… 40% · 35 s so far, about 50 s left": the step
// (from page.handle_steps), and once a few seconds have gone by, the time
// so far and, once a fifth is done, the time left at that pace.
function progressText({ fraction, text }) {
  const known = typeof fraction === "number";
  const seconds = (performance.now() - progressStarted) / 1000;
  let line = known ? `${text}… ${Math.round(100 * fraction)}%` : `${text}…`;
  if (seconds >= 2) line += ` · ${Math.round(seconds)} s so far`;
  if (seconds >= 2 && known && fraction >= 0.2 && fraction < 1) line += `, about ${Math.max(1, Math.round((seconds * (1 - fraction)) / fraction))} s left`;
  return line;
}

// fraction from 0 to 1 with what is being done, undefined while it is not
// known yet (a new synthesis), null to hide
function showProgress(fraction, text) {
  const figure = tab.figure;
  if (fraction === null || !figure) {
    clearInterval(progressClock);
    progressClock = null;
    return progress.remove();
  }
  if (fraction === undefined) {
    progressStarted = performance.now();
    progressStep = { fraction, text: "Synthesizing" };
  } else progressStep = { fraction, text: text ?? progressStep.text };
  if (progress.parentNode !== figure) figure.appendChild(progress);
  const known = typeof fraction === "number";
  progress.classList.toggle("unknown", !known);
  progress.querySelector(".bar").style.width = known ? `${Math.round(100 * fraction)}%` : "";
  progress.querySelector(".label").textContent = progressText(progressStep);
  progressClock ??= setInterval(() => (progress.querySelector(".label").textContent = progressText(progressStep)), 1000);
}

// --- synthesis and playback ----------------------------------------------------

// Each tab's starting drawing, synthesized ahead of time (tools/make_examples.py),
// so it plays at once while Pyodide and sonore load; fetched when first asked for.
const examples = new Map();
async function madeAhead(id, key) {
  if (!examples.has(id)) {
    examples.set(
      id,
      fetch(new URL(`./examples/${id}.json`, import.meta.url))
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    );
  }
  const example = await examples.get(id);
  return example && key === `${id} ${JSON.stringify(example.state)}` ? readResult(example.result) : null;
}

async function synthesize({ play }) {
  const page = history.present;
  const asked = tab;
  const state = tabState(page, tab.id);
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
  const ahead = await madeAhead(tab.id, key);
  if (mine !== requests) return null;
  if (ahead) {
    running = null;
    showProgress(null);
    result = { key, page, sound: ahead };
    showResult();
    status(ready ? `Made ${page.duration} s ahead of time.` : "Made ahead of time: press Play. Your own drawings are made once sonore has loaded.");
    if (!player.playing) {
      ui.play.disabled = false;
      ui.play.textContent = "▶ Play";
    }
    if (play) start(ahead);
    return ahead;
  }
  if (!ready) {
    running = null;
    showProgress(null);
    status(failed ?? "Still loading; this drawing will be made once sonore is ready.", Boolean(failed));
    return null;
  }
  status(page.duration > 1 ? `Synthesizing ${page.duration} s…` : "Synthesizing…");
  const askedAt = performance.now();
  const made = engine.synthesize({ tab: tab.id, state }, (fraction, text) => mine === requests && showProgress(fraction, text));
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
    if (tab === asked && history.present === page) tab.failed?.(error.message);
    return null;
  }
  if (mine === requests) {
    running = null;
    showProgress(null);
  }
  if (!sound) return null; // a newer drawing replaced this request
  // The drawing changed while this was made, to one that asks for no sound
  // (nothing drawn) or to another tab: this sound is no longer what is shown.
  if (tab !== asked || history.present !== page) return null;
  result = { key, page, sound };
  showResult();
  // the whole wait, pictures of the result included; the log also has synthesis alone
  const waited = (performance.now() - askedAt) / 1000;
  status(`Made ${page.duration} s in ${waited.toFixed(2)} s.`);
  log.info(`made ${page.duration} s in ${waited.toFixed(2)} s (synthesis ${sound.synthesisSeconds.toFixed(2)} s)`);
  if (asking.play && history.present === page) start(sound);
  return sound;
}

function showResult() {
  if (result && !result.key.startsWith(`${tab.id} `)) result = null;
  const sound = result?.sound;
  const duration = result?.page.duration ?? history.present.duration;
  tab.setResult(sound);
  drawWaveform(ui.waveform, sound, duration);
  ui.wav.disabled = !sound;
}

let ticking = false; // one playhead loop, however often a sound is restarted

function start(sound) {
  player.play(sound.samples, sound.fs, sound.right);
  ui.play.textContent = "■ Stop";
  if (ticking) return;
  ticking = true;
  const tick = () => {
    const position = player.position;
    tab.setPlayhead(position);
    if (position !== null) requestAnimationFrame(tick);
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
  change(resetTab(history.present, tab.id, opened ?? defaultPage(tab.id)));
  log.info(`reset the ${tab.id} tab to the drawing it opened with`);
  if (!ready) status("Reset to the drawing the page opened with.");
});
ui.redo.addEventListener("click", redo);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

ui.save.addEventListener("click", () => {
  const text = JSON.stringify(saved(), null, 1);
  download(new Blob([text], { type: "application/json" }), "sketch.json");
});
// The sound of the drawing shown: made first if the last one is of an older drawing.
ui.wav.addEventListener("click", async () => {
  const sound = result?.page === history.present ? result.sound : await synthesize({ play: false });
  if (sound) download(wavBlob(sound.samples, sound.fs, sound.right), "sketch.wav");
});
ui.open.addEventListener("click", () => ui.file.click());
ui.file.addEventListener("change", async () => {
  const file = ui.file.files[0];
  ui.file.value = "";
  if (!file) return;
  try {
    const page = openDocument(JSON.parse(await file.text()));
    openOnItsTab(page); // as a link does
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
    const linkedPage = stateFromHash(location.hash);
    if (!linkedPage) return switchTab(tabFromHash(location.hash));
    openOnItsTab(openDocument(linkedPage));
    status("Opened the drawing in the link.");
  } catch (error) {
    status(`Could not open the drawing in the link: ${error.message}`, true);
    log.error(`could not open the drawing in the link: ${error.message}`);
  }
});
ui.link.addEventListener("click", async () => {
  try {
    // the page and the drawing only: a query (?engine=, ?pyodide=) is for working on the page, not for sharing
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}${location.hash}`);
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
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    return event.shiftKey ? redo() : undo();
  }
  if (modifier && event.key.toLowerCase() === "y") {
    event.preventDefault();
    return redo();
  }
  if (modifier || event.altKey) return;
  if (event.key === " ") {
    if (event.target.closest?.("button, a[href], summary")) return; // Space presses a focused button, as everywhere else
    event.preventDefault();
    return event.repeat ? undefined : togglePlay();
  }
  if (tab.key(event)) event.preventDefault();
});

new ResizeObserver(showResult).observe(ui.waveform);
showTab();
show();
synthesize({ play: false }); // the starting drawing's sound is made ahead: no need to wait for sonore
