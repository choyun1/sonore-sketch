// The Draw modulation tab's state, the plane it is drawn on, and the picture of
// the drawing (docs/design/tabs/draw_modulation.md; sonore_sketch.draw_modulation is the Python
// half).
//
// A blob is sonore's ModulationBlob: a Gaussian bump of power centered on a
// rate [Hz, signed: positive sweeps down, negative up] and a density
// [cycles/octave], with a standard deviation in octaves of rate and one in
// cycles/octave, and a peak level [dB] relative to the other blobs.
//
// No DOM here, so this file runs under `node --test`.

import { replaceSpan, simplify } from "../draw_speech/model.js";

export const FORMAT = 1;
export const CARRIERS = ["tones", "harmonic", "noise"];
export const BLOB_LEVEL_MIN = -40; // dB, as the Level field allows (sonore_sketch.draw_modulation.BLOB_LEVELS)
export const MAX_BLOBS = 8;
export const ENV_FS = 1000; // sonore's envelope rate for from_blobs

export const DEFAULTS = {
  f_lo: 100, f_hi: 6400, bands_per_octave: 12,
  carrier: "tones", f0: 100, iterations: 0, rms_depth: 0.2, seed: 1,
};
// A new blob's widths and level (B2).
export const NEW_BLOB = { rate_width: 0.5, density_width: 0.25, level: 0 };
// sonore_sketch.draw_modulation.EXAMPLE_ITEMS: one blob near the origin, rate and
// density both positive; tests/test_draw_modulation.py checks the two agree.
export const EXAMPLE_ITEMS = [
  { rate: 2, density: 0.5, rate_width: 0.5, density_width: 0.25, level: 0 },
];

// The plane shown (B1): rate on a signed log axis from 1 to 64 Hz each side,
// density linear from 0 to 6 cycles/octave.
export const RATE_MIN = 1;
export const RATE_MAX = 64;
export const DENSITY_MAX = 6;
export const WIDTH_MIN = 0.05;
export const WIDTH_MAX = 3;
export const COARSE_BELOW_S = 2; // B8: a note on this tab below this duration

// The example's one band: two octaves round 500 Hz (about 250-1000 Hz), so
// the first sound is low and soft rather than spread up to 6.4 kHz.
export const EXAMPLE_BAND = { points: [[0, 500]], width: 2, level: 0 };

export function defaultSection() {
  return { ...DEFAULTS, items: EXAMPLE_ITEMS.map((item) => ({ ...item })), bands: [structuredClone(EXAMPLE_BAND)] };
}

// --- the grid the drawing is heard on --------------------------------------------

// The rates and densities sonore's from_blobs puts the drawing on (and the
// result's analysis measures): rate steps of 1/duration Hz (the envelopes'
// length at 1000 Hz), and density steps of 1 / (bands x octaves per band),
// from 0 up to half the bands' rate.
export function grid({ duration, f_lo, f_hi, bands_per_octave }) {
  const nTimes = Math.round(duration * ENV_FS);
  const nBands = Math.round(Math.log2(f_hi / f_lo) * bands_per_octave) - 1; // the filterbank's bands, less its two edges
  const densityStep = bands_per_octave / nBands;
  const nDensities = Math.ceil(nBands / 2);
  return { rateStep: ENV_FS / nTimes, nTimes, densityStep, densities: Array.from({ length: nDensities }, (_, index) => index * densityStep) };
}

// One blob's power at (atRate, atDensity), zero on the other side of the
// rate axis (ModulationBlob.power).
export function blobPower({ rate, density, rate_width, density_width, level }, atRate, atDensity) {
  if (Math.sign(atRate) !== Math.sign(rate)) return 0;
  const octaves = Math.log2(Math.abs(atRate) / Math.abs(rate));
  return 10 ** (level / 10) * Math.exp(-(octaves ** 2) / (2 * rate_width ** 2) - (atDensity - density) ** 2 / (2 * density_width ** 2));
}

// The drawing's power at (rate, density): the blobs' sum, made the same at
// (-rate, -density), as from_blobs does, since a real envelope's spectrum is.
export function power(items, rate, density) {
  let total = 0;
  for (const blob of items) total += blobPower(blob, rate, density) + blobPower(blob, -rate, -density);
  return total / 2;
}

// --- the plane's rate axis ---------------------------------------------------------

// Where a rate sits on the signed log axis, from -1 (-RATE_MAX) through the
// seam at 0 (±RATE_MIN) to 1 (RATE_MAX). Rates nearer 0 than RATE_MIN sit
// on the seam.
export function rateToUnit(rate) {
  const span = Math.log2(RATE_MAX / RATE_MIN);
  const unit = Math.min(1, Math.max(0, Math.log2(Math.max(Math.abs(rate), RATE_MIN) / RATE_MIN) / span));
  return rate < 0 ? -unit : unit;
}

// The rate at a place on the axis (the inverse of rateToUnit); 0 is taken
// as the positive side's RATE_MIN.
export function unitToRate(unit) {
  const magnitude = RATE_MIN * 2 ** (Math.min(1, Math.abs(unit)) * Math.log2(RATE_MAX / RATE_MIN));
  return unit < 0 ? -magnitude : magnitude;
}

// A blob's rate kept on the plane: 1 to 64 Hz in size, on its own side.
export function clampRate(rate) {
  const magnitude = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.abs(rate)));
  return rate < 0 ? -magnitude : magnitude;
}

export function clampDensity(density) {
  return Math.min(DENSITY_MAX, Math.max(0, density));
}

export function clampWidth(width) {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width));
}

// Numbers as saved: two decimals are finer than any blob's width.
export const tidy = (number) => Math.round(number * 100) / 100;

// --- sonore's refusals -----------------------------------------------------------

// The depth sonore says fits, from its refusal of a deeper one
// ("... at most 0.342 fits it ..."), or null.
export function depthThatFits(message) {
  const match = /at most ([0-9]*\.?[0-9]+) fits/.exec(message ?? "");
  return match ? Number(match[1]) : null;
}

// --- bands (docs/design/tabs/bands.md) ---------------------------------------------

// A band confines the sound to a region of the spectrogram: a center track
// of [time s, Hz] points (interpolated in log frequency, held past its ends),
// a width in octaves and a level in dB. sonore_sketch.draw_modulation.band_gain is the
// filter itself; the page only draws where the bands are.
export const MAX_BANDS = 5;
export const BAND_WIDTH_MIN = 1 / 6;
export const BAND_WIDTH_MAX = 4;
export const BAND_LEVEL_MIN = -40;
export const BAND_SKIRT = 1 / 6; // octaves of raised-cosine edge on each side
// Where "Add band" puts a new, flat band: the first of these not already inside one.
const NEW_BAND_CENTERS = [500, 2000, 1000, 4000, 250, 3000, 700, 1400];

export function bandCenter(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, f1] = points[i];
    if (t <= t1) {
      const [t0, f0] = points[i - 1];
      return 2 ** (Math.log2(f0) + ((t - t0) / (t1 - t0)) * (Math.log2(f1) - Math.log2(f0)));
    }
  }
  return points[points.length - 1][1];
}

export function newBand(bands, duration) {
  const inside = (f) => bands.some((band) => [0, duration / 2, duration].some((t) => Math.abs(Math.log2(f / bandCenter(band.points, t))) <= band.width / 2));
  const center = NEW_BAND_CENTERS.find((f) => !inside(f)) ?? 1000;
  return { points: [[0, center], [Math.min(duration, tidyTime(duration)), center]], width: 1, level: 0 };
}

export const clampBandWidth = (width) => Math.min(BAND_WIDTH_MAX, Math.max(BAND_WIDTH_MIN, width));
export const clampBandLevel = (level) => Math.min(0, Math.max(BAND_LEVEL_MIN, level));
// Times to the millisecond, centers to the hertz, as saved.
export const tidyTime = (t) => Math.round(t * 1000) / 1000;
export const tidyHz = (f) => Math.round(f);

// A Line or Freehand stroke [[t, Hz], ...] laid onto a band's points (or
// onto none, for a new band): the stroke, simplified in octaves, replaces
// the points within its span, as the Draw speech tab's tools do.
export const STROKE_TOLERANCE_OCT = 0.04;
export function strokeOnto(points, stroke) {
  const inOctaves = stroke.map(([t, f]) => [tidyTime(t), Math.log2(f)]);
  const span = simplify(inOctaves, STROKE_TOLERANCE_OCT).map(([t, octave]) => [t, tidyHz(2 ** octave)]);
  const merged = points?.length ? replaceSpan(points, span) : span;
  const tidied = [];
  for (const point of merged) {
    if (tidied.length && point[0] <= tidied[tidied.length - 1][0]) tidied[tidied.length - 1] = point;
    else tidied.push(point);
  }
  return tidied;
}

// Every band's times scaled to a new duration (the page's length changed).
export function stretchBands(bands, from, to) {
  if (!bands?.length || !(from > 0)) return bands;
  return bands.map((band) => {
    const points = [];
    for (const [t, f] of band.points) {
      const next = Math.min(to, tidyTime((t / from) * to));
      if (!points.length || next > points[points.length - 1][0]) points.push([next, f]);
    }
    return { ...band, points };
  });
}

// --- checking --------------------------------------------------------------------

const ITEM_KEYS = ["rate", "density", "rate_width", "density_width", "level"];

// Raise an Error saying what is wrong with a section from a file or a link;
// sonore_sketch.draw_modulation.check does the same in Python (with the page's fs).
export function check(state) {
  const { f_lo, f_hi, bands_per_octave, carrier, f0 = 100, iterations, rms_depth, seed, items } = state;
  if (!(f_lo > 0 && f_hi > f_lo)) throw new Error("the modulation tab's frequency range must have 0 < f_lo < f_hi");
  if (!(Number.isInteger(bands_per_octave) && bands_per_octave >= 1)) throw new Error("bands_per_octave must be a whole number of at least 1");
  if (!CARRIERS.includes(carrier)) throw new Error(`the modulation carrier must be one of ${CARRIERS.join(", ")}`);
  if (carrier === "harmonic" && !(f0 >= 20 && f0 <= f_hi)) throw new Error("f0 must be from 20 Hz up to f_hi for the harmonic carrier");
  if (!(Number.isInteger(iterations) && iterations >= 0 && iterations <= 10)) throw new Error("iterations must be a whole number from 0 to 10");
  if (!(rms_depth > 0 && rms_depth <= 1)) throw new Error("rms_depth must be in (0, 1]");
  if (!Number.isInteger(seed)) throw new Error("seed must be a whole number");
  if (!Array.isArray(items) || items.length > MAX_BLOBS) throw new Error(`items must be a list of at most ${MAX_BLOBS} blobs`);
  items.forEach((item, i) => {
    if (!ITEM_KEYS.every((key) => Number.isFinite(item?.[key]))) throw new Error(`blob ${i + 1} must give a number for each of ${ITEM_KEYS.join(", ")}`);
    if (item.rate === 0 || item.rate_width <= 0 || item.density_width <= 0) throw new Error(`blob ${i + 1} needs a nonzero rate and positive widths`);
    if (!(item.level >= BLOB_LEVEL_MIN && item.level <= 0)) throw new Error(`blob ${i + 1}'s level must be from ${BLOB_LEVEL_MIN} to 0 dB`);
  });
  const { bands = [], duration } = state;
  if (!Array.isArray(bands) || bands.length > MAX_BANDS) throw new Error(`bands must be a list of at most ${MAX_BANDS} bands`);
  bands.forEach((band, i) => {
    const { points, width, level = 0 } = band ?? {};
    if (!(width >= BAND_WIDTH_MIN - 1e-9 && width <= BAND_WIDTH_MAX)) throw new Error(`band ${i + 1}'s width must be from 1/6 to ${BAND_WIDTH_MAX} octaves`);
    if (!(level >= BAND_LEVEL_MIN && level <= 0)) throw new Error(`band ${i + 1}'s level must be from ${BAND_LEVEL_MIN} to 0 dB`);
    if (!Array.isArray(points) || !points.length || !points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
      throw new Error(`band ${i + 1} needs a list of [time, Hz] points`);
    }
    if (points.some(([t], index) => t < 0 || (duration !== undefined && t > duration + 1e-9) || (index > 0 && t <= points[index - 1][0]))) {
      throw new Error(`band ${i + 1}'s times must increase, within the duration`);
    }
    if (points.some(([, f]) => f < f_lo || f > f_hi)) throw new Error(`band ${i + 1}'s center must stay within ${f_lo}-${f_hi} Hz`);
  });
  return state;
}
