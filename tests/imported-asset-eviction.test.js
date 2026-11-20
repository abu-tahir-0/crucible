import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { gridGlb } from './fixtures/grid-glb.js';

const LARGE_GRID_SIDE = 950;
const MEBIBYTE = 1024 * 1024;

async function runtimeWithLargeAssets(context, names) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-asset-eviction-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) await writeFile(join(directory, name), gridGlb(LARGE_GRID_SIDE, name));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, assets: directory });
  context.after(() => runtime.close());
  return runtime;
}

function openAsset(runtime, assetName) {
  return runtime.createAsset({ recipe: { format: 'crucible.asset', schemaVersion: 1, assetName } });
}

test('large imported assets count their resident geometry and close the oldest scene by bytes before four scenes are open (#2699)', { timeout: 240000 }, async context => {
  const names = ['large-a.glb', 'large-b.glb', 'large-c.glb'];
  const runtime = await runtimeWithLargeAssets(context, names);
  const first = await openAsset(runtime, names[0]);
  const residentBytes = first.inspection.residentGeometryBytes;
  assert.ok(residentBytes > 40 * MEBIBYTE, `resident bytes ${residentBytes} should hold the vertex and index buffers`);
  assert.ok(2 * residentBytes <= SCENE_STORE_LIMITS.maxOpenSceneBytes, 'two of these assets fit under the cap');
  assert.ok(3 * residentBytes > SCENE_STORE_LIMITS.maxOpenSceneBytes, 'three of these assets are over the cap');

  const second = await openAsset(runtime, names[1]);
  assert.equal(second.evictedSessions, undefined, 'two large assets still fit');
  const third = await openAsset(runtime, names[2]);
  assert.deepEqual(third.evictedSessions, [first.sessionId], 'the third asset closes the oldest scene, before the scene count cap');
  assert.ok(SCENE_STORE_LIMITS.maxOpenScenes > 3);
  assert.match(third.evictionReason, /resident geometry, over the 96\.0 MiB cap/);
  assert.doesNotMatch(third.evictionReason, /at most 4 open scenes/);
});
