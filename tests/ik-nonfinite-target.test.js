import assert from 'node:assert/strict';
import test from 'node:test';
import { createFootPlacement, createLookAt } from '../src/animation-graph.js';

function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

const footJoints = { root: 'hip', middle: 'knee', end: 'ankle', smoothSeconds: 0 };

test('a foot placement keeps the last good offset when groundOffset returns NaN, and warns once', () => {
  const offsets = [0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN];
  let call = 0;
  const foot = createFootPlacement({ ...footJoints, groundOffset: () => offsets[call++] });
  const warnings = captureWarnings(() => {
    const first = foot.target(0, [0, 0, 0]);
    assert.ok(first[1] > 0);
    for (let frame = 1; frame < 4; frame++) {
      assert.deepEqual(foot.target(frame / 60, [0, 0, 0]), first);
    }
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /createFootPlacement.*groundOffset/);
});

test('a foot placement with no good offset yet applies none', () => {
  const foot = createFootPlacement({ ...footJoints, groundOffset: () => Number.NaN });
  const warnings = captureWarnings(() => assert.deepEqual(foot.target(0, [1, 0, 2]), [1, 0, 2]));
  assert.equal(warnings.length, 1);
});

test('a look-at keeps the last good target when the function returns NaN, and warns once', () => {
  const goals = [[1, 2, 3], [Number.NaN, 0, 0], null, [0, Number.POSITIVE_INFINITY, 0]];
  let call = 0;
  const look = createLookAt({ joints: ['head'], target: () => goals[call++], smoothSeconds: 0 });
  const warnings = captureWarnings(() => {
    const first = look.target(0, [9, 9, 9]);
    assert.deepEqual(first, [1, 2, 3]);
    for (let frame = 1; frame < 4; frame++) {
      assert.deepEqual(look.target(frame / 60, [9, 9, 9]), first);
    }
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /createLookAt.*target/);
});

test('a look-at with no good target yet leaves the aim where it is', () => {
  const look = createLookAt({ joints: ['head'], target: () => [Number.NaN, 0, 0], smoothSeconds: 0 });
  const warnings = captureWarnings(() => assert.deepEqual(look.target(0, [4, 5, 6]), [4, 5, 6]));
  assert.equal(warnings.length, 1);
});

test('a look-at with no good target and a NaN current aim keeps its smoothed aim finite, then eases to the first good target (#2377)', () => {
  const goals = [[Number.NaN, 0, 0], [Number.NaN, 0, 0], [2, 4, 6], [2, 4, 6]];
  let call = 0;
  const look = createLookAt({ joints: ['head'], target: () => goals[call++], smoothSeconds: 0.1 });
  const aims = [];
  captureWarnings(() => {
    for (let frame = 0; frame < goals.length; frame++) aims.push(look.target(frame / 30, [Number.NaN, Number.NaN, Number.NaN]));
  });
  for (const aim of aims) assert.ok(aim.every(Number.isFinite), `aim ${JSON.stringify(aim)} is not finite`);
  assert.deepEqual(aims[1], [0, 0, 0]);
  assert.ok(aims[2][0] > 0 && aims[3][0] > aims[2][0] && aims[3][0] < 2, 'the aim eases toward the good target');
});
