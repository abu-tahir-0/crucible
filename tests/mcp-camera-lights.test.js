import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mat4, vec3 } from 'gl-matrix';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { applyProjection, resolveThinLens } from '../src/camera.js';
import { effectsWithFStop } from '../src/camera-effects.js';
import { previewHarness } from './support/preview-harness.mjs';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from '../src/light-limits.js';

function baseRecipe(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: 'mesh', geometry: 'cube', material: 'blue' }],
    ...extra,
  };
}

async function connect(context) {
  let scene;
  const runtime = {
    async capabilities() { return { scene: {}, phase: 'idle' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { revision: scene.revision };
    },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'camera-lights-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, scene: () => scene };
}

function lightArray(count, make) {
  return Array.from({ length: count }, (_, index) => make(index));
}

test('the MCP light caps are the engine light limits', async context => {
  const { client } = await connect(context);
  const outline = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'environment' } })).structuredContent.fields;
  const limits = { pointLights: MAX_POINT_LIGHTS, spotLights: MAX_SPOT_LIGHTS, areaLights: MAX_AREA_LIGHTS };
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal(outline[`${field}?`].length, `{..${limit}}`, `${field} cap in the environment topic`);
  }
});

test('scene_create accepts a full set of lights and rejects one more', async context => {
  const { client, scene } = await connect(context);
  const position = index => [index, 2, 0];
  const environment = {
    pointLights: lightArray(MAX_POINT_LIGHTS, index => ({ position: position(index), intensity: 50 })),
    spotLights: lightArray(MAX_SPOT_LIGHTS, index => ({ position: position(index), direction: [0, -1, 0] })),
    areaLights: lightArray(MAX_AREA_LIGHTS, index => ({ position: position(index), direction: [0, -1, 0], width: 1, height: 1 })),
  };
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: baseRecipe({ environment }) } });
  assert.notEqual(created.isError, true);
  assert.equal(scene().exportRecipe().environment.pointLights.length, MAX_POINT_LIGHTS);
  assert.equal(scene().exportRecipe().environment.areaLights.length, MAX_AREA_LIGHTS);
  const tooMany = { ...environment, areaLights: lightArray(MAX_AREA_LIGHTS + 1, index => ({ position: position(index), direction: [0, -1, 0], width: 1, height: 1 })) };
  const rejected = await client.callTool({ name: 'scene_create', arguments: { recipe: baseRecipe({ environment: tooMany }) } }).catch(error => ({ isError: true, error }));
  assert.equal(rejected.isError, true);
});

test('scene_create and set-camera take orthographic, shift, focal length and f-stop', async context => {
  const { client, scene } = await connect(context);
  const camera = { eye: [0, 0, 5], target: [0, 0, 0], projection: 'orthographic', orthoScale: 6, shift: [0.1, -0.2], fStop: 2.8 };
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: baseRecipe({ camera }) } });
  assert.notEqual(created.isError, true);
  assert.deepEqual(scene().camera.shift, [0.1, -0.2]);
  assert.equal(scene().camera.orthoScale, 6);
  const applied = await client.callTool({ name: 'scene_apply', arguments: { sessionId: '00000000-0000-4000-8000-000000000000', expectedRevision: scene().revision,
    operations: [{ type: 'set-camera', projection: 'perspective', focalLength: 50, sensorWidth: 36 }] } });
  assert.notEqual(applied.isError, true, JSON.stringify(applied.content));
  assert.equal(scene().camera.focalLength, 50);
  assert.equal(scene().camera.fov, undefined, applied.content?.[0]?.text);
});

test('a camera takes fov or focalLength, never both, and checks each lens field', () => {
  const make = camera => createAgentScene(baseRecipe({ camera }));
  assert.throws(() => make({ fov: 40, focalLength: 50 }), /camera\.focalLength: got 50; expected only one of fov \(degrees\) or focalLength/);
  assert.throws(() => make({ sensorWidth: 36 }), /camera\.sensorWidth: got 36; expected a field used with focalLength/);
  assert.throws(() => make({ projection: 'orthographic', focalLength: 50 }), /camera\.focalLength: got 50; expected a field of a perspective camera/);
  assert.throws(() => make({ orthoScale: 4 }), /camera\.orthoScale: got 4; expected a field of an orthographic camera/);
  assert.throws(() => make({ projection: 'orthographic', orthoScale: 0 }), /camera\.orthoScale: got 0; expected a positive view height/);
  assert.throws(() => make({ projection: 'fisheye' }), /perspective or orthographic/);
  assert.throws(() => make({ shift: [2, 0] }), /shift/);
  assert.throws(() => make({ fStop: 0.1 }), /fStop/);
  assert.throws(() => createAgentScene(baseRecipe({ camera: { fStop: 2 }, effects: { depthOfField: { blur: 0.5 } } })), /camera\.fStop: got 2; expected a camera without effects\.depthOfField\.blur above 0/);
  const scene = createAgentScene(baseRecipe({ camera: { fov: 40 } }));
  assert.throws(() => scene.apply([{ type: 'set-camera', fov: 40, focalLength: 50 }], { expectedRevision: 0 }), /camera\.focalLength: got 50; expected only one of fov/);
  scene.apply([{ type: 'set-camera', focalLength: 85 }], { expectedRevision: 0 });
  assert.equal(scene.camera.fov, undefined);
  scene.apply([{ type: 'set-camera', fov: 30 }], { expectedRevision: 1 });
  assert.equal(scene.camera.focalLength, undefined);
});

test('a scene without the new fields keeps its camera exactly', () => {
  const scene = createAgentScene(baseRecipe());
  assert.deepEqual(Object.keys(scene.camera).sort(), ['eye', 'far', 'fov', 'near', 'target', 'up']);
});

function projectToScreen(point, camera, aspect = 1) {
  const projection = applyProjection(mat4.create(), camera, aspect);
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  return vec3.transformMat4(vec3.create(), point, mat4.multiply(mat4.create(), projection, view));
}

test('orthographic orthoScale is the view height and ignores depth', () => {
  const camera = createAgentScene(baseRecipe({ camera: { eye: [0, 0, 8], target: [0, 0, 0], projection: 'orthographic', orthoScale: 4 } })).camera;
  const near = projectToScreen([1, 1, 3], camera);
  const far = projectToScreen([1, 1, -3], camera);
  assert.ok(Math.abs(near[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(near[0] - far[0]) < 1e-6);
  assert.ok(Math.abs(projectToScreen([1, 1, 0], camera, 2)[0] - 0.25) < 1e-6);
});

test('lens shift moves the image by a frame fraction in both projections', () => {
  for (const projection of ['perspective', 'orthographic']) {
    const flat = createAgentScene(baseRecipe({ camera: { eye: [0, 0, 8], target: [0, 0, 0], projection } })).camera;
    const shifted = createAgentScene(baseRecipe({ camera: { eye: [0, 0, 8], target: [0, 0, 0], projection, shift: [0.25, 0.1] } })).camera;
    const before = projectToScreen([0, 0, 0], flat);
    const after = projectToScreen([0, 0, 0], shifted);
    // A fraction of the frame is 2 in clip space, and the frame moves right and up, so the image moves left and down.
    assert.ok(Math.abs(after[0] - before[0] + 0.5) < 1e-6, projection);
    assert.ok(Math.abs(after[1] - before[1] + 0.2) < 1e-6, projection);
  }
});

test('focal length with a sensor width gives the matching field of view at any aspect', () => {
  const lens = createAgentScene(baseRecipe({ camera: { eye: [0, 0, 8], target: [0, 0, 0], focalLength: 36, sensorWidth: 36 } })).camera;
  // A 36 mm lens on a 36 mm sensor sees 53.13 degrees across the width: half width 1 at distance 2.
  const edge = projectToScreen([1, 0, 6], lens, 1);
  assert.ok(Math.abs(edge[0] - 1) < 1e-6);
  const wide = projectToScreen([1, 0, 6], lens, 2);
  assert.ok(Math.abs(wide[0] - 1) < 1e-6);
});

test('an f-stop gives depth of field focused on the target, and an explicit blur wins', () => {
  const effects = { depthOfField: { blur: 0, focusDistance: 5 } };
  const camera = { eye: [0, 0, 8], target: [0, 0, 0], fStop: 2.8 };
  const result = effectsWithFStop(effects, camera);
  assert.equal(result.depthOfField.focusDistance, 8);
  assert.ok(Math.abs(result.depthOfField.blur - 0.5) < 1e-9);
  assert.equal(effectsWithFStop(effects, { ...camera, fStop: 1 }).depthOfField.blur, 1);
  assert.equal(effectsWithFStop(effects, { eye: [0, 0, 8], target: [0, 0, 0] }), effects);
  const shot = { depthOfField: { blur: 0.3, focusDistance: 2 } };
  assert.equal(effectsWithFStop(shot, camera), shot);
});

test('the preview draws the lens fields and the f-stop depth of field, and set-camera reaches them', () => {
  const harness = previewHarness();
  const { preview, renders } = harness;
  const sessionId = 'lens';
  const camera = { eye: [0, 0, 8], target: [0, 0, 0], projection: 'orthographic', orthoScale: 6, shift: [0.1, 0], fStop: 2.8 };
  preview.create({ recipe: baseRecipe({ camera }), sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  preview.frame({ sessionId });
  const frame = renders.at(-1).camera;
  assert.equal(frame.projection, 'orthographic');
  assert.equal(frame.orthoScale, 6);
  assert.deepEqual(frame.shift, [0.1, 0]);
  assert.equal(frame.effects.depthOfField.focusDistance, 8);
  assert.ok(Math.abs(frame.effects.depthOfField.blur - 0.5) < 1e-9);
  preview.apply({ sessionId, expectedRevision: 0, operations: [{ type: 'set-camera', projection: 'perspective', focalLength: 50 }] });
  preview.frame({ sessionId });
  const lens = renders.at(-1).camera;
  assert.equal(lens.focalLength, 50);
  assert.equal(lens.fov, undefined);
  assert.equal(lens.orthoScale, undefined);
});

test('a recipe camera carries focusDistance with fStop, round trips through export, and refuses bad values', () => {
  const make = camera => createAgentScene(baseRecipe({ camera }));
  const scene = make({ eye: [0, 1, 6], target: [0, 1, -4], fStop: 2, focusDistance: 3.5 });
  assert.equal(scene.camera.focusDistance, 3.5);
  assert.equal(scene.exportRecipe().camera.focusDistance, 3.5);
  assert.equal(make(scene.exportRecipe().camera).camera.focusDistance, 3.5);
  for (const focusDistance of [0, -2, '3']) {
    assert.throws(() => make({ fStop: 2, focusDistance }), /camera\.focusDistance: got .*; expected a positive distance in metres/);
  }
  assert.throws(() => make({ focusDistance: 3 }), /camera\.focusDistance: got 3; expected a field used with fStop/);
  scene.apply([{ type: 'set-camera', focusDistance: 1.25 }], { expectedRevision: 0 });
  assert.equal(scene.camera.focusDistance, 1.25);
  assert.throws(() => scene.apply([{ type: 'set-camera', focusDistance: -1 }], { expectedRevision: 1 }), /camera\.focusDistance/);
});

test('the raster effects and the path tracer lens read the recipe camera focusDistance', () => {
  const { camera } = createAgentScene(baseRecipe({ camera: { eye: [0, 1, 6], target: [0, 1, -4], fStop: 2, focusDistance: 3.5 } }));
  assert.equal(effectsWithFStop({ depthOfField: { blur: 0, focusDistance: 5 } }, camera).depthOfField.focusDistance, 3.5);
  assert.equal(resolveThinLens(camera, { aspect: 1, eye: camera.eye, target: camera.target }).focalDistance, 3.5);
});

test('a light list over its cap names the cap, why it exists and what to do instead', () => {
  const eightAreaLights = lightArray(MAX_AREA_LIGHTS + 1, index => ({ position: [index, 2, 0], direction: [0, -1, 0], width: 1, height: 1 }));
  const message = (() => {
    try {
      createAgentScene(baseRecipe({ environment: { areaLights: eightAreaLights } }));
    } catch (error) {
      return error.message;
    }
    return '';
  })();
  assert.match(message, /environment\.areaLights: got "8 entries"/);
  assert.match(message, /at most 7 lights/);
  assert.match(message, /one of 32 mask bits per light \(1 sun, 16 point, 8 spot, 7 area\)/);
  assert.match(message, /merge neighbouring panels into one wider light/);
  assert.match(message, /HDRI or emissive parts/);
  assert.match(message, /backend native, which takes 256 lights/);
});

test('set-camera fStop null turns depth of field off and clears focusDistance with it', () => {
  const scene = createAgentScene(baseRecipe({ camera: { eye: [0, 1, 6], target: [0, 1, -4], fStop: 2, focusDistance: 3.5 } }));
  scene.apply([{ type: 'set-camera', fStop: null }], { expectedRevision: 0 });
  assert.equal(Object.hasOwn(scene.camera, 'fStop'), false);
  assert.equal(Object.hasOwn(scene.camera, 'focusDistance'), false);
  assert.equal(Object.hasOwn(scene.exportRecipe().camera, 'fStop'), false);
  assert.equal(Object.hasOwn(scene.exportRecipe().camera, 'focusDistance'), false);
  const effects = { depthOfField: { blur: 0, focusDistance: 5 } };
  assert.equal(effectsWithFStop(effects, scene.camera).depthOfField.blur, 0);
  scene.apply([{ type: 'set-camera', fov: 35 }], { expectedRevision: 1 });
  assert.equal(Object.hasOwn(scene.camera, 'fStop'), false);
});

test('set-camera focusDistance null clears only the focus plane', () => {
  const scene = createAgentScene(baseRecipe({ camera: { fStop: 2, focusDistance: 3.5 } }));
  scene.apply([{ type: 'set-camera', focusDistance: null }], { expectedRevision: 0 });
  assert.equal(scene.camera.fStop, 2);
  assert.equal(Object.hasOwn(scene.camera, 'focusDistance'), false);
});

test('set-camera fStop null with a numeric focusDistance says what to pass, and a recipe camera refuses null', () => {
  const scene = createAgentScene(baseRecipe({ camera: { fStop: 2, focusDistance: 3.5 } }));
  assert.throws(() => scene.apply([{ type: 'set-camera', fStop: null, focusDistance: 2 }], { expectedRevision: 0 }), /camera\.focusDistance: got 2; expected null or left out: fStop null already clears focusDistance/);
  assert.equal(scene.camera.fStop, 2);
  assert.throws(() => createAgentScene(baseRecipe({ camera: { fStop: null } })), /camera\.fStop: got null; expected a number from 0\.7 to 64/);
});

test('the MCP set-camera operation accepts fStop null and focusDistance null', async context => {
  const { client, scene } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: baseRecipe({ camera: { fStop: 2, focusDistance: 3.5 } }) } });
  const sessionId = '00000000-0000-4000-8000-000000000000';
  const clearFocus = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: scene().revision, operations: [{ type: 'set-camera', focusDistance: null }] } });
  assert.notEqual(clearFocus.isError, true, JSON.stringify(clearFocus.content));
  assert.equal(scene().camera.fStop, 2);
  assert.equal(Object.hasOwn(scene().camera, 'focusDistance'), false);
  const clearLens = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: scene().revision, operations: [{ type: 'set-camera', fStop: null }] } });
  assert.notEqual(clearLens.isError, true, JSON.stringify(clearLens.content));
  assert.equal(Object.hasOwn(scene().camera, 'fStop'), false);
});
