import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/skinning.js';
import '../src/morph.js';
import '../src/crowd-skinning.js';
import { createVertexShader, SHADER_FEATURES } from '../src/shaders.js';
import { GUARANTEED_VERTEX_ATTRIBUTE_SLOTS, assertVertexAttributeBudget, countVertexAttributeSlots } from './support/shader-attribute-budget.js';

const DEFORMATION_VARIANTS = [[], ['skin'], ['morph'], ['crowd'], ['skin', 'morph', 'crowd']];

test('the instanced main vertex shader stays within 16 attribute slots on Safari, which counts gl_InstanceID (#2042)', () => {
  for (const extra of DEFORMATION_VARIANTS) {
    const features = [...new Set([...SHADER_FEATURES, 'instanced', ...extra])];
    const source = createVertexShader(features);
    assert.match(source, /#define INSTANCED/);
    assert.match(source, /gl_InstanceID/);
    const slots = countVertexAttributeSlots(source);
    assert.ok(slots <= GUARANTEED_VERTEX_ATTRIBUTE_SLOTS, `[${extra}] uses ${slots} slots`);
  }
});

test('the non-instanced main vertex shader fits too', () => {
  const source = createVertexShader(SHADER_FEATURES.filter(feature => feature !== 'instanced'));
  assert.ok(countVertexAttributeSlots(source) <= GUARANTEED_VERTEX_ATTRIBUTE_SLOTS);
});

test('the slot count adds matrix columns and one for a built-in input', () => {
  const source = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in mat4 matrix;
layout(location=5) in mat3 normals;
#ifdef INSTANCED
// gl_VertexID in a comment does not count
void main() { gl_Position = vec4(float(gl_InstanceID)); }
#else
void main() { gl_Position = vec4(0.0); }
#endif`;
  assert.equal(countVertexAttributeSlots(source), 8);
  assert.equal(countVertexAttributeSlots(`#define INSTANCED\n${source}`), 9);
});

test('a vertex shader over the budget fails at build time with the fix', () => {
  const declarations = Array.from({ length: 16 }, (_, index) => `layout(location=${index}) in vec4 attribute${index};`).join('\n');
  const source = `#version 300 es\n${declarations}\nvoid main() { gl_Position = vec4(float(gl_InstanceID)); }`;
  assert.throws(() => assertVertexAttributeBudget(source, 'test shader'), /17 vertex attribute slots.*Pack the new attribute/);
  assert.equal(assertVertexAttributeBudget(source.replace('gl_InstanceID', '0'), 'test shader'), 16);
});
