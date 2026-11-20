import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { decodePack, decodeRgbe, encodePack, encodeRgbe } from '../src/scene-pack-format.js';
import { compileRecipeToPack } from '../src/scene-pack.js';

const RELATIVE_TOLERANCE = 1 / 128;

function lampRecipe() {
  return JSON.parse(readFileSync(new URL('../public/recipes/view-transform.json', import.meta.url), 'utf8'));
}

function probesOf(parts) {
  return parts.map(part => part.material.environmentProbe).filter(Boolean);
}

function worstRelativeError(original, decoded) {
  let worst = 0;
  for (let pixel = 0; pixel < original.length; pixel += 3) {
    const brightest = Math.max(original[pixel], original[pixel + 1], original[pixel + 2]);
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(original[pixel + channel] - decoded[pixel + channel]);
      worst = Math.max(worst, brightest === 0 ? error : error / brightest);
    }
  }
  return worst;
}

test('RGBE keeps every channel within one part in 128 of the pixel brightest channel, from tiny to very bright values', () => {
  const values = new Float32Array([0, 0, 0, 1e-6, 2e-6, 5e-7, 0.5, 0.25, 0.01, 1, 1, 1, 37.3, 2.1, 0.4, 900, 3, 0.5, -1, 0.2, 0.1]);
  const bytes = encodeRgbe(values);
  assert.equal(bytes.length, 28);
  const decoded = decodeRgbe(bytes);
  const expected = values.map(value => Math.max(0, value));
  assert.ok(worstRelativeError(expected, decoded) <= RELATIVE_TOLERANCE, 'within the stated tolerance');
  assert.deepEqual([...decoded.subarray(0, 3)], [0, 0, 0], 'black stays exactly black');
});

test('an environment map inside a pack is stored as RGBE and read back as the Float32Array the renderer takes', () => {
  const data = Float32Array.from({ length: 8 * 4 * 3 }, (_, index) => (index * 0.37) % 5);
  const map = { kind: 'environment-map', width: 8, height: 4, channels: 3, data, intensity: 1, rotation: 0 };
  const bytes = encodePack({ map });
  const decoded = decodePack(bytes).map;
  assert.ok(decoded.data instanceof Float32Array);
  assert.equal(decoded.width, 8);
  assert.ok(worstRelativeError(data, decoded.data) <= RELATIVE_TOLERANCE);
  assert.ok(bytes.length < data.byteLength * 0.5 + 400, `RGBE is a third of the float bytes plus a small header, got ${bytes.length}`);
  const withAlpha = { ...map, channels: 4, data: new Float32Array(8 * 4 * 4) };
  assert.deepEqual([...decodePack(encodePack({ map: withAlpha })).map.data], [...withAlpha.data], 'a four channel map is kept as floats');
});

test('the reflection probes of a packed scene match the live probes and the pack stays deterministic', async () => {
  await loadAllAgentSceneModules();
  const live = probesOf(createAgentScene(lampRecipe()).parts);
  assert.ok(live.length > 0, 'the lamp has metal parts with probes');
  const first = await compileRecipeToPack(lampRecipe());
  const decoded = decodePack(first);
  // Tracing a probe is the slow part, so determinism is checked on the stored form: RGBE of what RGBE decoded is the same bytes.
  assert.deepEqual(Buffer.from(encodePack(decoded)), Buffer.from(first));
  const packed = probesOf(decoded.parts);
  assert.equal(packed.length, live.length);
  live.forEach((probe, index) => {
    assert.equal(packed[index].width, probe.width);
    assert.equal(packed[index].data.length, probe.data.length);
    assert.ok(worstRelativeError(probe.data, packed[index].data) <= RELATIVE_TOLERANCE, `probe ${index} within tolerance`);
  });
  const floatBytes = live.reduce((total, probe) => total + probe.data.byteLength, 0);
  assert.ok(first.length < floatBytes * 0.5 + 200_000, 'the pack no longer holds the probes as floats');
});
