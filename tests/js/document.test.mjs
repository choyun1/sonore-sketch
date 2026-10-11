import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultPage, openDocument, stretchPage, tabState, upgrade, withTabState } from "../../app/document.js";
import { defaultDocument } from "../../app/tracks/model.js";

test("the default page holds the Tracks tab's default drawing", () => {
  assert.deepEqual(tabState(defaultPage(), "tracks"), defaultDocument());
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

test("stretching the page stretches what the Tracks tab drew", () => {
  const page = stretchPage(defaultPage(), 1.2);
  assert.equal(page.duration, 1.2);
  assert.deepEqual(page.tracks.params.F3[0], defaultPage().tracks.params.F3[0].map((t) => t * 2));
});
