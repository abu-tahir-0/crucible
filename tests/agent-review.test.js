import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReview, REVIEW_LIMITS } from '../scripts/agent-review.mjs';

const request = () => ({ sessionId: 'scene', expectedRevision: 0, shots: [{}] });

test('review independently defaults shot clocks and bounds its labeled grid', () => {
  const input = { ...request(), width: 480, height: 480,
    shots: [{ motionTime: 1, rendererTime: 2 }, {}, {}, {}] };
  const normalized = normalizeReview(input);
  assert.equal(normalized.gridWidth, REVIEW_LIMITS.maximumGridWidth);
  assert.equal(normalized.gridHeight, REVIEW_LIMITS.maximumGridHeight);
  assert.deepEqual(normalized.shots[1], { label: 'View 2', motionTime: null, rendererTime: 0 });
  assert.equal(normalizeReview(request()).gridWidth, 384);
  assert.equal(normalizeReview(request()).gridHeight, 408);
});

test('review rejects unknown fields, nonfinite values and unbounded inputs before allocation', () => {
  for (const input of [
    { ...request(), path: 'render.png' }, { ...request(), shots: [] }, { ...request(), shots: Array(5).fill({}) },
    { ...request(), width: 481 }, { ...request(), height: 63 }, { ...request(), expectedRevision: NaN },
    { ...request(), width: null }, { ...request(), shots: [{ rendererTime: null }] },
    { ...request(), shots: [{ code: 'alert(1)' }] }, { ...request(), shots: [{ label: 'x'.repeat(49) }] },
    { ...request(), shots: [{ rendererTime: Infinity }] }, { ...request(), shots: [{ motionTime: NaN }] },
    { ...request(), shots: [{ animation: { clip: 0, time: 0, url: 'https://example.com' } }] },
    { ...request(), shots: [{ animation: { clip: 0, time: Infinity } }] },
    { ...request(), shots: [{ camera: { projection: 'fisheye' } }] },
    { ...request(), shots: [{ camera: { eye: [Infinity, 0, 0] } }] },
    { ...request(), shots: [{ camera: { fov: 1e100 } }] },
    { ...request(), shots: [{ camera: { fov: NaN } }] },
  ]) assert.throws(() => normalizeReview(input));
});

test('review detaches caller camera and imported animation records', () => {
  const input = { ...request(), shots: [{ camera: { eye: [4, 2, 1] }, animation: { clip: 0, time: 1 } }] };
  const normalized = normalizeReview(input);
  input.shots[0].camera.eye[0] = 99;
  input.shots[0].animation.time = 99;
  assert.equal(normalized.shots[0].camera.eye[0], 4);
  assert.equal(normalized.shots[0].animation.time, 1);
});

test('review accepts projection and orthoScale on a shot camera and checks them', () => {
  const camera = { eye: [10, 5, 10], target: [0, 2, 0], projection: 'orthographic', orthoScale: 8 };
  const normalized = normalizeReview({ ...request(), shots: [{ camera }] });
  assert.deepEqual(normalized.shots[0].camera, camera);
  assert.throws(() => normalizeReview({ ...request(), shots: [{ camera: { orthoScale: 0 } }] }), /orthoScale must be above 0/);
  assert.throws(() => normalizeReview({ ...request(), shots: [{ camera: { projection: 'fisheye' } }] }), /perspective, orthographic/);
  assert.throws(() => normalizeReview({ ...request(), shots: [{ camera: { focalLength: 35 } }] }), /pass fov in degrees/);
});

test('review sets rendererTime from the shot time unless the shot gives one', () => {
  const { shots } = normalizeReview({ ...request(), shots: [{ motionTime: 1.5 }, { animation: { clip: 0, time: 2 } },
    { motionTime: 1.5, rendererTime: 0 }, {}] });
  assert.deepEqual(shots.map(shot => shot.rendererTime), [1.5, 2, 0, 0]);
});
