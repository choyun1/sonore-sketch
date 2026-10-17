import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, tabState, withRecording, withTabState } from "../../app/document.js";
import { SEGMENT_RANGE, MIN_SEGMENTS, SLIDER_STEPS, check, clampSegment, segmentFromSlider, sliderFromSegment, wholeSegments } from "../../app/quilt/model.js";
import { tabFromHash } from "../../app/share.js";

function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nfrom sonore_sketch import quilt\n${code}`], { encoding: "utf8" }).trim();
}

test("the segment range and the fewest segments are the Python half's", () => {
  assert.deepEqual(JSON.parse(python("import json; print(json.dumps([list(quilt.SEGMENT_RANGE), quilt.MIN_SEGMENTS]))")), [SEGMENT_RANGE, MIN_SEGMENTS]);
});

test("the segment slider runs on a log scale from 30 to 960 ms, to the millisecond", () => {
  assert.equal(segmentFromSlider(0), 0.03);
  assert.equal(segmentFromSlider(SLIDER_STEPS), 0.96);
  assert.equal(segmentFromSlider(SLIDER_STEPS / 2), 0.17); // the geometric middle, 170 ms
  for (const segment of [0.03, 0.06, 0.25, 0.96]) assert.ok(Math.abs(segmentFromSlider(sliderFromSegment(segment)) - segment) <= 0.002, segment);
  assert.equal(clampSegment(5), 0.96);
  assert.equal(clampSegment(0.0604), 0.06);
});

test("whole segments are counted in samples, as sonore cuts them", () => {
  assert.equal(wholeSegments({ duration: 2, fs: 16000, segment: 0.06 }), 33);
  assert.equal(wholeSegments({ duration: 2, fs: 16000, segment: 0.96 }), 2);
});

test("the tab starts on the syllable train, cut into 60 ms segments, at 2 s", () => {
  const state = tabState(defaultPage("quilt"), "quilt");
  assert.deepEqual(state, { quilt: 1, sonore: state.sonore, duration: 2, fs: 16000, source: "syllables", segment: 0.06, seed: 1 });
});

test("a link names the tab, and a page saved before the tab existed opens with its default", () => {
  assert.equal(tabFromHash("#tab=quilt-a-sound"), "quilt");
  const { quilt: _quilt, ...older } = defaultPage("events");
  assert.deepEqual(openDocument(older).quilt, defaultPage().quilt);
});

test("bad sections say what is wrong", () => {
  const state = tabState(defaultPage("quilt"), "quilt");
  assert.throws(() => check({ ...state, segment: 0.01 }), /segment/);
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, seed: 0.5 }), /seed/);
  assert.throws(() => check({ ...state, seed: -1 }), /seed/);
});

test("a recording opened here becomes the quilt's source, and Clear leaves the settings alone", async () => {
  const page = withRecording(defaultPage("quilt"), { name: "a.wav", fs: 16000, pcm16: "AAAA" }, 3.5, "quilt");
  assert.equal(page.quilt.source, "file");
  assert.equal(page.duration, 3.5);
  assert.equal(tabState(page, "quilt").recording.name, "a.wav");
  const changed = { ...page, quilt: { ...page.quilt, segment: 0.2, seed: 4 } };
  assert.deepEqual((await clearTab(changed, "quilt")).quilt, changed.quilt);
});

test("another tab's drawing can be the source, and goes with the state", () => {
  const page = defaultPage("quilt");
  for (const source of ["painted", "blobs", "events"]) {
    const state = tabState({ ...page, quilt: { ...page.quilt, source } }, "quilt");
    assert.deepEqual(state.drawing, page[source], source);
    assert.ok(check(state));
  }
  assert.equal(tabState(page, "quilt").drawing, undefined); // the syllable train needs no drawing
  assert.equal(withTabState(page, "quilt", { ...tabState(page, "quilt"), drawing: {} }).quilt.drawing, undefined);
});
