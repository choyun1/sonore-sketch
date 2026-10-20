import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { decodeLevels } from "../../app/draw_spectrogram/model.js";
import { defaultPage, forLink, openDocument, stretchPage, tabState, upgrade, withRecording, withTabState } from "../../app/document.js";
import { encodePcm16 } from "../../app/sources.js";
import { BLANK_LEVELS, COLUMNS, FLOOR_DB, ROWS, WINDOW_S, blank, check, retime, rowFrequency, stretchSection } from "../../app/erase_spectrogram/model.js";

function python(code) {
  return execFileSync("python", ["-c", `import sys; sys.path.insert(0, "src")\nfrom sonore_sketch import erase_spectrogram\n${code}`], { encoding: "utf8" }).trim();
}

test("the grid and the starting mask are the Python half's", async () => {
  const [rows, columns, floor, window, f0, fLast] = JSON.parse(
    python("import json; f = erase_spectrogram.row_frequencies(16000); print(json.dumps([erase_spectrogram.ROWS, erase_spectrogram.COLUMNS, erase_spectrogram.FLOOR_DB, erase_spectrogram.WINDOW_S, f[0], f[-1]]))"),
  );
  assert.deepEqual([rows, columns, floor, window], [ROWS, COLUMNS, FLOOR_DB, WINDOW_S]);
  assert.equal(rowFrequency(0, 16000), f0);
  assert.equal(rowFrequency(ROWS - 1, 16000), fLast);
  assert.equal(BLANK_LEVELS, python("print(erase_spectrogram.BLANK_LEVELS)"));
  assert.deepEqual(await decodeLevels(BLANK_LEVELS, ROWS * COLUMNS), blank());
});

test("the page carries the mask section, with the source's drawing in its state", () => {
  const page = defaultPage();
  check(tabState(page, "erase_spectrogram"));
  const old = { ...page };
  delete old.erase_spectrogram;
  assert.deepEqual(upgrade(old).erase_spectrogram, page.erase_spectrogram);
  const speech = withTabState(page, "erase_spectrogram", { ...tabState(page, "erase_spectrogram"), source: "draw_speech" });
  assert.deepEqual(tabState(speech, "erase_spectrogram").draw_speech, page.draw_speech);
  assert.equal(withTabState(speech, "erase_spectrogram", tabState(speech, "erase_spectrogram")).erase_spectrogram.draw_speech, undefined);
  assert.equal(speech.erase_modulation.source, page.erase_modulation.source); // the two tabs choose their sources apart
});

test("a recording opened here is this tab's source, shared with the Edit tab, and never in links", () => {
  const recording = { name: "a.wav", fs: 16000, pcm16: encodePcm16(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 7))) };
  const page = withRecording(defaultPage(), recording, 0.5, "erase_spectrogram");
  assert.equal(page.duration, 0.5);
  assert.equal(page.erase_spectrogram.source, "file");
  assert.equal(page.erase_modulation.source, "syllables");
  assert.equal(tabState(page, "erase_spectrogram").recording, recording);
  assert.equal(tabState(withTabState(page, "erase_modulation", { ...tabState(page, "erase_modulation"), source: "file" }), "erase_modulation").recording, recording);
  assert.equal(tabState(openDocument(forLink(page)), "erase_spectrogram").recording, undefined);
});

test("bad sections are refused", () => {
  const state = tabState(defaultPage(), "erase_spectrogram");
  assert.throws(() => check({ ...state, source: "radio" }), /source/);
  assert.throws(() => check({ ...state, rows: 128 }), /256 rows/);
  assert.throws(() => check({ ...state, window: 0.005 }), /window/);
  assert.throws(() => openDocument({ ...defaultPage(), erase_spectrogram: { ...state, columns: 3 } }), /256 columns/);
});

test("erasures on a recording or syllables keep their seconds when the duration changes", () => {
  const section = { source: "file", levels: BLANK_LEVELS };
  assert.deepEqual(stretchSection(section, 3, 6), { ...section, span: 3 });
  assert.deepEqual(stretchSection({ ...section, span: 3 }, 6, 3), section); // back where the columns were
  assert.deepEqual(stretchSection({ ...section, source: "draw_speech" }, 3, 6), { ...section, source: "draw_speech" });
  assert.deepEqual(stretchSection({ ...section, source: "draw_speech", span: 1 }, 2, 4), { ...section, source: "draw_speech", span: 2 });
  // on the page: Reset (0.6 s) after a 3 s recording keeps the first 0.6 s of the erasures
  const page = withTabState(defaultPage(), "erase_spectrogram", { ...tabState(defaultPage(), "erase_spectrogram"), source: "syllables" });
  assert.equal(stretchPage({ ...page, duration: 3 }, 0.6).erase_spectrogram.span, 3);

  const bytes = blank();
  for (let r = 0; r < ROWS; r++) for (let c = 64; c < 128; c++) bytes[r * COLUMNS + c] = 60; // 0.75-1.5 s of 3 s
  const at6 = retime(bytes, 3, 6);
  const erased = (b, c) => b[c] === 60;
  assert.ok(erased(at6, 40) && !erased(at6, 70) && !erased(at6, 200)); // 0.95 s erased; 1.65 s and 4.7 s not
  assert.equal(retime(bytes, 3, 3), bytes);
});
