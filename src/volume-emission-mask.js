import { installRenderPasses } from './render-passes.js';
import { registerEmissionMaskDrawer } from './fog-shader.js';

// The emission mask of a volume shadow (#1360). It carries the render pass code, so it loads on demand: fog-shader.js asks for it
// the first time a `castShadow` volume sits over a glowing part, and a recipe that says so loads it up front (agent-scene-modules.js).

/**
 * Draws the emission of the opaque surfaces as a float pass into the render pass target, before the frame itself, so the post pass can leave
 * their emission out of the light it dims. The caller (fog-shader.js) has already checked that a shadowing volume covers a glowing part.
 */
function drawEmissionMask(renderer, frame) {
  installRenderPasses(renderer);
  renderer.render({ ...frame, pass: 'emission', passFloat: true, emissionMaskPass: true });
}

registerEmissionMaskDrawer(drawEmissionMask);
