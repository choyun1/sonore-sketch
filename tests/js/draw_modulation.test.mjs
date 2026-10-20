import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bandCenter,
  check,
  clampRate,
  defaultSection,
  depthThatFits,
  grid,
  newBand,
  strokeOnto,
  power,
  rateToUnit,
  unitToRate,
} from "../../app/draw_modulation/model.js";
import { defaultPage, openDocument, resetTab, stretchPage, tabState, withTabState } from "../../app/document.js";

// What sonore's from_blobs draws (tests/test_draw_modulation.py writes and checks it).
const fixture = JSON.parse(readFileSync(new URL("../fixtures/blob_power.json", import.meta.url)));

test("the plane's grid is the one sonore draws on", () => {
  const g = grid(fixture.state);
  assert.ok(Math.abs(g.rateStep - fixture.rate_step) < 1e-9);
  assert.equal(g.nTimes, fixture.n_rates);
  assert.equal(g.densities.length, fixture.n_densities);
  assert.ok(Math.abs(g.densityStep - fixture.density_step) < 1e-9);
});

test("the picture's levels are sonore's, relative to the peak", () => {
  const { items } = fixture.state;
  const levels = fixture.points.map(([r, d]) => 10 * Math.log10(power(items, r, d)));
  const peak = Math.max(...levels);
  fixture.points.forEach(([r, d, expected], i) => {
    assert.ok(Math.abs(levels[i] - peak - expected) < 0.01, `at ${r} Hz, ${d} cyc/oct: ${levels[i] - peak} dB, sonore ${expected} dB`);
  });
  assert.ok(fixture.points.length > 50);
});

test("the rate axis is signed and logarithmic, 1 to 64 Hz each side", () => {
  assert.equal(rateToUnit(1), 0);
  assert.equal(rateToUnit(8), 0.5);
  assert.equal(rateToUnit(-64), -1);
  assert.equal(rateToUnit(0.3), 0); // on the seam
  assert.equal(unitToRate(0.5), 8);
  assert.equal(unitToRate(-1), -64);
  for (const r of [-40, -3, 1.5, 20]) assert.ok(Math.abs(unitToRate(rateToUnit(r)) - r) < 1e-9);
  assert.equal(clampRate(0.2), 1);
  assert.equal(clampRate(-200), -64);
});

test("sonore's refusal of a depth names the depth that fits", () => {
  const message =
    "ValueError: rms_depth 0.99 would push 16.1% of this draw's envelope values below zero; at most 0.342 fits it (or draw again with another rng)";
  assert.equal(depthThatFits(message), 0.342);
  assert.equal(depthThatFits("something else"), null);
});

test("sections from files and links are checked", () => {
  const state = tabState(defaultPage(), "draw_modulation");
  assert.equal(check(state), state);
  assert.throws(() => check({ ...state, carrier: "pink" }), /carrier/);
  assert.throws(() => check({ ...state, carrier: "harmonic", f0: 5 }), /f0/);
  assert.throws(() => check({ ...state, items: [{ ...state.items[0], rate: 0 }] }), /nonzero rate/);
  assert.throws(() => check({ ...state, items: Array(9).fill(state.items[0]) }), /at most 8/);
});

test("the page keeps the blobs in their own section, and old pages gain it", () => {
  const page = defaultPage();
  const state = tabState(page, "draw_modulation");
  assert.equal(state.draw_modulation, 1);
  assert.equal(state.duration, page.duration);
  const next = withTabState(page, "draw_modulation", { ...state, seed: 2 });
  assert.deepEqual(next.draw_modulation, { ...defaultSection(), seed: 2 });
  assert.deepEqual(stretchPage(next, 3).draw_modulation, next.draw_modulation); // blobs are in Hz
  const { draw_modulation: _blobs, ...older } = page;
  assert.deepEqual(openDocument(older).draw_modulation, defaultSection());
  assert.equal(resetTab(next, "draw_modulation").draw_modulation.seed, 1);
  assert.equal(resetTab(next, "draw_spectrogram").draw_modulation.seed, 2);
});

// --- bands (docs/design/tabs/bands.md) ---------------------------------------------

test("a band's center is its points, interpolated in log frequency and held past its ends", () => {
  const points = [[0.2, 500], [0.6, 2000]];
  assert.equal(bandCenter(points, 0), 500);
  assert.ok(Math.abs(bandCenter(points, 0.4) - 1000) < 1e-9);
  assert.equal(bandCenter(points, 1), 2000);
});

test("a new band goes where no band is, flat across the page", () => {
  const first = newBand([], 0.6);
  assert.deepEqual(first, { points: [[0, 500], [0.6, 500]], width: 1, level: 0 });
  assert.equal(newBand([first], 0.6).points[0][1], 2000);
});

test("bands are checked", () => {
  const ok = { ...defaultSection(), duration: 0.6, bands: [newBand([], 0.6)] };
  assert.equal(check(ok), ok);
  assert.throws(() => check({ ...ok, bands: Array(6).fill(ok.bands[0]) }), /at most 5/);
  assert.throws(() => check({ ...ok, bands: [{ ...ok.bands[0], width: 0.1 }] }), /width/);
  assert.throws(() => check({ ...ok, bands: [{ ...ok.bands[0], points: [[0.3, 500], [0.3, 600]] }] }), /times must increase/);
  assert.throws(() => check({ ...ok, bands: [{ ...ok.bands[0], points: [[0, 50]] }] }), /center/);
});

test("stretching the page stretches the bands with it", () => {
  const page = defaultPage();
  page.draw_modulation = { ...page.draw_modulation, bands: [{ points: [[0, 500], [0.3, 800], [0.6, 500]], width: 1, level: 0 }] };
  const longer = stretchPage(page, 1.2);
  assert.deepEqual(longer.draw_modulation.bands[0].points, [[0, 500], [0.6, 800], [1.2, 500]]);
  assert.deepEqual(longer.draw_modulation.items, page.draw_modulation.items);
});

test("a stroke replaces a band's track over its span, simplified in octaves", () => {
  const points = strokeOnto([[0, 500], [1, 500]], [[0.2, 1000], [0.3, 1100], [0.4, 1200], [0.6, 700]]);
  assert.deepEqual(points, [[0, 500], [0.2, 1000], [0.4, 1200], [0.6, 700], [1, 500]]);
  assert.deepEqual(strokeOnto(null, [[0.5, 800]]), [[0.5, 800]]);
});
