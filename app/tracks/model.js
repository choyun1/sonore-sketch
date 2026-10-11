// The Tracks tab's document and the edits drawing makes to it.
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

// The drawable tracks (tracks.md, D1: the paper's voiced set). `tolerance`
// is the freehand simplification tolerance in the track's own unit (D10: a
// default to be tuned by trying it).
const FORMANT_COLORS = ["#d1495b", "#2e86ab", "#3c9d5d", "#9a6fb0", "#c07a1e"];
// The same tracks over the magma spectrogram, whose black-purple-red-orange-
// yellow leaves the cool and pale hues free: cyan, lime, white, sky blue,
// lavender, each drawn on a dark casing (style.css, .on-spectrogram).
const FORMANT_BRIGHT = ["#00e5ff", "#a6ff4d", "#ffffff", "#5aa9ff", "#d9b3ff"];
export const TRACKS = {
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((k, i) => [
      `F${k}`,
      { panel: "formants", min: 0, max: 5000, unit: "Hz", tolerance: 15, color: FORMANT_COLORS[i], bright: FORMANT_BRIGHT[i] },
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
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((k, i) => [
      `B${k}`,
      { panel: "bandwidths", min: 0, max: 600, unit: "Hz", tolerance: 5, color: FORMANT_COLORS[i] },
    ]),
  ),
};

// sonore's KLATT_DEFAULTS for the drawable tracks.
export const DEFAULTS = {
  F0: 100, AV: 60, F1: 500, F2: 1500, F3: 2500, F4: 3500, F5: 4500,
  B1: 60, B2: 90, B3: 150, B4: 200, B5: 250,
};

// A first drawing to hear at once: a short /aɪ/-like glide with a falling F0.
export function defaultDocument() {
  return {
    trackdraw: FORMAT,
    sonore: SONORE_VERSION,
    duration: 0.6,
    fs: 16000,
    mode: "klatt",
    params: {
      F0: [[0, 0.6], [125, 95]],
      AV: [[0, 0.03, 0.55, 0.6], [0, 60, 60, 0]],
      F1: [[0, 0.15, 0.45, 0.6], [700, 700, 400, 380]],
      F2: [[0, 0.15, 0.45, 0.6], [1100, 1100, 2000, 2100]],
      F3: [[0, 0.6], [2500, 2700]],
      F4: 3500,
      F5: 4500,
      B1: 60, B2: 90, B3: 150, B4: 200, B5: 250,
    },
  };
}

const round = (x, digits) => Number(x.toFixed(digits));

// A track's breakpoints as [[t, v], ...]; a number is a flat line.
export function points(doc, name) {
  const value = doc.params[name] ?? DEFAULTS[name];
  if (typeof value === "number") return [[0, value], [doc.duration, value]];
  const [times, values] = value;
  return times.map((t, i) => [t, values[i]]);
}

// Times are stored to 0.1 ms, and sonore needs them strictly increasing.
const TIME_DIGITS = 4;
const TIME_STEP = 10 ** -TIME_DIGITS;

// Breakpoints as sonore takes them: sorted by time, rounded, and with one
// value per time. Where several land on the same time (a line drawn with no
// width in time, a point dragged onto its neighbour, a stretch that shrinks
// two times into one), the last of them wins, so the newest edit is kept.
export function tidyPoints(pts) {
  const sorted = pts
    .map(([t, v], order) => [round(t, TIME_DIGITS), round(v, 2), order])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const tidy = [];
  for (const [t, v] of sorted) {
    if (tidy.length && tidy[tidy.length - 1][0] === t) tidy[tidy.length - 1] = [t, v];
    else tidy.push([t, v]);
  }
  return tidy;
}

// A new document with `name` set to the breakpoints `pts`.
export function withPoints(doc, name, pts) {
  const tidy = tidyPoints(pts);
  return { ...doc, params: { ...doc.params, [name]: [tidy.map(([t]) => t), tidy.map(([, v]) => v)] } };
}

// Every track of `doc` tidied (tidyPoints), for documents from a file or a
// link, which may come from an older page.
export function tidyDocument(doc) {
  const params = Object.fromEntries(
    Object.entries(doc.params ?? {}).map(([name, value]) => {
      const floor = TRACKS[name]?.floor ?? -Infinity;
      if (typeof value === "number") return [name, Math.max(floor, value)];
      const tidy = tidyPoints(value[0].map((t, i) => [t, Math.max(floor, value[1][i])]));
      return [name, [tidy.map(([t]) => t), tidy.map(([, v]) => v)]];
    }),
  );
  return { ...doc, params };
}

export function clampValue(name, v) {
  const { min, max, floor = min } = TRACKS[name];
  return Math.min(max, Math.max(floor, v));
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
export const toScale = (name, v, scale) => (trackSpec(name, scale).scale === "log" ? Math.log2(v) : v);
export const fromScale = (name, u, scale) => (trackSpec(name, scale).scale === "log" ? 2 ** u : u);

// A freehand stroke simplified within the track's tolerance, measured as the
// panel spaces values, so on a log scale the same detail is kept in every
// octave.
export function simplifyStroke(name, stroke, scale) {
  const scaled = stroke.map(([t, v]) => [t, toScale(name, v, scale)]);
  return simplify(scaled, trackSpec(name, scale).tolerance).map(([t, u]) => [t, fromScale(name, u, scale)]);
}

// The breakpoints of a Line from a to b (sorted by time). sonore goes in a
// straight line in Hz between breakpoints, so on a log scale the line is
// laid as enough breakpoints to stay within the tolerance of a straight
// line in octaves, which is what was drawn.
export function lineSpan(name, a, b, scale) {
  const [p, q] = [a, b].sort((x, y) => x[0] - y[0]);
  const { scale: kind, tolerance } = trackSpec(name, scale);
  if (kind !== "log" || p[0] === q[0] || p[1] === q[1]) return [p, q];
  // Each of n equal pieces spans ratio r; the straight-in-Hz chord across it
  // strays furthest from the octave line somewhere inside, found by sampling.
  const octaves = Math.log2(q[1] / p[1]);
  const stray = (n) => {
    const r = 2 ** (octaves / n);
    let worst = 0;
    for (let s = 0.05; s < 1; s += 0.05) worst = Math.max(worst, Math.abs(Math.log2(1 + (r - 1) * s) - s * Math.log2(r)));
    return worst;
  };
  let n = 1;
  while (stray(n) > tolerance) n++;
  return Array.from({ length: n + 1 }, (_, i) =>
    i === 0 ? p : i === n ? q : [p[0] + ((q[0] - p[0]) * i) / n, p[1] * 2 ** ((octaves * i) / n)],
  );
}

// Points to draw a track through: its breakpoints, and on a log scale the
// curve sonore takes between them (straight in Hz is bent in octaves).
export function drawnPoints(name, pts, scale) {
  if (trackSpec(name, scale).scale !== "log") return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1];
    const [t1, v1] = pts[i];
    const n = v0 === v1 || t0 === t1 ? 1 : 16;
    for (let k = 1; k <= n; k++) out.push([t0 + ((t1 - t0) * k) / n, v0 + ((v1 - v0) * k) / n]);
  }
  return out;
}

// The track's value at time t: linear between breakpoints, held beyond the
// ends, as sonore does.
export function valueAt(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    if (t <= t1) {
      const [t0, v0] = pts[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return pts[pts.length - 1][1];
}

// The index of the breakpoint nearest t, if within `tolerance` seconds.
export function nearestPoint(pts, t, tolerance) {
  let best = -1;
  let distance = tolerance;
  pts.forEach(([pt], i) => {
    const d = Math.abs(pt - t);
    if (d <= distance) {
      best = i;
      distance = d;
    }
  });
  return best;
}

// Add a breakpoint, keeping times sorted; returns the points and its index.
export function insertPoint(pts, t, v) {
  let index = pts.findIndex(([pt]) => pt > t);
  if (index < 0) index = pts.length;
  return { pts: [...pts.slice(0, index), [t, v], ...pts.slice(index)], index };
}

// Move breakpoint i, kept strictly between its neighbours in time.
export function movePoint(pts, i, t, v) {
  const lo = i > 0 ? pts[i - 1][0] + TIME_STEP : 0;
  const hi = i < pts.length - 1 ? pts[i + 1][0] - TIME_STEP : Infinity;
  const moved = pts.slice();
  moved[i] = [Math.min(hi, Math.max(lo, t)), v];
  return moved;
}

export function removePoint(pts, i) {
  return pts.length > 1 ? pts.filter((_, j) => j !== i) : pts;
}

// Replace the breakpoints under a span (line and freehand): those strictly
// inside the new points' time range go, and the new points come in.
export function replaceSpan(pts, span) {
  const t0 = span[0][0];
  const t1 = span[span.length - 1][0];
  const kept = pts.filter(([t]) => t < t0 || t > t1);
  return [...kept, ...span].sort((a, b) => a[0] - b[0]);
}

// Ramer-Douglas-Peucker on a stroke [[t, v], ...], keeping every point
// whose value is more than `tolerance` (in the track's unit) from the chord
// between the kept points on either side.
export function simplify(stroke, tolerance) {
  const sorted = [...stroke].sort((a, b) => a[0] - b[0]);
  if (sorted.length <= 2) return sorted;
  const keep = new Array(sorted.length).fill(false);
  keep[0] = keep[sorted.length - 1] = true;
  const stack = [[0, sorted.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ta, va] = sorted[a];
    const [tb, vb] = sorted[b];
    let worst = -1;
    let deviation = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [t, v] = sorted[i];
      const chord = tb === ta ? va : va + ((vb - va) * (t - ta)) / (tb - ta);
      const d = Math.abs(v - chord);
      if (d > deviation) {
        worst = i;
        deviation = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return sorted.filter((_, i) => keep[i]);
}

export function clampDuration(duration) {
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, duration));
}

// Change the duration, stretching every track with it: breakpoint times
// scale exactly (tracks.md, C3), so nothing is resampled or splined.
export function stretch(doc, duration) {
  const factor = duration / doc.duration;
  const params = Object.fromEntries(
    Object.entries(doc.params).map(([name, value]) =>
      typeof value === "number" ? [name, value] : [name, [value[0].map((t) => t * factor), value[1]]],
    ),
  );
  return tidyDocument({ ...doc, duration, params });
}

// Raise an Error saying what is wrong with a document read from a file or a
// link; the Python side checks the same (sonore_sketch.tracks.check).
export function check(doc) {
  if (!doc || doc.trackdraw !== FORMAT) throw new Error(`not a TrackDraw document of format ${FORMAT}`);
  if (!(typeof doc.duration === "number" && doc.duration >= MIN_DURATION && doc.duration <= MAX_DURATION))
    throw new Error(`duration must be from ${MIN_DURATION} to ${MAX_DURATION} s`);
  if (!(doc.fs > 0)) throw new Error("fs must be a positive sampling rate");
  if ((doc.mode ?? "klatt") !== "klatt") throw new Error(`mode ${doc.mode} is not supported yet`);
  for (const [name, value] of Object.entries(doc.params ?? {})) {
    if (typeof value === "number") continue;
    const ok =
      Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) && Array.isArray(value[1]) &&
      value[0].length === value[1].length && value[0].length > 0;
    if (!ok) throw new Error(`${name} must be a number or [times, values]`);
  }
  return doc;
}
