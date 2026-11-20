// scene_export_glb names what it did not write (issue 2130): motion tracks by kind, the camera and the lights,
// and scene_capabilities topic export says what the GLB carries. Runs the real MCP server on the CPU backend.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { GLB_EXPORT_NOTES, omittedFromGlb } from '../src/glb-export-omissions.js';

const CAMERA = { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 };
let directory;
let client;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-export-omitted-'));
  await mkdir(join(directory, 'assets'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--assets', join(directory, 'assets'), '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-export-omitted-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

async function exportOf(recipe) {
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const exported = await client.callTool({ name: 'scene_export_glb', arguments: { sessionId: created.structuredContent.sessionId } }, { timeout: 120000 });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  return exported.structuredContent;
}

const BASE = { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box' }], materials: [{ id: 'm' }], camera: CAMERA,
  nodes: [{ id: 'cube', geometry: 'box', material: 'm' }] };

test('an export of an animated, lit scene lists the motion tracks by kind, the camera and the lights', { timeout: 300000 }, async () => {
  const result = await exportOf({ ...BASE,
    environment: { pointLights: [{ position: [0, 2, 1], color: [1, 1, 1], intensity: 5 }, { position: [1, 2, 1], color: [1, 1, 1], intensity: 5 }] },
    motion: { duration: 2, tracks: [
      { kind: 'node', id: 'cube', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [1, 0, 0] }] },
      { kind: 'material', id: 'm', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 1 }] },
      { kind: 'camera', property: 'fov', keyframes: [{ time: 0, value: 45 }, { time: 2, value: 60 }] }] } });
  assert.deepEqual(result.omitted, ['motion tracks (3: camera 1, material 1, node 1)', 'camera', 'lights (2)']);
});

test('omitted names only the camera when nothing else was authored', { timeout: 300000 }, async () => {
  assert.deepEqual((await exportOf(BASE)).omitted, ['camera']);
});

test('scene_capabilities topic export says what the GLB carries and drops', { timeout: 120000 }, async () => {
  const answer = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'export' } });
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  assert.equal(answer.structuredContent.topic, 'export');
  assert.deepEqual(answer.structuredContent.value.writes, GLB_EXPORT_NOTES.writes);
  assert.deepEqual(answer.structuredContent.value.drops, GLB_EXPORT_NOTES.drops);
});

test('omittedFromGlb skips the node tracks of bones a clip baked and leaves an empty list without a camera', () => {
  const recipe = { motion: { tracks: [{ kind: 'node', id: 'bone', property: 'rotation' }, { kind: 'node', id: 'prop', property: 'scale' }] } };
  assert.deepEqual(omittedFromGlb(recipe, ['bone']), ['motion tracks (1: node 1)']);
  assert.deepEqual(omittedFromGlb({}), []);
});
