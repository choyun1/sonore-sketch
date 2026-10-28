import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, tabState, withRecording } from "../../app/document.js";
import {
  DRR_RANGE, F_RANGE, LABELS, N_POINTS, RT60_RANGE, START_RT60, check, drawOnCurve, median, nearestPointIndex, points, realRoom, scaledTo, startCurve,
} from "../../app/draw_room/model.js";
import { LABELS as QUILT_LABELS } from "../../app/quilt_sound/model.js";
import { tabFromHash } from "../../app/share.js";

function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nimport numpy as np, sonore as so\nfrom sonore_sketch import draw_room\n${code}`], { encoding: "utf8" }).trim();
}

test("the points, ranges and sources are the Python half's", () => {
  const theirs = JSON.parse(python(
    "import json; print(json.dumps([draw_room.points().tolist(), draw_room.N_POINTS, list(draw_room.F_RANGE), list(draw_room.RT60_RANGE), list(draw_room.DRR_RANGE), list(draw_room.SOURCES)]))",
  ));
  assert.deepEqual(theirs.slice(0, 5), [points(), N_POINTS, F_RANGE, RT60_RANGE, DRR_RANGE]);
  assert.deepEqual([...theirs[5]].sort(), Object.keys(LABELS).sort());
});

test("a real room is sonore's (band_rt60s, ecological) at every point", () => {
  const rooms = [0.1, 0.3, 1, 3, 10];
  const theirs = JSON.parse(python(`import json; print(json.dumps([so.band_rt60s(r, draw_room.points()).tolist() for r in ${JSON.stringify(rooms)}]))`));
  rooms.forEach((rt60, i) => realRoom(rt60).forEach((value, k) => assert.ok(Math.abs(value / theirs[i][k] - 1) < 1e-5, `${rt60} s at ${points()[k]} Hz`)));
});

test("the tab starts on a real room of 1 s, the syllable train, the direct sound at 0 dB, at 2 s", () => {
  const state = tabState(defaultPage("draw_room"), "draw_room");
  assert.equal(state.draw_room, 1);
  assert.equal(state.duration, 2);
  assert.equal(state.source, "syllables");
  assert.equal(state.drr_db, 0);
  assert.equal(state.seed, 1);
  assert.ok(Math.abs(median(state.rt60) - START_RT60) < 0.002);
  assert.ok(check(state));
});

test("its sources are a clap, then Quilt a sound's", () => {
  assert.deepEqual(Object.keys(LABELS), ["clap", ...Object.keys(QUILT_LABELS)]);
});

test("each room to start from has the RT60 asked for as its median", () => {
  for (const kind of ["real", "flat", "inverted"]) {
    const curve = startCurve(kind, 2.5);
    assert.equal(curve.length, N_POINTS);
    assert.ok(Math.abs(median(curve) - 2.5) < 0.005, kind);
  }
  const real = startCurve("real", 1);
  const inverted = startCurve("inverted", 1);
  const mid = nearestPointIndex(points(), Math.log(800));
  assert.ok(real[mid] > real[0] && real[mid] > real[N_POINTS - 1]); // real rooms ring longest in the middle
  assert.ok(inverted[mid] < inverted[0] && inverted[mid] < inverted[N_POINTS - 1]);
});

test("scaling keeps the shape and holds the curve on the axis", () => {
  const curve = startCurve("real", 1);
  const twice = scaledTo(curve, 2);
  assert.ok(Math.abs(twice[10] / curve[10] - twice[50] / curve[50]) < 0.01);
  assert.ok(scaledTo(curve, 10).every((value) => value <= RT60_RANGE[1]));
});

test("a stroke sets the points between its ends on a line in log frequency and log RT60", () => {
  const f = points();
  const flat = f.map(() => 1);
  const drawn = drawOnCurve(flat, f, [Math.log(200), Math.log(4)], [Math.log(800), Math.log(0.25)]);
  const at = (hz) => drawn[nearestPointIndex(f, Math.log(hz))];
  assert.equal(at(100), 1);
  assert.equal(at(4000), 1);
  assert.ok(Math.abs(Math.log(at(400))) < 0.1); // halfway in log frequency is halfway in log RT60
  assert.ok(drawn.every((value) => value >= RT60_RANGE[0] && value <= RT60_RANGE[1]));
});

test("a link names the tab, and a page saved before the tab existed opens with its default", () => {
  assert.equal(tabFromHash("#tab=draw-a-room"), "draw_room");
  const { draw_room: _room, ...older } = defaultPage("quilt_sound");
  assert.deepEqual(openDocument(older).draw_room, defaultPage().draw_room);
});

test("bad sections say what is wrong", () => {
  const state = tabState(defaultPage("draw_room"), "draw_room");
  assert.throws(() => check({ ...state, rt60: state.rt60.slice(1) }), /rt60/);
  assert.throws(() => check({ ...state, rt60: state.rt60.map(() => 20) }), /rt60/);
  assert.throws(() => check({ ...state, drr_db: 21 }), /drr_db/);
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, seed: -1 }), /seed/);
});

test("a recording opened here becomes the source, and Clear flattens the curve at its median", async () => {
  const page = withRecording(defaultPage("draw_room"), { name: "a.wav", fs: 16000, pcm16: "AAAA" }, 3.5, "draw_room");
  assert.equal(page.draw_room.source, "file");
  assert.equal(tabState(page, "draw_room").recording.name, "a.wav");
  const cleared = (await clearTab(page, "draw_room")).draw_room;
  assert.equal(cleared.source, "file");
  assert.equal(new Set(cleared.rt60).size, 1);
  assert.ok(Math.abs(cleared.rt60[0] - median(page.draw_room.rt60)) < 0.001);
});

test("another tab's drawing goes with the state when it is the source", () => {
  const page = defaultPage("draw_room");
  const state = tabState({ ...page, draw_room: { ...page.draw_room, source: "scatter_events" } }, "draw_room");
  assert.deepEqual(state.drawing, page.scatter_events);
});
