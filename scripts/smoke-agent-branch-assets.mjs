// Through MCP on the CPU backend: a scene that places a catalog GLB takes a scene_apply branch, and a branch can place one more
// copy of the asset; the source scene stays at its revision and a review renders the branch with the assets (#2267).
// Usage: node scripts/smoke-agent-branch-assets.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PREVIEW_DEADLINE_VARIABLE } from './preview-deadline.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const assetsDirectory = resolve('artifacts/branch-assets-assets');
await rm(assetsDirectory, { recursive: true, force: true });
await mkdir(assetsDirectory, { recursive: true });
await writeFile(resolve(assetsDirectory, 'robot.glb'), await readFile('public/wall-e.glb'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', assetsDirectory],
  stderr: 'pipe', cwd: process.cwd(),
  // SwiftShader on a loaded CI runner can pass the 30 second production deadline; the harness allows 90 (#2741).
  env: { ...process.env, [PREVIEW_DEADLINE_VARIABLE]: '90' },
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-branch-assets-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

try {
  await client.connect(transport, { timeout: 180000 });
  const robot = (await call('scene_asset_catalog')).structuredContent.assets.find(asset => asset.name === 'robot.glb').assetId;
  const created = (await call('scene_create', { recipe: {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'floor', type: 'terrain', size: 12, resolution: 16, amplitude: 0.1 }],
    materials: [{ id: 'sand', color: [0.6, 0.55, 0.4], roughness: 0.9 }],
    nodes: [{ id: 'ground', geometry: 'floor', material: 'sand' }, { id: 'robot-1', translation: [-1.5, 0, 0], asset: { id: robot } }],
    camera: { eye: [0, 3, 8], target: [0, 1, 0], fov: 45 },
  } })).structuredContent;
  const { sessionId, revision } = created;

  const moved = (await call('scene_apply', { sessionId, expectedRevision: revision, branch: 'moved',
    operations: [{ type: 'set-node', id: 'robot-1', translation: [1, 0, 0] }] })).structuredContent;
  assert.equal(moved.sourceRevision, revision, 'a fork does not consume a revision');
  const crowd = (await call('scene_apply', { sessionId, expectedRevision: revision, branch: 'crowd',
    operations: [{ type: 'add-node', node: { id: 'robot-2', translation: [1.5, 0, 0], asset: { id: robot } } }] })).structuredContent;
  assert.deepEqual(crowd.branches.sort(), ['crowd', 'moved']);

  // One shot per call keeps each review well under its deadline on a loaded SwiftShader runner.
  for (const branch of ['moved', 'crowd']) {
    const review = await call('scene_review', { sessionId, expectedRevision: revision, width: 160, height: 100, shots: [{ branch }] });
    assert.equal(review.structuredContent.shots.length, 1);
  }
  await call('scene_dispose', { sessionId });
  console.log(JSON.stringify({ branches: ['moved', 'crowd'], sourceRevision: revision }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
