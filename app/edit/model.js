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

import { SOURCES } from "../sources.js";

export const FORMAT = 1;
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
export function columnRate(column) {
  if (column === SIDE) return 0;
  const fromCenter = column > SIDE ? column - SIDE - 1 : SIDE - 1 - column; // columns out from the center one
  const magnitude = RATE_MIN * 2 ** ((fromCenter + 0.5) / COLUMNS_PER_OCTAVE);
  return column > SIDE ? magnitude : -magnitude;
}

export const rowDensity = (row) => (row + 0.5) * DENSITY_STEP;

// --- presets (E6) ------------------------------------------------------------------

const REMOVED = -FLOOR_DB;

export function blank() {
  return new Uint8Array(ROWS * COLUMNS);
}

// Keep rates below `rate` Hz: cut every faster column.
export function keepBelow(rate) {
  const bytes = blank();
  for (let column = 0; column < COLUMNS; column++) {
    if (Math.abs(columnRate(column)) <= rate) continue;
    for (let row = 0; row < ROWS; row++) bytes[row * COLUMNS + column] = REMOVED;
  }
  return bytes;
}

// Remove the downward (positive rate) or upward (negative rate) sweeps:
// one side of the plane, above the first row (density 0 has no direction).
export function removeSweeps(direction) {
  const bytes = blank();
  for (let column = 0; column < COLUMNS; column++) {
    const rate = columnRate(column);
    if (direction === "down" ? rate <= 0 : rate >= 0) continue;
    for (let row = 1; row < ROWS; row++) bytes[row * COLUMNS + column] = REMOVED;
  }
  return bytes;
}

export function isBlank(bytes) {
  return bytes.every((cut) => cut === 0);
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
