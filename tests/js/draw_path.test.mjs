import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, stretchPage, tabState } from "../../app/document.js";
import {
  check, defaultSection, elevationAt, elevationPoints, pathLength, pointAlong, positionAt, speedPoints, stretchSection, timeline, withElevation, withSpeed,
} from "../../app/draw_path/model.js";

test("the starting page has a path, and its state passes the check", () => {
  const state = tabState(defaultPage(), "draw_path");
  assert.equal(state.draw_path, 1);
  assert.ok(state.stroke.length > 2);
  assert.equal(check(state), state);
});

test("a document saved before the tab existed opens with the starting path", () => {
  const { draw_path: _paths, ...older } = defaultPage();
  assert.deepEqual(openDocument(older).draw_path, defaultSection());
});

test("the dot follows the stroke at its own pace, stretched to the duration", () => {
  // drawn slowly for the first meter (0.8 s) and fast for the next three (0.2 s)
  const section = { ...defaultSection(), stroke: [[0, -2, 1], [0.8, -1, 1], [1, 2, 1]] };
  const path = timeline(section, 2);
  // the 30 ms smoothing rounds the ends off a little, as in sonore_sketch.draw_path
  assert.ok(Math.abs(positionAt(path, 0).point[0] + 2) < 0.05);
  assert.ok(Math.abs(positionAt(path, 0.8).point[0] + 1.5) < 0.02); // stroke time 0.4, in the slow part
  assert.ok(Math.abs(positionAt(path, 2).point[0] - 2) < 0.2);
  const still = timeline({ ...section, stroke: [[0, 1, 1]] }, 2);
  assert.deepEqual(positionAt(still, 1).point, [1, 1]); // one point: a still source
});

test("an even speed track moves at one pace, and the marker's point does not depend on the speed", () => {
  const section = withSpeed({ ...defaultSection(), stroke: [[0, -2, 1], [0.8, -1, 1], [1, 2, 1]] }, [[0, 1], [1, 1]]);
  const path = timeline(section, 2);
  const length = pathLength(section);
  assert.ok(length > 3.7 && length < 4);
  for (const t of [0.5, 1, 1.5]) assert.ok(Math.abs(positionAt(path, t).along - t / 2) < 0.005);
  const drawn = timeline({ ...section, speed: null }, 2);
  assert.deepEqual(pointAlong(path, 0.3), pointAlong(drawn, 0.3));
});

test("the speed track is kept relative to the average, and starts as drawn", () => {
  const section = { ...defaultSection(), stroke: [[0, -2, 1], [0.8, -1, 1], [1, 2, 1]] };
  // drawn: a quarter of the path slowly, the rest fast
  const drawn = speedPoints(section);
  const at = (fraction) => drawn.reduce((best, point) => (Math.abs(point[0] - fraction) < Math.abs(best[0] - fraction) ? point : best))[1];
  assert.ok(at(0.1) < 1 && at(0.7) > 2);
  // a track twice as fast in its second half: rescaled so the trip's time stays the duration's
  const shaped = withSpeed(section, [[0, 1], [0.49, 1], [0.51, 2], [1, 2]]).speed;
  assert.deepEqual(shaped[0], [0, 0.49, 0.51, 1]);
  assert.ok(Math.abs(shaped[1][3] / shaped[1][0] - 2) < 1e-3); // the shape stays
  assert.ok(Math.abs(shaped[1][0] - 0.75) < 0.01); // about 1/2 (1/0.75 + 1/1.5) = 1
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
  const page = { ...defaultPage(), duration: 1, draw_path: withElevation(defaultSection(), [[0, 0], [1, 60]]) };
  const stretched = stretchPage(page, 3);
  assert.deepEqual(stretched.draw_path.elevation, [[0, 3], [0, 60]]);
  assert.deepEqual(stretched.draw_path.stroke, page.draw_path.stroke);
  const flat = defaultSection();
  assert.equal(stretchSection(flat, 1, 3), flat); // flat: unchanged
});

test("clear leaves no path and the elevation flat, and keeps the settings", async () => {
  const page = { ...defaultPage(), draw_path: { ...defaultSection(), room: "room", elevation: [[0, 1], [0, 30]] } };
  const cleared = await clearTab(page, "draw_path");
  assert.deepEqual(cleared.draw_path, { source: "noise", room: "room", stroke: [], elevation: 0, speed: null, smoothing: 0.15 });
});

test("bad states are refused", () => {
  const good = tabState(defaultPage(), "draw_path");
  assert.throws(() => check({ ...good, source: "drums" }), /source/);
  assert.throws(() => check({ ...good, stroke: [[0, 1, 1], [-1, 1, 1]] }), /must not go back/);
  assert.throws(() => check({ ...good, stroke: [[0, 1]] }), /\[t, x, y\]/);
  assert.throws(() => check({ ...good, elevation: [[0], [1, 2]] }), /elevation/);
  assert.throws(() => check({ ...good, speed: [[0, 1], [1, 0]] }), /speed/);
  assert.throws(() => check({ ...good, speed: [[0, 2], [1, 1]] }), /speed/);
  assert.throws(() => check({ ...good, smoothing: 2 }), /smoothing/);
});
