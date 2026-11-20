import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene } from '../src/agent-scene.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { validatePackManifest } from '../src/pack-manifest.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';
import packageMetadata from '../package.json' with { type: 'json' };

const EXAMPLE_PACK = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('a recipe with the old 67js.scene format is rejected with the format to pass', () => {
  assert.throws(
    () => createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] }),
    /crucible\.scene/,
  );
});

test('an asset recipe with the old 67js.asset format is rejected with the format to pass', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  assert.throws(
    () => createAgentAssetScene(asset, { format: '67js.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) }),
    /crucible\.asset/,
  );
});

test('a pack manifest with the old 67js.pack format or 67js engines key is rejected', () => {
  const manifest = JSON.parse(readFileSync(join(EXAMPLE_PACK, 'crucible-pack.json'), 'utf8'));
  const options = { label: 'old', packageVersion: packageMetadata.version };
  assert.throws(() => validatePackManifest({ ...manifest, format: '67js.pack' }, options), /crucible\.pack/);
  assert.throws(() => validatePackManifest({ ...manifest, engines: { '67js': manifest.engines.crucible } }, options), /engines/);
});
