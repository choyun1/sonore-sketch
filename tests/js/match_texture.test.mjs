import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, tabState, withRecording } from "../../app/document.js";
import { BARS, GROUPS, ITERATION_RANGE, LABELS, SNR_RANGE, check, toggled } from "../../app/match_texture/model.js";
import { LABELS as QUILT_LABELS } from "../../app/quilt_sound/model.js";
import { tabFromHash } from "../../app/share.js";

function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nfrom sonore_sketch import match_texture\n${code}`], { encoding: "utf8" }).trim();
}

test("the groups, bars, ranges and sources are the Python half's", () => {
  const theirs = JSON.parse(python(
    "import json; print(json.dumps([{k: list(v) for k, v in match_texture.GROUPS.items()}, list(match_texture.BARS), list(match_texture.ITERATION_RANGE), list(match_texture.SNR_RANGE), list(match_texture.SOURCES)]))",
  ));
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([id, { classes }]) => [id, classes]));
  assert.deepEqual(theirs, [groups, BARS.map(([name]) => name), ITERATION_RANGE, SNR_RANGE, theirs[4]]);
  assert.deepEqual([...theirs[4]].sort(), Object.keys(LABELS).sort());
});

test("the tab starts on the Scatter events tab's sound, keeping everything, 10 iterations, at 2 s", () => {
  const state = tabState(defaultPage("match_texture"), "match_texture");
  const { drawing, ...rest } = state;
  assert.deepEqual(rest, {
    match_texture: 1, sonore: state.sonore, duration: 2, fs: 16000, source: "scatter_events",
    keep: ["marginals", "modulation", "correlations"], iterations: 10, seed: 1,
  });
  assert.deepEqual(drawing, defaultPage().scatter_events);
});

test("its sources are Quilt a sound's", () => {
  assert.deepEqual(LABELS, QUILT_LABELS);
});

test("a group switched on or off keeps the groups in order", () => {
  assert.deepEqual(toggled(["correlations"], "marginals", true), ["marginals", "correlations"]);
  assert.deepEqual(toggled(["marginals", "modulation"], "marginals", false), ["modulation"]);
  assert.deepEqual(toggled([], "modulation", false), []);
});

test("a link names the tab, and a page saved before the tab existed opens with its default", () => {
  assert.equal(tabFromHash("#tab=match-a-texture"), "match_texture");
  const { match_texture: _match, ...older } = defaultPage("quilt_sound");
  assert.deepEqual(openDocument(older).match_texture, defaultPage().match_texture);
});

test("bad sections say what is wrong", () => {
  const state = tabState(defaultPage("match_texture"), "match_texture");
  assert.ok(check({ ...state, keep: [] }));
  assert.throws(() => check({ ...state, keep: ["spectrum"] }), /keep/);
  assert.throws(() => check({ ...state, keep: ["marginals", "marginals"] }), /keep/);
  assert.throws(() => check({ ...state, iterations: 0 }), /iterations/);
  assert.throws(() => check({ ...state, iterations: 31 }), /iterations/);
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, seed: -1 }), /seed/);
});

test("a recording opened here becomes the source, and Clear leaves the settings alone", async () => {
  const page = withRecording(defaultPage("match_texture"), { name: "a.wav", fs: 16000, pcm16: "AAAA" }, 3.5, "match_texture");
  assert.equal(page.match_texture.source, "file");
  assert.equal(tabState(page, "match_texture").recording.name, "a.wav");
  const changed = { ...page, match_texture: { ...page.match_texture, keep: ["modulation"], iterations: 3 } };
  assert.deepEqual((await clearTab(changed, "match_texture")).match_texture, changed.match_texture);
});
