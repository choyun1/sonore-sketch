// The Draw spectrogram tab's state and the brush that edits it
// (docs/design/tabs/painted.md; sonore_sketch.painted is the Python half).
//
// The painting is a grid of bytes, rows from f_lo up and columns from time 0,
// row after row. A byte is the cell's level in dB below 0 dB; -floor_db (60)
// and above is silence. In a state the grid is `levels`: base64 of the bytes
// deflated (zlib format, which Python's zlib reads). Deflating is
// asynchronous in the browser, so the tab keeps the bytes and encodes them
// only when a stroke ends.
//
// No DOM here, so this file runs under `node --test`.

export const FORMAT = 1;

export const DEFAULTS = {
  f_lo: 100, f_hi: 6400, rows_per_octave: 12, columns: 256, floor_db: -60,
  carrier: "harmonic", f0: 50, seed: 1,
};
export const CARRIERS = ["tones", "harmonic", "noise"];
// The most cells a painting may hold (sonore_sketch.painted.MAX_CELLS): the
// page's own grid is 72 x 256, and a file or link asking for more is refused
// before anything that size is made.
export const MAX_CELLS = 1 << 20;

// sonore_sketch.painted.encode_levels(example_levels()): "sonore" written by
// hand, 180 Hz to 1.4 kHz, on the harmonic carrier at 50 Hz (P7). tests/test_painted.py checks the two agree.
export const EXAMPLE_LEVELS =
  "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";

// The tab's section of a new page document (document.js).
export function defaultSection() {
  return { ...DEFAULTS, levels: EXAMPLE_LEVELS };
}

export function rows({ f_lo, f_hi, rows_per_octave }) {
  return Math.max(2, Math.round(Math.log2(f_hi / f_lo) * rows_per_octave));
}

export function octaves({ f_lo, f_hi }) {
  return Math.log2(f_hi / f_lo);
}

// --- levels: bytes <-> text ------------------------------------------------------

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// `bytes` through a compression stream; with `limit`, it stops and throws as
// soon as the output would be longer, so a small text cannot inflate to fill
// the memory.
async function through(stream, bytes, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new RangeError(`more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function encodeLevels(bytes) {
  return toBase64(await through(new CompressionStream("deflate"), bytes));
}

// The bytes of `levels`, checked against the grid's size.
export async function decodeLevels(text, size) {
  let bytes;
  try {
    bytes = await through(new DecompressionStream("deflate"), Uint8Array.from(atob(text), (c) => c.charCodeAt(0)), size);
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`the painting holds more than ${size} cells`);
    throw new Error("the painting's levels are not base64 of deflated bytes");
  }
  if (bytes.length !== size) throw new Error(`the painting holds ${bytes.length} cells, not ${size}`);
  return bytes;
}

// Grids already decoded (a painting, or an Erase tab's mask), by their
// levels, so undo and redo are instant: the newest `limit` are kept.
export class LevelCache {
  constructor(limit) {
    this.limit = limit;
    this.decoded = new Map();
  }

  get(levels) {
    return this.decoded.get(levels);
  }

  remember(levels, bytes) {
    this.decoded.delete(levels);
    this.decoded.set(levels, bytes);
    if (this.decoded.size > this.limit) this.decoded.delete(this.decoded.keys().next().value);
  }

  // `bytes` as levels, kept.
  async encode(bytes) {
    const levels = await encodeLevels(bytes);
    this.remember(levels, bytes);
    return levels;
  }

  // The bytes of `levels` (`size` of them), kept; when they cannot be read,
  // onError(error) is told and fallback() taken in their place.
  async decode(levels, size, fallback, onError) {
    let bytes = this.decoded.get(levels);
    if (!bytes) {
      try {
        bytes = await decodeLevels(levels, size);
      } catch (error) {
        onError(error);
        bytes = fallback();
      }
      this.remember(levels, bytes);
    }
    return bytes;
  }
}

export function blank(section) {
  return new Uint8Array(rows(section) * section.columns).fill(-section.floor_db);
}

export function isSilent(bytes, section) {
  return bytes.every((b) => b >= -section.floor_db);
}

// --- the brush -------------------------------------------------------------------

// A brush's weight at normalized distance d from its center (1 at the rim):
// 1 inside, falling to 0 at the rim over the outer `softness` of the radius.
export function brushWeight(d, softness) {
  if (d >= 1) return 0;
  const inner = 1 - Math.min(1, Math.max(0, softness));
  if (d <= inner) return 1;
  return 0.5 * (1 + Math.cos((Math.PI * (d - inner)) / (1 - inner)));
}

// Add one dab at (row, column), radius rRow x rColumn cells, to a stroke's
// weights: each cell keeps the largest weight any dab gave it, so going over
// a cell twice in one stroke does not paint it twice.
export function dab(weights, nRows, nColumns, row, column, rRow, rColumn, softness) {
  const r0 = Math.max(0, Math.floor(row - rRow));
  const r1 = Math.min(nRows - 1, Math.ceil(row + rRow));
  const c0 = Math.max(0, Math.floor(column - rColumn));
  const c1 = Math.min(nColumns - 1, Math.ceil(column + rColumn));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot((r + 0.5 - row) / rRow, (c + 0.5 - column) / rColumn);
      const w = brushWeight(d, softness);
      const i = r * nColumns + c;
      if (w > weights[i]) weights[i] = w;
    }
  }
}

// Dab centers from a to b ([row, column]), `spacing` apart in the brush's own
// normalized units, not including a (already dabbed).
export function dabsAlong(a, b, rRow, rColumn, spacing = 0.25) {
  const distance = Math.hypot((b[0] - a[0]) / rRow, (b[1] - a[1]) / rColumn);
  const n = Math.max(1, Math.ceil(distance / spacing));
  return Array.from({ length: n }, (_, k) => {
    const f = (k + 1) / n;
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
  });
}

// The painting after a stroke: every cell moved toward `target` (dB below
// 0 dB) by its weight, so painting over a stroke again never goes past the
// brush's level.
export function applyStroke(bytes, weights, target) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = Math.round(bytes[i] + weights[i] * (target - bytes[i]));
  return out;
}

// The number typed in a field, or `fallback` when it holds none (so 0 stays 0).
export function typedNumber(text, fallback) {
  const n = String(text).trim() === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : fallback;
}

// A stroke on a mask of cuts (dB below 0, as bytes): cutting (target above 0)
// only ever deepens a cell, so a shallower Depth leaves deeper cuts alone;
// restoring (target 0) brings cells back toward 0 dB.
export function applyCut(bytes, weights, target) {
  const out = applyStroke(bytes, weights, target);
  if (target > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], bytes[i]);
  return out;
}

// The painting on a new frequency range: each new row takes the level at its
// center frequency on the old grid (linear in dB between old row centers);
// rows outside the old range are silent.
export function resampleRows(bytes, from, to) {
  const oldRows = rows(from);
  const newRows = rows(to);
  const { columns } = from;
  const floor = -to.floor_db;
  const out = new Uint8Array(newRows * columns).fill(floor);
  for (let r = 0; r < newRows; r++) {
    const x = Math.log2(to.f_lo / from.f_lo) + ((r + 0.5) / newRows) * octaves(to); // octaves above old f_lo
    const position = (x / octaves(from)) * oldRows - 0.5; // in old rows
    if (position < -0.5 || position > oldRows - 0.5) continue;
    const i = Math.min(oldRows - 2, Math.max(0, Math.floor(position)));
    const w = Math.min(1, Math.max(0, position - i));
    for (let c = 0; c < columns; c++) {
      out[r * columns + c] = Math.round(bytes[i * columns + c] * (1 - w) + bytes[(i + 1) * columns + c] * w);
    }
  }
  return out;
}

// --- checking --------------------------------------------------------------------

// Raise an Error saying what is wrong with a section from a file or a link
// (the levels themselves are checked when decoded); the Python side checks
// the same (sonore_sketch.painted.check).
export function check(state) {
  const { f_lo, f_hi, rows_per_octave, columns, floor_db, carrier, levels } = state;
  // Whether f_hi is below Nyquist depends on the page's fs, which another
  // tab may need; Python says so when this tab synthesizes.
  if (!(f_lo > 0 && f_hi > f_lo)) throw new Error("the frequency range must have 0 < f_lo < f_hi");
  if (!(Number.isInteger(rows_per_octave) && rows_per_octave >= 2 && Number.isInteger(columns) && columns >= 2)) {
    throw new Error("rows_per_octave and columns must be whole numbers of at least 2");
  }
  if (rows(state) * columns > MAX_CELLS) throw new Error(`the painting may hold at most ${MAX_CELLS} cells`);
  if (!(floor_db < 0 && floor_db >= -255)) throw new Error("floor_db must be between -255 and 0 dB");
  if (!CARRIERS.includes(carrier)) throw new Error(`carrier must be one of ${CARRIERS.join(", ")}`);
  if (carrier === "harmonic" && !(Number.isFinite(state.f0) && state.f0 > 0 && state.f0 <= f_hi)) {
    throw new Error("f0 must be a positive frequency up to f_hi for the harmonic carrier");
  }
  if (typeof levels !== "string") throw new Error("levels must be text");
  return state;
}
