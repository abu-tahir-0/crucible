import { requireFiniteInRange } from './modeling-limits.js';
import { generateGeometryLods, checkRatios, DEFAULT_LOD_RATIOS } from './mesh-lod.js';
import { MAXIMUM_SIMPLIFY_TRIANGLES } from './geometry-simplify.js';
import { DENSE_TRIANGLES_PER_PIXEL, partTakesLods } from './renderer.js';

// Parts for a scene with more than one triangle per pixel (a scan, a sculpt), given `lods` so that each draws with the
// fewest triangles whose error stays under `lodPixelError` pixels (#1163). On such a scene every pixel is shaded about
// once per triangle that touches it, so a level with a quarter of the triangles shades far fewer quads.

// Meshes of a few thousand triangles, many of them, are as dense as a few huge scans, so the floor sits low (#2144). Lone Monk draws as fast from 4000 as from 1500 and shimmers no more (#2157).
export const DEFAULT_MINIMUM_TRIANGLES = 4000;

/** A scene file picks a level at this many pixels of error (CrucibleRenderer's own default is 1); `renderer.lodPixelError` overrides it (#2157). */
export const SCENE_FILE_LOD_PIXEL_ERROR = 0.5;

/** The renderer options of a scene file with the scene-file defaults under them. */
export function withSceneFileRendererDefaults(rendererOptions = {}) {
  return { lodPixelError: SCENE_FILE_LOD_PIXEL_ERROR, ...rendererOptions };
}

/**
 * The environment of a scene file: the GLB's own KHR_lights_punctual lights (`asset.lights`) with the scene file's
 * `renderer.environment` on top, key by key, so a scene file can still override the file's key light or light lists.
 */
export function withSceneFileLights(fileLights = {}, sceneEnvironment = {}) {
  return { ...fileLights, ...sceneEnvironment };
}

/** Triangles over pixels for these parts on a canvas of `pixels` pixels (the canvas size times the pixel ratio squared). */
export function trianglesPerPixel(parts, pixels) {
  if (!(pixels > 0)) throw new RangeError('pixels must be the canvas width times its height times the pixel ratio squared, a positive number.');
  let triangles = 0;
  for (const part of parts) triangles += part.geometry.indices.length / 3;
  return triangles / pixels;
}

/**
 * Returns `parts` with `lods` on every part that has at least `minimumTriangles` triangles and may take levels, when
 * the scene is denser than `minimumTrianglesPerPixel`; otherwise returns `parts` itself. Parts that share a geometry
 * share its levels and so one batch; a part that already has `lods` keeps them. The levels keep uvs and colours.
 */
export function addLodsToDenseParts(parts, { pixels, minimumTrianglesPerPixel = DENSE_TRIANGLES_PER_PIXEL, minimumTriangles = DEFAULT_MINIMUM_TRIANGLES, ratios = DEFAULT_LOD_RATIOS } = {}) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be the array of parts that goes to CrucibleRenderer.');
  // Checked here so bad ratios fail on a sparse scene too, not only on the frame a scene turns dense.
  checkRatios(ratios);
  requireFiniteInRange('addLodsToDenseParts', 'minimumTrianglesPerPixel', minimumTrianglesPerPixel, 0, 1e9);
  requireFiniteInRange('addLodsToDenseParts', 'minimumTriangles', minimumTriangles, 0, 1e9);
  if (trianglesPerPixel(parts, pixels) <= minimumTrianglesPerPixel) return parts;
  const levelsByGeometry = new Map();
  return parts.map(part => {
    const triangles = part.geometry.indices.length / 3;
    if (part.lods || triangles < minimumTriangles || triangles > MAXIMUM_SIMPLIFY_TRIANGLES || !partTakesLods(part)) return part;
    if (!levelsByGeometry.has(part.geometry)) levelsByGeometry.set(part.geometry, generateGeometryLods(part.geometry, { ratios }));
    return { ...part, lods: levelsByGeometry.get(part.geometry) };
  });
}

/**
 * The parts a scene file's renderer options ask for: `denseLods` (on by default) runs addLodsToDenseParts at the canvas's
 * size and pixel ratio (the default ratio of CrucibleRenderer is 1.5); `false` returns `parts` itself, so a scene file
 * can keep every triangle of a dense scan.
 */
export function partsForRendererOptions(parts, canvas, rendererOptions = {}) {
  const { denseLods = true, pixelRatio = 1.5 } = rendererOptions;
  if (typeof denseLods !== 'boolean') throw new TypeError('renderer.denseLods must be true or false.');
  if (!denseLods) return parts;
  requireFiniteInRange('partsForRendererOptions', 'pixelRatio', pixelRatio, 0.1, 16);
  const pixels = Math.max(1, canvas.clientWidth) * Math.max(1, canvas.clientHeight) * pixelRatio * pixelRatio;
  return addLodsToDenseParts(parts, { pixels });
}
