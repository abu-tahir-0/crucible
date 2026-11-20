import { resolveWaterMaterial } from './water-presets.js';

// Water for the path tracers (issue #2230). The rasterizer draws a `water` material with a wave shader; a trace has no such
// shader, so the export turns the material into the glossy dielectric it stands for and lets the tracer's own transmission,
// reflection and Beer-Lambert absorption draw it.

export const WATER_TRACE_IOR = 1.33;
// A calm surface: the rasterizer's water is a mirror with ripples, and a trace has no ripple normals to break the mirror up.
export const WATER_TRACE_DEFAULT_ROUGHNESS = 0.05;
// Light reaching a surface under the water is dimmed to exp(-extinction * metres). One metre is the reference distance.
export const WATER_TRACE_ATTENUATION_DISTANCE = 1;
// The tracers tint light by the base colour at every refraction, and a path to the bed and back crosses the surface four
// times: a teal water colour of 0.3 would keep 0.3^4 of the light, so the bed went black. The tint is the attenuation's job.
export const WATER_TRACE_COLOR = Object.freeze([1, 1, 1]);

/**
 * The material a water part is traced with: a clear dielectric (IOR 1.33, transmission 1, no metal, the material's own roughness
 * when set) that absorbs light like the water body does. Per colour channel the extinction per metre is the material's
 * `absorption` plus its `turbidity` (murky water dims every colour alike; the scatter that makes it murky is not traced), so the
 * attenuation colour kept after one metre is exp(-(absorption + turbidity)). The base colour becomes white, since the tracers tint
 * by it at every refraction; a material with its own `transmission` keeps its colour. `ior`, `transmission` and an explicit attenuation
 * on the material win over these values. A material that is not water is returned as it is.
 */
export function waterTraceMaterial(material) {
  if (material?.tag !== 'water') return material;
  const { absorption, turbidity } = resolveWaterMaterial({ ...material, absorption: material.absorption ? Array.from(material.absorption) : undefined });
  const hasOwnAttenuation = material.attenuationDistance !== undefined;
  return {
    ...material,
    color: material.transmission === undefined ? WATER_TRACE_COLOR : material.color,
    metallic: 0,
    roughness: material.roughness ?? WATER_TRACE_DEFAULT_ROUGHNESS,
    transmission: material.transmission ?? 1,
    ior: material.ior ?? WATER_TRACE_IOR,
    attenuationDistance: hasOwnAttenuation ? material.attenuationDistance : WATER_TRACE_ATTENUATION_DISTANCE,
    attenuationColor: hasOwnAttenuation ? material.attenuationColor : absorption.map(channel => Math.exp(-(channel + turbidity))),
  };
}

/**
 * The extinction per metre of each colour channel that a traced water material absorbs with: -ln(attenuationColor) / attenuationDistance,
 * which is absorption + turbidity for the default attenuation. The thin water medium (#2294) dims by the same numbers.
 */
export function waterExtinction(traceMaterial) {
  const color = traceMaterial.attenuationColor ?? [1, 1, 1];
  const distance = traceMaterial.attenuationDistance ?? WATER_TRACE_ATTENUATION_DISTANCE;
  return Array.from(color, channel => -Math.log(Math.max(channel, 1e-6)) / distance);
}

/** What a water part asks for that a trace does not draw, as report notes: the ripples, foam, glint and ramp of the rasterizer. */
export function describeUntracedWater(part) {
  const material = part.material ?? {};
  if (material.tag !== 'water') return [];
  const notes = ['water ripples are ignored: a traced water surface keeps its geometry normals.'];
  if (part.geometry?.vertexGroups?.foam) notes.push('water foam (the foam vertex group) is ignored.');
  if (material.waterGlint) notes.push('waterGlint is ignored.');
  if (material.waterRamp) notes.push('waterRamp is ignored: a traced water surface takes its colour from the material and the sky it reflects.');
  if (material.turbidity > 0) notes.push('water turbidity only dims the light under the surface; the scatter that softens shadows is not traced.');
  return notes;
}
