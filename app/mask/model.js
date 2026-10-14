// The Erase spectrogram tab's state and its mask
// (docs/design/tabs/mask.md; sonore_sketch.mask is the Python half).
//
// The mask is a grid of cuts in dB, one byte a cell, stored as the other
// tabs store theirs (base64 of deflated bytes, rows from 0 Hz up): 0 keeps a
// cell, -floor_db (60) removes it. Its rows are equal steps of frequency
// from 0 Hz to Nyquist (F4) and its columns equal fractions of `span`
// seconds, the duration unless the section says otherwise. A recording or
// the syllable train does not stretch with the duration, so neither do
// erasures on them: a duration change sets `span` to the time the columns
// held, and what lies past it is not erased (Cho, 2026-10-06). The source
// is the Erase modulation tab's (F2), and so is the page's recording.
//
// No DOM here, so this file runs under `node --test`.

import { SOURCES } from "../edit/model.js";

export { SOURCES };
export const FORMAT = 1;
export const ROWS = 256;
export const COLUMNS = 256;
export const FLOOR_DB = -60;
export const WINDOW_S = 0.032; // F5

// sonore_sketch.mask.BLANK_LEVELS: nothing cut, so the first Play is the
// source; tests/js/mask.test.mjs checks the two agree.
export const BLANK_LEVELS = "eNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoADwAB";

export const DEFAULTS = { source: "syllables", rows: ROWS, columns: COLUMNS, floor_db: FLOOR_DB, window: WINDOW_S };

export function defaultSection() {
  return { ...DEFAULTS, levels: BLANK_LEVELS };
}

export function blank() {
  return new Uint8Array(ROWS * COLUMNS);
}

export function isBlank(bytes) {
  return bytes.every((b) => b === 0);
}

// A row's centre frequency [Hz] at sampling rate fs.
export const rowFrequency = (r, fs) => ((r + 0.5) / ROWS) * (fs / 2);

// Sources that keep their own time when the duration changes.
export const FIXED_SOURCES = ["file", "syllables"];

// The section after the page's duration changes from `from` to `to` s: on a
// fixed source the erasures keep their seconds (`span`), on the Speech
// sound they stretch with it.
export function stretchSection(section, from, to) {
  const span = section.span ?? from;
  const next = FIXED_SOURCES.includes(section.source) ? span : (span / from) * to;
  const { span: _span, ...rest } = section;
  return Math.abs(next - to) < 1e-9 ? rest : { ...rest, span: next };
}

// The mask on columns over `duration` from one over `span` seconds (nearest
// column; time past `span` is not erased).
export function retime(bytes, span, duration) {
  if (!(span > 0) || Math.abs(span - duration) < 1e-9) return bytes;
  const out = new Uint8Array(bytes.length);
  for (let c = 0; c < COLUMNS; c++) {
    const t = ((c + 0.5) / COLUMNS) * duration;
    if (t >= span) continue;
    const from = Math.min(COLUMNS - 1, Math.floor((t / span) * COLUMNS));
    for (let r = 0; r < ROWS; r++) out[r * COLUMNS + c] = bytes[r * COLUMNS + from];
  }
  return out;
}

// Raise an Error saying what is wrong with a section from a file or a link
// (the mask itself is checked when decoded); sonore_sketch.mask.check does
// the same in Python.
export function check(state) {
  const { source, rows, columns, floor_db, window, levels } = state;
  if (!SOURCES.includes(source)) throw new Error(`the Erase spectrogram source must be one of ${SOURCES.join(", ")}`);
  if (rows !== ROWS || columns !== COLUMNS || floor_db !== FLOOR_DB || window !== WINDOW_S) {
    throw new Error(`the Erase spectrogram mask must be ${ROWS} rows x ${COLUMNS} columns with a floor of ${FLOOR_DB} dB and a ${WINDOW_S} s window`);
  }
  if (typeof levels !== "string") throw new Error("the Erase spectrogram mask's levels must be text");
  if (state.span !== undefined && !(typeof state.span === "number" && state.span > 0)) throw new Error("the Erase spectrogram mask's span must be a positive number of seconds");
  return state;
}
