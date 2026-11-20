import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerAnimator,
  applyViewToCamera,
  hoverTiltTarget,
  parseHoverTiltAttribute,
  parseScrollAttribute,
  parseViews,
  scrollProgress,
  scrollView,
  stepToward,
} from '../src/scene-triggers.js';

const camera = { eye: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 0.8 };
const neutral = { orbit: 0, elevation: 0, dolly: 1 };

test('scroll attribute parses mappings and says what to write on a mistake', () => {
  assert.deepEqual(parseScrollAttribute('orbit 0 90, dolly 1 0.6'), [
    { kind: 'orbit', from: 0, to: 90 },
    { kind: 'dolly', from: 1, to: 0.6 },
  ]);
  assert.throws(() => parseScrollAttribute('spin 0 90'), /Use orbit, elevation or dolly/);
  assert.throws(() => parseScrollAttribute('orbit 0'), /Write orbit <from> <to>/);
  assert.throws(() => parseScrollAttribute('dolly 1 0'), /between 0.1 and 10/);
  assert.throws(() => parseScrollAttribute('orbit 0 90, orbit 1 2'), /appears twice/);
  assert.throws(() => parseScrollAttribute(' '), /scroll is empty/);
});

test('hover-tilt attribute accepts degrees above 0 up to 30', () => {
  assert.equal(parseHoverTiltAttribute('6'), 6);
  for (const bad of ['0', '-2', '45', 'x', '']) assert.throws(() => parseHoverTiltAttribute(bad), /hover-tilt="6"/);
});

test('views parse from JSON and reject unknown fields', () => {
  assert.deepEqual(parseViews('{"close":{"orbit":40,"dolly":0.6}}'), { close: { orbit: 40, dolly: 0.6 } });
  assert.throws(() => parseViews('{oops'), /not valid JSON/);
  assert.throws(() => parseViews('[]'), /object of named views/);
  assert.throws(() => parseViews('{"a":{"zoom":2}}'), /views\.a\.zoom: use orbit, elevation or dolly/);
  assert.throws(() => parseViews('{"a":{"dolly":50}}'), /views\.a\.dolly/);
});

test('scroll progress runs 0 to 1 as the element crosses the viewport and clamps', () => {
  const rectAt = top => ({ top, height: 400 });
  assert.equal(scrollProgress(rectAt(800), 800), 0);
  assert.equal(scrollProgress(rectAt(-400), 800), 1);
  assert.equal(scrollProgress(rectAt(200), 800), 0.5);
  assert.equal(scrollProgress(rectAt(5000), 800), 0);
  assert.equal(scrollProgress(rectAt(-5000), 800), 1);
});

test('scroll progress maps to a camera orbit and dolly', () => {
  const mappings = parseScrollAttribute('orbit 0 90, dolly 1 0.5');
  assert.deepEqual(scrollView(mappings, 0), neutral);
  assert.deepEqual(scrollView(mappings, 1), { orbit: 90, elevation: 0, dolly: 0.5 });
  const quarterTurn = applyViewToCamera(camera, scrollView(mappings, 1));
  assert.ok(Math.abs(quarterTurn.eye[2]) < 1e-9, 'a quarter turn leaves the z axis');
  assert.ok(Math.abs(Math.abs(quarterTurn.eye[0]) - 2) < 1e-9, 'half the distance, on the x axis');
  assert.deepEqual(applyViewToCamera(camera, neutral).eye.map(value => Math.round(value * 1e9) / 1e9), [0, 0, 4]);
});

test('elevation keeps the camera under 85 degrees so it never flips over the pole', () => {
  const lifted = applyViewToCamera(camera, { orbit: 0, elevation: 400, dolly: 1 });
  const angle = Math.asin(lifted.eye[1] / 4) * 180 / Math.PI;
  assert.ok(Math.abs(angle - 85) < 1e-9);
});

test('hover tilt clamps to the maximum and turns off under reduced motion', () => {
  assert.deepEqual(hoverTiltTarget({ x: 1, y: -1 }, 6, false), { orbit: 6, elevation: 6 });
  assert.deepEqual(hoverTiltTarget({ x: 9, y: 9 }, 6, false), { orbit: 6, elevation: -6 });
  assert.deepEqual(hoverTiltTarget({ x: 0.5, y: 0 }, 6, false), { orbit: 3, elevation: -0 });
  assert.deepEqual(hoverTiltTarget(null, 6, false), { orbit: 0, elevation: 0 });
  assert.deepEqual(hoverTiltTarget({ x: 1, y: 1 }, 6, true), { orbit: 0, elevation: 0 });
});

test('stepToward halves the gap every half life and settles on the target', () => {
  assert.equal(stepToward(0, 10, 100, 100), 5);
  assert.equal(stepToward(0, 10, 200, 100), 7.5);
  assert.equal(stepToward(0, 10, 1000, 0), 10);
  assert.equal(stepToward(0, 10, 100000, 100), 10);
});

test('a named view eases in over frames and the animator reports when it is still moving', () => {
  const animator = new TriggerAnimator({ views: { close: { orbit: 40, dolly: 0.5 } } });
  assert.equal(animator.advance(0).animating, false);
  animator.setViewName('close');
  const first = animator.advance(110);
  assert.equal(first.animating, true);
  assert.ok(first.view.orbit > 0 && first.view.orbit < 40);
  assert.ok(first.view.dolly < 1 && first.view.dolly > 0.5);
  const last = animator.advance(100000);
  assert.deepEqual(last, { view: { orbit: 40, elevation: 0, dolly: 0.5 }, animating: false });
  animator.setViewName(null);
  assert.equal(animator.advance(100200).animating, true);
  assert.throws(() => animator.setViewName('far'), /Declared views: close/);
});

test('the first frame lands on the view already set, with no swing', () => {
  const animator = new TriggerAnimator({ views: { close: { orbit: 40 } } });
  animator.setViewName('close');
  assert.deepEqual(animator.advance(5), { view: { orbit: 40, elevation: 0, dolly: 1 }, animating: false });
});

test('pointer tilt eases toward the pointer and back, and reduced motion keeps it at rest', () => {
  const animator = new TriggerAnimator({ hoverTilt: 6 });
  animator.advance(0);
  animator.setPointer({ x: 1, y: 0 });
  const leaning = animator.advance(90);
  assert.equal(leaning.view.orbit, 3);
  assert.equal(leaning.animating, true);
  animator.setPointer(null);
  assert.ok(animator.advance(100000).view.orbit === 0);
  const still = new TriggerAnimator({ hoverTilt: 6, reducedMotion: true });
  still.setPointer({ x: 1, y: 1 });
  assert.deepEqual(still.advance(0), { view: neutral, animating: false });
});

test('scroll, tilt and view add up', () => {
  const animator = new TriggerAnimator({ scroll: parseScrollAttribute('orbit 0 90'), views: { a: { orbit: 10 } } });
  animator.setViewName('a');
  animator.setProgress(0.5);
  assert.equal(animator.advance(0).view.orbit, 55);
});
