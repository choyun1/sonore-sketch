// The Painted tab's state and the brush that edits it
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
  carrier: "harmonic", f0: 110, seed: 1,
};
export const CARRIERS = ["tones", "harmonic", "noise"];

// sonore_sketch.painted.encode_levels(example_levels()): a slow arpeggio of
// harmonic tones, A3 E4 A4 C#5, on the harmonic carrier at 110 Hz (P7). tests/test_painted.py checks the two agree.
export const EXAMPLE_LEVELS =
  "eNrtm2lbIjsQhR/HOygjgiKyK8gmO8gOM///d92sVal00xEZNifnsw/dSarecyrgnz9eXl5eXl5eXl5e/6B+r9aoDeg36lsuu999b7y9lgrZp0epNOoJlQE9o7KoHCiPKqCKoBKqjHoBvaIqqCroDVVD1UENVBPVArW7/eF4Mluu5Xm+FHOZdCoRj11fXV39QF2D/kP9RMVAN6hbVBz0C3WHSoDuUUlUCvSAekQ5Timz9ZQKpZfKW7353ukNRh/TebNW5VvwmEqEvWbC8Zopx2ueYTEZa19tZA9slvPJqN/l6qH6qAFoiBqhxqAP1AQ1Bc1Qc9QCtEStUGFg+vZk8jo/j1z/k+U3EB5Z5h55+e7I6CcMcKHp51aZG0TyTnjkxVvkM3fAaq2hgsBn1t+oVcThsy3Y8q4X5JPS/bu71sB6MR0Pex2mLugizfLQsNhclluzQ23LDGjUll1WdkHZiAI8lfLP6aiSzjhKOuco6aKDlC8OUnJC6s6X1c9mn3z26eH+160NKxtTdtfbDc/7/O725w8yR1w7IBlzQDLugOTu4Elnsvli+VURcNRpNdQWkL+3EWUfpX2K6vzYp9xFozzhQHnKgfK9i0msHUaApUE3G1A2m2ws2UBiGJp9DHvb0ThwoHHsQOPUgcaFA42CSSfEDwMNM1KeJY4z6gYOnyOEjr/LY65fkeZGMGJLlLp2RKmYI0rFHVEqkRQEgF045vp1in447o0HLQNkH/OAOZ/8ebxnhYmeQrwELYR55J7+aBuSndrtvG5fZOk7rHeltlJHyQ5mNng4bqzYx1pSXYFhyRBS4+Gwyv0LFvkXXGav/TcPn8GQHb6ikvFg86n4yOd06hwWsGcBtUOj/3o5MyyGGAsYCmsV27P2sEriTXZg9hdbx5Kc69rNehXqyigpo5iwjgwGGfTpSooWsudR5ls5qXxf56BOqw7512hp7GajkY0WxmXhitjswyh6EztvSArnRwp8jPpyBCiELalI/bAc6Y/MSPKKkWfMx8ZWAiocGSRSDOIGIa7AElEWmUzZ9aPXG+kquEpzidFJBBZG2sHsBdIIpAvY4s36Xy/4zMK7AD4XPhM+r9lU3xGS4yNHR84tuJ4iroffEZywDKyvf5T/8whEGx1eAJ5MGwIeFNy3GuElHEFbV1E8hon+6JTIkglotmL8H2j+w16FlYBaCuU+xE3ImZgPIBjoRCAeI9LmCVkgAEA8QLRAvyNXpRel1wRLknvkMkjWJqTY4X1eg91LzKwe7F5iYiTpk5RPIr4Zz0g2g2CGrS/EV94Sc5naYr21Zp3zN2dtyzzSKDYbcPzs+B05Fi2p2CAjH0il7sUUa5srEdtsffurDl/yT/+52cPqJHjlspiQjXZJzUhS0VuJX3AQ/9VB/LqD+CE10+31SfzZ8WpbJXcjtBtxXXxBuJga+T98jsDcT0L/+SZ+0yOrZo3UgsEYNr5jkkTjkd+183k75yiDA6Kjt+MXP/o3QnJGhrqGms6Fe2TZZAdgU1LknljbkSmhvW+HXcBLIlhMiEtya5P512LkI2UkBcLRK0GF3x0BoDAZ5ZDK3fMWIYvWHGGsZK9pk3RWf0Cjx2hMwocCkqDRbqWvPLInx8RCtEVWoi2kZaIhbAfN0KRfWgNUs1NjUxPzGPxbzXVGdK6wWauS9qgFQyRLUaWi7XV2XdtFbVe0ATarHnpWPQytemDmtznAHukUxfzfwUj+Y7vk3pcNX95BEX8mX2mDzzMyvATUG3BInJAJky+Gn0/8gFi2yWX2+N6/I5CAYBnZzchKOZgOoogRnqu2jJ3jwNgJ+ys2eLU5PCO3I7Iu71H2jFFR83nLMZ+zmf9Qe+CeH+aT8aDLMvCXwnPYIU/CD3lpthHOKCcfJJYzft/63vgOqWB3jeRlm5x/ThWklusT/ouJgsR3CodeXl5eXl5eXl4Xpf8BEOKkPg==";

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

async function through(stream, bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeLevels(bytes) {
  return toBase64(await through(new CompressionStream("deflate"), bytes));
}

// The bytes of `levels`, checked against the grid's size.
export async function decodeLevels(text, size) {
  let bytes;
  try {
    bytes = await through(new DecompressionStream("deflate"), Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  } catch {
    throw new Error("the painting's levels are not base64 of deflated bytes");
  }
  if (bytes.length !== size) throw new Error(`the painting holds ${bytes.length} cells, not ${size}`);
  return bytes;
}

export function blank(section) {
  return new Uint8Array(rows(section) * section.columns).fill(-section.floor_db);
}

export function isSilent(bytes, section) {
  return bytes.every((b) => b >= -section.floor_db);
}

// --- the brush -------------------------------------------------------------------

// A brush's weight at normalized distance d from its centre (1 at the rim):
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

// Dab centres from a to b ([row, column]), `spacing` apart in the brush's own
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
// centre frequency on the old grid (linear in dB between old row centres);
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
  if (!(floor_db < 0 && floor_db >= -255)) throw new Error("floor_db must be between -255 and 0 dB");
  if (!CARRIERS.includes(carrier)) throw new Error(`carrier must be one of ${CARRIERS.join(", ")}`);
  if (typeof levels !== "string") throw new Error("levels must be text");
  return state;
}
