import assert from "node:assert/strict";
import { test } from "node:test";

import { START_DURATION, clearTab, defaultPage, isStartingPage, openDocument, resetTab, stretchPage, tabState, upgrade, withTabState } from "../../app/document.js";
import * as painted from "../../app/painted/model.js";
import * as edit from "../../app/edit/model.js";
import * as mask from "../../app/mask/model.js";
import { DEFAULTS, defaultDocument } from "../../app/tracks/model.js";

test("the default page holds the Draw speech tab's default drawing", () => {
  assert.deepEqual(tabState(defaultPage(), "tracks"), defaultDocument());
});

test("Draw speech starts at its word's 0.6 s, every other tab at 2 s", () => {
  assert.equal(defaultPage().duration, 0.6);
  assert.equal(START_DURATION, 2);
  for (const tab of ["painted", "mask", "blobs", "edit", "paths", "events"]) {
    const page = defaultPage(tab);
    assert.equal(page.duration, 2, tab);
    assert.equal(page.tab, tab);
    assert.deepEqual({ ...page, duration: 0.6, tab: "tracks", tracks: defaultPage().tracks }, defaultPage()); // the same drawings
    assert.deepEqual(stretchPage(page, 0.6).tracks, defaultPage().tracks); // the word, stretched to 2 s
  }
});

test("the page is a starting page until something changes", () => {
  assert.ok(isStartingPage(defaultPage(), "tracks"));
  assert.ok(isStartingPage(defaultPage("blobs"), "blobs"));
  assert.ok(isStartingPage({ ...defaultPage("blobs"), tab: "tracks" }, "blobs")); // the tab saved in it does not count
  assert.ok(!isStartingPage(defaultPage(), "blobs")); // 0.6 s is not where Draw modulation starts
  assert.ok(!isStartingPage(stretchPage(defaultPage(), 1.2), "tracks"));
  assert.ok(!isStartingPage({ ...defaultPage("blobs"), blobs: { ...defaultPage().blobs, items: [] } }, "blobs"));
});

test("a TrackDraw document (an old link or file) opens as a page document", () => {
  const old = defaultDocument();
  const page = upgrade(old);
  assert.equal(page.version, 2);
  assert.equal(page.tab, "tracks");
  assert.deepEqual(tabState(page, "tracks"), old);
  assert.deepEqual(openDocument(old), defaultPage());
});

test("a tab's state goes back into the page without touching the rest", () => {
  const page = defaultPage();
  const state = { ...tabState(page, "tracks"), params: { F1: 400 } };
  const next = withTabState(page, "tracks", state);
  assert.deepEqual(next.tracks, { mode: "klatt", params: { F1: 400 } });
  assert.equal(next.duration, page.duration);
  assert.deepEqual(page, defaultPage());
});

test("opening refuses what is not a document, and tidies what is", () => {
  assert.throws(() => openDocument({ hello: 1 }), /not a sonore-sketch document/);
  assert.throws(() => openDocument({ ...defaultPage(), fs: 0 }), /fs must be/);
  const page = defaultPage();
  const repeated = withTabState(page, "tracks", { mode: "klatt", params: { F0: [[0, 0.3, 0.3, 0.6], [125, 100, 140, 95]] } });
  assert.deepEqual(openDocument(repeated).tracks.params.F0, [[0, 0.3, 0.6], [125, 140, 95]]);
});

test("stretching the page stretches what the Draw speech tab drew", () => {
  const page = stretchPage(defaultPage(), 1.2);
  assert.equal(page.duration, 1.2);
  assert.deepEqual(page.tracks.params.F3[0], defaultPage().tracks.params.F3[0].map((t) => t * 2));
});

test("Clear blanks the tab shown, keeping its settings and the duration", async () => {
  const page = { ...stretchPage(defaultPage(), 1.2), fs: 22050 };
  const tracks = await clearTab(page, "tracks");
  assert.deepEqual(tracks.tracks, { mode: "klatt", params: DEFAULTS });
  assert.equal(tracks.duration, 1.2);
  assert.equal(tracks.fs, 16000);
  assert.deepEqual(tracks.painted, page.painted);
  openDocument(tracks); // a schwa is a drawing the page opens

  const paintedPage = await clearTab({ ...page, painted: { ...page.painted, carrier: "noise" } }, "painted");
  assert.equal(paintedPage.painted.carrier, "noise");
  const bytes = await painted.decodeLevels(paintedPage.painted.levels, painted.rows(paintedPage.painted) * paintedPage.painted.columns);
  assert.ok(painted.isSilent(bytes, paintedPage.painted));
  assert.deepEqual(paintedPage.tracks, page.tracks);

  const blobs = await clearTab(page, "blobs");
  assert.deepEqual([blobs.blobs.items, blobs.blobs.bands], [[], []]);
  assert.equal(blobs.blobs.carrier, page.blobs.carrier);

  const edited = await clearTab(page, "edit");
  const cuts = await painted.decodeLevels(edited.edit.levels, edit.ROWS * edit.COLUMNS);
  assert.ok(cuts.every((b) => b === 0));
  assert.equal(edited.edit.source, page.edit.source);

  const masked = await clearTab({ ...page, mask: { ...page.mask, span: 0.6 } }, "mask");
  assert.deepEqual(masked.mask, mask.defaultSection());
  openDocument(blobs);
  openDocument(edited);
  openDocument(masked);
});

test("Reset puts the tab shown back as the page opened, the others stay", () => {
  const start = withTabState({ ...defaultPage(), duration: 0.8 }, "tracks", { mode: "klatt", params: { F1: 400 } });
  const drawn = withTabState(stretchPage(start, 1.2), "tracks", { mode: "klatt", params: { F1: 700 } });
  const changed = { ...drawn, blobs: { ...drawn.blobs, items: [] } };
  const reset = resetTab(changed, "tracks", start);
  assert.deepEqual(reset.tracks, start.tracks);
  assert.equal(reset.duration, 0.8);
  assert.deepEqual(reset.blobs.items, []);
  assert.deepEqual(resetTab(changed, "tracks").tracks, defaultPage().tracks); // with no start, the defaults
  assert.equal(resetTab(changed, "blobs", defaultPage("blobs")).duration, 2); // a tab's own starting duration
});
