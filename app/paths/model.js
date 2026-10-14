// The Draw path tab's state (docs/design/tabs/paths.md; sonore_sketch.paths
// is the Python half).
//
// A stroke is the pointer's positions on the top view as drawn, [[t, x, y],
// ...]: t in seconds from the stroke's start, x to the listener's right and
// y ahead, in meters. It keeps its own timing, stretched to the page's
// duration (W6). The elevation is a track over the page's time, a number of
// degrees or [times, degrees], from -40 to 90 (the measured range).
//
// No DOM here, so this file runs under `node --test`.

import { tidyPoints, valueAt } from "../tracks/model.js";

export const FORMAT = 1;
export const SOURCES = [
  ["noise", "noise"],
  ["syllables", "syllable train"],
  ["speech", "Draw speech tab's sound"],
  ["file", "recording"],
];
export const ROOMS = [["dry", "dry"], ["room", "room (RT60 0.6 s)"]];
export const HALF_WIDTH = 4; // m: the top view spans -4..4 m both ways (sonore_sketch.paths.HALF_WIDTH)
export const MEASURED_DISTANCE = 1.4; // m, where MIT KEMAR was measured
export const MIN_DISTANCE = 0.25; // m from the head's center (sonore_sketch.paths.MIN_DISTANCE)
export const ELEVATION_RANGE = [-40, 90]; // degrees, the measured range
export const MAX_POINTS = 20000; // sonore_sketch.paths.MAX_POINTS

// The starting path: a source passing in front from left to right, 1.2 m
// ahead at its nearest, at an even pace over 2 s of drawing.
function startingStroke() {
  const stroke = [];
  for (let i = 0; i <= 60; i++) {
    const fraction = i / 60;
    const x = -3 + 6 * fraction;
    const y = 1.2 + 0.6 * (2 * fraction - 1) ** 2;
    stroke.push([Number((2 * fraction).toFixed(3)), Number(x.toFixed(2)), Number(y.toFixed(2))]);
  }
  return stroke;
}

export function defaultSection() {
  return { source: "noise", room: "dry", stroke: startingStroke(), elevation: 0 };
}

// A point on the top view as kept in a stroke: time to the millisecond,
// positions to the centimeter.
export function strokePoint(t, x, y) {
  return [Number(t.toFixed(3)), Number(x.toFixed(2)), Number(y.toFixed(2))];
}

// The elevation track's breakpoints, [[t, degrees], ...] over [0, duration].
export function elevationPoints(section, duration) {
  const { elevation = 0 } = section;
  if (typeof elevation === "number") return [[0, elevation], [duration, elevation]];
  return elevation[0].map((t, i) => [t, elevation[1][i]]);
}

export function withElevation(section, breakpoints) {
  const clamped = breakpoints.map(([t, degrees]) => [t, Math.min(ELEVATION_RANGE[1], Math.max(ELEVATION_RANGE[0], degrees))]);
  const tidy = tidyPoints(clamped);
  if (tidy.every(([, degrees]) => degrees === tidy[0][1])) return { ...section, elevation: tidy[0][1] };
  return { ...section, elevation: [tidy.map(([t]) => t), tidy.map(([, degrees]) => degrees)] };
}

export function elevationAt(section, duration, t) {
  return valueAt(elevationPoints(section, duration), t);
}

// Where the drawn stroke is at page time `t`, for the dot that follows the
// sound (the sound follows the smoothed stroke, which is close to it).
export function positionAt(stroke, duration, t) {
  if (!stroke.length) return null;
  const first = stroke[0][0];
  const span = stroke[stroke.length - 1][0] - first;
  if (span <= 0) return stroke[stroke.length - 1].slice(1);
  const strokeTime = first + (Math.min(Math.max(t, 0), duration) / duration) * span;
  let i = 1;
  while (i < stroke.length - 1 && stroke[i][0] < strokeTime) i++;
  const [t0, x0, y0] = stroke[i - 1];
  const [t1, x1, y1] = stroke[i];
  const fraction = t1 > t0 ? Math.min(1, Math.max(0, (strokeTime - t0) / (t1 - t0))) : 1;
  return [x0 + (x1 - x0) * fraction, y0 + (y1 - y0) * fraction];
}

// The section after the page's duration changes: the elevation track's
// times stretch with it, as every track does; the stroke's own times are
// stretched to the duration when the sound is made, so they stay.
export function stretchSection(section, from, to) {
  if (typeof section.elevation === "number") return section;
  const factor = to / from;
  return withElevation(section, elevationPoints(section, from).map(([t, degrees]) => [t * factor, degrees]));
}

// Raise an Error saying what is wrong with a state from a file or a link;
// sonore_sketch.paths.check checks the same.
export function check(state) {
  if (!state || state.paths !== FORMAT) throw new Error(`not a Draw path state of format ${FORMAT}`);
  if (!SOURCES.some(([id]) => id === state.source)) throw new Error(`the path's source must be one of ${SOURCES.map(([id]) => id).join(", ")}`);
  if (!ROOMS.some(([id]) => id === state.room)) throw new Error(`the path's room must be one of ${ROOMS.map(([id]) => id).join(", ")}`);
  const { stroke } = state;
  if (!Array.isArray(stroke) || stroke.length > MAX_POINTS) throw new Error(`the path's stroke must be a list of at most ${MAX_POINTS} points`);
  for (const [i, point] of stroke.entries()) {
    if (!(Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))) throw new Error("each point of the path's stroke must be [t, x, y]");
    if (i && point[0] < stroke[i - 1][0]) throw new Error("the path's stroke times must not go back");
  }
  const { elevation } = state;
  if (typeof elevation === "number" && Number.isFinite(elevation)) return state;
  const valid =
    Array.isArray(elevation) && elevation.length === 2 && Array.isArray(elevation[0]) && Array.isArray(elevation[1]) &&
    elevation[0].length === elevation[1].length && elevation[0].length > 0 && elevation.flat().every(Number.isFinite);
  if (!valid) throw new Error("the path's elevation must be a number or [times, degrees]");
  return state;
}
