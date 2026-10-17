import assert from "node:assert/strict";
import { test } from "node:test";

import { SEED_LIMIT, randomSeed } from "../../app/seed.js";

test("a new seed is a random whole number below the limit, never the one in use", () => {
  for (let i = 0; i < 200; i++) {
    const seed = randomSeed(7);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < SEED_LIMIT && seed !== 7, seed);
  }
  const draws = [0.5, 0.5, 0.25]; // the first two give the seed in use, so a third is drawn
  assert.equal(randomSeed(50000, () => draws.shift()), 25000);
});
