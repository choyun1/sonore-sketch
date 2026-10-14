import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultPage, openDocument, resetTab, stretchPage, tabState, withTabState } from "../../app/document.js";
import {
  EXAMPLE_LEVELS,
  MAX_CELLS,
  applyStroke,
  check,
  blank,
  brushWeight,
  dab,
  dabsAlong,
  decodeLevels,
  defaultSection,
  encodeLevels,
  isSilent,
  resampleRows,
  rows,
} from "../../app/painted/model.js";

test("the grid has 12 rows per octave: 72 over 100-6400 Hz", () => {
  assert.equal(rows(defaultSection()), 72);
  assert.equal(rows({ f_lo: 200, f_hi: 6400, rows_per_octave: 12 }), 60);
});

test("levels round-trip through deflate and base64, and the size is checked", async () => {
  const bytes = Uint8Array.from({ length: 72 * 256 }, (_, i) => i % 61);
  const text = await encodeLevels(bytes);
  assert.deepEqual(await decodeLevels(text, bytes.length), bytes);
  await assert.rejects(decodeLevels(text, 10), /holds more than 10 cells/);
  await assert.rejects(decodeLevels(await encodeLevels(bytes.subarray(0, 100)), 200), /holds 100 cells, not 200/);
  await assert.rejects(decodeLevels("not levels", 10), /not base64 of deflated bytes/);
});

test("the example painting decodes, and is not silent", async () => {
  const section = defaultSection();
  const bytes = await decodeLevels(EXAMPLE_LEVELS, rows(section) * section.columns);
  assert.ok(!isSilent(bytes, section));
  assert.ok(isSilent(blank(section), section));
});

test("a brush is full inside, fades over its soft rim, and is zero outside", () => {
  assert.equal(brushWeight(0, 0.5), 1);
  assert.equal(brushWeight(0.5, 0.5), 1);
  assert.ok(Math.abs(brushWeight(0.75, 0.5) - 0.5) < 1e-12);
  assert.equal(brushWeight(1, 0.5), 0);
  assert.equal(brushWeight(0.99, 0), 1); // a hard brush
});

test("a stroke paints each cell once, toward the level and never past it", () => {
  const weights = new Float32Array(5 * 5);
  dab(weights, 5, 5, 2.5, 2.5, 1.5, 1.5, 0);
  dab(weights, 5, 5, 2.5, 2.5, 1.5, 1.5, 0); // the same place again
  const bytes = new Uint8Array(25).fill(60);
  const once = applyStroke(bytes, weights, 10);
  assert.equal(once[2 * 5 + 2], 10);
  assert.equal(once[0], 60); // outside the brush
  assert.deepEqual(applyStroke(once, weights, 10), once);
});

test("dabs along a stroke are a quarter of the radius apart", () => {
  const centres = dabsAlong([0, 0], [0, 4], 1, 1);
  assert.equal(centres.length, 16);
  assert.deepEqual(centres.at(-1), [0, 4]);
});

test("changing the range keeps what is painted inside it", () => {
  const from = { ...defaultSection(), f_lo: 100, f_hi: 6400 };
  const to = { ...from, f_lo: 200, f_hi: 6400 }; // drop the bottom octave
  const bytes = blank(from);
  bytes.fill(0, 12 * 256, 13 * 256); // row 12 (an octave up) at 0 dB
  const moved = resampleRows(bytes, from, to);
  assert.equal(moved.length, 60 * 256);
  assert.equal(moved[0], 0); // now row 0
  assert.equal(moved[256], 60);
  assert.deepEqual(resampleRows(bytes, from, from), bytes);
  const wider = resampleRows(bytes, from, { ...from, f_lo: 50 });
  assert.equal(wider[0], 60); // below the old range: silent
});

test("the page keeps the painting in its own section", () => {
  const page = defaultPage();
  const state = tabState(page, "painted");
  assert.equal(state.painted, 1);
  assert.equal(state.duration, page.duration);
  const next = withTabState(page, "painted", { ...state, carrier: "noise" });
  assert.deepEqual(next.painted, { ...defaultSection(), carrier: "noise" });
  assert.deepEqual(next.tracks, page.tracks);
  assert.deepEqual(stretchPage(next, 2).painted, next.painted);
  assert.throws(() => openDocument({ ...next, painted: { ...next.painted, f_hi: 50 } }), /frequency range/);
});

test("Reset resets the tab shown and the duration, and keeps the other tab", () => {
  const page = withTabState(stretchPage(defaultPage(), 1.2), "painted", { ...tabState(defaultPage(), "painted"), carrier: "noise" });
  const reset = resetTab(page, "tracks");
  assert.equal(reset.duration, 0.6);
  assert.deepEqual(reset.tracks, defaultPage().tracks);
  assert.equal(reset.painted.carrier, "noise");
});

test("a file or link cannot freeze the tab or fill the memory", () => {
  const section = { ...defaultSection(), carrier: "harmonic" };
  assert.throws(() => check({ ...section, f0: -150 }), /f0 must be a positive frequency/);
  assert.throws(() => check({ ...section, f0: 0 }), /f0 must be a positive frequency/);
  assert.doesNotThrow(() => check({ ...section, carrier: "tones", f0: -150 }));
  assert.throws(() => check({ ...section, columns: MAX_CELLS }), /at most 1048576 cells/);
});
