import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

const OCEAN = { op: 'ocean', seed: 3, windSpeed: 4, size: 2, resolution: 4 };

function seaRecipe({ trackTime = true, stack = [{ op: 'subdivide', levels: 3 }, OCEAN] } = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack }],
    materials: [{ id: 'water', color: [0.1, 0.3, 0.5] }],
    nodes: [{ id: 'surface', geometry: 'sea', material: 'water' }],
    camera: { eye: [30, 20, 30], target: [0, 0, 0] },
    ...(trackTime ? {
      motion: {
        duration: 4,
        tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 8 }] }],
      },
    } : {}),
  };
}

function positionsOf(scene) {
  return Array.from(scene.parts[0].geometry.positions);
}

test('an ocean time track moves the waves, and a frame equals the still written at that time', () => {
  const scene = createAgentScene(seaRecipe());
  scene.sampleMotion(0);
  const atStart = positionsOf(scene);
  scene.sampleMotion(2);
  const atTwoSeconds = positionsOf(scene);
  assert.notDeepEqual(atTwoSeconds, atStart, 'the sea moves between frames');
  const still = createAgentScene(seaRecipe({ trackTime: false, stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, time: 4 }] }));
  assert.deepEqual(atTwoSeconds, positionsOf(still), 'time 2 s on a 0 to 8 track is the still at ocean time 4');
});

test('seeking back and forth gives the same vertices, and a repeated time keeps the geometry', () => {
  const scene = createAgentScene(seaRecipe());
  scene.sampleMotion(1.25);
  const first = positionsOf(scene);
  scene.sampleMotion(3.5);
  scene.sampleMotion(1.25);
  assert.deepEqual(positionsOf(scene), first);
  const geometry = scene.parts[0].geometry;
  scene.sampleMotion(1.25);
  assert.equal(scene.parts[0].geometry, geometry);
});

test('an ocean time track names a mesh geometry with an ocean node in its stack', () => {
  const missingGeometry = seaRecipe();
  missingGeometry.motion.tracks[0].id = 'nowhere';
  assert.throws(() => createAgentScene(missingGeometry), /ocean node/);
  assert.throws(() => createAgentScene(seaRecipe({ stack: [{ op: 'subdivide', levels: 2 }] })), /ocean node/);
});

test('ocean time keyframes stay within the bounds of the modifier', () => {
  const recipe = seaRecipe();
  recipe.motion.tracks[0].keyframes[1].value = 2e6;
  assert.throws(() => createAgentScene(recipe), /oceanTime/);
  const wrongSize = seaRecipe();
  wrongSize.motion.tracks[0].keyframes[1].value = [1, 2];
  assert.throws(() => createAgentScene(wrongSize));
});

test('per-frame ocean work stays inside the ocean work limit', () => {
  const scene = createAgentScene(seaRecipe({ stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, resolution: 16 }] }));
  assert.doesNotThrow(() => scene.sampleMotion(1));
});

// #2730: Studio moves its camera with set-camera, and every apply rebuilt the posed sea and re-ranked the whole scene.
test('an edit that does not touch the sea keeps the posed sea part, the topology and the flush ranks', async () => {
  const { flushOrderOf } = await import('../src/depth-layer.js');
  const recipe = seaRecipe();
  // The track starts at ocean time 1, so the posed sea lies flush with a still sea built at time 1 and the rest sea does not.
  recipe.motion.tracks[0].keyframes[0].value = 1;
  recipe.geometries.push({ id: 'box', type: 'box', bevel: 0 }, { ...recipe.geometries[0], id: 'still', stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, time: 1 }] });
  recipe.nodes.push(
    { id: 'still', geometry: 'still', material: 'water' },
    { id: 'wall', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [10, 4, 0.2] },
    { id: 'sign', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [1, 0.5, 0.2] },
    { id: 'crate', geometry: 'box', material: 'water', translation: [8, 1, 8] },
  );
  const scene = createAgentScene(recipe);
  const partNamed = name => scene.parts.find(part => part.name === name);
  const sea = partNamed('surface');
  const signRanks = flushOrderOf(partNamed('sign')).ranges.map(range => range.rank);
  const drawnOrders = scene.parts.map(flushOrderOf);
  assert.equal(flushOrderOf(partNamed('surface')), null, 'the moving sea is left out of the flush ranking');
  assert.equal(flushOrderOf(partNamed('still')), null, 'so the still sea lying flush with it is not cut against it');
  const flush = scene.inspect().flush;
  const topology = scene.topologyRevision;
  scene.apply([{ type: 'set-camera', eye: [25, 18, 30], target: [0, 0, 0] }], { expectedRevision: scene.revision });
  scene.apply([{ type: 'set-node', id: 'crate', translation: [9, 1, 8] }], { expectedRevision: scene.revision });
  assert.equal(scene.topologyRevision, topology, 'neither edit is a topology change');
  assert.equal(partNamed('surface'), sea, 'the posed sea is the same part');
  assert.deepEqual(flushOrderOf(partNamed('sign')).ranges.map(range => range.rank), signRanks, 'the sign keeps its ranks');
  scene.parts.forEach((part, index) => assert.equal(flushOrderOf(part), drawnOrders[index], `${part.name} draws with the ranks of the drawn parts`));
  assert.deepEqual(scene.inspect().flush, flush);
  assert.ok(flushOrderOf(partNamed('wall')).geometry, 'the wall is still cut under the sign');
});

test('an edit to the sea stack builds the posed sea again', () => {
  const recipe = seaRecipe();
  const scene = createAgentScene(recipe);
  const before = positionsOf(scene);
  const calmer = { ...recipe.geometries[0], stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, windSpeed: 9 }] };
  scene.apply([{ type: 'remove-geometry', id: 'sea' }, { type: 'add-geometry', geometry: calmer }], { expectedRevision: scene.revision });
  assert.notDeepEqual(positionsOf(scene), before, 'the new wind gives new waves');
  const still = createAgentScene(seaRecipe({ stack: calmer.stack }));
  assert.deepEqual(positionsOf(scene), positionsOf(still), 'the edited sea equals a scene built with that stack');
});

test('an edit after a seek keeps the playhead, the posed sea part and the topology, and an edit to the sea poses it there', () => {
  const recipe = seaRecipe();
  recipe.geometries.push({ id: 'box', type: 'box', bevel: 0 });
  recipe.nodes.push(
    { id: 'crate', geometry: 'box', material: 'water', translation: [8, 1, 8] },
    // A sign flush on a wall, so the rest parts carry ranks and ranking them again would stage a new list.
    { id: 'wall', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [10, 4, 0.2] },
    { id: 'sign', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [1, 0.5, 0.2] },
  );
  const scene = createAgentScene(recipe);
  // Two seeks to new times rank two posed lists, which must not push out the ranks of the rest parts.
  scene.sampleMotion(0.5);
  scene.sampleMotion(1.25);
  const sea = scene.parts[0];
  const topology = scene.topologyRevision;
  scene.apply([{ type: 'set-camera', eye: [25, 18, 30], target: [0, 0, 0] }], { expectedRevision: scene.revision });
  scene.apply([{ type: 'set-node', id: 'crate', translation: [9, 1, 8] }], { expectedRevision: scene.revision });
  assert.equal(scene.motionTime, 1.25, 'the playhead stays where the host put it');
  assert.equal(scene.topologyRevision, topology, 'neither edit is a topology change');
  assert.equal(scene.parts[0], sea, 'the sea posed at 1.25 s is the same part');
  const calmer = { ...recipe.geometries[0], stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, windSpeed: 9 }] };
  scene.apply([{ type: 'remove-geometry', id: 'sea' }, { type: 'add-geometry', geometry: calmer }], { expectedRevision: scene.revision });
  const fresh = createAgentScene({ ...recipe, geometries: [calmer, recipe.geometries[1]] });
  fresh.sampleMotion(1.25);
  assert.deepEqual(positionsOf(scene), positionsOf(fresh), 'the edited sea is posed at the playhead, as a fresh scene sampled there');
});

// #2730: each new sea frame searched the whole still scene for flush faces again, seconds a frame on the lighthouse.
test('seeking to new sea frames keeps the ranks of the still parts and the staged list of each frame', async () => {
  const { flushOrderOf } = await import('../src/depth-layer.js');
  const recipe = seaRecipe();
  recipe.geometries.push({ id: 'box', type: 'box', bevel: 0 });
  recipe.nodes.push(
    { id: 'wall', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [10, 4, 0.2] },
    { id: 'sign', geometry: 'box', material: 'water', translation: [0, 5, 0], scale: [1, 0.5, 0.2] },
  );
  const scene = createAgentScene(recipe);
  const sign = () => scene.parts.find(part => part.name === 'sign');
  const order = flushOrderOf(sign());
  assert.ok(order, 'the sign is ranked against the wall');
  for (const time of [0.5, 1.25, 2, 3.5]) {
    scene.sampleMotion(time);
    assert.equal(flushOrderOf(sign()), order, `the sign keeps its ranks at ${time} s`);
    assert.equal(flushOrderOf(scene.parts[0]), null, `the sea at ${time} s is not ranked`);
  }
  scene.sampleMotion(1.25);
  const parts = scene.parts;
  scene.sampleMotion(1.25);
  assert.equal(scene.parts, parts, 'the same frame keeps its staged parts');
});
