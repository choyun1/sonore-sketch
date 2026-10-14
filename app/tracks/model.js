// The Draw speech tab's document and the edits drawing makes to it.
//
// A document is the file format of docs/design/tabs/tracks.md (D5), kept as
// is in memory: each parameter is a number or [times, values], which is what
// sonore_sketch.tracks hands to so.klatt_synthesize. Edits never change a
// document in place; each returns a new one, so undo is a list of documents.
//
// No DOM here, so this file runs under `node --test`.

export const FORMAT = 1;
export const SONORE_VERSION = "0.6.0";
export const MAX_DURATION = 10; // seconds (docs/design/app.md, D10)
export const MIN_DURATION = 0.05;

// The drawable tracks (tracks.md, D1: the paper's voiced set). The formants
// go up to 8 kHz, the top of 16 kHz sound; their panel shows up to 5 kHz or
// 8 kHz (a viewing choice in the tab), and drawing stays inside what it shows. `tolerance`
// is the freehand simplification tolerance in the track's own unit (D10: a
// default to be tuned by trying it).
const FORMANT_COLORS = ["#d1495b", "#2e86ab", "#3c9d5d", "#9a6fb0", "#c07a1e"];
// The same tracks over the magma spectrogram, whose black-purple-red-orange-
// yellow leaves the cool and pale hues free: cyan, lime, white, sky blue,
// lavender, each drawn on a dark casing (style.css, .on-spectrogram).
const FORMANT_BRIGHT = ["#00e5ff", "#a6ff4d", "#ffffff", "#5aa9ff", "#d9b3ff"];
export const TRACKS = {
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((number, i) => [
      `F${number}`,
      { panel: "formants", min: 0, max: 8000, unit: "Hz", tolerance: 15, color: FORMANT_COLORS[i], bright: FORMANT_BRIGHT[i] },
    ]),
  ),
  // F0 is drawn in octaves (`scale: "log"`) from 20 to 800 Hz. Below 20 Hz the
  // voicing turns into separate clicks and the rest of the sound goes odd
  // (Cho, 2026-10-05); 800 Hz leaves room above children's voices (about
  // 250-500 Hz) and sung or shrieked pitch. A log track's `tolerance` is in
  // octaves: 0.02 is about 1.5 Hz at 100 Hz. The strip can also be shown
  // linear, 0-800 Hz, with `linear` in place of the log settings.
  F0: {
    panel: "F0", min: 20, max: 800, floor: 20, scale: "log", unit: "Hz", tolerance: 0.02, color: "#444",
    linear: { min: 0, tolerance: 1.5 },
  },
  AV: { panel: "AV", min: 0, max: 80, unit: "dB", tolerance: 1, color: "#444" },
  // The noise sources, for consonants: frication (AF, through the parallel
  // formants: hiss, as in /s/) and aspiration (AH, through the cascade
  // formants: breath, as in /h/).
  AF: { panel: "noise", min: 0, max: 80, unit: "dB", tolerance: 1, color: "#b5651d", bright: "#ffb35c" },
  AH: { panel: "noise", min: 0, max: 80, unit: "dB", tolerance: 1, color: "#6a7f2a", bright: "#d6f07a" },
  // The nasal zero, drawn with the formants: raised above FNP (250 Hz) it
  // takes energy out there, as the nasal tract does in /n/ and /m/; at 250
  // Hz it cancels the nasal pole and does nothing.
  FNZ: { panel: "formants", min: 0, max: 8000, unit: "Hz", tolerance: 15, color: "#888", bright: "#ff7ab8" },
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((number, i) => [
      `B${number}`,
      { panel: "bandwidths", min: 0, max: 600, unit: "Hz", tolerance: 5, color: FORMANT_COLORS[i] },
    ]),
  ),
};

// sonore's KLATT_DEFAULTS for the drawable tracks; also what Clear leaves on
// the Draw speech tab, which cannot be blank (document.js, clearTab).
export const DEFAULTS = {
  F0: 100, AV: 60, F1: 500, F2: 1500, F3: 2500, F4: 3500, F5: 4500, AF: 0, AH: 0, FNZ: 250,
  B1: 60, B2: 90, B3: 150, B4: 200, B5: 250,
};

// A first drawing to hear at once: sonore saying its name, /sɔnɔʁ/, with the
// tracks of "sonore says its name" in sonore's gallery
// (docs/gallery/voice/formants.py), read off a recording of the word. Only
// The /s/ is frication (AF) through the high parallel formants, the
// voiceless /ʁ/ aspiration (AH), and the /n/ opens the nasal zero (FNZ); all
// of these can be drawn. The parallel formants' levels (A4-A6, F6, B6) and the
// voice settings (SS, RD) come along as they are.
export function defaultDocument() {
  const times = [0.15, 0.21, 0.23, 0.27, 0.29, 0.35, 0.42, 0.46, 0.49, 0.58]; // o, n, o, r
  return {
    trackdraw: FORMAT,
    sonore: SONORE_VERSION,
    duration: 0.6,
    fs: 16000,
    mode: "klatt",
    params: {
      F0: [[0.14, 0.18, 0.22, 0.26, 0.3, 0.34, 0.38, 0.47], [266, 250, 232, 212, 205, 197, 192, 189]],
      AV: [[0.135, 0.14, 0.16, 0.21, 0.23, 0.27, 0.29, 0.43, 0.46, 0.48], [0, 56, 60, 56, 50, 50, 55, 54, 47, 0]],
      F1: [times, [530, 470, 380, 380, 600, 590, 590, 600, 750, 750]],
      F2: [times, [1750, 1730, 1750, 1750, 1800, 1450, 1250, 1200, 1250, 1250]],
      F3: [times, [3000, 2950, 2800, 2800, 2950, 2900, 2970, 3050, 2900, 2900]],
      F4: 4400,
      F5: 5200,
      B1: 60, B2: 90, B3: 150, B4: 200, B5: 250,
      AF: [[0, 0.02, 0.125, 0.145], [0, 48, 48, 0]],
      AH: [[0.45, 0.48, 0.55, 0.6], [0, 34, 32, 0]],
      F6: 6500, B6: 1500, A4: 34, A5: 50, A6: 60,
      FNZ: [[0.21, 0.23, 0.27, 0.29], [250, 450, 450, 250]],
      SS: 3, RD: 1.3,
    },
  };
}

// Frication sounds only through the parallel formants, which are off by
// default (A1-A6 are 0). When AF is drawn in a document that has none of them
// on, these, the example's /s/, come with it, so the hiss is heard.
export const FRICATION_SETTINGS = { F6: 6500, B6: 1500, A4: 34, A5: 50, A6: 60 };

export function withFrication(drawing) {
  const parallelOn = ["A1", "A2", "A3", "A4", "A5", "A6", "AB"].some((name) => {
    const value = drawing.params[name];
    return typeof value === "number" ? value > 0 : Array.isArray(value) && value[1].some((level) => level > 0);
  });
  return parallelOn ? drawing : { ...drawing, params: { ...FRICATION_SETTINGS, ...drawing.params } };
}

const round = (number, digits) => Number(number.toFixed(digits));

// A track's breakpoints as [[t, value], ...]; a number is a flat line.
export function points(drawing, name) {
  const value = drawing.params[name] ?? DEFAULTS[name];
  if (typeof value === "number") return [[0, value], [drawing.duration, value]];
  const [times, values] = value;
  return times.map((t, i) => [t, values[i]]);
}

// Times are stored to 0.1 ms, and sonore needs them strictly increasing.
const TIME_DIGITS = 4;
const TIME_STEP = 10 ** -TIME_DIGITS;

// Breakpoints as sonore takes them: sorted by time, rounded, and with one
// value per time. Where several land on the same time (a line drawn with no
// width in time, a point dragged onto its neighbor, a stretch that shrinks
// two times into one), the last of them wins, so the newest edit is kept.
export function tidyPoints(breakpoints) {
  const sorted = breakpoints
    .map(([t, value], order) => [round(t, TIME_DIGITS), round(value, 2), order])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const tidy = [];
  for (const [t, value] of sorted) {
    if (tidy.length && tidy[tidy.length - 1][0] === t) tidy[tidy.length - 1] = [t, value];
    else tidy.push([t, value]);
  }
  return tidy;
}

// A new document with `name` set to the breakpoints `breakpoints`.
export function withPoints(drawing, name, breakpoints) {
  const tidy = tidyPoints(breakpoints);
  return { ...drawing, params: { ...drawing.params, [name]: [tidy.map(([t]) => t), tidy.map(([, value]) => value)] } };
}

// Every track of `drawing` tidied (tidyPoints), for documents from a file or a
// link, which may come from an older page.
export function tidyDocument(drawing) {
  const params = Object.fromEntries(
    Object.entries(drawing.params ?? {}).map(([name, value]) => {
      const floor = TRACKS[name]?.floor ?? -Infinity;
      if (typeof value === "number") return [name, Math.max(floor, value)];
      const tidy = tidyPoints(value[0].map((t, i) => [t, Math.max(floor, value[1][i])]));
      return [name, [tidy.map(([t]) => t), tidy.map(([, tidyValue]) => tidyValue)]];
    }),
  );
  return { ...drawing, params };
}

export function clampValue(name, value) {
  const { min, max, floor = min } = TRACKS[name];
  return Math.min(max, Math.max(floor, value));
}

// A track's settings as its panel shows it: `scale` "log" or "linear", or
// the track's own when not given. Only a track with `linear` settings can be
// shown linear.
export function trackSpec(name, scale = TRACKS[name].scale) {
  const track = TRACKS[name];
  return scale === "linear" && track.linear ? { ...track, ...track.linear, scale: "linear" } : track;
}

// A track's values as its panel spaces them: octaves (log2 Hz) for a log
// scale, the value itself otherwise.
export const toScale = (name, value, scale) => (trackSpec(name, scale).scale === "log" ? Math.log2(value) : value);
export const fromScale = (name, scaled, scale) => (trackSpec(name, scale).scale === "log" ? 2 ** scaled : scaled);

// A freehand stroke simplified within the track's tolerance, measured as the
// panel spaces values, so on a log scale the same detail is kept in every
// octave.
export function simplifyStroke(name, stroke, scale) {
  const scaled = stroke.map(([t, value]) => [t, toScale(name, value, scale)]);
  return simplify(scaled, trackSpec(name, scale).tolerance).map(([t, scaledValue]) => [t, fromScale(name, scaledValue, scale)]);
}

// The breakpoints of a Line from `from` to `to` (sorted by time). sonore
// goes in a straight line in Hz between breakpoints, so on a log scale the
// line is laid as enough breakpoints to stay within the tolerance of a
// straight line in octaves, which is what was drawn.
export function lineSpan(name, from, to, scale) {
  const [first, last] = [from, to].sort((a, b) => a[0] - b[0]);
  const { scale: kind, tolerance } = trackSpec(name, scale);
  if (kind !== "log" || first[0] === last[0] || first[1] === last[1]) return [first, last];
  // Each of `pieces` equal pieces spans a ratio; the straight-in-Hz chord
  // across it strays furthest from the octave line somewhere inside, found
  // by sampling.
  const octaves = Math.log2(last[1] / first[1]);
  const stray = (pieces) => {
    const ratio = 2 ** (octaves / pieces);
    let worst = 0;
    for (let fraction = 0.05; fraction < 1; fraction += 0.05) worst = Math.max(worst, Math.abs(Math.log2(1 + (ratio - 1) * fraction) - fraction * Math.log2(ratio)));
    return worst;
  };
  let pieces = 1;
  while (stray(pieces) > tolerance) pieces++;
  return Array.from({ length: pieces + 1 }, (_, i) =>
    i === 0 ? first : i === pieces ? last : [first[0] + ((last[0] - first[0]) * i) / pieces, first[1] * 2 ** ((octaves * i) / pieces)],
  );
}

// Points to draw a track through: its breakpoints, and on a log scale the
// curve sonore takes between them (straight in Hz is bent in octaves).
export function drawnPoints(name, breakpoints, scale) {
  if (trackSpec(name, scale).scale !== "log") return breakpoints;
  const out = [breakpoints[0]];
  for (let i = 1; i < breakpoints.length; i++) {
    const [t0, value0] = breakpoints[i - 1];
    const [t1, value1] = breakpoints[i];
    const steps = value0 === value1 || t0 === t1 ? 1 : 16;
    for (let step = 1; step <= steps; step++) out.push([t0 + ((t1 - t0) * step) / steps, value0 + ((value1 - value0) * step) / steps]);
  }
  return out;
}

// The track's value at time t: linear between breakpoints, held beyond the
// ends, as sonore does.
export function valueAt(breakpoints, t) {
  if (t <= breakpoints[0][0]) return breakpoints[0][1];
  for (let i = 1; i < breakpoints.length; i++) {
    const [t1, value1] = breakpoints[i];
    if (t <= t1) {
      const [t0, value0] = breakpoints[i - 1];
      return t1 === t0 ? value1 : value0 + ((value1 - value0) * (t - t0)) / (t1 - t0);
    }
  }
  return breakpoints[breakpoints.length - 1][1];
}

// The index of the breakpoint nearest t, if within `tolerance` seconds.
export function nearestPoint(breakpoints, t, tolerance) {
  let best = -1;
  let distance = tolerance;
  breakpoints.forEach(([pointTime], i) => {
    const gap = Math.abs(pointTime - t);
    if (gap <= distance) {
      best = i;
      distance = gap;
    }
  });
  return best;
}

// Add a breakpoint, keeping times sorted; returns the points and its index.
export function insertPoint(breakpoints, t, value) {
  let index = breakpoints.findIndex(([pointTime]) => pointTime > t);
  if (index < 0) index = breakpoints.length;
  return { breakpoints: [...breakpoints.slice(0, index), [t, value], ...breakpoints.slice(index)], index };
}

// Move breakpoint i, kept strictly between its neighbors in time.
export function movePoint(breakpoints, i, t, value) {
  const earliest = i > 0 ? breakpoints[i - 1][0] + TIME_STEP : 0;
  const latest = i < breakpoints.length - 1 ? breakpoints[i + 1][0] - TIME_STEP : Infinity;
  const moved = breakpoints.slice();
  moved[i] = [Math.min(latest, Math.max(earliest, t)), value];
  return moved;
}

export function removePoint(breakpoints, i) {
  return breakpoints.length > 1 ? breakpoints.filter((_, other) => other !== i) : breakpoints;
}

// Replace the breakpoints under a span (line and freehand): those strictly
// inside the new points' time range go, and the new points come in.
export function replaceSpan(breakpoints, span) {
  const t0 = span[0][0];
  const t1 = span[span.length - 1][0];
  const kept = breakpoints.filter(([t]) => t < t0 || t > t1);
  return [...kept, ...span].sort((a, b) => a[0] - b[0]);
}

// Ramer-Douglas-Peucker on a stroke [[t, value], ...], keeping every point
// whose value is more than `tolerance` (in the track's unit) from the chord
// between the kept points on either side.
export function simplify(stroke, tolerance) {
  const sorted = [...stroke].sort((a, b) => a[0] - b[0]);
  if (sorted.length <= 2) return sorted;
  const keep = new Array(sorted.length).fill(false);
  keep[0] = keep[sorted.length - 1] = true;
  const stack = [[0, sorted.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [firstTime, firstValue] = sorted[first];
    const [lastTime, lastValue] = sorted[last];
    let worst = -1;
    let deviation = tolerance;
    for (let i = first + 1; i < last; i++) {
      const [t, value] = sorted[i];
      const chord = lastTime === firstTime ? firstValue : firstValue + ((lastValue - firstValue) * (t - firstTime)) / (lastTime - firstTime);
      const offChord = Math.abs(value - chord);
      if (offChord > deviation) {
        worst = i;
        deviation = offChord;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([first, worst], [worst, last]);
    }
  }
  return sorted.filter((_, i) => keep[i]);
}

export function clampDuration(duration) {
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, duration));
}

// Change the duration, stretching every track with it: breakpoint times
// scale exactly (tracks.md, C3), so nothing is resampled or splined.
export function stretch(drawing, duration) {
  const factor = duration / drawing.duration;
  const params = Object.fromEntries(
    Object.entries(drawing.params).map(([name, value]) =>
      typeof value === "number" ? [name, value] : [name, [value[0].map((t) => t * factor), value[1]]],
    ),
  );
  return tidyDocument({ ...drawing, duration, params });
}

// Raise an Error saying what is wrong with a document read from a file or a
// link; the Python side checks the same (sonore_sketch.tracks.check).
export function check(drawing) {
  if (!drawing || drawing.trackdraw !== FORMAT) throw new Error(`not a TrackDraw document of format ${FORMAT}`);
  if (!(typeof drawing.duration === "number" && drawing.duration >= MIN_DURATION && drawing.duration <= MAX_DURATION))
    throw new Error(`duration must be from ${MIN_DURATION} to ${MAX_DURATION} s`);
  if (!(drawing.fs > 0)) throw new Error("fs must be a positive sampling rate");
  if ((drawing.mode ?? "klatt") !== "klatt") throw new Error(`mode ${drawing.mode} is not supported yet`);
  for (const [name, value] of Object.entries(drawing.params ?? {})) {
    if (typeof value === "number") continue;
    const valid =
      Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) && Array.isArray(value[1]) &&
      value[0].length === value[1].length && value[0].length > 0;
    if (!valid) throw new Error(`${name} must be a number or [times, values]`);
  }
  return drawing;
}
