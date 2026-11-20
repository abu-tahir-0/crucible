import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mat4 } from 'gl-matrix';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { CONSTRAINT_TYPES } from '../src/node-constraints.js';
import { PROPERTY_KINDS } from '../src/motion-properties.js';
import { MOTION_EXPRESSION_SOURCE_NAMES } from '../src/motion-expression.js';
import { CONSTRAINT_TYPE_NAMES } from '../src/motion-constraint-types.js';
import { DRIVER_VARIABLE_KIND_NAMES } from '../src/motion-driver-variable-kinds.js';
import { IK_SOLVER_TYPE_NAMES } from '../src/motion-ik-solver-types.js';
import { MOTION_PROPERTY_KIND_NAMES } from '../src/motion-property-kinds.js';

// #2124: scene_create took a smaller motion than set-motion and the docs. Each list the MCP schema needs comes from a leaf
// module the backend shares, and every form the docs show goes through scene_create and scene_apply.

const BASE_NODES = [
  { id: 'lid', geometry: 'cube', material: 'red' },
  { id: 'a', geometry: 'cube', material: 'red', translation: [3, 0, 0] },
];

function recipeWith(motion, nodes = BASE_NODES) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'red', color: [1, 0, 0] }],
    nodes,
  };
  if (motion) recipe.motion = motion;
  return recipe;
}

async function withClient(use) {
  let scene;
  const runtime = {
    activeSessionId() { return scene ? 'forms' : null; },
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { sessionId: 'forms', revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { sessionId: 'forms', revision: scene.revision };
    },
    async exportRecipe() { return { sessionId: 'forms', revision: scene.revision, recipe: scene.exportRecipe() }; },
    async close() {},
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-motion-create-forms-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await use(client, () => scene);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  return { isError: result.isError === true, text };
}

function partOf(scene, id) {
  return scene.parts.find(candidate => candidate.name === id);
}

function positionOf(scene, id) {
  return Array.from(mat4.getTranslation(new Float64Array(3), partOf(scene, id).matrix));
}

function assertClose(actual, expected, label, tolerance = 1e-3) {
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= tolerance, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
}

// scene_create accepts the motion, then scene_apply set-motion accepts the same motion on a scene made without it.
// Returns the scene scene_create made, so the caller can sample it.
async function createAndApply(client, getScene, motion, nodes) {
  const plain = await call(client, 'scene_create', { recipe: recipeWith(undefined, nodes) });
  assert.equal(plain.isError, false, plain.text);
  const applied = await call(client, 'scene_apply', { expectedRevision: getScene().revision, operations: [{ type: 'set-motion', motion }] });
  assert.equal(applied.isError, false, applied.text);
  const created = await call(client, 'scene_create', { recipe: recipeWith(motion, nodes) });
  assert.equal(created.isError, false, created.text);
  return getScene();
}

test('each leaf list equals what the backend lists', () => {
  assert.deepEqual([...CONSTRAINT_TYPE_NAMES], [...CONSTRAINT_TYPES], 'constraint types');
  assert.deepEqual([...CONSTRAINT_TYPE_NAMES], [...AGENT_SCENE_CAPABILITIES.motionConstraints], 'constraint types in scene_capabilities');
  assert.deepEqual([...IK_SOLVER_TYPE_NAMES], [...AGENT_SCENE_CAPABILITIES.motionIk], 'IK solver types in scene_capabilities');
  assert.deepEqual([...MOTION_PROPERTY_KIND_NAMES], [...PROPERTY_KINDS], 'property kinds');
  assert.deepEqual(['time', 'node', ...DRIVER_VARIABLE_KIND_NAMES], [...MOTION_EXPRESSION_SOURCE_NAMES], 'driver variable kinds');
  const wrongType = () => createAgentScene(recipeWith({ duration: 1, tracks: [], ik: [{ type: 'nope' }] }));
  assert.throws(wrongType, error => IK_SOLVER_TYPE_NAMES.every(type => error.message.includes(type)));
});

test('scene_create takes the docs custom property example and the three driver variables', async () => {
  await withClient(async (client, getScene) => {
    const nodes = [...BASE_NODES, { id: 'b', geometry: 'cube', material: 'red', rotation: [0.5, 0, 0, Math.sqrt(0.75)] }];
    const motion = {
      duration: 2, tracks: [],
      properties: [{ node: 'lid', name: 'open', min: 0, max: 1, keys: [{ time: 0, value: 0 }, { time: 2, value: 1 }] }],
      drivers: [
        { target: { kind: 'node', id: 'lid', property: 'rotation', component: 'x' }, expression: { mul: [{ custom: { node: 'lid', name: 'open' } }, 90] } },
        { target: { kind: 'node', id: 'lid', property: 'translation', component: 'y' }, expression: { distance: { from: 'a', to: 'lid' } } },
        { target: { kind: 'node', id: 'a', property: 'translation', component: 'z' }, expression: { div: [{ rotationDifference: { from: 'lid', to: 'b' } }, 10] } },
      ],
    };
    const scene = await createAndApply(client, getScene, motion, nodes);
    scene.sampleMotion(2);
    assert.ok(Math.abs(partOf(scene, 'lid').matrix[6] - 1) < 1e-6, 'the custom property turned the lid 90 degrees');
    assert.ok(Math.abs(positionOf(scene, 'lid')[1] - 3) < 1e-6, 'the lid rose by its distance to a');
    assert.ok(positionOf(scene, 'a')[2] > 0, 'rotationDifference drove a');
  });
});

test('scene_create still names a custom property that was not declared', async () => {
  await withClient(async client => {
    const motion = { duration: 1, tracks: [], drivers: [{ target: { kind: 'node', id: 'lid', property: 'rotation', component: 'x' }, expression: { custom: { node: 'lid', name: 'open' } } }] };
    const result = await call(client, 'scene_create', { recipe: recipeWith(motion) });
    assert.equal(result.isError, true);
    assert.match(result.text, /no custom property "open"; add it to motion\.properties first/);
  });
});

const CONSTRAINT_FORMS = {
  maintain_volume: {
    constraint: { freeAxis: 'y', volume: 1 },
    nodes: [{ id: 'lid', geometry: 'cube', material: 'red', scale: [1, 2, 1] }, BASE_NODES[1]],
    check: scene => assertClose([partOf(scene, 'lid').matrix[0]], [Math.SQRT1_2], 'x scale keeps the volume'),
  },
  damped_track: {
    constraint: { target: 'a', trackAxis: '+y' },
    check: scene => assertClose([partOf(scene, 'lid').matrix[4]], [1], 'the +y axis points at a'),
  },
  pivot: { constraint: { target: 'a' }, check: scene => assert.ok(positionOf(scene, 'lid').every(Number.isFinite)) },
  follow_path: {
    constraint: { points: [[0, 0, 0], [4, 0, 0]], duration: 2 },
    check: scene => assertClose(positionOf(scene, 'lid'), [4, 0, 0], 'the node reached the path end'),
  },
  clamp_to: {
    constraint: { points: [[0, 0, 0], [4, 0, 0]], mainAxis: 'x' },
    nodes: [{ id: 'lid', geometry: 'cube', material: 'red', translation: [1, 5, 0] }, BASE_NODES[1]],
    check: scene => assertClose(positionOf(scene, 'lid'), [1, 0, 0], 'the node sits on the curve'),
  },
  shrinkwrap: {
    constraint: { target: 'a', mode: 'nearest' },
    check: scene => assertClose(positionOf(scene, 'lid'), [2.5, 0, 0], 'the node sits on the surface of a'),
  },
  armature: { constraint: { targets: [{ target: 'a', weight: 1 }] }, check: scene => assert.ok(positionOf(scene, 'lid').every(Number.isFinite)) },
};

test('scene_create takes the seven constraint types it used to refuse, flat and in args', async () => {
  assert.deepEqual(Object.keys(CONSTRAINT_FORMS), CONSTRAINT_TYPE_NAMES.slice(-7));
  await withClient(async (client, getScene) => {
    for (const [type, form] of Object.entries(CONSTRAINT_FORMS)) {
      for (const shape of ['flat', 'args']) {
        const constraint = shape === 'flat' ? { type, node: 'lid', ...form.constraint } : { type, node: 'lid', args: form.constraint };
        const scene = await createAndApply(client, getScene, { duration: 2, tracks: [], constraints: [constraint] }, form.nodes);
        scene.sampleMotion(2);
        form.check(scene);
      }
    }
  });
});

test('scene_create takes chain and spline IK', async () => {
  const nodes = [
    { id: 'b0', translation: [0, 1, 0] },
    { id: 'b1', parent: 'b0', translation: [0.4, 0, 0] },
    { id: 'b2', parent: 'b1', translation: [0.4, 0, 0] },
    { id: 'tip', parent: 'b2', translation: [0.4, 0, 0], geometry: 'cube', material: 'red', scale: [0.05, 0.05, 0.05] },
  ];
  await withClient(async (client, getScene) => {
    const chain = await createAndApply(client, getScene, { duration: 1, tracks: [], ik: [{ type: 'chain', chain: ['b0', 'b1', 'b2', 'tip'], target: [0.8, 1.6, 0], iterations: 20 }] }, nodes);
    chain.sampleMotion(0);
    assertClose(positionOf(chain, 'tip'), [0.8, 1.6, 0], 'the chain reached its target', 2e-2);
    const spline = await createAndApply(client, getScene, { duration: 1, tracks: [], ik: [{ type: 'spline', root: 'b0', end: 'tip', curve: [[0, 1, 0], [0.6, 1.4, 0], [1.2, 1, 0]], stretch: true }] }, nodes);
    spline.sampleMotion(0);
    assertClose(positionOf(spline, 'tip'), [1.2, 1, 0], 'the spline carried the tip to the curve end', 2e-2);
  });
});
