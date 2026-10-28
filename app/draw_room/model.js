// The Draw a room tab's state (docs/design/tabs/draw_room.md;
// sonore_sketch.draw_room is the Python half).
//
// A room is its RT60 curve: how long it rings, in seconds, at each of
// N_POINTS frequencies equally spaced on a log axis from 50 Hz to 8 kHz (R3,
// R11), drawn freehand on a log RT60 axis. With it go the source heard in
// the room (R5), the direct sound against the room's (R6) and the seed of
// the room's noise (R10).
//
// No DOM here, so this file runs under `node --test`.

import { LABELS as QUILT_LABELS } from "../quilt_sound/model.js";

export const FORMAT = 1;
export const N_POINTS = 64;
export const F_RANGE = [50, 8000]; // Hz, the first and last points
export const RT60_RANGE = [0.1, 10]; // s, the curve's axis
export const DRR_RANGE = [-20, 20]; // dB (sonore_sketch.draw_room.DRR_RANGE)
export const START_RT60 = 1; // s, the room the tab opens on (R4)

// A clap, then Quilt a sound's sources (R5): sounds made here, the tabs' sounds, a file.
export const LABELS = { clap: "A clap", ...QUILT_LABELS };
export const SOURCES = Object.keys(LABELS);

const round = (value, digits) => Number(value.toFixed(digits));
const clampRt60 = (value) => round(Math.min(RT60_RANGE[1], Math.max(RT60_RANGE[0], value)), 3);

// The curve's frequencies, as sonore_sketch.draw_room.points() makes them.
export function points() {
  const [low, high] = F_RANGE.map(Math.log);
  return Array.from({ length: N_POINTS }, (_, i) => round(Math.exp(low + ((high - low) * i) / (N_POINTS - 1)), 1));
}

// sonore's real rooms (band_rt60s, profile "ecological"; Traer & McDermott,
// 2016): at each of the fit's frequencies, log10 of the band's RT60 is
// SLOPE * log10(the room's RT60) + INTERCEPT, read between them linearly in
// frequency and in seconds, as sonore reads them. tests/test_draw_room.py
// checks this table against sonore.
const FIT_F = [
  20, 52.53452073, 89.32266484, 130.9205589, 177.9570386, 231.1431546, 291.2829217, 359.2854732, 436.1788039, 523.1253109, 621.4393649,
  732.6071801, 858.309281, 1000.445907, 1161.165738, 1342.898377, 1548.391078, 1780.750274, 2043.48854, 2340.577694, 2676.508832,
  3056.360229, 3485.8741, 3971.543408, 4520.710019, 5141.675688, 5843.827557, 6637.78006, 7535.535381, 8550.664891,
];
const FIT_SLOPE = [
  -0.1245416457, 0.9148902294, 1.013118959, 1.069421357, 1.098513902, 1.10869094, 1.108344942, 1.116670271, 1.123222944, 1.122437119,
  1.115662305, 1.105856167, 1.090074105, 1.066017356, 1.040058539, 1.020107203, 1.010525312, 1.000367407, 0.9828518543, 0.9622009718,
  0.9381557076, 0.9113659806, 0.8825565121, 0.8549946712, 0.8348950939, 0.7746798008, 0.6635433819, 0.5893045427, 0.5473088723, 0.4814735842,
];
const FIT_INTERCEPT = [
  -0.4075845181, -0.08755363867, -0.03077867102, 0.01137709471, 0.04099871701, 0.05900899492, 0.07023252645, 0.08041977324, 0.08686232352,
  0.09006023641, 0.09142489181, 0.09111601412, 0.08789729932, 0.08019029099, 0.06918402021, 0.05842367025, 0.04942513933, 0.03898892003,
  0.02590483879, 0.01136123398, -0.005963473582, -0.02690493327, -0.04989381739, -0.07330266891, -0.1022897703, -0.1645816298,
  -0.2624395635, -0.3531859729, -0.4345192386, -0.529957714,
];

function interpolate(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let k = 1;
  while (xs[k] < x) k += 1;
  const w = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return ys[k - 1] + w * (ys[k] - ys[k - 1]);
}

// A real room's RT60 at frequencies `f`, for a room of `rt60` seconds (unrounded).
export function realRoom(rt60, f = points()) {
  const atFit = FIT_SLOPE.map((slope, k) => 10 ** (slope * Math.log10(rt60) + FIT_INTERCEPT[k]));
  return f.map((frequency) => interpolate(frequency, FIT_F, atFit));
}

// The curve's median RT60: the number in the RT60 box (R4).
export function median(curve) {
  const sorted = [...curve].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// `curve` scaled so that its median is `rt60`, held on the axis.
export function scaledTo(curve, rt60) {
  const factor = rt60 / median(curve);
  return curve.map((value) => clampRt60(value * factor));
}

// The rooms "Start from" draws (R4), each with its median at `rt60`: a real
// room, the same RT60 everywhere, or a real room upside down (sonore's
// "inverted": max + min - real, slow where real rooms are fast).
export const STARTS = {
  real: "A real room",
  flat: "Flat",
  inverted: "A real room, inverted",
};

export function startCurve(kind, rt60) {
  const real = realRoom(rt60);
  if (kind === "flat") return points().map(() => clampRt60(rt60));
  if (kind === "inverted") {
    const [low, high] = [Math.min(...real), Math.max(...real)];
    return scaledTo(real.map((value) => high + low - value), rt60);
  }
  if (kind === "real") return scaledTo(real, rt60);
  throw new Error(`unknown room ${kind}`);
}

export function defaultSection() {
  return { source: "syllables", rt60: startCurve("real", START_RT60), drr_db: 0, seed: 1 };
}

// Clear (document.js): the curve goes flat at its median, a blank to draw on.
export function clearedSection(section) {
  return { ...section, rt60: startCurve("flat", round(median(section.rt60), 3)) };
}

// A curve drawn over from one pointer position to the next, each [log
// frequency, log RT60]: the points between them are set on the straight
// line joining the two.
export function drawOnCurve(curve, f, from, to) {
  const [[x0, y0], [x1, y1]] = from[0] <= to[0] ? [from, to] : [to, from];
  return curve.map((value, k) => {
    const x = Math.log(f[k]);
    if (x < x0 || x > x1) return value;
    const w = x1 === x0 ? 1 : (x - x0) / (x1 - x0);
    return clampRt60(Math.exp(y0 + w * (y1 - y0)));
  });
}

// The index of the point nearest log frequency x (a single click sets that one).
export function nearestPointIndex(f, x) {
  let best = 0;
  f.forEach((frequency, k) => {
    if (Math.abs(Math.log(frequency) - x) < Math.abs(Math.log(f[best]) - x)) best = k;
  });
  return best;
}

// `section` with a new curve, each RT60 held on the axis.
export function withCurve(section, curve) {
  return { ...section, rt60: curve.map(clampRt60) };
}

// Raise an Error saying what is wrong with a section from a file or a link;
// sonore_sketch.draw_room.check does the same in Python.
export function check(state) {
  const { source, rt60, drr_db: drr, seed } = state;
  if (!SOURCES.includes(source)) throw new Error(`the Draw a room source must be one of ${SOURCES.join(", ")}`);
  const [low, high] = RT60_RANGE;
  if (!(Array.isArray(rt60) && rt60.length === N_POINTS && rt60.every((v) => Number.isFinite(v) && v >= low && v <= high))) {
    throw new Error(`rt60 must be ${N_POINTS} RT60s from ${low} to ${high} s`);
  }
  if (!(Number.isFinite(drr) && drr >= DRR_RANGE[0] && drr <= DRR_RANGE[1])) throw new Error(`drr_db must be from ${DRR_RANGE[0]} to ${DRR_RANGE[1]} dB`);
  if (!(Number.isInteger(seed) && seed >= 0)) throw new Error("seed must be a whole number from 0 up");
  return state;
}
