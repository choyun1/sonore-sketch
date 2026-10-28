import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, stretchPage, tabState } from "../../app/document.js";
import {
  DB_RANGE, MAX_MOMENTS, MIN_GAP, N_POINTS, addMoment, check, curveAt, defaultSection, drawOnCurve, drawPitch, erbNumber, moveMoment,
  pitchAt, points, removeMoment, unvoice, voicedRuns, vowelCurve, withEnds, withTrack,
} from "../../app/draw_voice/model.js";

test("the starting voice is ah, ee, oo on a falling pitch, and checks", () => {
  const section = defaultSection();
  assert.deepEqual(section.filter.moments, [0.2, 1, 1.8]);
  assert.equal(section.filter.f.length, N_POINTS);
  assert.deepEqual(section.filter.db, ["a", "i", "u"].map((id) => vowelCurve(id)));
  check({ draw_voice: 1, ...section });
  check(tabState(defaultPage("draw_voice"), "draw_voice"));
});

test("the filter's points are equally spaced on the ERB scale from 50 Hz to 8 kHz", () => {
  const f = points();
  assert.equal(f[0], 50);
  assert.equal(f[f.length - 1], 8000);
  const steps = f.slice(1).map((v, i) => erbNumber(v) - erbNumber(f[i]));
  assert.ok(Math.max(...steps) - Math.min(...steps) < 0.01);
});

test("a vowel's curve peaks at 0 dB at its first formant and stays on the axis", () => {
  const f = points();
  for (const [id, formant] of [["a", 730], ["i", 270], ["u", 300]]) {
    const curve = vowelCurve(id);
    const peak = f[curve.indexOf(0)];
    assert.ok(Math.abs(Math.log2(peak / formant)) < 0.2, `${id}: peak at ${peak} Hz`);
    assert.ok(curve.every((level) => level >= DB_RANGE[0] && level <= DB_RANGE[1]));
  }
});

test("unvoicing a stretch keeps the line's pitch either side, and drawing over it voices only what is drawn", () => {
  const line = [[0, 100], [2, 200]];
  const gap = unvoice(line, 0.5, 1);
  assert.equal(pitchAt(gap, 0.75), 0);
  assert.ok(Math.abs(pitchAt(gap, 0.45) - 122.5) < 0.1);
  assert.ok(Math.abs(pitchAt(gap, 1.1) - 155) < 0.1);
  assert.deepEqual(voicedRuns(gap, 2).map((run) => [run[0][0], run[run.length - 1][0]]), [[0, 0.5], [1, 2]]);
  const drawn = drawPitch(gap, [[0.7, 300], [1.5, 300]]);
  assert.equal(pitchAt(drawn, 0.6), 0); // still unvoiced up to the stroke
  assert.equal(pitchAt(drawn, 0.8), 300);
});

test("a track keeps its ends when a stroke is drawn in its middle", () => {
  const section = withTrack(defaultSection(), "breathiness", [...withEnds([[0, 0.001]], 2)].concat([[0.9, 0.5], [1.1, 0.5]]));
  assert.deepEqual(section.breathiness, [[0, 0.9, 1.1, 2], [0.001, 0.5, 0.5, 0.001]]);
  assert.deepEqual(withTrack(defaultSection(), "f0", [[0, 30], [1, 900], [1.5, 0]]).f0, [[0, 1, 1.5], [50, 500, 0]]);
});

test("moments are added with the curve heard there, moved between their neighbours and removed down to one", () => {
  const section = defaultSection();
  const { section: added, index } = addMoment(section, 0.6);
  assert.equal(index, 1);
  assert.deepEqual(added.filter.db[1], curveAt(section.filter, 0.6));
  assert.equal(addMoment(added, 0.6 + MIN_GAP / 2), null);
  assert.deepEqual(moveMoment(added, 1, 5, 2).filter.moments, [0.2, 0.99, 1, 1.8]);
  let fewer = added;
  for (let i = 0; i < 6; i++) fewer = removeMoment(fewer, 0);
  assert.equal(fewer.filter.moments.length, 1);
  let many = { ...section, filter: { ...section.filter, moments: [0], db: [section.filter.db[0]] } };
  for (let i = 1; i < 40; i++) many = addMoment(many, i * 0.05)?.section ?? many;
  assert.equal(many.filter.moments.length, MAX_MOMENTS);
});

test("drawing on a curve sets the points the stroke passes over, on the line between pointer positions", () => {
  const f = points();
  const flat = f.map(() => -30);
  const drawn = drawOnCurve(flat, f, [erbNumber(500), -10], [erbNumber(2000), -50]);
  assert.equal(drawn[0], -30);
  assert.equal(drawn[f.length - 1], -30);
  const inside = f.map((v, k) => [v, drawn[k]]).filter(([v]) => v >= 500 && v <= 2000);
  assert.ok(inside.length > 3 && inside.every(([, level], k) => !k || level <= inside[k - 1][1]));
  assert.equal(drawOnCurve(flat, f, [erbNumber(1000), 20], [erbNumber(1100), 20]).find((level) => level !== -30), 0); // held at the top
});

test("the page's duration stretches the voice, and Clear leaves a steady buzz", async () => {
  const page = defaultPage("draw_voice");
  const longer = stretchPage(page, 4).draw_voice;
  assert.deepEqual(longer.filter.moments, [0.4, 2, 3.6]);
  assert.deepEqual(longer.f0[0], [0, 1.8, 2.4, 4]);
  const cleared = (await clearTab(page, "draw_voice")).draw_voice;
  assert.deepEqual(cleared.f0, [[0], [100]]);
  assert.deepEqual(cleared.filter.moments, [1]);
  check({ draw_voice: 1, ...cleared });
});

test("a saved page with a bad voice does not open", () => {
  const page = defaultPage("draw_voice");
  assert.throws(() => openDocument({ ...page, draw_voice: { ...page.draw_voice, f0: [[0], [20]] } }), /pitch|f0/);
  assert.throws(() => openDocument({ ...page, draw_voice: { ...page.draw_voice, filter: { ...page.draw_voice.filter, moments: [1, 0.5, 1.8] } } }), /moments/);
  const older = { ...page };
  delete older.draw_voice;
  assert.deepEqual(openDocument(older).draw_voice, page.draw_voice); // a page saved before the tab gets its starting voice
});
