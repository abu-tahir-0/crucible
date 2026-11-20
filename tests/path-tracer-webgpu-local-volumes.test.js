// Local volumes on the WebGPU path tracer (#1048): the volume table is packed in plain JS and tested here, the kernel gets the march only for a
// scene that has volumes, boxes and spheres are drawn on a real adapter and compared to the CPU tracer (headless Chrome, skips without an adapter),
// the mesh kind the table cannot hold is refused with the backend that can draw it, and a grid volume (#1785) is packed after the table and marched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { buildTraceScene, refuseLocalVolumes } from '../src/path-tracer-scene.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { assertWebGpuLocalVolumes, buildLocalVolumeFunctions, LOCAL_VOLUME_FUNCTIONS, LOCAL_VOLUME_GRID_HEADER_TEXELS, LOCAL_VOLUME_GRID_SHAPE, LOCAL_VOLUME_HEADER_TEXELS, LOCAL_VOLUME_MESH_SHAPE, LOCAL_VOLUME_RAMP_TEXELS, LOCAL_VOLUME_TEXELS, MAX_WEBGPU_MESH_VOLUME_TRIANGLES, MESH_VOLUME_STEP_OFFSET_FRACTION, MESH_VOLUME_TRIANGLE_TEXELS, packWebGpuLocalVolumes, packWebGpuMeshVolumes, webGpuVolumeFeatures } from '../src/path-tracer-webgpu-local-volumes.js';
import { decodeVolumeGrid, encodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { meshVolumeSegments } from '../src/path-tracer-volume.js';
import { renderBlastBothBackends } from './helpers/grid-blast-render.js';
import { renderMeshVolumeBothBackends } from './helpers/mesh-volume-render.js';
import { traceOnWebGpu } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

const SMOKE_BOX = { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], emission: [0.2, 0.1, 0], emissionStrength: 2, scatter: 0.8, noiseAmount: 0.5, noiseScale: 2, steps: 24 };
const PUFF = { shape: 'sphere', center: [1, 1, 0], radius: 0.6, density: 2, falloff: 0.5 };
const EMBER = { shape: 'sphere', center: [-1.2, 0.9, 0.5], radius: 0.5, density: 0.5, emission: [1, 0.4, 0.1], emissionStrength: 3, steps: 16 };

function floorPart() {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  return { name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } };
}

const rounded = values => [...values].map(value => Math.round(value * 1e4) / 1e4);

test('the table holds the count, the sky light and eight vectors per volume in the order the kernel reads them', () => {
  const [smoke, puff] = resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes');
  const environment = { width: 2, height: 1, channels: 3, data: new Float32Array(6).fill(0.25), intensity: 2 };
  const table = packWebGpuLocalVolumes([smoke, puff], environment);
  assert.equal(table.length, (LOCAL_VOLUME_HEADER_TEXELS + 2 * LOCAL_VOLUME_TEXELS) * 4);
  assert.equal(table[0], 2);
  assert.ok(Math.abs(table[4] - 0.5) < 1e-6, `sky red ${table[4]}`);
  const first = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(first, first + 4)), [0, 1.5, 0, 0]);
  assert.deepEqual(rounded(table.subarray(first + 4, first + 8)), [1.5, 0.75, 1.5, 0.3]);
  assert.ok(Math.abs(table[first + 8] - 0.84) < 1e-6 && table[first + 11] === 0.5, 'absorption times density, then the noise amount');
  assert.ok(Math.abs(table[first + 12] - 0.4) < 1e-6 && table[first + 15] === 2, 'emission times strength, then the noise scale');
  assert.deepEqual(rounded(table.subarray(first + 16, first + 20)), [24, 0.8, 0, 0]);
  assert.deepEqual([...table.subarray(first + 20, first + 32)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const second = first + LOCAL_VOLUME_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(second, second + 4)), [1, 1, 0, 1]);
  assert.deepEqual(rounded(table.subarray(second + 4, second + 8)), [0.6, 0.6, 0.6, 0.5]);
  assert.ok(table[second + 18] === 0 && Math.abs(table[second + 19] - 0.6) < 1e-6, 'anisotropy and the radius');
});

test('a rotated box packs its axes rows, and more volumes than the limit are refused', () => {
  const turn = Math.PI / 2;
  const rotated = { ...resolveLocalVolumes([SMOKE_BOX], 'volumes')[0], axes: [Math.cos(turn), 0, Math.sin(turn), 0, 1, 0, -Math.sin(turn), 0, Math.cos(turn)] };
  const table = packWebGpuLocalVolumes([rotated], null);
  const rows = LOCAL_VOLUME_HEADER_TEXELS * 4 + 20;
  assert.ok(Math.abs(table[rows + 2] - 1) < 1e-6 && Math.abs(table[rows + 8] + 1) < 1e-6);
  assert.throws(() => packWebGpuLocalVolumes(new Array(9).fill(rotated), null), /at most 8 local volumes, got 9/);
});

test('the march is compiled into the megakernel only for a scene that has local volumes, and fog keeps its single phase function', () => {
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /crossLocalVolumes|localVolumeProfile/);
  const localSource = buildMegakernelSource({ hasLocalVolumes: true });
  assert.match(localSource, /fn crossLocalVolumes\(/);
  assert.match(localSource, /crossLocalVolumes\(depth, position,/);
  assert.equal(localSource.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.doesNotMatch(localSource, /scatterInFog/);
  const both = buildMegakernelSource({ hasLocalVolumes: true, hasVolume: true });
  assert.equal(both.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.match(both, /fn scatterInFog\(/);
});

// A closed L-shaped prism (three unit squares in x and z, the notch at x and z in 1..2, extruded in y from 0 to 1) and two unit boxes with a gap of two units: the shapes of the mesh volume tests.
function lPrismMesh() {
  const outline = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]];
  const positions = [];
  for (const height of [0, 1]) for (const [x, z] of outline) positions.push(x, height, z);
  const indices = [];
  const top = outline.length;
  for (const [firstCorner, secondCorner, thirdCorner, fourthCorner] of [[0, 1, 4, 7], [1, 2, 3, 4], [7, 4, 5, 6]]) {
    indices.push(firstCorner, secondCorner, thirdCorner, firstCorner, thirdCorner, fourthCorner, top + firstCorner, top + thirdCorner, top + secondCorner, top + firstCorner, top + fourthCorner, top + thirdCorner);
  }
  for (let corner = 0; corner < outline.length; corner++) {
    const next = (corner + 1) % outline.length;
    indices.push(corner, next, top + next, corner, top + next, top + corner);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function dumbbellMesh() {
  const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const positions = [...corners];
  for (let index = 0; index < corners.length; index += 3) positions.push(corners[index] + 3, corners[index + 1], corners[index + 2]);
  return { positions: new Float32Array(positions), indices: new Uint32Array([...faces, ...faces.map(index => index + 8)]) };
}

const MESH_SMOKE = { shape: 'mesh', part: 'room', fit: 'mesh', density: 1.2, falloff: 0, steps: 24, emission: [0.9, 0.45, 0.15], emissionStrength: 1.5 };

// The trace scene of a hidden part of that shape with a mesh volume over it: its volumes are what the WebGPU tracer receives (the mesh BVH built by buildTraceScene).
function meshVolumeScene(mesh, matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) {
  const room = { name: 'room', visible: false, geometry: { ...mesh, normals: new Float32Array(mesh.positions.length) }, matrix, material: { color: [0.5, 0.5, 0.5] } };
  return buildTraceScene([floorPart(), room], { localVolumes: [MESH_SMOKE] });
}

test('a mesh volume is drawn by the WebGPU tracer once its BVH is built, and a part that was never prepared is refused with what to do', () => {
  const scene = meshVolumeScene(lPrismMesh());
  assert.doesNotThrow(() => assertWebGpuLocalVolumes(scene));
  assert.equal(webGpuVolumeFeatures(scene.localVolumes).hasMeshVolume, true);
  assert.equal(webGpuVolumeFeatures(resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes')).hasMeshVolume, false);
  assert.throws(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'box' }, { shape: 'mesh', part: { name: 'room' } }] }), /localVolumes\[1\] is a mesh volume that was not prepared for tracing; build the scene with buildTraceScene/);
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'grid', gridData: {} }] }));
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes') }));
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({}));
});

test('a mesh volume packs the mesh shape code and its mesh number in its table row, and the header says where the mesh block starts', () => {
  const scene = meshVolumeScene(lPrismMesh());
  const table = packWebGpuLocalVolumes(scene.localVolumes, null);
  const row = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.equal(table[row + 3], LOCAL_VOLUME_MESH_SHAPE);
  assert.equal(table[row + 19], 0, 'the first mesh volume');
  assert.equal(table[1], LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS, 'the block follows the one table row, counted in vectors');
  assert.deepEqual(rounded(table.subarray(row + 16, row + 19)), [24, 0, 0], 'the steps of the volume, no scatter');
  const [plainBox] = resolveLocalVolumes([SMOKE_BOX], 'volumes');
  assert.equal(packWebGpuLocalVolumes([plainBox], null)[1], 0, 'a scene without a mesh volume keeps 0 in the second header float');
});

// The packed mesh block read the way the WGSL reads it, with a plain loop over the leaves instead of the stack walk: the nearest surface along a ray, or -1.
function nearestPackedSurface(block, meshNumber, origin, direction) {
  const descriptor = (1 + meshNumber) * 4;
  const nodeStart = block[descriptor];
  const triangleStart = block[descriptor + 1];
  const nodeCount = block[descriptor + 3];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let nearest = Infinity;
  for (let node = 0; node < nodeCount; node++) {
    const header = (nodeStart + node * 2) * 4;
    const leafCount = -block[header + 3];
    if (!(leafCount > 0)) continue;
    const first = block[header + 7];
    for (let slot = first; slot < first + leafCount; slot++) {
      const base = (triangleStart + slot * 3) * 4;
      const corner = [block[base], block[base + 1], block[base + 2]];
      const edgeFirst = [block[base + 4], block[base + 5], block[base + 6]];
      const edgeSecond = [block[base + 8], block[base + 9], block[base + 10]];
      const pivot = cross(direction, edgeSecond);
      const determinant = dot(edgeFirst, pivot);
      if (determinant === 0) continue;
      const offset = origin.map((value, axis) => value - corner[axis]);
      const firstWeight = dot(offset, pivot) / determinant;
      if (firstWeight < 0 || firstWeight > 1) continue;
      const query = cross(offset, edgeFirst);
      const secondWeight = dot(direction, query) / determinant;
      if (secondWeight < 0 || firstWeight + secondWeight > 1) continue;
      const distance = dot(edgeSecond, query) / determinant;
      if (distance >= 0 && distance < nearest) nearest = distance;
    }
  }
  return nearest === Infinity ? -1 : nearest;
}

// The inside segments of the packed mesh volume by the crossing walk of meshVolumeSegments in the WGSL.
function packedSegments(table, origin, direction, limit) {
  const block = table.subarray(table[1] * 4);
  const stepOffset = block[6];
  const crossings = [];
  let cursor = 0;
  while (crossings.length < 64) {
    const distance = nearestPackedSurface(block, 0, origin.map((value, axis) => value + direction[axis] * cursor), direction);
    if (distance < 0) break;
    cursor += distance;
    crossings.push(cursor);
    cursor += stepOffset;
  }
  let inside = crossings.length % 2 === 1;
  let start = 0;
  const segments = [];
  for (const crossing of crossings) {
    if (inside) {
      const end = Math.min(crossing, limit);
      if (end > start) segments.push([start, end]);
    } else {
      start = crossing;
    }
    inside = !inside;
  }
  return segments;
}

test('the packed mesh block gives the segments the CPU tracer finds: an L arm, the notch, a ray that leaves and comes back, and a ray that starts inside', () => {
  const cpuSegments = (scene, origin, direction, limit) => {
    const out = new Float64Array(64);
    const count = meshVolumeSegments(scene.localVolumes[0], ...origin, ...direction, limit, out);
    return Array.from({ length: count }, (value, segment) => [out[segment * 2], out[segment * 2 + 1]]);
  };
  const close = (actual, expected, label) => {
    const message = `${label}: ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`;
    assert.equal(actual.length, expected.length, message);
    actual.forEach((segment, index) => segment.forEach((value, end) => assert.ok(Math.abs(value - expected[index][end]) < 1e-3, message)));
  };
  const lShape = meshVolumeScene(lPrismMesh());
  const lTable = packWebGpuLocalVolumes(lShape.localVolumes, null);
  const rays = [
    ['through the long arm', [-1, 0.37, 0.43], [1, 0, 0], 10],
    ['through the notch', [-1, 0.37, 1.5], [1, 0, 0], 10],
    ['down through the corner', [0.5, 5, 0.5], [0, -1, 0], 20],
    ['starting inside', [0.5, 0.5, 0.5], [1, 0, 0], 10],
    ['clipped by the limit', [-1, 0.37, 0.43], [1, 0, 0], 2],
    ['a miss', [-1, 3, 0.43], [1, 0, 0], 10],
  ];
  for (const [label, origin, direction, limit] of rays) close(packedSegments(lTable, origin, direction, limit), cpuSegments(lShape, origin, direction, limit), label);
  assert.equal(cpuSegments(lShape, [-1, 0.37, 1.5], [1, 0, 0], 10).length, 1, 'the notch ray crosses the first arm only');
  const twoShells = meshVolumeScene(dumbbellMesh());
  const through = cpuSegments(twoShells, [-1, 0.5, 0.5], [1, 0, 0], 20);
  assert.equal(through.length, 2, 'the ray leaves the first box and enters the second');
  close(packedSegments(packWebGpuLocalVolumes(twoShells.localVolumes, null), [-1, 0.5, 0.5], [1, 0, 0], 20), through, 'a ray that leaves and comes back');
});

test('the mesh block holds the triangles in world space, the BVH nodes of packNodes and a step offset past a crossing', () => {
  const placed = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 0, 0, 1]);
  const scene = meshVolumeScene(dumbbellMesh(), placed);
  const [volume] = scene.localVolumes;
  const table = packWebGpuLocalVolumes(scene.localVolumes, null);
  const block = table.subarray(table[1] * 4);
  const { bvh, indices, positions } = volume.mesh;
  assert.equal(block[0], 1, 'one mesh volume');
  assert.equal(block[7], bvh.nodeCount);
  assert.ok(Math.abs(block[6] - Math.hypot(...volume.size) * MESH_VOLUME_STEP_OFFSET_FRACTION) < 1e-6, 'a fraction of the volume diagonal');
  const triangleBase = block[5] * 4;
  const triangle = bvh.triangleOrder[0];
  const cornerAt = vertex => Array.from(positions.subarray(indices[triangle * 3 + vertex] * 3, indices[triangle * 3 + vertex] * 3 + 3));
  assert.deepEqual(rounded(block.subarray(triangleBase, triangleBase + 3)), rounded(cornerAt(0)), 'the first corner of the first leaf slot, in world space');
  assert.deepEqual(rounded(block.subarray(triangleBase + 4, triangleBase + 7)), rounded(cornerAt(1).map((value, axis) => value - cornerAt(0)[axis])), 'then the edge to the second corner');
  assert.ok(Math.min(...positions.filter((value, index) => index % 3 === 0)) >= 10, 'the part matrix moved the mesh');
  assert.equal(block.length, (1 + 1 + bvh.nodeCount * 2 + (indices.length / 3) * MESH_VOLUME_TRIANGLE_TEXELS) * 4, 'header, descriptor, nodes and triangles');
});

test('the mesh volumes of one scene may hold at most the triangle limit, and the error says what to pass instead', () => {
  const tooMany = { mesh: { indices: new Uint32Array(3 * (MAX_WEBGPU_MESH_VOLUME_TRIANGLES + 1)) } };
  assert.throws(() => packWebGpuMeshVolumes([tooMany]), /at most 262144 triangles across mesh local volumes, got 262145; simplify the parts or use backend "cpu"/);
});

test('the mesh march is compiled only for a scene that has a mesh volume, and any other scene gets the kernel it had before mesh volumes', () => {
  assert.equal(LOCAL_VOLUME_FUNCTIONS, buildLocalVolumeFunctions({ hasMesh: false }));
  assert.equal(buildLocalVolumeFunctions({ hasGrid: true, hasNoiseOctaves: true, hasEmissionRamp: true }), buildLocalVolumeFunctions({ hasGrid: true, hasNoiseOctaves: true, hasEmissionRamp: true, hasMesh: false }));
  const plain = buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true, hasNoiseOctaves: true, hasEmissionRamp: true });
  assert.doesNotMatch(plain, /mesh|Mesh/);
  assert.match(plain, /if \(!localVolumeInterval\(volume, origin, direction, segmentLength\)\) \{ continue; \}\n    entries\[volume\] = localSpan\.x;/);
  const withMesh = buildMegakernelSource({ hasLocalVolumes: true, hasMeshVolume: true });
  assert.match(withMesh, /fn meshVolumeSegments\(volume: i32, origin: vec3<f32>, rayDirection: vec3<f32>, limit: f32\) -> i32/);
  assert.match(withMesh, /fn meshNearestSurface\(/);
  assert.match(withMesh, /emitted \+= crossLocalMesh\(volume, origin, segmentLength, jitter\);/);
  assert.match(withMesh, /localSpan = vec2<f32>\(meshSegments\[0\], meshSegments\[segmentCount \* 2 - 1\]\);/);
  assert.match(withMesh, /let steps = max\(1, i32\(floor\(volumeSteps \* segmentLength \/ total \+ 0\.5\)\)\);/, 'the steps are shared by segment length, rounded half up as Math.round does');
  assert.match(withMesh, /var inside = \(crossingCount % 2\) == 1;/, 'the origin is inside when the crossings ahead are odd');
});

test('on a WebGPU adapter a mesh volume over an L-shaped room matches the CPU tracer', { timeout: 300000 }, async context => {
  await withWebGpuPage(context, async page => {
    const { cpu, webgpu } = await page.evaluate(renderMeshVolumeBothBackends, { width: 48, height: 30, samples: 32 });
    let difference = 0;
    let reference = 0;
    let lit = 0;
    cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - webgpu.linear[index]);
      reference += value;
      if (value > 0.05) lit++;
    });
    assert.deepEqual(webgpu.ignored, []);
    assert.ok(lit > 200, `the room shows in the frame: ${lit} lit values`);
    assert.ok(difference / reference < 0.05, `mean relative difference ${(difference / reference).toFixed(4)}`);
  }, { hardwareOnly: true });
});

// A 2 x 2 x 1 grid with distinct values per voxel, bound as a volume with the options a test turns on.
function boundGrid(options = {}) {
  const resolution = [2, 2, 1];
  const velocity = options.shutter > 0 ? { velocityX: [0.5, 1, 1.5, 2], velocityY: [0, 0, 0, 0], velocityZ: [0, 0, 0, 0] } : {};
  const channels = { density: [0.25, 0.5, 0.75, 1], temperature: [0, 0, 2, 3], flame: [1, 0.5, 0.25, 0], ...velocity };
  registerVolumeGrid('webgpu-grid-1785', decodeVolumeGrid(encodeVolumeGrid({ resolution, channels, size: [2, 2, 2] })));
  const resolved = resolveLocalVolumes([{ shape: 'grid', grid: 'webgpu-grid-1785', center: [0, 1, 0], density: 2, emission: [1, 0.5, 0.25], emissionStrength: 4, steps: 24, scatter: options.scatter ?? 0, blackbodyIntensity: options.blackbodyIntensity ?? 0, temperatureScale: 1000 }], 'volumes');
  return bindLocalVolumeParts(resolved, [], { shutter: options.shutter ?? 0 })[0];
}

test('a grid volume packs its table row with the grid shape code, then a block of resolution, flags and voxels in the grid file order', () => {
  const table = packWebGpuLocalVolumes([boundGrid()], null);
  const row = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(row, row + 4)), [0, 1, 0, LOCAL_VOLUME_GRID_SHAPE]);
  assert.deepEqual(rounded(table.subarray(row + 4, row + 7)), [1, 1, 1], 'half the size of the box');
  assert.equal(table[row + 16], 24, 'the step count of the grid');
  const block = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4;
  assert.equal(table.length, block + (LOCAL_VOLUME_GRID_HEADER_TEXELS + 4) * 4, 'one vector per voxel while blackbody and shutter are off');
  assert.deepEqual(rounded(table.subarray(block, block + 8)), [2, 2, 1, 0, 0, 0, 0, 1]);
  const voxels = block + LOCAL_VOLUME_GRID_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(voxels, voxels + 16)), [0.25, 1, 0, 0, 0.5, 0.5, 0, 0, 0.75, 0.25, 0, 0, 1, 0, 0, 0], 'density then flame, x fastest');
});

test('a grid with a blackbody and a shutter packs the baked radiance and the unit velocity after each voxel, and the header says so', () => {
  const volume = boundGrid({ blackbodyIntensity: 0.3, shutter: 0.04 });
  const table = packWebGpuLocalVolumes([volume], null);
  const block = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4;
  assert.ok(Math.abs(table[block + 3] - 0.3 * 4) < 1e-6, 'blackbody weight is intensity times emission strength');
  assert.deepEqual(rounded(table.subarray(block + 4, block + 8)), [0.04, 1, 1, 3]);
  assert.equal(table.length, block + (LOCAL_VOLUME_GRID_HEADER_TEXELS + 4 * 3) * 4);
  const coldVoxel = block + LOCAL_VOLUME_GRID_HEADER_TEXELS * 4;
  const hotVoxel = coldVoxel + 2 * 3 * 4;
  assert.deepEqual([...table.subarray(coldVoxel + 4, coldVoxel + 7)], [0, 0, 0], 'a cold voxel has no baked radiance');
  assert.ok(table[hotVoxel + 4] > 0, 'the voxel at 2000 K glows');
  assert.deepEqual(rounded(table.subarray(hotVoxel + 8, hotVoxel + 11)), [0.75, 0, 0], 'unit velocity: 1.5 m/s over a 2 m box');
});

test('the grid march is compiled only for a scene that has a grid, and a scene without one gets the kernel it had before grids', () => {
  assert.equal(LOCAL_VOLUME_FUNCTIONS, buildLocalVolumeFunctions({ hasGrid: false }));
  const plain = buildMegakernelSource({ hasLocalVolumes: true });
  assert.doesNotMatch(plain, /crossLocalGrid|localGridSample|GridCell/);
  const withGrid = buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true });
  assert.match(withGrid, /fn crossLocalGrid\(/);
  assert.match(withGrid, /emitted \+= crossLocalGrid\(volume, origin, entries\[volume\], exits\[volume\] - entries\[volume\], jitter\);/);
  assert.match(withGrid, /if \(localVolumeTexel\(volume, 0\)\.w < -0\.5\) \{ return localGridSample\(volume, point\)\.density; \}/);
  assert.match(withGrid, /const LOCAL_GRID_TIME_STEP: f32 = 0\.618034;/);
  assert.match(withGrid, /for \(var corner = 0; corner < 8; corner\+\+\)/, 'trilinear over eight corners');
  assert.match(withGrid, /let stepCount = localVolumeStepCount\(volume, span\);/, 'the grid step count is the volume rule, capped by LOCAL_VOLUME_MAXIMUM_STEPS');
  assert.match(withGrid, /const LOCAL_VOLUME_MAXIMUM_STEPS: f32 = \d+\.0;/);
});

// A grid that carries velocity, traced through buildTraceScene as the WebGPU tracer receives it, with the shutter value a test passes in the environment.
function tracedGridScene(volumeShutter) {
  const channels = { density: [0.25, 0.5, 0.75, 1], temperature: [0, 0, 2, 3], velocityX: [0.5, 1, 1.5, 2], velocityY: [0, 0, 0, 0], velocityZ: [0, 0, 0, 0] };
  registerVolumeGrid('webgpu-grid-1785-moving', decodeVolumeGrid(encodeVolumeGrid({ resolution: [2, 2, 1], channels, size: [2, 2, 2] })));
  const volume = { shape: 'grid', grid: 'webgpu-grid-1785-moving', center: [0, 1, 0], density: 2, emission: [1, 0.5, 0.25], emissionStrength: 4, steps: 24, blackbodyIntensity: 0.3, temperatureScale: 1000 };
  return buildTraceScene([floorPart()], { localVolumes: [volume], ...(volumeShutter === undefined ? {} : { volumeShutter }) });
}

test('with the shutter off or unset a grid that carries velocity uploads the table and the kernel it had before shutter support (#1785)', () => {
  const unset = tracedGridScene(undefined);
  const off = tracedGridScene(0);
  const unsetTable = packWebGpuLocalVolumes(unset.localVolumes, unset.environment);
  const offTable = packWebGpuLocalVolumes(off.localVolumes, off.environment);
  assert.deepEqual(Buffer.from(offTable.buffer), Buffer.from(unsetTable.buffer), 'volumeShutter 0 packs the same bytes as no volumeShutter');
  const block = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4;
  assert.deepEqual([...offTable.subarray(block + 4, block + 8)], [0, 1, 0, 2], 'header: shutter 0, blackbody baked, no velocity, two vectors per voxel');
  assert.equal(offTable.length, block + (LOCAL_VOLUME_GRID_HEADER_TEXELS + 4 * 2) * 4, 'no velocity vector per voxel is uploaded');
  assert.equal(off.localVolumes[0].motionShutter, undefined, 'the bound volume carries no motion shutter');
  const features = webGpuVolumeFeatures(off.localVolumes);
  assert.equal(buildMegakernelSource({ hasLocalVolumes: true, ...features }), buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true }), 'the shutter adds no kernel variant');
  const open = tracedGridScene(1 / 12);
  const openTable = packWebGpuLocalVolumes(open.localVolumes, open.environment);
  assert.equal(openTable.length, offTable.length + 4 * 4, 'control: an open shutter adds one velocity vector per voxel');
  assert.ok(Math.abs(openTable[block + 4] - 1 / 12) < 1e-6 && openTable[block + 6] === 1, 'control: the header carries the shutter and the velocity flag');
});

test('a scene without a grid packs and compiles the same whatever volumeShutter says (#1785)', () => {
  const plain = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX, PUFF] });
  const shuttered = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX, PUFF], volumeShutter: 1 / 12 });
  assert.deepEqual(Buffer.from(packWebGpuLocalVolumes(shuttered.localVolumes, shuttered.environment).buffer), Buffer.from(packWebGpuLocalVolumes(plain.localVolumes, plain.environment).buffer));
  assert.deepEqual(webGpuVolumeFeatures(shuttered.localVolumes), webGpuVolumeFeatures(plain.localVolumes));
  assert.equal(webGpuVolumeFeatures(plain.localVolumes).hasGridVolume, false);
});

// How closely two difference images point the same way: the Pearson correlation of their pixels.
function correlation(first, second) {
  const meanOf = values => values.reduce((total, value) => total + value, 0) / values.length;
  const firstMean = meanOf(first);
  const secondMean = meanOf(second);
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  first.forEach((value, index) => {
    covariance += (value - firstMean) * (second[index] - secondMean);
    firstVariance += (value - firstMean) ** 2;
    secondVariance += (second[index] - secondMean) ** 2;
  });
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

test('the WebGL tracers still refuse every local volume, and the wavefront kernel refuses them before it asks for an adapter', async () => {
  const scene = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX] });
  assert.throws(() => refuseLocalVolumes(scene, 'backend "gpu"'), /traced by the CPU path tracer only; backend "gpu" cannot draw them/);
  await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volume fog, local volumes or subsurface/);
});

// Runs in the page: the same scene on the CPU and the WebGPU tracer, with the seconds each took.
async function renderBothBackends({ volumes, width, height, samples }) {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  const parts = [{ name: 'floor', geometry: makeBox(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } }];
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: volumes, keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map };
  const camera = { eye: [0, 2.2, 5], target: [0, 1, 0], fov: 45 };
  const result = {};
  for (const backend of ['cpu', 'webgpu']) {
    const started = performance.now();
    const image = await renderPathTracedImage({ parts, environment, camera }, { width, height, samples, bounces: 3, seed: 7, backend, denoise: false, threads: 1 });
    result[backend] = { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000 };
  }
  return result;
}

test('on a WebGPU adapter box and sphere volumes match the CPU tracer', { timeout: 300000 }, async context => {
  await withWebGpuPage(context, async page => {
    const { cpu, webgpu } = await page.evaluate(renderBothBackends, { volumes: [SMOKE_BOX, PUFF, EMBER], width: 48, height: 30, samples: 32 });
    let difference = 0;
    let reference = 0;
    let lit = 0;
    cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - webgpu.linear[index]);
      reference += value;
      if (value > 0.05) lit++;
    });
    assert.ok(lit > 200, `the volumes show in the frame: ${lit} lit values`);
    assert.ok(difference / reference < 0.05, `mean relative difference ${(difference / reference).toFixed(4)}`);
  }, { hardwareOnly: true });
});

test('on a WebGPU adapter the #1735 blast grid matches the CPU tracer, and its motion blur changes the frame as the CPU blur does', { timeout: 600000 }, async context => {
  await withWebGpuPage(context, async page => {
    const frame = { resolution: 32, width: 64, height: 40, samples: 48, volumeTime: 3 / 24 };
    const sharp = await page.evaluate(renderBlastBothBackends, { ...frame, volumeShutter: 0 });
    let difference = 0;
    let reference = 0;
    sharp.cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - sharp.webgpu.linear[index]);
      reference += value;
    });
    assert.deepEqual(sharp.webgpu.ignored, []);
    assert.ok(reference / sharp.cpu.linear.length > 0.05, 'the blast shows in the frame');
    assert.ok(difference / reference < 0.05, `shutter off: mean relative difference ${(difference / reference).toFixed(4)}`);
    const blurred = await page.evaluate(renderBlastBothBackends, { ...frame, volumeShutter: 1 / 12 });
    const changeOf = backend => blurred[backend].linear.map((value, index) => value - sharp[backend].linear[index]);
    const cpuChange = changeOf('cpu');
    const webgpuChange = changeOf('webgpu');
    assert.ok(Math.max(...webgpuChange.map(Math.abs)) > 0.02, 'the shutter changes the WebGPU frame');
    const agreement = correlation(cpuChange, webgpuChange);
    assert.ok(agreement > 0.8, `the blur changes both frames the same way: correlation ${agreement.toFixed(3)}`);
  }, { hardwareOnly: true });
});

const OCTAVE_SMOKE = { shape: 'sphere', center: [0, 1, 0], radius: 1.2, density: 1.5, falloff: 0.6, emission: [0.3, 0.2, 0.1], emissionStrength: 2, noiseAmount: 0.8, noiseScale: 3, noiseOctaves: 4, steps: 32 };
const RAMP_FIRE = { shape: 'box', center: [0, 1, 0], size: [2, 2, 2], density: 1, falloff: 0.5, emissionStrength: 3, steps: 32, emissionRamp: { source: 'density', stops: [[0, 0, 0], [1, 0.3, 0], [1, 0.9, 0.6]], exposure: 1.5 } };

test('noiseOctaves and emissionRamp no longer throw on the WebGPU tracer', () => {
  const volumes = resolveLocalVolumes([OCTAVE_SMOKE, RAMP_FIRE], 'volumes');
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: volumes }));
  assert.deepEqual(webGpuVolumeFeatures(volumes), { hasGridVolume: false, hasNoiseOctaves: true, hasEmissionRamp: true, hasMeshVolume: false });
  assert.deepEqual(webGpuVolumeFeatures(resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes')), { hasGridVolume: false, hasNoiseOctaves: false, hasEmissionRamp: false, hasMeshVolume: false });
});

test('the table keeps the octaves after the first in vector 5 and the ramp number in vector 7, and a ramp block follows with the stops baked', () => {
  const [smoke, fire] = resolveLocalVolumes([OCTAVE_SMOKE, RAMP_FIRE], 'volumes');
  const table = packWebGpuLocalVolumes([smoke, fire], null);
  const tableLength = (LOCAL_VOLUME_HEADER_TEXELS + 2 * LOCAL_VOLUME_TEXELS) * 4;
  const first = LOCAL_VOLUME_HEADER_TEXELS * 4;
  const second = first + LOCAL_VOLUME_TEXELS * 4;
  assert.equal(table[first + 23], 3, 'four octaves are stored as three after the first');
  assert.equal(table[first + 31], 0, 'the sphere has no ramp');
  assert.equal(table[second + 23], 0, 'one octave stores 0');
  assert.equal(table[second + 31], 1, 'ramp number 1');
  assert.equal(table.length, tableLength + LOCAL_VOLUME_RAMP_TEXELS * 4);
  const ramp = table.subarray(tableLength);
  assert.deepEqual(rounded(ramp.subarray(0, 4)), [1, 3, 0, 1], 'source density is code 1, three stops, range 0 to 1');
  assert.equal(ramp[4], 3, 'emission strength');
  assert.deepEqual(rounded(ramp.subarray(12, 16)), [1.5, 0.45, 0, 0], 'the second stop times the exposure');
  assert.deepEqual(rounded(ramp.subarray(16, 20)), [1.5, 1.35, 0.9, 0]);
  assert.deepEqual(rounded(ramp.subarray(20, 24)), [0, 0, 0, 0], 'unused stops are 0');
  assert.equal(packWebGpuLocalVolumes([smoke], null).length, (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS) * 4, 'no ramp, no ramp block');
});

test('a grid with a ramp packs its temperature channel, and the ramp block sits after the grid block', () => {
  const grid = boundGrid({});
  const withRamp = { ...grid, emissionRamp: { source: 'temperature', range: [0, 3], exposure: 1, stops: [[0, 0, 0], [1, 1, 1]] } };
  const plain = packWebGpuLocalVolumes([grid], null);
  const ramped = packWebGpuLocalVolumes([withRamp], null);
  const voxels = (LOCAL_VOLUME_HEADER_TEXELS + LOCAL_VOLUME_TEXELS + LOCAL_VOLUME_GRID_HEADER_TEXELS) * 4;
  assert.deepEqual([0, 1, 2, 3].map(voxel => plain[voxels + voxel * 4 + 2]), [0, 0, 0, 0], 'without a ramp the third float of a voxel is 0');
  assert.deepEqual([0, 1, 2, 3].map(voxel => ramped[voxels + voxel * 4 + 2]), [0, 0, 2, 3], 'with a ramp it is the temperature');
  assert.equal(ramped.length, plain.length + LOCAL_VOLUME_RAMP_TEXELS * 4);
  assert.deepEqual(rounded(ramped.subarray(plain.length, plain.length + 4)), [2, 2, 0, 3], 'temperature is source 2');
});

test('the fractal noise and the ramp light are compiled only for a scene that uses them, and the other kernels stay as they were', () => {
  const plain = buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true });
  assert.doesNotMatch(plain, /localVolumeFractalNoise|localEmissionRampLight|localRampBase|temperature: f32/);
  assert.equal(buildLocalVolumeFunctions({ hasGrid: true, hasNoiseOctaves: false, hasEmissionRamp: false }), buildLocalVolumeFunctions({ hasGrid: true }));
  const octaves = buildMegakernelSource({ hasLocalVolumes: true, hasNoiseOctaves: true });
  assert.match(octaves, /fn localVolumeFractalNoise\(position: vec3<f32>, octaves: i32\) -> f32/);
  assert.match(octaves, /noise = localVolumeFractalNoise\(point \* noiseScale, i32\(localVolumeTexel\(volume, 5\)\.w\) \+ 1\);/);
  assert.match(octaves, /weight \*= 0\.5;\n\s+frequency \*= 2\.0;/, 'the gain and lacunarity of localVolumeFractalNoise');
  assert.doesNotMatch(octaves, /localEmissionRampLight/);
  const ramp = buildMegakernelSource({ hasLocalVolumes: true, hasEmissionRamp: true });
  assert.match(ramp, /emitted \+= throughput \* localEmissionRampLight\(volume, vec3<f32>\(profile\), stepLength\) \* volumeStepIntegral\(extinction \* width\);/);
  assert.doesNotMatch(ramp, /localVolumeFractalNoise|GridCell/);
  assert.doesNotMatch(ramp, /resolution\.x \* resolution\.y/, 'without a grid the ramp block follows the table');
  const gridRamp = buildMegakernelSource({ hasLocalVolumes: true, hasGridVolume: true, hasEmissionRamp: true });
  assert.match(gridRamp, /localEmissionRampLight\(volume, vec3<f32>\(cell\.density, cell\.temperature, cell\.flame\), stepLength\) \* volumeStepIntegral\(extinction \* width\);/);
  assert.match(gridRamp, /cell\.temperature \+= found\.weight \* values\.z;/);
  assert.match(gridRamp, /resolution\.x \* resolution\.y \* resolution\.z \* i32\(materials\[base \+ 1\]\.w\)/, 'the ramp block follows the grid block');
});

// Mean relative difference and RMSE between the two backends of a rendered pair, and how many values are lit.
function compareBackends({ cpu, webgpu }) {
  let difference = 0;
  let reference = 0;
  let squared = 0;
  let lit = 0;
  cpu.linear.forEach((value, index) => {
    const delta = value - webgpu.linear[index];
    difference += Math.abs(delta);
    squared += delta * delta;
    reference += value;
    if (value > 0.05) lit++;
  });
  return { relative: difference / reference, rmse: Math.sqrt(squared / cpu.linear.length), lit };
}

test('on a WebGPU adapter fractal noise octaves and an emission ramp match the CPU tracer', { timeout: 600000 }, async context => {
  await withWebGpuPage(context, async page => {
    const frame = { width: 48, height: 30, samples: 32 };
    for (const [label, volumes] of [['noiseOctaves', [OCTAVE_SMOKE]], ['emissionRamp', [RAMP_FIRE]]]) {
      const pair = await page.evaluate(renderBothBackends, { volumes, ...frame });
      const { relative, lit } = compareBackends(pair);
      assert.ok(lit > 100, `${label} shows in the frame: ${lit} lit values`);
      assert.ok(relative < 0.05, `${label}: mean relative difference ${relative.toFixed(4)}`);
    }
    const oneOctave = await page.evaluate(renderBothBackends, { volumes: [{ ...OCTAVE_SMOKE, noiseOctaves: 1 }], ...frame });
    const fourOctaves = await page.evaluate(renderBothBackends, { volumes: [OCTAVE_SMOKE], ...frame });
    const octaveChange = compareBackends({ cpu: oneOctave.webgpu, webgpu: fourOctaves.webgpu }).rmse;
    assert.ok(octaveChange > 5 * compareBackends(fourOctaves).rmse, `the octaves change the WebGPU frame (rmse ${octaveChange}) well above the backend difference`);
  }, { hardwareOnly: true });
});

test('on a WebGPU adapter the #1735 blast with an emission ramp matches the CPU tracer', { timeout: 600000 }, async context => {
  await withWebGpuPage(context, async page => {
    const emissionRamp = { source: 'temperature', range: [0, 1], exposure: 6, stops: [[0, 0, 0], [1, 0.25, 0], [1, 0.8, 0.4]] };
    const frame = { resolution: 32, width: 64, height: 40, samples: 48, volumeTime: 3 / 24, volumeShutter: 0 };
    const withoutRamp = await page.evaluate(renderBlastBothBackends, frame);
    const withRamp = await page.evaluate(renderBlastBothBackends, { ...frame, volumeExtra: { emissionRamp } });
    const { relative } = compareBackends(withRamp);
    assert.deepEqual(withRamp.webgpu.ignored, []);
    assert.ok(relative < 0.05, `mean relative difference ${relative.toFixed(4)}`);
    const rampChange = compareBackends({ cpu: withoutRamp.webgpu, webgpu: withRamp.webgpu }).rmse;
    assert.ok(rampChange > 5 * compareBackends(withRamp).rmse, `the ramp changes the WebGPU frame (rmse ${rampChange}) well above the backend difference`);
  }, { hardwareOnly: true });
});
