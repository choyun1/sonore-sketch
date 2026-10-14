import assert from "node:assert/strict";
import { test } from "node:test";

import { History } from "../../app/history.js";
import { decodeState, encodeState, stateFromHash, tabFromHash } from "../../app/share.js";
import {
  FRICATION_SETTINGS,
  check,
  drawnPoints,
  lineSpan,
  simplifyStroke,
  trackSpec,
  clampDuration,
  clampValue,
  defaultDocument,
  insertPoint,
  movePoint,
  nearestPoint,
  points,
  replaceSpan,
  simplify,
  stretch,
  tidyDocument,
  valueAt,
  withFrication,
  withPoints,
} from "../../app/tracks/model.js";

test("a number is a flat track over the whole duration", () => {
  const doc = defaultDocument();
  assert.deepEqual(points(doc, "F4"), [[0, 4400], [0.6, 4400]]);
  assert.deepEqual(points({ ...doc, params: {} }, "B3"), [[0, 150], [0.6, 150]]);
});

test("withPoints stores [times, values], sorted, and leaves the old document alone", () => {
  const doc = defaultDocument();
  const next = withPoints(doc, "F4", [[0.5, 3600], [0.1, 3400]]);
  assert.deepEqual(next.params.F4, [[0.1, 0.5], [3400, 3600]]);
  assert.equal(doc.params.F4, 4400);
});

test("valueAt interpolates linearly and holds beyond the ends, as sonore does", () => {
  const pts = [[0.1, 100], [0.3, 300]];
  assert.equal(valueAt(pts, 0), 100);
  assert.equal(valueAt(pts, 0.2), 200);
  assert.equal(valueAt(pts, 1), 300);
});

test("point edits: grab within tolerance, insert in order, move between neighbors", () => {
  const pts = [[0, 1], [0.2, 2], [0.4, 3]];
  assert.equal(nearestPoint(pts, 0.21, 0.02), 1);
  assert.equal(nearestPoint(pts, 0.3, 0.02), -1);
  const { breakpoints: added, index } = insertPoint(pts, 0.3, 9);
  assert.equal(index, 2);
  assert.deepEqual(added.map(([t]) => t), [0, 0.2, 0.3, 0.4]);
  // Kept 0.1 ms inside its neighbors: sonore needs times to increase.
  const [right] = movePoint(pts, 1, 0.9, 5)[1];
  const [left] = movePoint(pts, 1, -1, 5)[1];
  assert.ok(Math.abs(right - 0.3999) < 1e-12 && Math.abs(left - 0.0001) < 1e-12);
});

test("a line replaces the breakpoints under it, as the paper's line-draw", () => {
  const pts = [[0, 1], [0.1, 2], [0.2, 3], [0.3, 4]];
  assert.deepEqual(replaceSpan(pts, [[0.05, 10], [0.25, 20]]), [[0, 1], [0.05, 10], [0.25, 20], [0.3, 4]]);
});

test("freehand strokes simplify to the fewest breakpoints within the tolerance", () => {
  const ramp = Array.from({ length: 50 }, (_, i) => [i / 49, 1000 + 500 * (i / 49)]);
  assert.deepEqual(simplify(ramp, 1), [ramp[0], ramp[49]]);
  // A corner survives.
  const corner = Array.from({ length: 51 }, (_, i) => [i / 50, i <= 25 ? 1000 : 1000 + 40 * (i - 25)]);
  const kept = simplify(corner, 5);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept[1], corner[25]);
  // Every original point is within the tolerance of the simplified track.
  for (const [t, v] of corner) assert.ok(Math.abs(valueAt(kept, t) - v) <= 5);
});

test("stretching scales breakpoint times exactly and keeps values (tracks.md, C3)", () => {
  const doc = defaultDocument();
  const longer = stretch(doc, 1.2);
  assert.equal(longer.duration, 1.2);
  assert.deepEqual(longer.params.F1[0], doc.params.F1[0].map((t) => t * 2));
  assert.deepEqual(longer.params.F1[1], doc.params.F1[1]);
  assert.equal(longer.params.F4, 4400);
  assert.equal(clampDuration(40), 30);
  assert.equal(clampDuration(0), 0.05);
});

test("check accepts the default document and refuses broken ones", () => {
  assert.equal(check(defaultDocument()).trackdraw, 1);
  assert.throws(() => check({ ...defaultDocument(), duration: 31 }), /duration/);
  assert.throws(() => check({ ...defaultDocument(), params: { F1: [[0], [1, 2]] } }), /F1/);
  assert.throws(() => check({ hello: 1 }), /TrackDraw/);
});

test("a drawing goes into a link and comes back unchanged", () => {
  const doc = defaultDocument();
  const encoded = encodeState(doc);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeState(encoded), doc);
  assert.deepEqual(stateFromHash(`#state=${encoded}`), doc);
  assert.equal(stateFromHash("#nothing"), null);
  // The default drawing ("sonore", with its consonants) is about a kilobyte:
  // more than app.md D8's few hundred bytes, still a short link.
  assert.ok(encoded.length < 1500, `link state is ${encoded.length} characters`);
});

test("a link can name a tab by the name the page shows, or by its id", () => {
  assert.equal(tabFromHash("#tab=draw-spectrogram"), "painted");
  assert.equal(tabFromHash("#tab=erase-modulation"), "edit");
  assert.equal(tabFromHash("#tab=blobs"), "blobs");
  assert.equal(tabFromHash("#tab=nonsense"), null);
  assert.equal(tabFromHash("#state=abc"), null);
});

test("history undoes and redoes, and a new edit drops the redo branch", () => {
  const history = new History("a");
  history.push("b");
  history.push("c");
  assert.ok(history.undo());
  assert.equal(history.present, "b");
  assert.ok(history.redo());
  assert.equal(history.present, "c");
  history.undo();
  history.push("d");
  assert.equal(history.redo(), false);
  assert.equal(history.present, "d");
});

// sonore refuses a track whose times do not strictly increase ("F0's times
// must increase"), so no edit may leave two breakpoints at one time.
const increasing = (times) => times.every((t, i) => i === 0 || t > times[i - 1]);

// A falling F0 of two breakpoints, the old default.
const twoPointF0 = () => withPoints(defaultDocument(), "F0", [[0, 125], [0.6, 95]]);

test("a point dragged onto its neighbor stays just beside it", () => {
  const doc = twoPointF0();
  const pts = points(doc, "F0");
  const next = withPoints(doc, "F0", movePoint(pts, 1, -1, 110));
  assert.ok(increasing(next.params.F0[0]));
  assert.equal(next.params.F0[0].length, 2);
});

test("a line with no width in time keeps one breakpoint there, the newest", () => {
  const doc = twoPointF0();
  const next = withPoints(doc, "F0", replaceSpan(points(doc, "F0"), [[0.3, 100], [0.30001, 140]]));
  assert.deepEqual(next.params.F0, [[0, 0.3, 0.6], [125, 140, 95]]);
});

test("shrinking the duration never merges times into a repeat", () => {
  const doc = withPoints(defaultDocument(), "F1", [[0, 500], [0.0002, 600], [0.0004, 700], [0.6, 500]]);
  const short = stretch(doc, 0.05);
  for (const value of Object.values(short.params)) if (typeof value !== "number") assert.ok(increasing(value[0]));
});

test("a document from a file or link with repeated times is tidied", () => {
  const doc = { ...defaultDocument(), params: { F0: [[0, 0.3, 0.3, 0.6], [125, 100, 140, 95]] } };
  assert.deepEqual(tidyDocument(doc).params.F0, [[0, 0.3, 0.6], [125, 140, 95]]);
});

test("F0 is never drawn or read below 20 Hz; other tracks still reach 0", () => {
  assert.equal(clampValue("F0", 5), 20);
  assert.equal(clampValue("F0", 120), 120);
  assert.equal(clampValue("F1", -5), 0);
  const doc = { ...defaultDocument(), params: { F0: [[0, 0.3, 0.6], [125, 8, 95]], AV: 0 } };
  assert.deepEqual(tidyDocument(doc).params, { F0: [[0, 0.3, 0.6], [125, 20, 95]], AV: 0 });
  assert.equal(tidyDocument({ ...doc, params: { F0: 10 } }).params.F0, 20);
});

test("F0 is drawn in octaves: a freehand stroke keeps the same detail in every octave", () => {
  // A wobble of 1% rides on a glide from 50 to 400 Hz; at 0.02 octave
  // tolerance (about 1.4%) it is dropped in every octave alike.
  const stroke = Array.from({ length: 61 }, (_, i) => [i / 100, 50 * 8 ** (i / 60) * (1 + 0.01 * (i % 2))]);
  const kept = simplifyStroke("F0", stroke);
  assert.equal(kept.length, 2);
  assert.ok(Math.abs(kept[1][1] - 400 * 1.0) < 5);
});

test("a Line on F0 is laid as breakpoints that stay straight in octaves", () => {
  const span = lineSpan("F0", [0.5, 400], [0, 100]);
  assert.deepEqual(span[0], [0, 100]);
  assert.deepEqual(span[span.length - 1], [0.5, 400]);
  assert.ok(span.length > 2);
  // Halfway in time is one octave up, not 250 Hz.
  assert.ok(Math.abs(valueAt(span, 0.25) - 200) / 200 < 0.02, `${valueAt(span, 0.25)}`);
  // Linear tracks keep just the two ends.
  assert.deepEqual(lineSpan("F1", [0, 500], [0.5, 900]), [[0, 500], [0.5, 900]]);
});

test("a log track is drawn along the curve sonore takes between breakpoints", () => {
  const drawn = drawnPoints("F0", [[0, 100], [0.5, 400], [0.6, 400]]);
  assert.ok(drawn.length > 3);
  assert.deepEqual(drawn.find(([t]) => Math.abs(t - 0.25) < 1e-9), [0.25, 250]);
  assert.deepEqual(drawnPoints("F1", [[0, 500], [1, 900]]), [[0, 500], [1, 900]]);
});

test("F0 is clamped to 20-800 Hz", () => {
  assert.equal(clampValue("F0", 5), 20);
  assert.equal(clampValue("F0", 2000), 800);
});

test("F0 can be shown linear: 0-800 Hz, strokes simplified in Hz, Lines kept to two ends", () => {
  assert.equal(trackSpec("F0").scale, "log");
  const linear = trackSpec("F0", "linear");
  assert.deepEqual([linear.scale, linear.min, linear.max, linear.tolerance], ["linear", 0, 800, 1.5]);
  assert.deepEqual(lineSpan("F0", [0, 100], [0.5, 400], "linear"), [[0, 100], [0.5, 400]]);
  assert.deepEqual(drawnPoints("F0", [[0, 100], [0.5, 400]], "linear"), [[0, 100], [0.5, 400]]);
  // Tracks with no linear settings stay as they are.
  assert.equal(trackSpec("F1", "log").scale, undefined);
});

test("drawing frication turns the parallel formants on only when they are all off", () => {
  const doc = { ...defaultDocument(), params: { F1: 500 } };
  assert.deepEqual(withFrication(doc).params, { ...FRICATION_SETTINGS, F1: 500 });
  const own = { ...doc, params: { A5: 20 } };
  assert.equal(withFrication(own), own);
  // The example already has its /s/ settings.
  assert.equal(withFrication(defaultDocument()).params.A4, 34);
});

test("a freehand stroke drawn back over itself keeps only the newer pass", async () => {
  const { extendStroke } = await import("../../app/tracks/model.js");
  const stroke = [];
  for (const t of [0, 1, 2, 3, 4, 5]) extendStroke(stroke, [t, 10]); // forward at 10
  for (const t of [4.5, 3.5, 2.5]) extendStroke(stroke, [t, 20]); // back to 2.5 at 20
  const sorted = [...stroke].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(sorted, [[0, 10], [1, 10], [2, 10], [2.5, 20], [3.5, 20], [4.5, 20], [5, 10]]);
});
