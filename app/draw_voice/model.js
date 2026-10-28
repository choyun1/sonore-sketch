// The Draw a voice tab's state (docs/design/tabs/draw_voice.md;
// sonore_sketch.draw_voice is the Python half).
//
// The source and the filter of a voice, drawn separately (S2, S4): the
// pitch, a track in Hz with 0 where it is unvoiced, and the breathiness, the
// share of the power that is noise; and the filter, a curve of level in dB
// at each of a few moments, at N_POINTS frequencies equally spaced on the ERB
// scale (S3), blended between moments by sonore. Times are in seconds (S11).
//
// No DOM here, so this file runs under `node --test`.

import { simplify, valueAt } from "../draw_speech/model.js";
import { SOURCES } from "../quilt_sound/model.js";

export const FORMAT = 1;
export const F0_RANGE = [50, 500]; // Hz, the pitch line's axis; 0 is unvoiced (sonore_sketch.draw_voice.F0_RANGE)
export const DB_RANGE = [-60, 0]; // the filter's axis (S3)
export const N_POINTS = 48;
export const F_RANGE = [50, 8000]; // Hz, the first and last points
export const MAX_BREAKPOINTS = 2000;
export const MAX_MOMENTS = 32;
export const MIN_GAP = 0.01; // s, how close two moments may be
export const BREATHY_START = 0.001; // the starting share of noise (S5)
export { SOURCES }; // S6: the sounds a voice is taken from, as on Quilt a sound (sonore_sketch.draw_voice.SOURCES)
export const DEFAULT_SOURCE = "draw_speech";
const TAKEN_PITCH_TOLERANCE = 1 / 48; // octaves (a quarter of a semitone) a taken pitch line may stray from the measured one
const TAKEN_SHARE_TOLERANCE = 0.02;
const UNVOICE_MARGIN = 0.001; // s: an unvoiced stretch keeps the line's pitch up to this close to its ends

export const erbNumber = (f) => 21.4 * Math.log10(1 + 0.00437 * f);
export const erbFrequency = (e) => (10 ** (e / 21.4) - 1) / 0.00437;
const round = (value, digits) => Number(value.toFixed(digits));

// The filter's frequencies, as sonore_sketch.draw_voice.points() makes them.
export function points() {
  const [low, high] = F_RANGE.map(erbNumber);
  return Array.from({ length: N_POINTS }, (_, i) => round(erbFrequency(low + ((high - low) * i) / (N_POINTS - 1)), 1));
}

// Vowels for the filter's menu: Peterson & Barney's (1952) men's F1-F3 and
// a fourth formant at 3400 Hz, with Klatt's bandwidths.
export const VOWELS = [
  ["a", "ah (father)", [730, 1090, 2440, 3400], [90, 110, 170, 250]],
  ["e", "eh (bed)", [530, 1840, 2480, 3400], [60, 100, 170, 250]],
  ["i", "ee (heed)", [270, 2290, 3010, 3400], [60, 90, 150, 250]],
  ["o", "aw (law)", [570, 840, 2410, 3400], [70, 100, 160, 250]],
  ["u", "oo (who'd)", [300, 870, 2240, 3400], [60, 90, 150, 250]],
];

// A vowel's curve at the filter's frequencies: second-order resonances in
// cascade and, above 200 Hz, a -6 dB per octave slope (source and
// radiation), its peak at 0 dB and held at the axis's floor, to 0.1 dB.
export function vowelCurve(id, f = points()) {
  const [, , formants, widths] = VOWELS.find(([name]) => name === id);
  const db = f.map((frequency) => {
    let level = -6 * Math.log2(Math.max(frequency, 200) / 200);
    formants.forEach((centre, k) => {
      const sigma = Math.PI * widths[k];
      const omega = 2 * Math.PI * centre;
      const w = 2 * Math.PI * frequency;
      // |p p*| / |(jw - p)(jw - p*)| for the pole p = -sigma + j omega
      const gain = (sigma ** 2 + omega ** 2) / Math.hypot(sigma, w - omega) / Math.hypot(sigma, w + omega);
      level += 20 * Math.log10(gain);
    });
    return level;
  });
  const peak = Math.max(...db);
  return db.map((level) => round(Math.max(DB_RANGE[0], level - peak), 1));
}

// The starting voice (S5), for 2 s (app/document.js stretches it to the
// page's duration): ah, ee, oo at 10%, 50% and 90% of it, on a falling pitch
// with a rise in the middle, barely breathy.
export function defaultSection() {
  const duration = 2;
  const at = (fraction) => round(fraction * duration, 4);
  const f = points();
  return {
    f0: [[0, at(0.45), at(0.6), at(1)], [130, 115, 125, 95]],
    breathiness: [[0], [BREATHY_START]],
    filter: { f, moments: [at(0.1), at(0.5), at(0.9)], db: ["a", "i", "u"].map((id) => vowelCurve(id, f)) },
    seed: 1,
  };
}

// --- the source's tracks ---------------------------------------------------------------

// A track's breakpoints, [[t, value], ...].
export const trackPoints = ([times, values]) => times.map((t, i) => [t, values[i]]);

// The breakpoints with one at each end of [0, duration], holding what the
// track holds there, so a stroke in the middle changes only what it passes
// over (`at` reads the track: pitchAt for the pitch).
export function withEnds(breakpoints, duration, at = valueAt) {
  const out = [...breakpoints];
  if (out[0][0] > 0) out.unshift([0, at(breakpoints, 0)]);
  if (out[out.length - 1][0] < duration) out.push([duration, at(breakpoints, duration)]);
  return out;
}

// The section with `name` ("f0" or "breathiness") set to these breakpoints:
// sorted, the last one given at a time kept, times to 0.1 ms, the pitch to
// 0.1 Hz and a share to 0.0001.
export function withTrack(section, name, breakpoints) {
  const clamp = name === "f0" ? (v) => (v === 0 ? 0 : Math.min(F0_RANGE[1], Math.max(F0_RANGE[0], v))) : (v) => Math.min(1, Math.max(0, v));
  const sorted = breakpoints.map(([t, value], order) => [round(Math.max(0, t), 4), round(clamp(value), name === "f0" ? 1 : 4), order]).sort((x, y) => x[0] - y[0] || x[2] - y[2]);
  const tidy = [];
  for (const [t, value] of sorted) {
    if (tidy.length && tidy[tidy.length - 1][0] === t) tidy[tidy.length - 1] = [t, value];
    else tidy.push([t, value]);
  }
  return { ...section, [name]: [tidy.map(([t]) => t), tidy.map(([, value]) => value)] };
}

// The pitch at t: the line, 0 where unvoiced. Between a voiced breakpoint and
// one at 0 the voiced one's pitch is held (sonore_sketch.draw_voice.pitch).
export function pitchAt(breakpoints, t) {
  let after = breakpoints.findIndex(([time]) => time > t);
  if (after === -1) after = breakpoints.length;
  const before = breakpoints[Math.max(0, after - 1)][1];
  const next = breakpoints[Math.min(breakpoints.length - 1, after)][1];
  if (before === 0) return next;
  if (next === 0) return before;
  return valueAt(breakpoints, t);
}

// The voiced stretches of the pitch line, each its breakpoints to draw:
// [[[t, f0], ...], ...], over [0, duration].
export function voicedRuns(breakpoints, duration) {
  const runs = [];
  let run = [];
  const ends = [[0, pitchAt(breakpoints, 0)], ...breakpoints.filter(([t]) => t > 0 && t < duration), [duration, pitchAt(breakpoints, duration)]];
  for (let i = 0; i < ends.length; i++) {
    const [t, value] = ends[i];
    if (value > 0) {
      run.push([t, value]);
      continue;
    }
    // a 0 breakpoint: the run before it holds its last pitch up to here
    if (run.length) runs.push([...run, [t, run[run.length - 1][1]]]);
    run = [];
    const next = ends[i + 1];
    if (next && next[1] > 0) run = [[t, next[1]]];
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1 || r[0][0] < duration);
}

// The pitch line with [t0, t1] unvoiced: 0 breakpoints at its ends, and the
// line's pitch kept just outside them.
export function unvoice(breakpoints, t0, t1) {
  const [a, b] = [Math.min(t0, t1), Math.max(t0, t1)];
  const kept = breakpoints.filter(([t]) => t < a - UNVOICE_MARGIN || t > b + UNVOICE_MARGIN);
  const outside = [];
  const left = pitchAt(breakpoints, a - UNVOICE_MARGIN);
  const right = pitchAt(breakpoints, b + UNVOICE_MARGIN);
  if (a - UNVOICE_MARGIN > 0 && left > 0) outside.push([a - UNVOICE_MARGIN, left]);
  if (right > 0) outside.push([b + UNVOICE_MARGIN, right]);
  return [...kept, ...outside, [a, 0], [b, 0]].sort((x, y) => x[0] - y[0]);
}

// --- the filter's moments and curves ---------------------------------------------------

// The curve at time t: sonore's reading, linear in dB between moments and held beyond them.
export function curveAt(filter, t) {
  const { moments, db } = filter;
  if (t <= moments[0]) return [...db[0]];
  for (let i = 1; i < moments.length; i++) {
    if (t <= moments[i]) {
      const w = (t - moments[i - 1]) / (moments[i] - moments[i - 1]);
      return db[i].map((level, k) => round(db[i - 1][k] + w * (level - db[i - 1][k]), 1));
    }
  }
  return [...db[db.length - 1]];
}

// The section with a moment added at t (its curve what was heard there), and its index;
// null when there is no room (MAX_MOMENTS, or within MIN_GAP of another).
export function addMoment(section, t) {
  const { filter } = section;
  const at = round(t, 4);
  if (filter.moments.length >= MAX_MOMENTS || filter.moments.some((m) => Math.abs(m - at) < MIN_GAP)) return null;
  const index = filter.moments.filter((m) => m < at).length;
  const moments = [...filter.moments.slice(0, index), at, ...filter.moments.slice(index)];
  const db = [...filter.db.slice(0, index), curveAt(filter, at), ...filter.db.slice(index)];
  return { section: { ...section, filter: { ...filter, moments, db } }, index };
}

// The section without moment i (the last one stays).
export function removeMoment(section, i) {
  const { filter } = section;
  if (filter.moments.length <= 1) return section;
  return { ...section, filter: { ...filter, moments: filter.moments.filter((_, k) => k !== i), db: filter.db.filter((_, k) => k !== i) } };
}

// Moment i moved to t, kept MIN_GAP from its neighbours and within [0, duration].
export function moveMoment(section, i, t, duration) {
  const { moments } = section.filter;
  const low = i ? moments[i - 1] + MIN_GAP : 0;
  const high = i < moments.length - 1 ? moments[i + 1] - MIN_GAP : duration;
  const at = round(Math.min(high, Math.max(low, t)), 4);
  return { ...section, filter: { ...section.filter, moments: moments.map((m, k) => (k === i ? at : m)) } };
}

// The section with moment i's curve set.
export function withCurve(section, i, curve) {
  const clamped = curve.map((level) => round(Math.min(DB_RANGE[1], Math.max(DB_RANGE[0], level)), 1));
  return { ...section, filter: { ...section.filter, db: section.filter.db.map((c, k) => (k === i ? clamped : c)) } };
}

// A curve drawn over from one pointer position to the next, each [ERB-number, dB]:
// the points between them are set on the straight line joining the two.
export function drawOnCurve(curve, f, from, to) {
  const [[e0, d0], [e1, d1]] = from[0] <= to[0] ? [from, to] : [to, from];
  return curve.map((level, k) => {
    const e = erbNumber(f[k]);
    if (e < e0 || e > e1) return level;
    const w = e1 === e0 ? 1 : (e - e0) / (e1 - e0);
    return round(Math.min(DB_RANGE[1], Math.max(DB_RANGE[0], d0 + w * (d1 - d0))), 1);
  });
}

// The index of the curve point nearest ERB-number e (a single click sets that one).
export function nearestPointIndex(f, e) {
  let best = 0;
  f.forEach((frequency, k) => {
    if (Math.abs(erbNumber(frequency) - e) < Math.abs(erbNumber(f[best]) - e)) best = k;
  });
  return best;
}

// --- the page's duration ---------------------------------------------------------------

// The section after the page's duration changes: every time stretches with it.
export function stretchSection(section, from, to) {
  const factor = to / from;
  const scale = ([times, values]) => [times.map((t) => round(t * factor, 4)), values];
  return {
    ...section,
    f0: scale(section.f0),
    breathiness: scale(section.breathiness),
    filter: { ...section.filter, moments: section.filter.moments.map((t) => round(t * factor, 4)) },
  };
}

// --- checking --------------------------------------------------------------------------

function checkTrack(state, name, [low, high], zero) {
  const track = state[name];
  const valid = Array.isArray(track) && track.length === 2 && Array.isArray(track[0]) && Array.isArray(track[1]) &&
    track[0].length === track[1].length && track[0].length > 0 && track[0].length <= MAX_BREAKPOINTS && track.flat().every(Number.isFinite);
  if (!valid) throw new Error(`the voice's ${name} must be [times, values], 1 to ${MAX_BREAKPOINTS} numbers`);
  if (track[0].some((t, i) => i && t <= track[0][i - 1])) throw new Error(`the ${name} track's times must increase`);
  if (!track[1].every((v) => (v >= low && v <= high) || (zero && v === 0))) throw new Error(`the voice's ${name} must stay from ${low} to ${high}${zero ? " (or 0, unvoiced)" : ""}`);
}

// Raise an Error saying what is wrong with a state from a file or a link;
// sonore_sketch.draw_voice.check checks the same.
export function check(state) {
  if (!state || state.draw_voice !== FORMAT) throw new Error(`not a Draw a voice state of format ${FORMAT}`);
  checkTrack(state, "f0", F0_RANGE, true);
  checkTrack(state, "breathiness", [0, 1], false);
  const { f, moments, db } = state.filter ?? {};
  if (!(Array.isArray(f) && f.length >= 2 && f.length <= 512 && f.every((v, i) => Number.isFinite(v) && v > 0 && (!i || v > f[i - 1])))) {
    throw new Error("the filter's frequencies must be 2 to 512 increasing numbers above 0 Hz");
  }
  if (!(Array.isArray(moments) && moments.length >= 1 && moments.length <= MAX_MOMENTS && moments.every((t, i) => Number.isFinite(t) && (!i || t > moments[i - 1])))) {
    throw new Error(`the filter's moments must be 1 to ${MAX_MOMENTS} increasing times`);
  }
  if (!(Array.isArray(db) && db.length === moments.length && db.every((curve) => Array.isArray(curve) && curve.length === f.length &&
    curve.every((level) => Number.isFinite(level) && level >= DB_RANGE[0] && level <= DB_RANGE[1])))) {
    throw new Error(`the filter needs one curve of ${f.length} levels from ${DB_RANGE[0]} to ${DB_RANGE[1]} dB per moment`);
  }
  if (!(Number.isInteger(state.seed) && state.seed >= 0)) throw new Error("the voice's seed must be a whole number from 0 up");
  if (state.source !== undefined && !SOURCES.includes(state.source)) throw new Error(`the Draw a voice source must be one of ${SOURCES.join(", ")}`);
  return state;
}

// What Clear leaves (app/document.js, clearTab): a steady 100 Hz, barely
// breathy, and one flat curve in the middle of the filter's axis.
export function clearedSection(section, duration) {
  const f = section.filter.f;
  return {
    ...section,
    f0: [[0], [100]],
    breathiness: [[0], [BREATHY_START]],
    filter: { f, moments: [round(duration / 2, 4)], db: [f.map(() => (DB_RANGE[0] + DB_RANGE[1]) / 2)] },
  };
}

// The pitch line with a stroke drawn over it ([[t, Hz], ...], sorted): the
// stroke replaces what it passes over, and an unvoiced stretch it starts or
// ends inside stays unvoiced up to it.
export function drawPitch(breakpoints, stroke) {
  const [t0, t1] = [stroke[0][0], stroke[stroke.length - 1][0]];
  const kept = breakpoints.filter(([t]) => t < t0 || t > t1);
  const edges = [];
  if (t0 - UNVOICE_MARGIN > 0 && pitchAt(breakpoints, t0) === 0) edges.push([t0 - UNVOICE_MARGIN, 0]);
  if (pitchAt(breakpoints, t1) === 0) edges.push([t1 + UNVOICE_MARGIN, 0]);
  return [...kept.filter(([t]) => !edges.some(([e]) => Math.abs(e - t) < UNVOICE_MARGIN / 2)), ...edges, ...stroke].sort((x, y) => x[0] - y[0]);
}

// --- taken from a sound (S6) -----------------------------------------------------------
//
// A measured voice (sonore_sketch.draw_voice.measure_steps) holds, every 5 ms
// (t): the pitch (f0, 0 where unvoiced), the share of noise (breathiness) and
// the filter's curve (db, at the frequencies f).

// Breakpoints simplified within `tolerance`, the tolerance doubled until they
// fit MAX_BREAKPOINTS.
function simplified(stroke, tolerance) {
  let out = simplify(stroke, tolerance);
  for (let k = 2; out.length > MAX_BREAKPOINTS; k *= 2) out = simplify(stroke, tolerance * k);
  return out;
}

// The runs of a measured pitch, [first, last, voiced], with the runs shorter
// than `shortest` windows taken into the run before them.
function voicingRuns(f0, shortest) {
  const runs = [];
  for (let i = 0; i < f0.length; ) {
    let j = i;
    while (j + 1 < f0.length && f0[j + 1] > 0 === f0[i] > 0) j++;
    const last = runs[runs.length - 1];
    if (last && (j - i + 1 < shortest || last[2] === f0[i] > 0)) last[1] = j;
    else runs.push([i, j, f0[i] > 0]);
    i = j + 1;
  }
  return runs;
}

// The pitch line of a measured voice: each voiced run simplified,
// each unvoiced run 0 at its first and last window. A line too long for
// MAX_BREAKPOINTS is simplified more loosely, then its shortest runs merged.
export function takenPitch({ t, f0 }) {
  if (!f0.some((v) => v > 0)) return [[t[0], 0], [t[t.length - 1], 0]];
  for (let shortest = 1; ; shortest *= 2) {
    const runs = voicingRuns(f0, shortest);
    for (let k = 1; k <= 64; k *= 2) {
      const line = runs.flatMap(([i, j, voiced]) => {
        if (!voiced) return j > i ? [[t[i], 0], [t[j], 0]] : [[t[i], 0]];
        // the run's own voiced windows (a merged run may hold unvoiced ones),
        // in Hz as sonore reads them, within the tolerance at the run's lowest pitch
        const run = [];
        for (let n = i; n <= j; n++) if (f0[n] > 0) run.push([t[n], f0[n]]);
        const lowest = Math.min(...run.map(([, v]) => v));
        return simplify(run, lowest * (2 ** (TAKEN_PITCH_TOLERANCE * k) - 1));
      });
      if (line.length <= MAX_BREAKPOINTS) return line;
    }
  }
}

// The breathiness of a measured voice: where it is unvoiced (all noise when
// heard) the share is drawn straight across from the voiced windows either side.
export function takenBreathiness({ t, f0, breathiness }) {
  const voiced = t.map((time, i) => [time, breathiness[i]]).filter((_, i) => f0[i] > 0);
  if (!voiced.length) return [[t[0], BREATHY_START]];
  return simplified(voiced, TAKEN_SHARE_TOLERANCE);
}

// The section with its source (pitch and breathiness) taken from a measured voice.
export function withTakenSource(section, voice) {
  return withTrack(withTrack(section, "f0", takenPitch(voice)), "breathiness", takenBreathiness(voice));
}

// The index of the measured window nearest t.
export function nearestWindow(voice, t) {
  let nearest = 0;
  voice.t.forEach((time, i) => {
    if (Math.abs(time - t) < Math.abs(voice.t[nearest] - t)) nearest = i;
  });
  return nearest;
}

// The measured voice's filter at the window nearest t, at the frequencies
// `f` (read linearly in dB over the ERB scale, held beyond its ends).
export function measuredCurve(voice, t, f) {
  const curve = voice.db[nearestWindow(voice, t)];
  const e = voice.f.map(erbNumber);
  return f.map((frequency) => {
    const at = erbNumber(frequency);
    if (at <= e[0]) return curve[0];
    const k = e.findIndex((value) => value >= at);
    if (k === -1) return curve[curve.length - 1];
    const w = (at - e[k - 1]) / (e[k] - e[k - 1]);
    return curve[k - 1] + w * (curve[k] - curve[k - 1]);
  });
}

// The section with moment i's curve copied from a measured voice, at that moment.
export function withCopiedCurve(section, i, voice) {
  return withCurve(section, i, measuredCurve(voice, section.filter.moments[i], section.filter.f));
}
