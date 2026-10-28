// The Match a texture tab's state (sonore_sketch.match_texture is the Python
// half): the source, which groups of texture statistics to impose besides
// the spectrum, how many iterations, and the seed of the starting noise
// (docs/design/tabs/match_texture.md).
//
// No DOM here, so this file runs under `node --test`.

import { DRAWN as QUILT_DRAWN, LABELS as QUILT_LABELS } from "../quilt_sound/model.js";

// Quilt a sound's sources (T2).
export const DRAWN = QUILT_DRAWN;
export const LABELS = QUILT_LABELS;
export const SOURCES = Object.keys(LABELS);

export const FORMAT = 1;
// The groups of statistics (T3), as sonore_sketch.match_texture.GROUPS, with their names on the page.
export const GROUPS = {
  marginals: { name: "Envelope marginals", classes: ["env_mean", "env_var", "env_skew", "env_kurt"] },
  modulation: { name: "Modulation power", classes: ["mod_power"] },
  correlations: { name: "Correlations", classes: ["env_corr", "c1", "c2"] },
};
// The bars (T7), in sonore_sketch.match_texture.BARS's order, with their
// labels, long and short (for a narrow plot).
export const BARS = [
  ["subband_var", "spectrum", "spec."],
  ["env_mean", "mean", "mean"], ["env_var", "variance", "var."], ["env_skew", "skew", "skew"], ["env_kurt", "kurtosis", "kurt."],
  ["mod_power", "mod. power", "mod."],
  ["env_corr", "env. corr.", "corr."], ["c1", "C1", "C1"], ["c2", "C2", "C2"],
];
export const ITERATION_RANGE = [1, 30]; // T4
export const SNR_RANGE = [-20, 60]; // dB, the bars' axis (sonore_sketch.match_texture.SNR_RANGE)

export function defaultSection() {
  return { source: "scatter_events", keep: Object.keys(GROUPS), iterations: 10, seed: 1 };
}

// `keep` with `group` switched on or off, in GROUPS's order.
export function toggled(keep, group, on) {
  return Object.keys(GROUPS).filter((name) => (name === group ? on : keep.includes(name)));
}

// Raise an Error saying what is wrong with a section from a file or a link;
// sonore_sketch.match_texture.check does the same in Python.
export function check(state) {
  const { source, keep, iterations, seed } = state;
  if (!SOURCES.includes(source)) throw new Error(`the Match a texture source must be one of ${SOURCES.join(", ")}`);
  if (!(Array.isArray(keep) && keep.every((group) => Object.hasOwn(GROUPS, group)) && new Set(keep).size === keep.length)) {
    throw new Error(`keep must be a list of some of ${Object.keys(GROUPS).join(", ")}, each once`);
  }
  const [low, high] = ITERATION_RANGE;
  if (!(Number.isInteger(iterations) && iterations >= low && iterations <= high)) throw new Error(`iterations must be a whole number from ${low} to ${high}`);
  if (!(Number.isInteger(seed) && seed >= 0)) throw new Error("seed must be a whole number from 0 up");
  return state;
}
