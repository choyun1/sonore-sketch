import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, stretchPage, tabState } from "../../app/document.js";
import { check, defaultSection, elevationAt, elevationPoints, positionAt, stretchSection, withElevation } from "../../app/paths/model.js";

test("the starting page has a path, and its state passes the check", () => {
  const state = tabState(defaultPage(), "paths");
  assert.equal(state.paths, 1);
  assert.ok(state.stroke.length > 2);
  assert.equal(check(state), state);
});

test("a document saved before the tab existed opens with the starting path", () => {
  const { paths: _paths, ...older } = defaultPage();
  assert.deepEqual(openDocument(older).paths, defaultSection());
});

test("the dot follows the stroke at its own pace, stretched to the duration", () => {
  const stroke = [[0, -2, 1], [0.8, -1, 1], [1, 2, 1]];
  assert.deepEqual(positionAt(stroke, 2, 0), [-2, 1]);
  assert.deepEqual(positionAt(stroke, 2, 0.8), [-1.5, 1]); // stroke time 0.4, in the slow part
  assert.deepEqual(positionAt(stroke, 2, 2), [2, 1]);
  assert.deepEqual(positionAt([[0, 1, 1]], 2, 1), [1, 1]); // one point: a still source
});

test("elevation is a number while flat, breakpoints otherwise, within the measured range", () => {
  const section = defaultSection();
  assert.equal(withElevation(section, [[0, 10], [1, 10]]).elevation, 10);
  const lifted = withElevation(section, [[0, 0], [1, 120], [2, -70]]);
  assert.deepEqual(lifted.elevation, [[0, 1, 2], [0, 90, -40]]);
  assert.equal(elevationAt(lifted, 2, 0.5), 45);
  assert.deepEqual(elevationPoints(section, 3), [[0, 0], [3, 0]]);
});

test("the elevation track stretches with the duration; the stroke keeps its own times", () => {
  const page = { ...defaultPage(), duration: 1, paths: withElevation(defaultSection(), [[0, 0], [1, 60]]) };
  const stretched = stretchPage(page, 3);
  assert.deepEqual(stretched.paths.elevation, [[0, 3], [0, 60]]);
  assert.deepEqual(stretched.paths.stroke, page.paths.stroke);
  const flat = defaultSection();
  assert.equal(stretchSection(flat, 1, 3), flat); // flat: unchanged
});

test("clear leaves no path and the elevation flat, and keeps the settings", async () => {
  const page = { ...defaultPage(), paths: { ...defaultSection(), room: "room", elevation: [[0, 1], [0, 30]] } };
  const cleared = await clearTab(page, "paths");
  assert.deepEqual(cleared.paths, { source: "noise", room: "room", stroke: [], elevation: 0 });
});

test("bad states are refused", () => {
  const good = tabState(defaultPage(), "paths");
  assert.throws(() => check({ ...good, source: "drums" }), /source/);
  assert.throws(() => check({ ...good, stroke: [[0, 1, 1], [-1, 1, 1]] }), /must not go back/);
  assert.throws(() => check({ ...good, stroke: [[0, 1]] }), /\[t, x, y\]/);
  assert.throws(() => check({ ...good, elevation: [[0], [1, 2]] }), /elevation/);
});
