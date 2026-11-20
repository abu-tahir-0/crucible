import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostFragment, createLocalVolumeCompositeFragment, localVolumeKindSteps, GRID_MOTION_STEP, GRID_ONLY_STEP, SHAPE_ONLY_STEP } from '../src/post.js';
import { createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';
import '../src/fog-shader.js';

// The driver builds every inlined copy of a function, and the build of a grid volume's post program took 23 to 32 s on ANGLE d3d11
// when the in-scatter light was inlined with both the grid and the shape profile at each call site (#1768). These tests pin the
// shape of the source that made it fast, since a build time cannot be measured in a unit test. The size ceiling rose from 32500 to 33000 for the
// joint march of overlapping volumes (#1722).

const sources = {
  still: createPostFragment(['local']),
  motion: createPostFragment(['local', GRID_MOTION_STEP]),
};

function occurrences(source, text) {
  return source.split(text).length - 1;
}

for (const [name, source] of Object.entries(sources)) {
  test(`the ${name} local volume program keeps one copy of the in-scatter light per kind of volume`, () => {
    for (const kind of ['Grid', 'Shape']) {
      assert.equal(occurrences(source, `localVolumeInScatter${kind}(${kind === 'Grid' ? 'nearest' : 'member'}, position, direction)`), 1, `${kind} march calls its in-scatter once`);
      assert.equal(occurrences(source, `localVolumeSkyLight${kind}(index, position)`), 1);
      assert.equal(occurrences(source, `localVolumeDepth${kind}(index, position, lightDirection`), 1);
    }
    assert.equal(occurrences(source, 'localVolumeInScatter(nearest'), 0, 'no march uses the generic copy');
  });

  test(`the ${name} program's grid copy never reads the shape profile and the shape copy never reads the grid profile`, () => {
    const gridCopy = source.slice(source.indexOf('vec3 localVolumeDepthGrid('), source.indexOf('vec3 localVolumeDepthShape('));
    const shapeCopy = source.slice(source.indexOf('vec3 localVolumeDepthShape('), source.indexOf('// The share of the key light a surface keeps'));
    assert.ok(gridCopy.length > 0 && shapeCopy.length > 0);
    assert.doesNotMatch(gridCopy, /localVolumeShapeProfile|localVolumeProfile\(/);
    assert.doesNotMatch(shapeCopy, /localVolumeGridProfile|localVolumeProfile\(/);
  });

  test(`the ${name} program gathers the sky light in one loop over the five directions`, () => {
    for (const kind of ['Grid', 'Shape']) {
      assert.equal(occurrences(source, `localVolumeDepthOnce${kind}(index, position, direction)`), 1);
      assert.equal(occurrences(source, `localVolumeDepthOnce${kind}(index, position, vec3(`), 0, 'no direction is spelled out as its own call');
    }
  });

  test(`the ${name} program stays under its source size`, () => {
    assert.ok(source.length < 34000, `${source.length} characters`);
  });
}

// A frame whose volumes are all grids or all boxes and spheres compiles only the march it uses (#1768); a mixed frame keeps today's program.
const kindSources = {
  grid: createPostFragment(['local', GRID_ONLY_STEP]),
  shape: createPostFragment(['local', SHAPE_ONLY_STEP]),
  both: createPostFragment(['local']),
};

test('a grid-only program has the grid march and none of the box and sphere march', () => {
  const source = kindSources.grid;
  assert.equal(occurrences(source, 'localVolumeInScatterGrid(nearest, position, direction)'), 1);
  assert.equal(occurrences(source, 'localVolumeInScatterShape'), 0);
  for (const name of ['localVolumeShapeProfile', 'localVolumeNoise(', 'localVolumeWarpedFade']) assert.equal(occurrences(source, name), 0, name);
  assert.equal(occurrences(source, 'localGridSample(nearest'), 1);
});

test('a shape-only program has the box and sphere march and none of the grid march', () => {
  const source = kindSources.shape;
  assert.equal(occurrences(source, 'localVolumeInScatterShape(member, position, direction)'), 1);
  assert.equal(occurrences(source, 'localVolumeInScatterGrid'), 0);
  for (const name of ['localVolumeGridProfile', 'localGridSample(', 'localGridBlackbody(']) assert.equal(occurrences(source, name), 0, name);
});

test('the program of a mixed frame is the one it was before the variants', () => {
  assert.equal(kindSources.both, sources.still);
  assert.ok(kindSources.grid.length < kindSources.both.length && kindSources.shape.length < kindSources.both.length);
});

test('the glow composite takes the same variants and keeps one in-scatter copy', () => {
  assert.equal(createLocalVolumeCompositeFragment(), createLocalVolumeCompositeFragment(false, 'both'));
  assert.equal(occurrences(createLocalVolumeCompositeFragment(false, 'grid'), 'localVolumeInScatterShape'), 0);
  assert.equal(occurrences(createLocalVolumeCompositeFragment(false, 'shape'), 'localVolumeInScatterGrid'), 0);
  assert.equal(occurrences(createLocalVolumeCompositeFragment(true, 'grid'), 'localGridMotionPosition(nearest'), 1);
  assert.equal(occurrences(createLocalVolumeCompositeFragment(), 'localVolumeInScatterGrid(nearest, position, direction)'), 1);
});

test('the marker steps name the kind of volume a frame packs', () => {
  assert.deepEqual(localVolumeKindSteps('grid'), [GRID_ONLY_STEP]);
  assert.deepEqual(localVolumeKindSteps('shape'), [SHAPE_ONLY_STEP]);
  assert.deepEqual(localVolumeKindSteps('both'), []);
  const kindOf = volumes => packLocalVolumes(volumes, createLocalVolumeBuffers()).kind;
  const common = { center: [0, 0, 0], size: [1, 1, 1], absorption: [1, 1, 1], emission: [0, 0, 0] };
  const grid = { ...common, shape: 'grid', gridData: {} };
  const box = { ...common, shape: 'box' };
  const mesh = { ...common, shape: 'mesh', part: 'cloud' };
  assert.equal(kindOf([grid]), 'grid');
  assert.equal(kindOf([grid, mesh]), 'grid');
  assert.equal(kindOf([box]), 'shape');
  assert.equal(kindOf([box, mesh]), 'shape');
  assert.equal(kindOf([grid, box]), 'both');
  assert.equal(kindOf([mesh]), 'both');
});
