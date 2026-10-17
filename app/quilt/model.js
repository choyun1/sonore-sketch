// The Quilt a sound tab's state (sonore_sketch.quilt is the Python half):
// the source, the segment length in seconds, and the seed of the quilt's
// first segment, from which sonore orders the rest.
//
// No DOM here, so this file runs under `node --test`.

import { SOURCES } from "../sources.js";

export const FORMAT = 1;
export const SEGMENT_RANGE = [0.03, 0.96]; // s, the paper's shortest and longest (sonore_sketch.quilt.SEGMENT_RANGE)
export const MIN_SEGMENTS = 3; // sonore_sketch.quilt.MIN_SEGMENTS
export const SLIDER_STEPS = 1000; // the segment slider's positions, on a log scale

export function defaultSection() {
  return { source: "syllables", segment: 0.06, seed: 1 };
}

// The segment length [s] at a slider position, to the millisecond, and back.
export function segmentFromSlider(position) {
  const [low, high] = SEGMENT_RANGE;
  const fraction = Math.min(1, Math.max(0, position / SLIDER_STEPS));
  return clampSegment(low * (high / low) ** fraction);
}

export function sliderFromSegment(segment) {
  const [low, high] = SEGMENT_RANGE;
  return Math.round((Math.log(segment / low) / Math.log(high / low)) * SLIDER_STEPS);
}

// A segment length [s] kept to the range, to the millisecond.
export function clampSegment(segment) {
  const [low, high] = SEGMENT_RANGE;
  return Math.min(high, Math.max(low, Math.round(segment * 1000) / 1000));
}

// How many whole segments the source holds at the page's duration (as
// sonore counts them, in samples).
export function wholeSegments({ duration, fs, segment }) {
  return Math.floor(Math.round(duration * fs) / Math.round(segment * fs));
}

// Raise an Error saying what is wrong with a section from a file or a link;
// sonore_sketch.quilt.check does the same in Python.
export function check(state) {
  const { source, segment, seed } = state;
  if (!SOURCES.includes(source)) throw new Error(`the Quilt a sound source must be one of ${SOURCES.join(", ")}`);
  const [low, high] = SEGMENT_RANGE;
  if (!(typeof segment === "number" && segment >= low && segment <= high)) throw new Error(`the segment must be from ${low} to ${high} s`);
  if (!(Number.isInteger(seed) && seed >= 0)) throw new Error("seed must be a whole number from 0 up");
  return state;
}
