import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, tabState, withRecording, withTabState } from "../../app/document.js";
import { SEGMENT_RANGE, MIN_SEGMENTS, SLIDER_STEPS, check, clampSegment, segmentFromSlider, sliderFromSegment, wholeSegments } from "../../app/quilt_sound/model.js";
import { tabFromHash } from "../../app/share.js";

function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nfrom sonore_sketch import quilt_sound\n${code}`], { encoding: "utf8" }).trim();
}

test("the segment range and the fewest segments are the Python half's", () => {
  assert.deepEqual(JSON.parse(python("import json; print(json.dumps([list(quilt_sound.SEGMENT_RANGE), quilt_sound.MIN_SEGMENTS]))")), [SEGMENT_RANGE, MIN_SEGMENTS]);
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
  const state = tabState(defaultPage("quilt_sound"), "quilt_sound");
  assert.deepEqual(state, { quilt_sound: 1, sonore: state.sonore, duration: 2, fs: 16000, source: "syllables", segment: 0.06, seed: 1 });
});

test("a link names the tab, and a page saved before the tab existed opens with its default", () => {
  assert.equal(tabFromHash("#tab=quilt-a-sound"), "quilt_sound");
  const { quilt_sound: _quilt, ...older } = defaultPage("scatter_events");
  assert.deepEqual(openDocument(older).quilt_sound, defaultPage().quilt_sound);
});

test("bad sections say what is wrong", () => {
  const state = tabState(defaultPage("quilt_sound"), "quilt_sound");
  assert.throws(() => check({ ...state, segment: 0.01 }), /segment/);
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, seed: 0.5 }), /seed/);
  assert.throws(() => check({ ...state, seed: -1 }), /seed/);
});

test("a recording opened here becomes the quilt's source, and Clear leaves the settings alone", async () => {
  const page = withRecording(defaultPage("quilt_sound"), { name: "a.wav", fs: 16000, pcm16: "AAAA" }, 3.5, "quilt_sound");
  assert.equal(page.quilt_sound.source, "file");
  assert.equal(page.duration, 3.5);
  assert.equal(tabState(page, "quilt_sound").recording.name, "a.wav");
  const changed = { ...page, quilt_sound: { ...page.quilt_sound, segment: 0.2, seed: 4 } };
  assert.deepEqual((await clearTab(changed, "quilt_sound")).quilt_sound, changed.quilt_sound);
});

test("another tab's drawing can be the source, and goes with the state", () => {
  const page = defaultPage("quilt_sound");
  for (const source of ["draw_spectrogram", "draw_modulation", "scatter_events"]) {
    const state = tabState({ ...page, quilt_sound: { ...page.quilt_sound, source } }, "quilt_sound");
    assert.deepEqual(state.drawing, page[source], source);
    assert.ok(check(state));
  }
  assert.equal(tabState(page, "quilt_sound").drawing, undefined); // the syllable train needs no drawing
  assert.equal(withTabState(page, "quilt_sound", { ...tabState(page, "quilt_sound"), drawing: {} }).quilt_sound.drawing, undefined);
});

test("every Source list keeps the tabs' order: sounds made here, the tabs' sounds, a file last", async () => {
  const { LABELS } = await import("../../app/quilt_sound/model.js");
  const { SOURCES: PATHS } = await import("../../app/draw_path/model.js");
  const { SOURCE_LABELS } = await import("../../app/sources.js");
  const { TABS } = await import("../../app/document.js");
  const tabs = (ids) => ids.filter((id) => TABS.includes(id));
  for (const ids of [Object.keys(LABELS), PATHS.map(([id]) => id), Object.keys(SOURCE_LABELS)]) {
    assert.equal(ids.at(-1), "file");
    const order = tabs(ids).map((id) => TABS.indexOf(id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), ids.join(", "));
  }
  for (const label of [...Object.values(LABELS), ...PATHS.map(([, label]) => label)]) assert.ok(!label.startsWith("The "), label);
});
