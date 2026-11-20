// A shader feature that a draw asks for while its program is still linking must be asked for again by the draw that comes back (#1360).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { ProgramNotReady } from '../src/gl-program.js';

function fakeRenderer(rebuildMainProgram) {
  return { benchmark: false, shaderFeatures: new Set(['studioLighting']), rebuildMainProgram };
}

test('a main program that is still linking does not keep the feature it was built for', () => {
  let attempts = 0;
  const renderer = fakeRenderer(() => {
    attempts += 1;
    if (attempts === 1) throw new ProgramNotReady({});
  });
  assert.throws(() => CrucibleRenderer.prototype.requireFeatureNames.call(renderer, ['renderPass']), ProgramNotReady);
  assert.equal(renderer.shaderFeatures.has('renderPass'), false, 'the failed rebuild leaves the old program, so the feature is not recorded as built');
  CrucibleRenderer.prototype.requireFeatureNames.call(renderer, ['renderPass']);
  assert.equal(attempts, 2, 'the draw that comes back rebuilds the program');
  assert.equal(renderer.shaderFeatures.has('renderPass'), true);
});
