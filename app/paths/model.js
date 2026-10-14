// The Draw path tab's state (docs/design/tabs/paths.md; sonore_sketch.paths
// is the Python half).
//
// A stroke is the pointer's positions on the top view as drawn, [[t, x, y],
// ...]: t in seconds from the stroke's start, x to the listener's right and
// y ahead, in meters. It keeps its own timing, stretched to the page's
// duration (W6), unless a speed track is drawn: `speed` is null (the
// drawing's timing) or [fractions, speeds], relative speeds at fractions of
// the path's length from its start (W7), 1 being the average, which the
// duration sets. The elevation is a track over the page's time, a number of
// degrees or [times, degrees], from -40 to 90 (the measured range).
//
// No DOM here, so this file runs under `node --test`.

import { simplify, tidyPoints, valueAt } from "../tracks/model.js";

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
export const SLOWEST = 1 / 20; // of the speed track's fastest (W8; sonore_sketch.paths.SLOWEST)
export const SPEED_RANGE = [1 / 8, 8]; // the track's range, times the average speed
const STEP = 0.01; // s (sonore_sketch.paths.STEP)
const SMOOTHING = 0.03; // s (sonore_sketch.paths.SMOOTHING)
export const SHAPE_SMOOTHING = 0.15; // m, the default (sonore_sketch.paths.SHAPE_SMOOTHING)
export const MAX_SHAPE_SMOOTHING = 0.5; // m (sonore_sketch.paths.MAX_SHAPE_SMOOTHING)
const SHAPE_STEP = 0.01; // m (sonore_sketch.paths.SHAPE_STEP)
const SPEED_TOLERANCE = 0.08; // octaves, how far a simplified speed curve may stray

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
  return { source: "noise", room: "dry", stroke: startingStroke(), elevation: 0, speed: null, smoothing: SHAPE_SMOOTHING };
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

// --- the path in time ------------------------------------------------------------

// The stroke put every 10 ms and smoothed with a 30 ms Gaussian, then its
// shape smoothed with a 15 cm Gaussian along the path, as
// sonore_sketch.paths.smoothed does (scipy's gaussian_filter1d, mode
// "nearest"): its times from 0 and its [x, y] points.
export function smoothed(stroke, shape = SHAPE_SMOOTHING) {
  if (!stroke.length) return { times: [], points: [] };
  const first = stroke[0][0];
  const span = stroke[stroke.length - 1][0] - first;
  if (span <= 0) return { times: [0], points: [stroke[stroke.length - 1].slice(1)] };
  // where the pointer reported two positions at one time, the later one stands
  const kept = stroke.filter((point, i) => i === stroke.length - 1 || stroke[i + 1][0] > point[0]);
  const grid = [];
  for (let i = 0; i * STEP < span + STEP / 2; i++) grid.push(i * STEP);
  let j = 1;
  const resampled = grid.map((t) => {
    const strokeTime = first + t;
    while (j < kept.length - 1 && kept[j][0] < strokeTime) j++;
    const [t0, x0, y0] = kept[j - 1];
    const [t1, x1, y1] = kept[j];
    const fraction = strokeTime <= t0 ? 0 : strokeTime >= t1 ? 1 : (strokeTime - t0) / (t1 - t0);
    return [x0 + (x1 - x0) * fraction, y0 + (y1 - y0) * fraction];
  });
  return { times: grid, points: smoothShape(gaussian(resampled, SMOOTHING / STEP), shape) };
}

// scipy's gaussian_filter1d on [x, y] points, mode "nearest", truncated at 4 SDs.
function gaussian(values, sigma) {
  const radius = Math.floor(4 * sigma + 0.5);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-0.5 * ((k - radius) / sigma) ** 2));
  const total = weights.reduce((a, b) => a + b, 0);
  return values.map((_, i) => {
    let x = 0;
    let y = 0;
    weights.forEach((weight, k) => {
      const [px, py] = values[Math.min(values.length - 1, Math.max(0, i + k - radius))];
      x += weight * px;
      y += weight * py;
    });
    return [x / total, y / total];
  });
}

// Linear interpolation of `ys` (numbers or [x, y]) over increasing `xs` at `at`, held beyond the ends.
function interpolate(at, xs, ys) {
  let j = 1;
  return at.map((a) => {
    if (a <= xs[0]) return ys[0];
    if (a >= xs[xs.length - 1]) return ys[ys.length - 1];
    while (xs[j] < a) j++;
    const part = (a - xs[j - 1]) / (xs[j] - xs[j - 1]);
    return [0, 1].map((k) => ys[j - 1][k] + (ys[j][k] - ys[j - 1][k]) * part);
  });
}

// Each point moved to a Gaussian average of the path around it, 15 cm wide
// along it, at the same distance along the path (sonore_sketch.paths.smooth_shape).
function smoothShape(points, width) {
  const along = distances(points);
  const length = along[along.length - 1];
  if (!(length > 0 && width > 0)) return points;
  // evenly spaced from end to end, at most SHAPE_STEP apart
  const count = Math.ceil(length / SHAPE_STEP) + 1;
  const grid = Array.from({ length: count }, (_, i) => (length * i) / (count - 1));
  const spacing = grid[1] - grid[0];
  const even = interpolate(grid, along, points);
  // mirrored through each end point, so a straight end stays where it was drawn
  const pad = Math.min(even.length - 1, Math.floor((4 * width) / spacing + 0.5));
  const mirror = (end, k) => [2 * end[0] - even[k][0], 2 * end[1] - even[k][1]];
  const before = Array.from({ length: pad }, (_, i) => mirror(even[0], pad - i));
  const after = Array.from({ length: pad }, (_, i) => mirror(even[even.length - 1], even.length - 2 - i));
  const shape = gaussian([...before, ...even, ...after], width / spacing).slice(pad, pad + even.length);
  return interpolate(along, grid, shape);

}

// The section's stroke, smoothed with its own shape smoothing.
const smoothedPath = (section) => smoothed(section.stroke, section.smoothing ?? SHAPE_SMOOTHING);

// Each point's distance along the path from its start, in meters.
function distances(points) {
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return along;
}

export function pathLength(section) {
  const along = distances(smoothedPath(section).points);
  return along[along.length - 1] ?? 0;
}

// The speed track's breakpoints, [[fraction, speed], ...]: the stored track,
// or the speed the stroke was drawn at, against the fraction of the path
// covered, relative to its average.
export function speedPoints(section) {
  if (section.speed) return section.speed[0].map((fraction, i) => [fraction, section.speed[1][i]]);
  const { times, points } = smoothedPath(section);
  const along = distances(points);
  const length = along[along.length - 1] ?? 0;
  if (!(length > 0)) return [[0, 1], [1, 1]];
  const average = length / times[times.length - 1];
  const drawn = [];
  for (let i = 1; i < points.length; i++) {
    const speed = (along[i] - along[i - 1]) / STEP / average;
    if (speed > 0) drawn.push([(along[i] + along[i - 1]) / 2 / length, Math.log2(clampSpeed(speed))]);
  }
  if (!drawn.length) return [[0, 1], [1, 1]];
  const ends = [[0, drawn[0][1]], ...drawn, [1, drawn[drawn.length - 1][1]]];
  return simplifyLog(ends).map(([fraction, octaves]) => [fraction, 2 ** octaves]);
}

const clampSpeed = (speed) => Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], speed));

function simplifyLog(points) {
  return simplify(points, SPEED_TOLERANCE).map(([fraction, octaves]) => [Number(fraction.toFixed(4)), Number(octaves.toFixed(3))]);
}

// Relative speed at `fraction` of the path, interpolated on a log scale and
// kept at least SLOWEST of the fastest, as sonore_sketch.paths does.
function speedAt(breakpoints, fraction) {
  const octaves = valueAt(breakpoints.map(([f, speed]) => [f, Math.log2(speed)]), fraction);
  const fastest = Math.max(...breakpoints.map(([, speed]) => speed));
  return Math.max(2 ** octaves, SLOWEST * fastest);
}

// The section with the speed track set to `breakpoints` [[fraction, speed],
// ...], kept within the track's range and rescaled so that 1 is the
// average: the duration fixes the average speed, so only the shape counts.
export function withSpeed(section, breakpoints) {
  const clamped = breakpoints.map(([fraction, speed]) => [Math.min(1, Math.max(0, fraction)), clampSpeed(speed)]);
  const tidy = tidyPoints(clamped);
  const samples = 400;
  let slowness = 0; // the mean of 1 / speed over the path, which sets the trip's time
  for (let i = 0; i < samples; i++) slowness += 1 / speedAt(tidy, (i + 0.5) / samples) / samples;
  const scaled = tidy.map(([fraction, speed]) => [fraction, Number((speed * slowness).toPrecision(4))]);
  return { ...section, speed: [scaled.map(([fraction]) => fraction), scaled.map(([, speed]) => speed)] };
}

// The path in page time: [times, points] on the smoothed stroke, as
// sonore_sketch.paths.trajectory makes them before the elevation.
export function timeline(section, duration) {
  const { times, points } = smoothedPath(section);
  if (!points.length) return { times: [], points: [] };
  const along = distances(points);
  const length = along[along.length - 1];
  if (section.speed && length > 0) {
    const breakpoints = speedPoints(section);
    const out = [0];
    for (let i = 1; i < points.length; i++) {
      const middle = (along[i] + along[i - 1]) / 2 / length;
      out.push(out[i - 1] + (along[i] - along[i - 1]) / speedAt(breakpoints, middle));
    }
    return { times: out.map((t) => (t / out[out.length - 1]) * duration), points, along: along.map((d) => d / length) };
  }
  const span = times[times.length - 1];
  if (!(span > 0)) return { times: [0, duration], points: [points[0], points[0]], along: [0, 1] };
  return { times: times.map((t) => (t / span) * duration), points, along: length > 0 ? along.map((d) => d / length) : along.map(() => 0) };
}

// Where the path is at page time `t`, and how far along it, as a fraction.
export function positionAt(path, t) {
  const { times, points, along } = path;
  if (!points.length) return null;
  let i = 1;
  while (i < times.length - 1 && times[i] < t) i++;
  const span = times[i] - times[i - 1];
  const fraction = span > 0 ? Math.min(1, Math.max(0, (t - times[i - 1]) / span)) : 1;
  const mix = (a, b) => a + (b - a) * fraction;
  return { point: [mix(points[i - 1][0], points[i][0]), mix(points[i - 1][1], points[i][1])], along: mix(along[i - 1], along[i]) };
}

// The point `fraction` of the way along the path.
export function pointAlong(path, fraction) {
  const { points, along } = path;
  if (!points.length) return null;
  let i = 1;
  while (i < along.length - 1 && along[i] < fraction) i++;
  const span = along[i] - along[i - 1];
  const part = span > 0 ? Math.min(1, Math.max(0, (fraction - along[i - 1]) / span)) : 1;
  return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * part, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * part];
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
  const { smoothing = SHAPE_SMOOTHING } = state;
  if (!(Number.isFinite(smoothing) && smoothing >= 0 && smoothing <= MAX_SHAPE_SMOOTHING)) {
    throw new Error(`the path's smoothing must be a width from 0 to ${MAX_SHAPE_SMOOTHING} m`);
  }
  const { speed = null } = state;
  if (speed !== null) {
    const valid =
      Array.isArray(speed) && speed.length === 2 && Array.isArray(speed[0]) && Array.isArray(speed[1]) &&
      speed[0].length === speed[1].length && speed[0].length > 0 && speed.flat().every(Number.isFinite) &&
      speed[0].every((fraction) => fraction >= 0 && fraction <= 1) && speed[1].every((value) => value > 0);
    if (!valid) throw new Error("the path's speed must be null or [fractions, speeds]");
  }
  const { elevation } = state;
  if (typeof elevation === "number" && Number.isFinite(elevation)) return state;
  const valid =
    Array.isArray(elevation) && elevation.length === 2 && Array.isArray(elevation[0]) && Array.isArray(elevation[1]) &&
    elevation[0].length === elevation[1].length && elevation[0].length > 0 && elevation.flat().every(Number.isFinite);
  if (!valid) throw new Error("the path's elevation must be a number or [times, degrees]");
  return state;
}
