import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';

function quadPart(name, material, extraGeometry = {}) {
  return {
    name,
    material,
    geometry: {
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      ...extraGeometry,
    },
  };
}

const WATER = { tag: 'water', color: [0.02, 0.2, 0.25], metallic: 0.7, roughness: 0.2, emission: 0, absorption: [0.5, 0.1, 0.05], turbidity: 0.1 };
const PLAIN = { tag: 'surface', color: [0.5, 0.4, 0.3], metallic: 0, roughness: 0.6, emission: 0 };

test('a water part becomes a glossy dielectric with attenuation from its absorption and turbidity', () => {
  const scene = buildTraceScene([quadPart('Sea', WATER)], {});
  const [material] = scene.materials;
  assert.equal(material.transmission, 1);
  assert.equal(material.ior, 1.33);
  assert.equal(material.metallic, 0);
  assert.equal(material.roughness, 0.2);
  // The bed under the water stays lit: the tint is left to the attenuation, not the base colour applied at every refraction.
  assert.deepEqual(Array.from(material.color), [1, 1, 1]);
  const [own] = scene.partMaterials;
  assert.equal(own.attenuationDistance, 1);
  const expected = [0.5, 0.1, 0.05].map(channel => Math.exp(-(channel + 0.1)));
  expected.forEach((value, channel) => assert.ok(Math.abs(own.attenuationColor[channel] - value) < 1e-12));
});

test('a water part without roughness gets a calm default and the recipe preset fills in absorption', () => {
  const { roughness, ...bare } = { ...WATER, absorption: undefined, turbidity: undefined, waterPreset: 'sea' };
  const scene = buildTraceScene([quadPart('Sea', bare)], {});
  assert.equal(scene.materials[0].roughness, 0.05);
  assert.ok(Math.abs(scene.partMaterials[0].attenuationColor[0] - Math.exp(-(0.4 + 0.1))) < 1e-12);
});

test('a part that is not water traces exactly as before', () => {
  const scene = buildTraceScene([quadPart('Floor', PLAIN)], {});
  assert.equal(scene.materials[0].transmission, 0);
  assert.equal(scene.materials[0].ior, 1.5);
  assert.equal(scene.partMaterials[0], PLAIN);
  assert.equal(scene.partMaterials[0].attenuationDistance, undefined);
});

test('fogDensity with world on becomes a homogeneous volume of that extinction and colour, in the scene box plus a margin', () => {
  const scene = buildTraceScene([quadPart('Floor', PLAIN)], { world: true, fogDensity: 0.05, fogColor: [0.2, 0.3, 0.4] });
  assert.equal(scene.volume.density, 0.05);
  assert.deepEqual([...scene.volume.albedo], [0.2, 0.3, 0.4]);
  assert.equal(scene.volume.anisotropy, 0);
  assert.deepEqual([...scene.volume.minimum], [-1.5, -0.5, -1.5]);
  assert.deepEqual([...scene.volume.maximum], [1.5, 0.5, 1.5]);
});

test('no distance haze volume without fogDensity or without world, as the rasterizer draws none there', () => {
  assert.equal(buildTraceScene([quadPart('Floor', PLAIN)], { world: true }).volume, null);
  assert.equal(buildTraceScene([quadPart('Floor', PLAIN)], { world: true, fogDensity: 0 }).volume, null);
  assert.equal(buildTraceScene([quadPart('Floor', PLAIN)], { fogDensity: 0.05 }).volume, null);
});

test('fogDensity still maps when the recipe carries an unset volumeFog of density 0', () => {
  const environment = { world: true, fogDensity: 0.05, volumeFog: { density: 0 } };
  assert.equal(buildTraceScene([quadPart('Floor', PLAIN)], environment).volume.density, 0.05);
  assert.match(describeIgnoredFeatures([quadPart('Floor', PLAIN)], environment).join(' '), /fogDensity is traced as a uniform medium/);
});

test('volumeFog wins over fogDensity', () => {
  const volumeFog = { density: 0.3, color: [1, 0, 0] };
  const scene = buildTraceScene([quadPart('Floor', PLAIN)], { world: true, fogDensity: 0.05, volumeFog });
  assert.equal(scene.volume.density, 0.3);
  assert.deepEqual([...scene.volume.albedo], [1, 0, 0]);
});

test('the ignored list names water ripples, foam, glint and ramp, and the haze mapping', () => {
  const foamPart = quadPart('Sea', { ...WATER, waterGlint: { strength: 1 }, waterRamp: { colors: [] } }, { vertexGroups: { foam: new Float32Array(4) } });
  const notes = describeIgnoredFeatures([foamPart], { world: true, fogDensity: 0.05 }).join('\n');
  assert.match(notes, /water ripples are ignored/);
  assert.match(notes, /water foam/);
  assert.match(notes, /waterGlint is ignored/);
  assert.match(notes, /waterRamp is ignored/);
  assert.match(notes, /fogDensity is traced as a uniform medium/);
  assert.doesNotMatch(notes, /water materials are traced as plain surfaces/);
  assert.equal(describeIgnoredFeatures([quadPart('Floor', PLAIN)], {}).some(note => /water/.test(note)), false);
});
