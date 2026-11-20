// Safari (ANGLE on Metal) counts gl_InstanceID and gl_VertexID against MAX_VERTEX_ATTRIBS, which is 16 on Apple GPUs,
// while Chrome's backends do not. A vertex shader that fits Chrome can therefore fail to link on Safari (#2042).
// tests/shader-attribute-budget.test.js builds every main vertex shader variant and fails when one goes over, so the
// check costs no bytes in the shipped bundle.
export const GUARANTEED_VERTEX_ATTRIBUTE_SLOTS = 16;

const SLOTS_BY_TYPE = Object.freeze({ mat4: 4, mat3: 3, mat2: 2 });
const BUILT_IN_INPUT = /\bgl_(InstanceID|VertexID)\b/;

/** Removes the lines an #ifdef, #ifndef or #else leaves out, given the macros the source defines itself. */
function activeSource(source) {
  const defined = new Set([...source.matchAll(/^#define\s+(\w+)/gm)].map(match => match[1]));
  const kept = [];
  const stack = [];
  for (const line of source.split('\n')) {
    const directive = line.match(/^\s*#\s*(ifdef|ifndef|else|endif)\b\s*(\w*)/);
    if (!directive) {
      if (stack.every(Boolean)) kept.push(line);
      continue;
    }
    const [, name, macro] = directive;
    if (name === 'ifdef') stack.push(defined.has(macro));
    else if (name === 'ifndef') stack.push(!defined.has(macro));
    else if (name === 'else') stack.push(!stack.pop());
    else stack.pop();
  }
  return kept.join('\n').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Counts the attribute slots a vertex shader uses on Safari: declared inputs plus one when it reads gl_InstanceID or gl_VertexID. */
export function countVertexAttributeSlots(vertexSource) {
  const source = activeSource(vertexSource);
  let slots = 0;
  for (const [, type] of source.matchAll(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\s+(?:\w+\s+)?(\w+)\s+\w+\s*;/g)) {
    slots += SLOTS_BY_TYPE[type] ?? 1;
  }
  return slots + (BUILT_IN_INPUT.test(source) ? 1 : 0);
}

/** Throws when a vertex shader would fail to link on a GPU that allows only 16 attributes, naming the count and how to fix it. */
export function assertVertexAttributeBudget(vertexSource, label = 'vertex shader') {
  const slots = countVertexAttributeSlots(vertexSource);
  if (slots > GUARANTEED_VERTEX_ATTRIBUTE_SLOTS) {
    throw new Error(`The ${label} uses ${slots} vertex attribute slots (gl_InstanceID and gl_VertexID count as one), over the ${GUARANTEED_VERTEX_ATTRIBUTE_SLOTS} that Safari allows. Pack the new attribute into a spare component of an existing one in src/shaders.js and renderer.pointInstanceAttributes instead of adding a location.`);
  }
  return slots;
}
