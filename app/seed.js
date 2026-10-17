// A new random seed, for the buttons that hear another draw (Draw
// modulation's and Scatter events' New draw, Quilt a sound's New order):
// a whole number below SEED_LIMIT, short enough to read and type, never
// the one in use.
//
// No DOM here, so this file runs under `node --test`.

export const SEED_LIMIT = 100000;

export function randomSeed(current, random = Math.random) {
  for (;;) {
    const seed = Math.floor(random() * SEED_LIMIT);
    if (seed !== current) return seed;
  }
}
