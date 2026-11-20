import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTraceScene, refuseLocalVolumes } from '../src/path-tracer-scene.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';
import { nativeGridVolumes } from '../src/path-tracer-native-volumes.js';
import { THIN_WATER_HEIGHT_FRACTION, withoutWaterMedia } from '../src/path-tracer-water-medium.js';

// A unit box (-0.5 to 0.5) placed by its centre and size, as a recipe's box node is.
function boxPart(name, material, center, size) {
  const corners = [];
  for (let corner = 0; corner < 8; corner++) corners.push((corner & 1) - 0.5, ((corner >> 1) & 1) - 0.5, ((corner >> 2) & 1) - 0.5);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return {
    name,
    material,
    matrix: [size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1],
    geometry: { positions: new Float32Array(corners), normals: new Float32Array(corners), indices: new Uint32Array(indices) },
  };
}

const WATER = { tag: 'water', color: [0.05, 0.3, 0.35], roughness: 0.08, absorption: [0.4, 0.1, 0.05], turbidity: 0.1 };
const BED = { tag: 'surface', color: [0.55, 0.47, 0.34], metallic: 0, roughness: 0.9, emission: 0 };

// Bed top at y = -1.9, bottom at -2.1.
const bedPart = boxPart('Bed', BED, [0, -2, 0], [40, 0.2, 40]);

test('a thin water sheet exports an absorbing box from its underside to the bottom of the scene, under its footprint', () => {
  const sheet = boxPart('Sea', WATER, [1, 0, -2], [20, 0.04, 10]);
  const scene = buildTraceScene([bedPart, sheet], {});
  assert.equal(scene.localVolumes.length, 1);
  const [medium] = scene.localVolumes;
  assert.equal(medium.shape, 'box');
  assert.equal(medium.waterMedium, true);
  // The sheet's underside is -0.02 and the scene bottom -2.1.
  assert.ok(Math.abs(medium.size[1] - 2.08) < 1e-6);
  assert.deepEqual(medium.center.map(value => Math.round(value * 1e6) / 1e6), [1, -1.06, -2]);
  assert.deepEqual([medium.size[0], medium.size[2]].map(value => Math.round(value * 1e6) / 1e6), [20, 10]);
  assert.equal(medium.falloff, 0);
  assert.equal(medium.scatter, 0);
  assert.deepEqual([...medium.emission], [0, 0, 0]);
  // Extinction per metre is absorption + turbidity, the numbers the dielectric's attenuation uses.
  [0.5, 0.2, 0.15].forEach((expected, channel) => {
    assert.ok(Math.abs(medium.density * medium.absorption[channel] - expected) < 1e-9, `channel ${channel}`);
  });
});

test('a ray through the medium keeps the Beer-Lambert share of its light', () => {
  const sheet = boxPart('Sea', WATER, [0, 0, 0], [20, 0.04, 20]);
  const [medium] = buildTraceScene([bedPart, sheet], {}).localVolumes;
  const crossing = createLocalVolumeCrossing([medium]);
  const throughput = new Float64Array([1, 1, 1]);
  const emitted = new Float64Array(3);
  const depth = 2.08;
  crossing(0, -0.02, 0, 0, -1, 0, depth, 0.5, throughput, emitted);
  [0.5, 0.2, 0.15].forEach((extinction, channel) => assert.ok(Math.abs(throughput[channel] - Math.exp(-extinction * depth)) < 1e-4, `channel ${channel}`));
  assert.deepEqual([...emitted], [0, 0, 0]);
});

test('a deep closed water body gets no medium: its own attenuation tints it', () => {
  const body = boxPart('Pool', WATER, [0, -0.95, 0], [20, 1.9, 20]);
  const scene = buildTraceScene([bedPart, body], {});
  assert.equal(scene.localVolumes, null);
  assert.ok(scene.partMaterials[1].attenuationColor[0] < 1);
});

test('the thinness line sits at a tenth of the water column', () => {
  assert.equal(THIN_WATER_HEIGHT_FRACTION, 0.1);
  // Column 2.1 m: a 0.2 m part is thin, a 0.3 m part is not.
  const thin = buildTraceScene([bedPart, boxPart('Sea', WATER, [0, -0.1, 0], [20, 0.2, 20])], {});
  assert.equal(thin.localVolumes.length, 1);
  const thick = buildTraceScene([bedPart, boxPart('Sea', WATER, [0, -0.15, 0], [20, 0.3, 20])], {});
  assert.equal(thick.localVolumes, null);
});

test('water with nothing below it, or with no absorption, adds no medium', () => {
  const alone = buildTraceScene([boxPart('Sea', WATER, [0, 0, 0], [20, 0.04, 20])], {});
  assert.equal(alone.localVolumes, null);
  const clear = { ...WATER, absorption: [0, 0, 0], turbidity: 0 };
  const clearScene = buildTraceScene([bedPart, boxPart('Sea', clear, [0, 0, 0], [20, 0.04, 20])], {});
  assert.equal(clearScene.localVolumes, null);
});

test('a scene without water exports exactly as before', () => {
  const scene = buildTraceScene([bedPart, boxPart('Block', BED, [0, 0, 0], [1, 1, 1])], {});
  assert.equal(scene.localVolumes, null);
  assert.equal('waterMedium' in scene, false);
});

test('the medium follows the author volumes and the instanced scene gets it too', () => {
  const environment = { localVolumes: [{ shape: 'sphere', center: [0, 3, 0], radius: 1 }] };
  const sheet = boxPart('Sea', WATER, [0, 0, 0], [20, 0.04, 20]);
  const flat = buildTraceScene([bedPart, sheet], environment);
  assert.deepEqual(flat.localVolumes.map(volume => volume.shape), ['sphere', 'box']);
  assert.equal(flat.localVolumes[0].waterMedium, undefined);
  const instanced = buildTraceScene([bedPart, sheet, { ...sheet, name: 'Sea 2' }], {}, { instancing: true });
  assert.equal(instanced.localVolumes.length, 2);
});

test('more thin water parts than the volume limit are refused with what to do', () => {
  const sheets = Array.from({ length: 9 }, (unused, index) => boxPart(`Sea ${index}`, WATER, [index * 30, 0, 0], [20, 0.04, 20]));
  assert.throws(() => buildTraceScene([bedPart, ...sheets], {}), /at most 8 local volumes.*Merge the water sheets/);
});

test('a tracer that cannot draw local volumes still accepts water, and still refuses the author volumes', () => {
  const sheet = boxPart('Sea', WATER, [0, 0, 0], [20, 0.04, 20]);
  const waterOnly = buildTraceScene([bedPart, sheet], {});
  assert.doesNotThrow(() => refuseLocalVolumes(waterOnly, 'the WebGL tracer'));
  const withAuthor = buildTraceScene([bedPart, sheet], { localVolumes: [{ shape: 'sphere', center: [0, 3, 0], radius: 1 }] });
  assert.throws(() => refuseLocalVolumes(withAuthor, 'the WebGL tracer'), /CPU path tracer only/);
  assert.equal(withoutWaterMedia(waterOnly.localVolumes), null);
  assert.equal(withoutWaterMedia(withAuthor.localVolumes).length, 1);
});

test('Cook gets the medium as a uniform density grid with the same box and extinction and no scatter', () => {
  const sheet = boxPart('Sea', WATER, [1, 0, -2], [20, 0.04, 10]);
  const scene = buildTraceScene([bedPart, sheet], {});
  const [grid] = nativeGridVolumes(scene.localVolumes);
  assert.deepEqual(grid.center, scene.localVolumes[0].center);
  assert.deepEqual(grid.size, scene.localVolumes[0].size);
  assert.ok(grid.channels.density.every(value => value === 1));
  assert.equal(grid.channels.density.length, grid.resolution.reduce((total, side) => total * side, 1));
  assert.deepEqual(grid.scatter, [0, 0, 0]);
  assert.equal(grid.emissionStrength, 0);
  [0.5, 0.2, 0.15].forEach((expected, channel) => assert.ok(Math.abs(grid.density * grid.absorption[channel] - expected) < 1e-9));
});

test('the ignored list tells the WebGL tracer draws no depth tint under thin water', async () => {
  const { describeIgnoredFeatures } = await import('../src/path-tracer.js');
  const sheet = boxPart('Sea', WATER, [0, 0, 0], [20, 0.04, 20]);
  assert.match(describeIgnoredFeatures([sheet], {}, 'gpu').join('\n'), /depth tint under a thin water sheet is not drawn/);
  assert.doesNotMatch(describeIgnoredFeatures([sheet], {}, 'cpu').join('\n'), /depth tint/);
});
