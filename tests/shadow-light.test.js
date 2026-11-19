import assert from 'node:assert/strict';
import test from 'node:test';
import { fitWorldShadowView, resolveShadowLight, shadowBiasPerSlope } from '../src/shadow-light.js';
import { CrucibleRenderer } from '../src/renderer.js';

function directionBetween(light) {
  const offset = light.eye.map((value, axis) => value - light.target[axis]);
  const length = Math.hypot(...offset);
  return offset.map(value => value / length);
}

test('resolveShadowLight refuses a non-finite light direction with the range to pass', () => {
  assert.throws(() => resolveShadowLight(true, [Infinity, 1, 0]), /resolveShadowLight: lightDirection.*pass three finite numbers/);
  assert.throws(() => resolveShadowLight(false, [NaN, 0, 1]), /resolveShadowLight: lightDirection/);
  assert.ok(resolveShadowLight(true, [-3, 6, 4]).eye.every(Number.isFinite));
});

test('shadowBiasPerSlope refuses a bad depth range, extent or map size', () => {
  const light = { extent: 65, near: 1, far: 220 };
  assert.throws(() => shadowBiasPerSlope({ ...light, far: light.near }, 2048), /far \(1\) must be greater than near \(1\)/);
  assert.throws(() => shadowBiasPerSlope({ ...light, far: 0 }, 2048), /far \(0\) must be greater than near \(1\)/);
  assert.throws(() => shadowBiasPerSlope({ ...light, extent: 0 }, 2048), /extent must be greater than 0/);
  assert.throws(() => shadowBiasPerSlope(light, 0), /shadowBiasPerSlope: mapSize/);
  assert.ok(Number.isFinite(shadowBiasPerSlope(light, 2048)));
});

test('the default shadow eye sits along the sun direction', () => {
  for (const world of [false, true]) {
    for (const sun of [[-3, 6, 4], [0.85, 0.2, -0.25], [5, 5, 0]]) {
      const length = Math.hypot(...sun);
      const light = resolveShadowLight(world, sun);
      directionBetween(light).forEach((component, axis) => assert.ok(Math.abs(component - sun[axis] / length) < 1e-9));
    }
  }
});

test('an explicit shadow eye wins and a custom target moves the derived eye', () => {
  assert.deepEqual(resolveShadowLight(false, [0, 1, 0], { eye: [1, 2, 3] }).eye, [1, 2, 3]);
  const moved = resolveShadowLight(false, [0, 1, 0], { target: [4, 0, 0] });
  assert.equal(moved.eye[0], 4);
  assert.ok(moved.eye[1] > 1);
});

test('a missing or zero sun falls back to the default direction', () => {
  assert.deepEqual(resolveShadowLight(true, undefined).eye, resolveShadowLight(true, [-3, 6, 4]).eye);
  assert.deepEqual(resolveShadowLight(true, [0, 0, 0]).eye, resolveShadowLight(true, [-3, 6, 4]).eye);
});

test('the shadow bias is the same distance in metres for two depth ranges', () => {
  const mapSize = 2048;
  const studio = resolveShadowLight(false, [-3, 6, 4], { extent: 8, near: 0.1, far: 40 });
  const world = resolveShadowLight(false, [-3, 6, 4], { extent: 8, near: 1, far: 200 });
  const studioMetres = shadowBiasPerSlope(studio, mapSize) * (studio.far - studio.near);
  const worldMetres = shadowBiasPerSlope(world, mapSize) * (world.far - world.near);
  assert.ok(Math.abs(studioMetres - worldMetres) < 1e-12);
  // 3.5 texels of a 16 m wide map held in 2048 texels.
  assert.ok(Math.abs(studioMetres - (16 / 2048) * 3.5) < 1e-12);
  assert.ok(shadowBiasPerSlope(studio, mapSize) > shadowBiasPerSlope(world, mapSize));
});

test('the shadow bias in metres follows the texel size', () => {
  const mapSize = 2048;
  const narrow = resolveShadowLight(true, [-3, 6, 4], { extent: 4, near: 1, far: 100 });
  const wide = resolveShadowLight(true, [-3, 6, 4], { extent: 8, near: 1, far: 100 });
  const ratio = shadowBiasPerSlope(wide, mapSize) / shadowBiasPerSlope(narrow, mapSize);
  assert.ok(Math.abs(ratio - 2) < 1e-12);
});

// A sealed room of 0.2 m slabs, about 6 m across (issue #1695).
const room = { minimum: [-3, 0, -3], maximum: [3, 3, 3] };

test('a small world scene gets a shadow view fitted to its casters, with a bias thinner than its walls', () => {
  const fitted = fitWorldShadowView(room);
  // The sphere around the room has a radius of 4.5 m; padded and snapped up to a quarter octave that is 5.66 m.
  assert.ok(Math.abs(fitted.extent - 2 ** 2.5) < 1e-9);
  assert.deepEqual(fitted.target, [0, 1.414213562373095, 0].map(value => Math.round(value / (fitted.extent / 8)) * (fitted.extent / 8)));
  const light = resolveShadowLight(true, [-3, 6, 4], {}, fitted);
  const fittedMetres = shadowBiasPerSlope(light, 2048) * (light.far - light.near);
  const fixed = resolveShadowLight(true, [-3, 6, 4]);
  const fixedMetres = shadowBiasPerSlope(fixed, 2048) * (fixed.far - fixed.near);
  assert.ok(fixedMetres > 0.2, `the fixed world view bias is ${fixedMetres} m`);
  assert.ok(fittedMetres < 0.03, `the fitted bias is ${fittedMetres} m`);
  // The casters lie between the near and far planes along the light.
  const radius = Math.hypot(6, 3, 6) / 2;
  assert.ok(light.near < fitted.distance - radius && light.far > fitted.distance + radius * 10);
});

test('a world scene as large as the fixed view keeps it, and so does missing or flat bounds', () => {
  assert.equal(fitWorldShadowView({ minimum: [-60, 0, -60], maximum: [60, 10, 60] }), null);
  assert.equal(fitWorldShadowView(null), null);
  assert.equal(fitWorldShadowView({ minimum: [1, 1, 1], maximum: [1, 1, 1] }), null);
});

test('a small move keeps the same fitted view, so shadow edges do not crawl', () => {
  const moved = { minimum: room.minimum.map(value => value + 0.05), maximum: room.maximum.map(value => value + 0.05) };
  assert.deepEqual(fitWorldShadowView(moved), fitWorldShadowView(room));
});

test('explicit shadowBounds fields win over the fitted view', () => {
  const fitted = fitWorldShadowView(room);
  const light = resolveShadowLight(true, [-3, 6, 4], { near: 0.5, eye: [1, 9, 1] }, fitted);
  assert.equal(light.near, 0.5);
  assert.deepEqual(light.eye, [1, 9, 1]);
  assert.equal(light.extent, fitted.extent);
});

function slab(translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, ...translation, 1]);
  return { matrix, geometry: { positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]) } };
}

function rendererWith({ world = true, shadowBounds = {}, batches }) {
  return Object.assign(Object.create(CrucibleRenderer.prototype), { world, shadowBounds, batches });
}

test('the renderer fits the world sun view to its casters and leaves the floor and other cases alone', () => {
  const walls = [slab([0, 1.5, -3], [6, 3, 0.2]), slab([0, 1.5, 3], [6, 3, 0.2]), slab([0, 3, 0], [6, 0.2, 6])];
  const floor = { floor: true, castShadow: true, parts: [slab([0, 0, 0], [400, 0.1, 400])] };
  const batches = [{ floor: false, castShadow: true, parts: walls }, floor, { floor: false, castShadow: false, parts: [slab([100, 0, 100], [1, 1, 1])] }];
  const fitted = rendererWith({ batches }).fittedWorldShadowView();
  assert.ok(fitted.extent < 8, `extent ${fitted.extent}`);
  assert.equal(rendererWith({ world: false, batches }).fittedWorldShadowView(), null);
  assert.equal(rendererWith({ shadowBounds: { extent: 20 }, batches }).fittedWorldShadowView(), null);
  assert.equal(rendererWith({ shadowBounds: { target: [0, 0, 0] }, batches }).fittedWorldShadowView(), null);
  assert.equal(rendererWith({ shadowBounds: null, batches }).fittedWorldShadowView()?.extent, fitted.extent);
  assert.equal(rendererWith({ batches: [floor] }).fittedWorldShadowView(), null);
  const skinned = { ...slab([0, 1, 0], [1, 1, 1]), skin: {} };
  assert.equal(rendererWith({ batches: [{ floor: false, castShadow: true, parts: [...walls, skinned] }] }).fittedWorldShadowView(), null);
});
