// The Scatter events tab's state (docs/design/tabs/events.md;
// sonore_sketch.events is the Python half).
//
// One event (a chirp, a tone pip, a noise burst or an impact, with its own
// knobs) copied at random times: the rate is a track over the page's time
// in events per second, a number while flat (E3); three sliders set how
// regular the timing is and how much each copy's level and pitch vary (E4);
// the seed is the draw.
//
// No DOM here, so this file runs under `node --test`.

import { tidyPoints, valueAt } from "../tracks/model.js";

export const FORMAT = 1;
export const EVENTS = [
  ["chirp", "chirp"],
  ["pip", "tone pip"],
  ["noise", "noise burst"],
  ["impact", "impact"],
];
export const RATE_RANGE = [1, 1000]; // events per second (sonore_sketch.events.RATE_RANGE)
export const DEFAULT_RATE = 10;
export const MAX_BREAKPOINTS = 2000; // sonore_sketch.events.MAX_BREAKPOINTS

// Every knob is a slider: its name in the state, its label, unit, range,
// scale ("log" moves by equal ratios), the step its values keep, and which
// events use it (null: every event). The ranges are the ones
// sonore_sketch.events.check takes (E2, E4).
export const KNOBS = [
  { name: "length", label: "Length", unit: "ms", factor: 1000, low: 0.01, high: 0.1, scale: "linear", step: 0.001, events: ["chirp", "pip", "noise"], title: "How long each event lasts, under a Hann window" },
  { name: "f_low", label: "From", unit: "Hz", low: 50, high: 7500, scale: "log", step: 1, events: ["chirp"], title: "The chirp's starting frequency" },
  { name: "f_high", label: "To", unit: "Hz", low: 50, high: 7500, scale: "log", step: 1, events: ["chirp"], title: "The chirp's ending frequency" },
  { name: "frequency", label: "Frequency", unit: "Hz", low: 50, high: 7500, scale: "log", step: 1, events: ["pip"], title: "The tone pip's frequency" },
  { name: "decay", label: "Decay", unit: "ms", factor: 1000, low: 0.002, high: 0.05, scale: "log", step: 0.0005, events: ["impact"], title: "The impact's time constant: how fast it dies away" },
  { name: "cutoff", label: "Cutoff", unit: "Hz", low: 300, high: 8000, scale: "log", step: 10, events: ["impact"], title: "The impact's lowpass: lower is duller, like a knock; higher is brighter, like a clap" },
  { name: "regularity", label: "Regularity", unit: "", low: 1, high: 64, scale: "log", step: 0.1, events: null, title: "The gamma shape of the intervals: 1 is random (Poisson) timing, 64 nearly regular" },
  { name: "level_sd", label: "Level spread", unit: "dB", low: 0, high: 12, scale: "linear", step: 0.5, events: null, title: "The standard deviation of each copy's level" },
  { name: "pitch_sd", label: "Pitch spread", unit: "cents", low: 0, high: 300, scale: "linear", step: 5, events: null, title: "The standard deviation of each copy's pitch shift; a higher copy is also shorter" },
];
export const SLIDER_STEPS = 1000; // a range input's positions from low to high

export function defaultSection() {
  return {
    event: "chirp", length: 0.03, f_low: 2000, f_high: 6000, frequency: 1000, decay: 0.008, cutoff: 2000,
    rate: DEFAULT_RATE, regularity: 1, level_sd: 0, pitch_sd: 0, seed: 0,
  };
}

export const knob = (name) => KNOBS.find((entry) => entry.name === name);

// A knob's value from a slider position, 0 to SLIDER_STEPS, kept to its step.
export function fromSlider(name, position) {
  const { low, high, scale, step } = knob(name);
  const fraction = Math.min(1, Math.max(0, position / SLIDER_STEPS));
  const value = scale === "log" ? low * (high / low) ** fraction : low + fraction * (high - low);
  const stepped = Math.round(value / step) * step;
  return Math.min(high, Math.max(low, Number(stepped.toFixed(6))));
}

// The slider position of a knob's value.
export function toSlider(name, value) {
  const { low, high, scale } = knob(name);
  const fraction = scale === "log" ? Math.log(value / low) / Math.log(high / low) : (value - low) / (high - low);
  return Math.round(Math.min(1, Math.max(0, fraction)) * SLIDER_STEPS);
}

// A knob's value as the slider's label shows it: 30 ms, 2000 Hz, 4.0.
export function knobLabel(name, value) {
  const { unit, factor = 1, scale } = knob(name);
  const shown = value * factor;
  const digits = unit === "" ? (shown < 10 ? 1 : 0) : unit === "dB" ? 1 : scale === "log" && shown < 10 ? 1 : 0;
  return `${shown.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

// Whether the knob belongs to the event chosen.
export const knobShown = (name, event) => knob(name).events === null || knob(name).events.includes(event);

// --- the rate track ------------------------------------------------------------------

const clampRate = (rate) => Math.min(RATE_RANGE[1], Math.max(RATE_RANGE[0], rate));
const roundRate = (rate) => Number(rate.toPrecision(3));

// The rate track's breakpoints, [[t, events per second], ...] over [0, duration].
export function ratePoints(section, duration) {
  const { rate = DEFAULT_RATE } = section;
  if (typeof rate === "number") return [[0, rate], [duration, rate]];
  return rate[0].map((t, i) => [t, rate[1][i]]);
}

// The section with these breakpoints as its rate: a number while flat.
export function withRate(section, breakpoints) {
  const tidy = tidyPoints(breakpoints.map(([t, rate]) => [t, roundRate(clampRate(rate))]));
  if (tidy.every(([, rate]) => rate === tidy[0][1])) return { ...section, rate: tidy[0][1] };
  return { ...section, rate: [tidy.map(([t]) => t), tidy.map(([, rate]) => rate)] };
}

export function rateAt(section, duration, t) {
  return valueAt(ratePoints(section, duration), t);
}

// The rate while flat, else null (the sparsity plot's dot needs one rate).
export function flatRate(section) {
  return typeof section.rate === "number" ? section.rate : null;
}

// The section after the page's duration changes: the rate track's times
// stretch with it, as every track does.
export function stretchSection(section, from, to) {
  if (typeof section.rate === "number") return section;
  const factor = to / from;
  return withRate(section, ratePoints(section, from).map(([t, rate]) => [t * factor, rate]));
}

// Raise an Error saying what is wrong with a state from a file or a link;
// sonore_sketch.events.check checks the same.
export function check(state) {
  if (!state || state.events !== FORMAT) throw new Error(`not a Scatter events state of format ${FORMAT}`);
  if (!EVENTS.some(([id]) => id === state.event)) throw new Error(`the event must be one of ${EVENTS.map(([id]) => id).join(", ")}`);
  for (const { name, low, high } of KNOBS) {
    const value = state[name];
    if (!(Number.isFinite(value) && value >= low && value <= high)) throw new Error(`the events' ${name} must be a number from ${low} to ${high}`);
  }
  if (!Number.isInteger(state.seed)) throw new Error("the events' seed must be a whole number");
  const { rate } = state;
  let values = [rate];
  if (typeof rate !== "number") {
    const valid =
      Array.isArray(rate) && rate.length === 2 && Array.isArray(rate[0]) && Array.isArray(rate[1]) &&
      rate[0].length === rate[1].length && rate[0].length > 0 && rate[0].length <= MAX_BREAKPOINTS && rate.flat().every(Number.isFinite);
    if (!valid) throw new Error("the events' rate must be a number or [times, events per second]");
    if (rate[0].some((t, i) => i && t <= rate[0][i - 1])) throw new Error("the rate track's times must increase");
    values = rate[1];
  }
  if (!values.every((value) => Number.isFinite(value) && value >= RATE_RANGE[0] && value <= RATE_RANGE[1])) {
    throw new Error(`the rate must stay from ${RATE_RANGE[0]} to ${RATE_RANGE[1]} events per second`);
  }
  return state;
}
