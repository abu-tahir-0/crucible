import { resolveLocalVolumes, MAX_LOCAL_VOLUMES } from './local-volumes.js';
import { waterTraceMaterial, waterExtinction } from './path-tracer-water.js';

// The depth tint of thin water in a path trace (issue #2294). A trace absorbs light only over the distance a ray travels inside a
// part, so a water sheet a few centimetres thick traced as a clear dielectric and the bed under it stayed untinted, while the
// rasterizer tints by the depth under the surface. A thin water part therefore gets an absorbing box under its footprint: from the
// underside of the part down to the bottom of the scene, extinction per channel as the dielectric's own attenuation reads it.

/**
 * A water part counts as thin when its height is at most this fraction of the whole depth of the water column: its own height plus
 * the depth from its underside down to the lowest point of the scene. A 4 cm sheet over a 2 m bed is 0.02; a 1.9 m closed body over
 * the same bed is 0.9. Anything above the fraction is a body that holds its own water: its attenuation tints it and it gets no medium.
 */
export const THIN_WATER_HEIGHT_FRACTION = 0.1;

// The box is a plain absorber: no scatter (the scatter of turbidity is not traced either), no emission, a hard edge, no noise.
const MEDIUM_STEPS = 16;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometryBox(positions) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[offset + axis]);
      high[axis] = Math.max(high[axis], positions[offset + axis]);
    }
  }
  return { low, high };
}

/** The world box of a part: its geometry box carried through the part's matrix, so a rotated part gets the box around its corners. */
export function partWorldBounds(part) {
  const matrix = part.matrix ?? IDENTITY_MATRIX;
  const local = geometryBox(part.geometry.positions);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? local.high[0] : local.low[0];
    const y = corner & 2 ? local.high[1] : local.low[1];
    const z = corner & 4 ? local.high[2] : local.low[2];
    for (let axis = 0; axis < 3; axis++) {
      const world = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      low[axis] = Math.min(low[axis], world);
      high[axis] = Math.max(high[axis], world);
    }
  }
  return { low, high };
}

// The absorbing box under one thin water part, as a resolved local volume, or null when the part is not thin water or has nothing to tint.
function mediumUnderWater(part, sceneBounds) {
  if (part.material?.tag !== 'water' || !part.geometry?.positions?.length) return null;
  const extinction = waterExtinction(waterTraceMaterial(part.material));
  const strongest = Math.max(...extinction);
  if (!(strongest > 0)) return null;
  const water = partWorldBounds(part);
  const waterHeight = water.high[1] - water.low[1];
  const depthBelow = water.low[1] - sceneBounds.low[1];
  if (!(depthBelow > 0) || waterHeight > THIN_WATER_HEIGHT_FRACTION * (depthBelow + waterHeight)) return null;
  const size = [water.high[0] - water.low[0], depthBelow, water.high[2] - water.low[2]];
  const center = [(water.low[0] + water.high[0]) / 2, water.low[1] - depthBelow / 2, (water.low[2] + water.high[2]) / 2];
  // A local volume dims by absorption (0 to 1) times density (0 to 100) per metre, so the strongest channel sets the density.
  const density = Math.min(100, strongest);
  const absorption = extinction.map(channel => Math.min(1, channel / density));
  const [volume] = resolveLocalVolumes([{ shape: 'box', center, size, density, absorption, falloff: 0, steps: MEDIUM_STEPS }], 'water medium');
  return { ...volume, waterMedium: true };
}

/** The absorbing boxes of every thin water part, in part order. Empty when no part is water, which leaves a scene exactly as it was. */
export function thinWaterMedia(parts, sceneBounds) {
  if (!Array.isArray(parts)) return [];
  return parts.map(part => mediumUnderWater(part, sceneBounds)).filter(Boolean);
}

/**
 * The local volumes of a trace with the water media after the author's own. A scene with no thin water gets its volumes back untouched.
 * The tracers hold at most MAX_LOCAL_VOLUMES together, so a scene that would pass it is refused with what to do.
 */
export function withWaterMedia(localVolumes, media) {
  if (media.length === 0) return localVolumes;
  const combined = [...(localVolumes ?? []), ...media];
  if (combined.length > MAX_LOCAL_VOLUMES) {
    throw new RangeError(`A path trace draws at most ${MAX_LOCAL_VOLUMES} local volumes, and ${media.length} thin water part${media.length === 1 ? '' : 's'} each add one to the ${localVolumes?.length ?? 0} of environment.localVolumes. Merge the water sheets into fewer parts or remove some localVolumes.`);
  }
  return combined;
}

/** The volumes of a trace without its water media, for a tracer that cannot draw them. Null when none are left. */
export function withoutWaterMedia(localVolumes) {
  if (!localVolumes) return localVolumes;
  const kept = localVolumes.filter(volume => volume.waterMedium !== true);
  return kept.length === 0 ? null : kept;
}
