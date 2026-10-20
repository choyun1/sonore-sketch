import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { decodeLevels } from "../../app/draw_spectrogram/model.js";
import { defaultPage, forLink, openDocument, tabState, upgrade, withRecording, withTabState } from "../../app/document.js";
import {
  COLUMNS,
  EXAMPLE_LEVELS,
  ROWS,
  SIDE,
  check,
  columnRate,
  keepBelow,
  removeSweeps,
} from "../../app/erase_modulation/model.js";
import { checkRecording, encodePcm16, pcm16Length } from "../../app/sources.js";

// The Python half's presets, as base64 of deflated bytes (sonore_sketch.erase_modulation).
function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nfrom sonore_sketch import erase_modulation\n${code}`], { encoding: "utf8" }).trim();
}

test("the grid's columns are the Python half's", () => {
  const rates = JSON.parse(python("import json; print(json.dumps(erase_modulation.column_rates().tolist()))"));
  assert.equal(rates.length, COLUMNS);
  rates.forEach((rate, c) => assert.ok(Math.abs(columnRate(c) - rate) < 1e-9, `column ${c}`));
  assert.equal(columnRate(SIDE), 0);
});

test("the starting mask and the presets are the Python half's", async () => {
  assert.deepEqual(await decodeLevels(EXAMPLE_LEVELS, ROWS * COLUMNS), keepBelow(4));
  for (const [js, py] of [
    [keepBelow(16), "erase_modulation.encode(erase_modulation.keep_below(16))"],
    [removeSweeps("down"), 'erase_modulation.encode(erase_modulation.remove_sweeps("down"))'],
    [removeSweeps("up"), 'erase_modulation.encode(erase_modulation.remove_sweeps("up"))'],
  ]) {
    assert.deepEqual(await decodeLevels(python(`print(${py})`), ROWS * COLUMNS), js, py);
  }
});

test("a downward-sweep cut is the right side above density 0", () => {
  const bytes = removeSweeps("down");
  assert.equal(bytes[0 * COLUMNS + COLUMNS - 1], 0); // density 0 has no direction
  assert.equal(bytes[5 * COLUMNS + COLUMNS - 1], 60);
  assert.equal(bytes[5 * COLUMNS + 0], 0);
  assert.equal(bytes[5 * COLUMNS + SIDE], 0); // the center strip
});

test("the page carries the edit section, with the source's drawing in its state", () => {
  const page = defaultPage();
  check(tabState(page, "erase_modulation"));
  const old = { ...page };
  delete old.erase_modulation;
  assert.deepEqual(upgrade(old).erase_modulation, page.erase_modulation);
  const speech = withTabState(page, "erase_modulation", { ...tabState(page, "erase_modulation"), source: "draw_speech" });
  assert.deepEqual(tabState(speech, "erase_modulation").draw_speech, page.draw_speech);
  assert.equal(withTabState(speech, "erase_modulation", tabState(speech, "erase_modulation")).erase_modulation.draw_speech, undefined);
});

test("a recording sets the duration and the source, goes in saved files and never in links", () => {
  const samples = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 5));
  const recording = checkRecording({ name: "a.wav", fs: 16000, pcm16: encodePcm16(samples) });
  assert.equal(pcm16Length(recording.pcm16), 4000);
  const page = withRecording(defaultPage(), recording, 0.25);
  assert.equal(page.duration, 0.25);
  assert.equal(page.erase_modulation.source, "file");
  assert.equal(tabState(page, "erase_modulation").recording, recording);
  assert.deepEqual(openDocument(JSON.parse(JSON.stringify(page))).recording, recording);
  const link = forLink(page);
  assert.equal(link.recording, undefined);
  assert.equal(tabState(openDocument(link), "erase_modulation").recording, undefined);
  assert.equal(withRecording(defaultPage(), recording, 40).duration, 30);
});

test("bad sections are refused", () => {
  const state = tabState(defaultPage(), "erase_modulation");
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, iterations: 21 }), /iterations/);
  assert.throws(() => check({ ...state, columns: 100 }), /193 columns/);
  assert.throws(() => checkRecording({ name: "x", fs: 0, pcm16: "" }), /recording/);
});
