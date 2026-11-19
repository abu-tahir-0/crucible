import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrownSkyField } from '../src/tree-sky.js';

const CROWN = [-1, 0, -1, 1, 0, -1, -1, 2, 1, 1, 2, 1, 0, 3, 0];

test('a non-finite target position is refused with the field it came from', () => {
  const field = createCrownSkyField(CROWN);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => field.visibilityOf([0, 1, 0, bad, 0, 0]), /targetPositions: .*finite vertex positions/);
  }
});

test('valid positions keep returning the same visibility', () => {
  const field = createCrownSkyField(CROWN);
  const first = field.visibilityOf(CROWN);
  const second = field.visibilityOf(CROWN);
  assert.equal(first.length, CROWN.length / 3);
  assert.deepEqual(first, second);
  assert.ok(first.every(value => value >= 0.04 && value <= 1));
});
