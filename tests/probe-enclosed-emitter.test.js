import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere, torus } from '../src/geometry.js';
import * as probeTrace from '../src/probe-trace.js';

const { traceObjectProbes } = probeTrace;

const cube = box(0, 1);
const ball = sphere(16, 12);
const ring = torus(0.1, 48, 12);
const openAir = { pointLights: [], keyColor: [0, 0, 0] };
const tealGlow = { color: [0.08, 0.72, 0.62], emission: 1.35, emissiveColor: [0.08, 0.72, 0.62] };

function placed(name, geometry, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

function ringScene(corePosition) {
  return [
    placed('floor', cube, [0, -0.05, 0], [20, 0.1, 20], { color: [0.5, 0.5, 0.5] }),
    placed('ring', ring, [0, 1, 0], [1, 1, 1], { metallic: 0.92, roughness: 0.24 }),
    placed('core', ball, corePosition, [0.3, 0.3, 0.3], tealGlow),
  ];
}

function glowingTexelCount(probe) {
  let count = 0;
  for (let texel = 0; texel < probe.data.length; texel += 3) {
    if (probe.data[texel + 1] > 0.5 && probe.data[texel + 1] > 2 * probe.data[texel]) count++;
  }
  return count;
}

test('an emissive sphere at the middle of a metal ring does not fill the ring probe with its colour (#2669)', () => {
  const [probe] = traceObjectProbes(ringScene([0, 1, 0]), openAir, { width: 32 }).traced;
  assert.equal(glowingTexelCount(probe), 0, 'the glowing core seen from inside must not be a direction of the probe');
  assert.ok(probe.hitFraction < 0.65, `only the floor fills the view: ${probe.hitFraction}`);
});

test('an emissive sphere beside the ring still shows in the ring probe', () => {
  const [probe] = traceObjectProbes(ringScene([2, 1, 0]), openAir, { width: 64 }).traced;
  assert.ok(glowingTexelCount(probe) > 0, 'the glowing sphere is reflected');
});

test('a part that holds the point inside its solid is found, and one beside it is not', () => {
  const sphereAtOrigin = placed('core', ball, [0, 0, 0], [0.5, 0.5, 0.5]);
  assert.equal(probeTrace.partEnclosesPoint(sphereAtOrigin, [0, 0, 0]), true);
  assert.equal(probeTrace.partEnclosesPoint(sphereAtOrigin, [0.9, 0, 0]), false);
  assert.equal(probeTrace.partEnclosesPoint(placed('ring', ring, [0, 0, 0], [1, 1, 1]), [0, 0, 0]), false);
});

test('a room around a mirror stays in its probe', () => {
  const room = [
    placed('room', cube, [0, 1.5, 0], [6, 3, 6]),
    placed('mirror', ball, [1.5, 0.5, 0], [0.5, 0.5, 0.5], { metallic: 1, roughness: 0.05 }),
  ];
  const [probe] = traceObjectProbes(room, openAir, { width: 32 }).traced;
  assert.ok(probe.hitFraction >= 0.9, `the walls around the mirror stay in its probe: ${probe.hitFraction}`);
});
