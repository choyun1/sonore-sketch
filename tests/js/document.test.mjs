import assert from "node:assert/strict";
import { test } from "node:test";

import { START_DURATION, clearTab, defaultPage, isStartingPage, openDocument, resetTab, stretchPage, tabState, upgrade, withTabState } from "../../app/document.js";
import * as drawSpectrogram from "../../app/draw_spectrogram/model.js";
import * as eraseModulation from "../../app/erase_modulation/model.js";
import * as eraseSpectrogram from "../../app/erase_spectrogram/model.js";
import { DEFAULTS, defaultDocument } from "../../app/draw_speech/model.js";

test("the default page holds the Draw speech tab's default drawing", () => {
  assert.deepEqual(tabState(defaultPage(), "draw_speech"), defaultDocument());
});

test("Draw speech starts at its word's 0.6 s, every other tab at 2 s", () => {
  assert.equal(defaultPage().duration, 0.6);
  assert.equal(START_DURATION, 2);
  for (const tab of ["draw_voice", "draw_spectrogram", "erase_spectrogram", "draw_modulation", "erase_modulation", "draw_path", "draw_room", "scatter_events", "quilt_sound", "match_texture"]) {
    const page = defaultPage(tab);
    assert.equal(page.duration, 2, tab);
    assert.equal(page.tab, tab);
    const { draw_speech: speech, draw_voice: voice } = defaultPage();
    assert.deepEqual({ ...page, duration: 0.6, tab: "draw_speech", draw_speech: speech, draw_voice: voice }, defaultPage()); // the same drawings
    assert.deepEqual(stretchPage(page, 0.6).draw_speech, speech); // the word, stretched to 2 s
    assert.deepEqual(stretchPage(page, 0.6).draw_voice, voice); // and the voice
  }
});

test("the page is a starting page until something changes", () => {
  assert.ok(isStartingPage(defaultPage(), "draw_speech"));
  assert.ok(isStartingPage(defaultPage("draw_modulation"), "draw_modulation"));
  assert.ok(isStartingPage({ ...defaultPage("draw_modulation"), tab: "draw_speech" }, "draw_modulation")); // the tab saved in it does not count
  assert.ok(!isStartingPage(defaultPage(), "draw_modulation")); // 0.6 s is not where Draw modulation starts
  assert.ok(!isStartingPage(stretchPage(defaultPage(), 1.2), "draw_speech"));
  assert.ok(!isStartingPage({ ...defaultPage("draw_modulation"), draw_modulation: { ...defaultPage().draw_modulation, items: [] } }, "draw_modulation"));
});

test("a TrackDraw document (an old link or file) opens as a page document", () => {
  const old = defaultDocument();
  const page = upgrade(old);
  assert.equal(page.version, 3);
  assert.equal(page.tab, "draw_speech");
  assert.deepEqual(tabState(page, "draw_speech"), old);
  assert.deepEqual(openDocument(old), defaultPage());
});

test("a version-2 document (before 2026-10-20) opens with the tabs renamed", () => {
  const page = defaultPage();
  const old = {
    app: "sonore-sketch", version: 2, sonore: page.sonore, duration: page.duration, fs: page.fs, tab: "edit",
    tracks: page.draw_speech, painted: page.draw_spectrogram, mask: page.erase_spectrogram, blobs: page.draw_modulation,
    edit: { ...page.erase_modulation, source: "speech" }, paths: page.draw_path, events: page.scatter_events,
    quilt: { ...page.quilt_sound, source: "blobs" },
  };
  const opened = openDocument(old);
  assert.equal(opened.tab, "erase_modulation");
  assert.deepEqual(opened, {
    ...page, tab: "erase_modulation",
    erase_modulation: { ...page.erase_modulation, source: "draw_speech" }, quilt_sound: { ...page.quilt_sound, source: "draw_modulation" },
  });
});

test("a tab's state goes back into the page without touching the rest", () => {
  const page = defaultPage();
  const state = { ...tabState(page, "draw_speech"), params: { F1: 400 } };
  const next = withTabState(page, "draw_speech", state);
  assert.deepEqual(next.draw_speech, { mode: "klatt", params: { F1: 400 } });
  assert.equal(next.duration, page.duration);
  assert.deepEqual(page, defaultPage());
});

test("opening refuses what is not a document, and tidies what is", () => {
  assert.throws(() => openDocument({ hello: 1 }), /not a sonore-sketch document/);
  assert.throws(() => openDocument({ ...defaultPage(), fs: 0 }), /fs must be/);
  const page = defaultPage();
  const repeated = withTabState(page, "draw_speech", { mode: "klatt", params: { F0: [[0, 0.3, 0.3, 0.6], [125, 100, 140, 95]] } });
  assert.deepEqual(openDocument(repeated).draw_speech.params.F0, [[0, 0.3, 0.6], [125, 140, 95]]);
});

test("stretching the page stretches what the Draw speech tab drew", () => {
  const page = stretchPage(defaultPage(), 1.2);
  assert.equal(page.duration, 1.2);
  assert.deepEqual(page.draw_speech.params.F3[0], defaultPage().draw_speech.params.F3[0].map((t) => t * 2));
});

test("Clear blanks the tab shown, keeping its settings and the duration", async () => {
  const page = { ...stretchPage(defaultPage(), 1.2), fs: 22050 };
  const tracks = await clearTab(page, "draw_speech");
  assert.deepEqual(tracks.draw_speech, { mode: "klatt", params: DEFAULTS });
  assert.equal(tracks.duration, 1.2);
  assert.equal(tracks.fs, 16000);
  assert.deepEqual(tracks.draw_spectrogram, page.draw_spectrogram);
  openDocument(tracks); // a schwa is a drawing the page opens

  const paintedPage = await clearTab({ ...page, draw_spectrogram: { ...page.draw_spectrogram, carrier: "noise" } }, "draw_spectrogram");
  assert.equal(paintedPage.draw_spectrogram.carrier, "noise");
  const bytes = await drawSpectrogram.decodeLevels(paintedPage.draw_spectrogram.levels, drawSpectrogram.rows(paintedPage.draw_spectrogram) * paintedPage.draw_spectrogram.columns);
  assert.ok(drawSpectrogram.isSilent(bytes, paintedPage.draw_spectrogram));
  assert.deepEqual(paintedPage.draw_speech, page.draw_speech);

  const blobs = await clearTab(page, "draw_modulation");
  assert.deepEqual([blobs.draw_modulation.items, blobs.draw_modulation.bands], [[], []]);
  assert.equal(blobs.draw_modulation.carrier, page.draw_modulation.carrier);

  const edited = await clearTab(page, "erase_modulation");
  const cuts = await drawSpectrogram.decodeLevels(edited.erase_modulation.levels, eraseModulation.ROWS * eraseModulation.COLUMNS);
  assert.ok(cuts.every((b) => b === 0));
  assert.equal(edited.erase_modulation.source, page.erase_modulation.source);

  const masked = await clearTab({ ...page, erase_spectrogram: { ...page.erase_spectrogram, span: 0.6 } }, "erase_spectrogram");
  assert.deepEqual(masked.erase_spectrogram, eraseSpectrogram.defaultSection());
  openDocument(blobs);
  openDocument(edited);
  openDocument(masked);
});

test("Reset puts the tab shown back as the page opened, the others stay", () => {
  const start = withTabState({ ...defaultPage(), duration: 0.8 }, "draw_speech", { mode: "klatt", params: { F1: 400 } });
  const drawn = withTabState(stretchPage(start, 1.2), "draw_speech", { mode: "klatt", params: { F1: 700 } });
  const changed = { ...drawn, draw_modulation: { ...drawn.draw_modulation, items: [] } };
  const reset = resetTab(changed, "draw_speech", start);
  assert.deepEqual(reset.draw_speech, start.draw_speech);
  assert.equal(reset.duration, 0.8);
  assert.deepEqual(reset.draw_modulation.items, []);
  assert.deepEqual(resetTab(changed, "draw_speech").draw_speech, defaultPage().draw_speech); // with no start, the defaults
  assert.equal(resetTab(changed, "draw_modulation", defaultPage("draw_modulation")).duration, 2); // a tab's own starting duration
});
