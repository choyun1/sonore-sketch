import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, stretchPage, tabState } from "../../app/document.js";
import {
  KNOBS,
  SLIDER_STEPS,
  check,
  defaultSection,
  fromSlider,
  fromTyped,
  knobNumber,
  knobName,
  knobShown,
  rateAt,
  ratePoints,
  stretchSection,
  toSlider,
  withDefaults,
  withRate,
} from "../../app/events/model.js";

test("the starting page has the events section, and its state passes the check", () => {
  const state = tabState(defaultPage(), "events");
  assert.equal(state.events, 1);
  assert.equal(state.rate, 10);
  assert.equal(check(state), state);
});

test("a document saved before the tab existed opens with the starting events", () => {
  const { events: _events, ...older } = defaultPage();
  assert.deepEqual(openDocument(older).events, defaultSection());
});

test("a section saved before the tone and noise band knobs opens with them at their defaults", () => {
  const { tone: _tone, harmonics: _harmonics, noise_low: _low, noise_high: _high, ...older } = defaultSection();
  const page = { ...defaultPage(), events: { ...older, pitch_sd: 200 } };
  const opened = openDocument(page).events;
  assert.equal(opened.tone, "pure");
  assert.equal(opened.noise_high, 7500);
  assert.equal(opened.pitch_sd, 200);
  assert.deepEqual(withDefaults({}), defaultSection());
});

test("each slider's ends are its knob's range, and a position round-trips", () => {
  for (const { name, low, high, scale, step } of KNOBS) {
    assert.equal(fromSlider(name, 0), low, name);
    assert.equal(fromSlider(name, SLIDER_STEPS), high, name);
    const middle = fromSlider(name, SLIDER_STEPS / 2);
    // within a step of the knob's value (a whole-number knob moves in steps of 1)
    const tolerance = scale === "linear" ? Math.max(3, (SLIDER_STEPS * step) / (high - low)) : 3;
    assert.ok(Math.abs(toSlider(name, middle) - SLIDER_STEPS / 2) <= tolerance, name);
  }
  assert.equal(fromSlider("regularity", SLIDER_STEPS / 2), 8); // log: the middle of 1 to 64
  assert.equal(knobNumber("length", 0.03), "30");
  assert.equal(knobNumber("cutoff", 2000), "2000");
  assert.equal(knobNumber("regularity", 4), "4.0");
  assert.equal(knobNumber("harmonics", 8), "8");
  assert.equal(fromSlider("pitch_sd", SLIDER_STEPS), 1200);
  assert.equal(fromSlider("length", SLIDER_STEPS), 0.5);
});

test("a typed value is read in the box's units, kept to the knob's range and step", () => {
  assert.equal(fromTyped("length", "250"), 0.25); // ms
  assert.equal(fromTyped("length", "250.4"), 0.25);
  assert.equal(fromTyped("length", "2000"), 0.5);
  assert.equal(fromTyped("length", "1"), 0.01);
  assert.equal(fromTyped("pitch_sd", "1200"), 1200);
  assert.equal(fromTyped("pitch_sd", "333"), 330);
  assert.equal(fromTyped("decay", "8.2"), 0.008);
  assert.equal(fromTyped("regularity", "12.34"), 12.3);
  assert.equal(fromTyped("cutoff", ""), null);
  assert.equal(fromTyped("cutoff", "abc"), null);
});

test("only the chosen event's knobs show, and the copies' knobs always do", () => {
  const as = (event, tone = "pure") => ({ event, tone });
  assert.ok(knobShown("f_low", as("chirp")) && !knobShown("f_low", as("impact")));
  assert.ok(knobShown("cutoff", as("impact")) && !knobShown("length", as("impact")));
  assert.ok(knobShown("pitch_sd", as("noise")) && knobShown("regularity", as("impact")));
  assert.ok(knobShown("noise_low", as("noise")) && !knobShown("noise_low", as("pip")));
  assert.ok(!knobShown("harmonics", as("pip")) && knobShown("harmonics", as("pip", "harmonic")));
  assert.equal(knobName("frequency", as("pip")), "Frequency");
  assert.equal(knobName("frequency", as("pip", "harmonic")), "F0");
});

test("the rate is a number while flat, breakpoints otherwise, within 1 to 1000 per second", () => {
  const section = defaultSection();
  assert.equal(withRate(section, [[0, 30], [1, 30]]).rate, 30);
  const rising = withRate(section, [[0, 0.2], [1, 123.456], [2, 5000]]);
  assert.deepEqual(rising.rate, [[0, 1, 2], [1, 123, 1000]]);
  assert.equal(rateAt(rising, 2, 0.5), 62);
  assert.deepEqual(ratePoints(section, 3), [[0, 10], [3, 10]]);
});

test("the rate track stretches with the duration", () => {
  const page = { ...defaultPage(), duration: 1, events: withRate(defaultSection(), [[0, 2], [1, 200]]) };
  assert.deepEqual(stretchPage(page, 3).events.rate, [[0, 3], [2, 200]]);
  const flat = defaultSection();
  assert.equal(stretchSection(flat, 1, 3), flat);
});

test("clear puts the rate back to 10 per second and keeps the rest", async () => {
  const page = { ...defaultPage(), events: { ...defaultSection(), event: "impact", seed: 4, rate: [[0, 1], [5, 500]] } };
  const cleared = await clearTab(page, "events");
  assert.deepEqual(cleared.events, { ...defaultSection(), event: "impact", seed: 4 });
});

test("bad states are refused", () => {
  const good = tabState(defaultPage(), "events");
  assert.throws(() => check({ ...good, event: "drum" }), /event must be/);
  assert.throws(() => check({ ...good, cutoff: 20 }), /cutoff/);
  assert.throws(() => check({ ...good, seed: 0.5 }), /seed/);
  assert.throws(() => check({ ...good, tone: "square" }), /tone/);
  assert.throws(() => check({ ...good, harmonics: 2.5 }), /harmonics/);
  assert.throws(() => check({ ...good, noise_low: 3000, noise_high: 2000 }), /below its highest/);
  assert.throws(() => check({ ...good, pitch_sd: 1300 }), /pitch_sd/);
  assert.throws(() => check({ ...good, rate: 0.5 }), /rate must stay/);
  assert.throws(() => check({ ...good, rate: [[1, 0], [10, 20]] }), /must increase/);
  assert.throws(() => check({ ...good, rate: [[0], [10, 20]] }), /rate must be/);
});
