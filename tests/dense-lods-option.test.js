// A scene file's renderer option `denseLods` gives a dense scan levels of detail, on by default (#1163); `false` leaves the parts untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sphere } from '../src/geometry.js';
import { partsForRendererOptions, SCENE_FILE_LOD_PIXEL_ERROR, withSceneFileLights, withSceneFileRendererDefaults } from '../src/dense-lods.js';

function scanPart() {
  return { name: 'scan', geometry: sphere(200, 100), matrix: new Float32Array(16), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 } };
}

const SMALL_CANVAS = { clientWidth: 20, clientHeight: 20 };
const HUGE_CANVAS = { clientWidth: 8000, clientHeight: 8000 };

test('denseLods true gives levels to a scan that has more than one triangle per pixel', () => {
  const parts = [scanPart()];
  const result = partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: true, pixelRatio: 1 });
  assert.notEqual(result, parts);
  assert.ok(result[0].lods.length > 1, 'the part carries levels');
});

test('denseLods is on by default: a dense scan gets levels without the option', () => {
  for (const options of [{ pixelRatio: 1 }, {}, undefined]) {
    const parts = [scanPart()];
    const result = partsForRendererOptions(parts, SMALL_CANVAS, options);
    assert.notEqual(result, parts);
    assert.ok(result[0].lods.length > 1, 'the part carries levels');
  }
});

test('denseLods false returns the same parts', () => {
  const parts = [scanPart()];
  assert.equal(partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: false }), parts);
});

test('the pixel ratio counts: the same scan is sparse on a big canvas', () => {
  const parts = [scanPart()];
  assert.equal(partsForRendererOptions(parts, HUGE_CANVAS, { denseLods: true, pixelRatio: 1 }), parts);
  assert.notEqual(partsForRendererOptions(parts, SMALL_CANVAS, { denseLods: true, pixelRatio: 1 }), parts);
});

test('denseLods must be a boolean, and the error says so', () => {
  assert.throws(() => partsForRendererOptions([scanPart()], SMALL_CANVAS, { denseLods: 'yes' }), /renderer\.denseLods must be true or false/);
});

test('a scene file picks levels at 0.5 pixels of error unless its renderer says otherwise (#2157)', () => {
  assert.equal(SCENE_FILE_LOD_PIXEL_ERROR, 0.5);
  assert.equal(withSceneFileRendererDefaults().lodPixelError, 0.5);
  assert.equal(withSceneFileRendererDefaults({ samples: 2 }).lodPixelError, 0.5);
  assert.equal(withSceneFileRendererDefaults({ lodPixelError: 2 }).lodPixelError, 2);
  assert.equal(withSceneFileRendererDefaults({ samples: 2 }).samples, 2);
});

test('a scene file is lit by its GLB lights, and its own renderer.environment wins key by key (#2664)', () => {
  const fileLights = { pointLights: [{ position: [0, 2, 0], color: [1, 1, 1], intensity: 5, range: 0 }], keyColor: [15, 15, 15], lightDirection: [0, 1, 0], keyIntensity: 1, fillIntensity: 0 };
  assert.deepEqual(withSceneFileLights(fileLights, undefined), fileLights);
  const merged = withSceneFileLights(fileLights, { keyColor: [40, 40, 40], exposure: 2 });
  assert.deepEqual(merged.keyColor, [40, 40, 40]);
  assert.equal(merged.pointLights, fileLights.pointLights);
  assert.equal(merged.exposure, 2);
  assert.deepEqual(withSceneFileLights(undefined, { keyIntensity: 0.5 }), { keyIntensity: 0.5 });
});

test('a pixel ratio that is not a usable number is refused by name, and NaN thresholds are not read as "dense"', async () => {
  const { addLodsToDenseParts } = await import('../src/dense-lods.js');
  for (const pixelRatio of [0, -1, NaN, '1']) {
    assert.throws(() => partsForRendererOptions([scanPart()], SMALL_CANVAS, { pixelRatio }), /partsForRendererOptions: pixelRatio was .*; pass a number from 0\.1 to 16/);
  }
  for (const options of [{ minimumTriangles: NaN }, { minimumTrianglesPerPixel: NaN }, { minimumTrianglesPerPixel: 'x' }]) {
    assert.throws(() => addLodsToDenseParts([scanPart()], { pixels: 1e9, ...options }), /addLodsToDenseParts: minimumTriangle/);
  }
});
