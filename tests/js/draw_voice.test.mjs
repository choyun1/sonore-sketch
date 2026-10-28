import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, measureState, openDocument, soundState, stretchPage, tabState, withRecording, withTabState } from "../../app/document.js";
import {
  DB_RANGE, MAX_MOMENTS, MIN_GAP, N_POINTS, addMoment, check, curveAt, defaultSection, drawOnCurve, drawPitch, erbNumber, moveMoment,
  measuredCurve, pitchAt, points, removeMoment, takenBreathiness, takenPitch, unvoice, voicedRuns, vowelCurve, withCopiedCurve, withEnds,
  withTakenSource, withTrack,
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

// --- taken from a sound (S6) ---------------------------------------------------------

// A measured voice: 120 Hz gliding to 240 Hz over 0.2-0.4 s, unvoiced from 0.5 to 0.6 s.
function measured() {
  const t = Array.from({ length: 161 }, (_, i) => Number((i * 0.005).toFixed(4)));
  const f0 = t.map((time) => (time >= 0.5 && time <= 0.6 ? 0 : time < 0.2 ? 120 : time < 0.4 ? 120 * 2 ** ((time - 0.2) / 0.2) : 240));
  const breathiness = t.map((time) => (time >= 0.5 && time <= 0.6 ? 0.9 : 0.1));
  const f = points();
  const db = t.map((time) => f.map((frequency) => (time < 0.3 ? (frequency < 1000 ? 0 : -40) : -20)));
  return { t, f0, breathiness, f, db };
}

test("a taken pitch line follows the measured one, unvoiced where it is", () => {
  const voice = measured();
  const line = takenPitch(voice);
  assert.ok(line.length < 20, `${line.length} breakpoints`);
  voice.t.forEach((time, i) => {
    const heard = pitchAt(line, time);
    if (voice.f0[i] === 0 && time > 0.5 && time < 0.6) assert.equal(heard, 0, `at ${time}`);
    if (voice.f0[i] > 0) assert.ok(Math.abs(Math.log2(heard / voice.f0[i])) < 0.03, `at ${time}: ${heard} for ${voice.f0[i]}`);
  });
  assert.deepEqual(takenPitch({ t: [0, 1], f0: [0, 0] }), [[0, 0], [1, 0]]);
});

test("a long jittery pitch still fits the breakpoint limit", () => {
  const t = Array.from({ length: 6001 }, (_, i) => i * 0.005);
  const line = takenPitch({ t, f0: t.map((_, i) => (i % 7 === 3 ? 0 : 100 + 60 * Math.sin(i))) });
  assert.ok(line.length <= 2000 && line.length > 2);
});

test("the taken breathiness skips the unvoiced windows, and the section checks", () => {
  const voice = measured();
  assert.deepEqual(takenBreathiness(voice), [[0, 0.1], [0.8, 0.1]]);
  const section = withTakenSource(defaultSection(), voice);
  check({ draw_voice: 1, ...section, source: "file" });
  assert.deepEqual(section.filter, defaultSection().filter);
});

test("copying the filter takes the window nearest the moment, onto the section's points", () => {
  const voice = measured();
  const section = withCopiedCurve(defaultSection(), 0, voice); // the moment at 0.2 s
  assert.deepEqual(section.filter.db[0], voice.db[40]);
  assert.deepEqual(section.filter.db.slice(1), defaultSection().filter.db.slice(1));
  const coarse = measuredCurve(voice, 1.8, [40, 1000, 9000]);
  assert.deepEqual(coarse, [-20, -20, -20]);
});

test("the source is not heard, and what is measured carries the source's own sound", () => {
  const page = defaultPage("draw_voice");
  const chosen = withTabState(page, "draw_voice", { ...tabState(page, "draw_voice"), source: "scatter_events" });
  assert.equal(tabState(chosen, "draw_voice").source, "scatter_events");
  assert.deepEqual(soundState(chosen, "draw_voice"), soundState(page, "draw_voice"));
  assert.deepEqual(measureState(chosen).drawing, chosen.scatter_events);
  assert.deepEqual(measureState(page).draw_speech, page.draw_speech); // Draw speech's sound until one is chosen
  const opened = withRecording(page, { name: "a.wav", fs: 16000, pcm16: "AAAA" }, 1.5, "draw_voice");
  assert.equal(opened.draw_voice.source, "file");
  assert.equal(measureState(opened).recording.name, "a.wav");
  assert.equal(withTabState(opened, "draw_voice", { ...tabState(opened, "draw_voice"), recording: opened.recording }).draw_voice.recording, undefined);
});
