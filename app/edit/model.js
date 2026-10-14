// The Erase modulation tab's state, its mask and the plane it is painted on
// (docs/design/tabs/edit.md; sonore_sketch.edit is the Python half).
//
// The mask is a grid of cuts in dB, one byte a cell, stored as the
// Draw spectrogram tab stores its painting (base64 of deflated bytes, rows from
// density 0 up): 0 keeps a cell, -floor_db (60) removes it. Its columns are
// 16 per octave of rate from 1 to 64 Hz on each side of the plane, the
// negative side first, with one center column between them for |rate| < 1 Hz.
//
// No DOM here, so this file runs under `node --test`.

export const FORMAT = 1;
export const SOURCES = ["syllables", "speech", "file"];
export const CARRIERS = ["source", "tones", "noise"];
export const MAX_ITERATIONS = 20;
export const RATE_MIN = 1;
export const RATE_MAX = 64;
export const DENSITY_MAX = 6;
export const COLUMNS_PER_OCTAVE = 16;
export const SIDE = COLUMNS_PER_OCTAVE * Math.round(Math.log2(RATE_MAX / RATE_MIN)); // 96
export const COLUMNS = 2 * SIDE + 1; // 193
export const ROWS = 48;
export const DENSITY_STEP = DENSITY_MAX / ROWS; // 0.125
export const FLOOR_DB = -60;
export const COARSE_BELOW_S = 2; // as on the Draw modulation tab: few rates below this
export const MAX_RECORDING_S = 10; // F6: a recording sets the duration, up to the page's limit

// sonore_sketch.edit.EXAMPLE_LEVELS: the "keep rates below 4 Hz" preset the
// tab starts from (E8); tests/test_edit.py and the JS tests check the two agree.
export const EXAMPLE_LEVELS = "eNrtzzEBAAAIAyCDrX8uQ+zwEBqQdKaVYwICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKPAgvrUaBM";

export const DEFAULTS = {
  source: "syllables", carrier: "source", iterations: 5, seed: 1,
  f_lo: 100, f_hi: 6400, bands_per_octave: 12, columns: COLUMNS, rows: ROWS, floor_db: FLOOR_DB,
};

export function defaultSection() {
  return { ...DEFAULTS, levels: EXAMPLE_LEVELS };
}

// --- the grid ---------------------------------------------------------------------

// A column's center rate [Hz]: the negative side, 0 for the center column, the positive side.
export function columnRate(c) {
  if (c === SIDE) return 0;
  const k = c > SIDE ? c - SIDE - 1 : SIDE - 1 - c;
  const magnitude = RATE_MIN * 2 ** ((k + 0.5) / COLUMNS_PER_OCTAVE);
  return c > SIDE ? magnitude : -magnitude;
}

export const rowDensity = (r) => (r + 0.5) * DENSITY_STEP;

// --- presets (E6) ------------------------------------------------------------------

const REMOVED = -FLOOR_DB;

export function blank() {
  return new Uint8Array(ROWS * COLUMNS);
}

// Keep rates below `rate` Hz: cut every faster column.
export function keepBelow(rate) {
  const bytes = blank();
  for (let c = 0; c < COLUMNS; c++) {
    if (Math.abs(columnRate(c)) <= rate) continue;
    for (let r = 0; r < ROWS; r++) bytes[r * COLUMNS + c] = REMOVED;
  }
  return bytes;
}

// Remove the downward (positive rate) or upward (negative rate) sweeps:
// one side of the plane, above the first row (density 0 has no direction).
export function removeSweeps(direction) {
  const bytes = blank();
  for (let c = 0; c < COLUMNS; c++) {
    const rate = columnRate(c);
    if (direction === "down" ? rate <= 0 : rate >= 0) continue;
    for (let r = 1; r < ROWS; r++) bytes[r * COLUMNS + c] = REMOVED;
  }
  return bytes;
}

export function isBlank(bytes) {
  return bytes.every((b) => b === 0);
}

// --- recordings (E1, after the Erase spectrogram design's F1, F3, F6) ---------------

// Mono samples (any range) as 16-bit PCM in base64, scaled so the peak is
// just under full scale; what a page document keeps of a recording.
export function encodePcm16(samples) {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const scale = peak > 0 ? 32767 / peak : 0;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((x, i) => view.setInt16(2 * i, Math.round(x * scale), true));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function pcm16Length(pcm16) {
  const padding = pcm16.endsWith("==") ? 2 : pcm16.endsWith("=") ? 1 : 0;
  return Math.floor(((pcm16.length * 3) / 4 - padding) / 2);
}

export function checkRecording(recording) {
  const { name, fs, pcm16 } = recording ?? {};
  if (typeof name !== "string" || !(fs > 0) || typeof pcm16 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm16)) {
    throw new Error("a recording must have a name, a sampling rate and 16-bit samples in base64");
  }
  return recording;
}

// --- checking --------------------------------------------------------------------

// Raise an Error saying what is wrong with a section from a file or a link
// (the mask itself is checked when decoded); sonore_sketch.edit.check does
// the same in Python.
export function check(state) {
  const { source, carrier, iterations, seed = 1, f_lo, f_hi, bands_per_octave, columns, rows, floor_db, levels } = state;
  if (!SOURCES.includes(source)) throw new Error(`the Erase modulation source must be one of ${SOURCES.join(", ")}`);
  if (!CARRIERS.includes(carrier)) throw new Error(`the Erase modulation carrier must be one of ${CARRIERS.join(", ")}`);
  if (!(Number.isInteger(iterations) && iterations >= 0 && iterations <= MAX_ITERATIONS)) {
    throw new Error(`iterations must be a whole number from 0 to ${MAX_ITERATIONS}`);
  }
  if (!Number.isInteger(seed)) throw new Error("seed must be a whole number");
  if (!(f_lo > 0 && f_hi > f_lo)) throw new Error("the Erase modulation tab's frequency range must have 0 < f_lo < f_hi");
  if (!(Number.isInteger(bands_per_octave) && bands_per_octave >= 1)) throw new Error("bands_per_octave must be a whole number of at least 1");
  if (columns !== COLUMNS || rows !== ROWS || floor_db !== FLOOR_DB) {
    throw new Error(`the Erase modulation mask must be ${COLUMNS} columns x ${ROWS} rows with a floor of ${FLOOR_DB} dB`);
  }
  if (typeof levels !== "string") throw new Error("the Erase modulation mask's levels must be text");
  return state;
}
