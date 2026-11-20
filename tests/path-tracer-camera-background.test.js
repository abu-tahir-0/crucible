import assert from 'node:assert/strict';
import test from 'node:test';

import { box, sphere } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { DEFAULT_BACKGROUND } from '../src/clear-colour.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

// Issue #2016: with world false the rasterizer clears to its flat background colour and the trace has to draw the same
// colour behind the picture, while the environment map keeps lighting the scene.

const SKY_STRENGTH = 2;
const SMALL = { width: 16, height: 16, samples: 8, bounces: 3, threads: 1, denoise: false };
const SKY_MAP = createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(SKY_STRENGTH) });
const FLOOR = { name: 'floor', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 40, 0, 0, -0.05, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.5, 0.5, 0.5] } };
const GLASS_BALL = { name: 'glass', geometry: sphere(24, 16), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 0.05, emission: 0, color: [1, 1, 1], transmission: 1 } };
const LOOKING_AT_SKY = { eye: [0, 1, 0], target: [0, 5, 0], up: [0, 0, 1], fov: 40 };
const LOOKING_AT_FLOOR = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };

function traced(world, camera, parts = [FLOOR]) {
  const environment = { map: SKY_MAP, ...(world === undefined ? {} : { world }) };
  return renderPathTracedImage({ parts, environment, camera }, SMALL);
}

function pixelOf(result, column, row) {
  const offset = (row * result.width + column) * 3;
  return [result.linear[offset], result.linear[offset + 1], result.linear[offset + 2]];
}

function assertColour(actual, expected, message) {
  for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6, `${message}: channel ${channel} is ${actual[channel]}, expected ${expected[channel]}`);
}

test('world false draws the raster background where a camera ray sees only the sky', async () => {
  const result = await traced(false, LOOKING_AT_SKY);
  assertColour(pixelOf(result, 8, 8), DEFAULT_BACKGROUND, 'centre pixel');
  assertColour(pixelOf(result, 0, 0), DEFAULT_BACKGROUND, 'corner pixel');
});

test('world true and a bare environment keep the map behind the picture', async () => {
  for (const world of [true, undefined]) {
    const result = await traced(world, LOOKING_AT_SKY);
    assertColour(pixelOf(result, 8, 8), [SKY_STRENGTH, SKY_STRENGTH, SKY_STRENGTH], `world ${world}`);
  }
});

test('world false still lights the floor with the map, so only the camera view changes', async () => {
  const flat = await traced(false, LOOKING_AT_FLOOR);
  const sky = await traced(true, LOOKING_AT_FLOOR);
  const floorPixel = pixelOf(flat, 8, 8);
  assert.ok(floorPixel[0] > 0.2, `the floor is lit by the map (got ${floorPixel[0]})`);
  assertColour(floorPixel, pixelOf(sky, 8, 8), 'floor pixel');
});

test('a camera ray refracted through glass still sees the background, not the sky', async () => {
  const result = await traced(false, LOOKING_AT_SKY, [FLOOR, GLASS_BALL]);
  const centre = pixelOf(result, 8, 8);
  assert.ok(centre.every(value => Math.abs(value - DEFAULT_BACKGROUND[0]) < 0.5 * SKY_STRENGTH), 'the view through the ball stays near the background, not the sky');
  assert.ok(centre[0] < SKY_STRENGTH * 0.5, `the glass ball does not show the sky (got ${centre[0]})`);
});

test('the trace scene carries the background only for world false', () => {
  assert.deepEqual(buildTraceScene([FLOOR], { map: SKY_MAP, world: false }).cameraBackground, [...DEFAULT_BACKGROUND].slice(0, 3));
  assert.equal(buildTraceScene([FLOOR], { map: SKY_MAP, world: true }).cameraBackground, null);
  assert.equal(buildTraceScene([FLOOR], { map: SKY_MAP }).cameraBackground, null);
});
