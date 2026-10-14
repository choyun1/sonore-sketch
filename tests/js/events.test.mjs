import assert from "node:assert/strict";
import { test } from "node:test";

import { clearTab, defaultPage, openDocument, stretchPage, tabState } from "../../app/document.js";
import {
  KNOBS,
  SLIDER_STEPS,
  check,
  defaultSection,
  flatRate,
  fromSlider,
  knobLabel,
  knobShown,
  rateAt,
  ratePoints,
  stretchSection,
  toSlider,
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

test("each slider's ends are its knob's range, and a position round-trips", () => {
  for (const { name, low, high } of KNOBS) {
    assert.equal(fromSlider(name, 0), low, name);
    assert.equal(fromSlider(name, SLIDER_STEPS), high, name);
    const middle = fromSlider(name, SLIDER_STEPS / 2);
    assert.ok(Math.abs(toSlider(name, middle) - SLIDER_STEPS / 2) <= 3, name);
  }
  assert.equal(fromSlider("regularity", SLIDER_STEPS / 2), 8); // log: the middle of 1 to 64
  assert.equal(knobLabel("length", 0.03), "30 ms");
  assert.equal(knobLabel("cutoff", 2000), "2000 Hz");
  assert.equal(knobLabel("regularity", 4), "4.0");
});

test("only the chosen event's knobs show, and the copies' knobs always do", () => {
  assert.ok(knobShown("f_low", "chirp") && !knobShown("f_low", "impact"));
  assert.ok(knobShown("cutoff", "impact") && !knobShown("length", "impact"));
  assert.ok(knobShown("pitch_sd", "noise") && knobShown("regularity", "impact"));
});

test("the rate is a number while flat, breakpoints otherwise, within 1 to 1000 per second", () => {
  const section = defaultSection();
  assert.equal(withRate(section, [[0, 30], [1, 30]]).rate, 30);
  const rising = withRate(section, [[0, 0.2], [1, 123.456], [2, 5000]]);
  assert.deepEqual(rising.rate, [[0, 1, 2], [1, 123, 1000]]);
  assert.equal(rateAt(rising, 2, 0.5), 62);
  assert.equal(flatRate(rising), null);
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
  assert.throws(() => check({ ...good, rate: 0.5 }), /rate must stay/);
  assert.throws(() => check({ ...good, rate: [[1, 0], [10, 20]] }), /must increase/);
  assert.throws(() => check({ ...good, rate: [[0], [10, 20]] }), /rate must be/);
});
