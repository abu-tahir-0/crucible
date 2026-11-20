import { resolveVolumeFog } from './volumetric.js';
import { localVolumeInterval, localVolumeProfile, localVolumeStepCount, localVolumeGridSample, localVolumeGridMotionPoint, LOCAL_VOLUME_DETAIL_SHADOW_TAPS, LOCAL_VOLUME_KEY_GAIN, LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, LOCAL_VOLUME_SHADOW_STRENGTH, LOCAL_VOLUME_SKY_GAIN, LOCAL_VOLUME_SUN_FLATTEN, LOCAL_VOLUME_SURFACE_SHADOW_TAPS, LOCAL_VOLUME_GRID_SHADOW_TAPS, LOCAL_VOLUME_MULTI_SCATTER, LOCAL_VOLUME_MULTI_EXTINCTION, LOCAL_VOLUME_MULTI_ANISOTROPY } from './local-volumes.js';
import { countOpenEdges } from './local-volume-parts.js';
import { gridMotionTimeFraction } from './volume-grid.js';
import { bakeEmissionRamp, emissionRampPosition, sampleBakedRamp } from './local-volume-ramp-bake.js';
import { stepIntegralWeight } from './volume-step-integral.js';
import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';

// Homogeneous fog for the path tracer: a box of uniform scattering medium with the colour, density and anisotropy of the
// rasterizer's `environment.volumeFog`. Distances to the next scattering event are drawn from the exact free-flight
// distribution, so the cost is one random number per ray segment and there is no step count to trade against quality.
// The rasterizer's drift and ambient term are not traced: the medium is lit only by the scene's lights.

/** The medium the tracer reads, or null when the environment has no fog. Throws what the rasterizer throws for bad input. */
export function resolveTraceVolume(volumeFog) {
  if (!volumeFog) return null;
  const resolved = resolveVolumeFog(volumeFog);
  if (!(resolved.density > 0)) return null;
  return {
    density: resolved.density,
    minimum: resolved.minimum,
    maximum: resolved.maximum,
    albedo: resolved.color,
    anisotropy: resolved.anisotropy,
    maxDistance: resolved.maxDistance,
  };
}

// The rasterizer's distance haze (`environment.fogDensity`, `environment.fogColor`, only with `world: true`) mixes a pixel toward
// the fog colour by 1 - exp(-distance * fogDensity): the transmittance of a uniform medium whose extinction is fogDensity per
// metre. The trace gets that medium, so a surface at distance d keeps exp(-fogDensity * d) of its light, and the medium scatters
// the fog colour (isotropic, no noise), lit by the traced lights and sky. The medium fills the scene's bounding box plus a
// margin and no more: the rasterizer's haze never dims the light itself, but a traced medium does, and a box that took in the
// sky above the scene stopped the sun (a 630 m cube at density 0.04 rendered black). A camera outside the box sees haze only
// from where its ray enters the box.
const HAZE_MARGIN_FRACTION = 0.02;
const HAZE_MINIMUM_MARGIN = 0.5;
const HAZE_MAXIMUM_DISTANCE = 1e4;
const HAZE_DEFAULT_COLOR = [0.35, 0.43, 0.43];

/**
 * The medium for the rasterizer's distance haze, or null when the environment has none. The caller takes `volumeFog` first: a
 * scene that sets both keeps only its volumeFog (a recipe always carries a volumeFog, with density 0 when it sets none).
 * `bounds` is the scene's world box, `{ low, high }`.
 */
export function resolveTraceDistanceHaze(environment, bounds) {
  if (environment?.world !== true || !(environment.fogDensity > 0)) return null;
  const largestSide = Math.max(...bounds.high.map((high, axis) => high - bounds.low[axis]));
  const margin = Math.max(HAZE_MINIMUM_MARGIN, largestSide * HAZE_MARGIN_FRACTION);
  return resolveTraceVolume({
    density: environment.fogDensity,
    color: environment.fogColor ?? HAZE_DEFAULT_COLOR,
    minimum: bounds.low.map(low => low - margin),
    maximum: bounds.high.map(high => high + margin),
    maxDistance: HAZE_MAXIMUM_DISTANCE,
    anisotropy: 0,
    noiseAmount: 0,
  });
}

/**
 * Where the ray is inside the box, as distances along it: writes `[entry, exit]` into `out`
 * clipped to `[0, limit]` and returns true, or returns false when the ray misses the box in that range.
 */
export function volumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = Math.min(limit, volume.maxDistance);
  for (let axis = 0; axis < 3; axis++) {
    const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
    const direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
    if (direction === 0) {
      if (origin < volume.minimum[axis] || origin > volume.maximum[axis]) return false;
      continue;
    }
    const first = (volume.minimum[axis] - origin) / direction;
    const second = (volume.maximum[axis] - origin) / direction;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}

/** Henyey-Greenstein value per steradian; `cosine` is between the path direction and the direction toward the light. */
export function henyeyGreensteinPhase(anisotropy, cosine) {
  const squared = anisotropy * anisotropy;
  return (1 - squared) / (4 * Math.PI * (1 + squared - 2 * anisotropy * cosine) ** 1.5);
}

/**
 * Draws the cosine of the scattering angle from Henyey-Greenstein. The probability density of the drawn direction is
 * `henyeyGreensteinPhase(anisotropy, cosine)`, so a scatter keeps its throughput times the albedo.
 */
export function sampleHenyeyGreensteinCosine(anisotropy, unit) {
  if (Math.abs(anisotropy) < 1e-3) return 1 - 2 * unit;
  const squared = anisotropy * anisotropy;
  const ratio = (1 - squared) / (1 - anisotropy + 2 * anisotropy * unit);
  return Math.max(-1, Math.min(1, (1 + squared - ratio * ratio) / (2 * anisotropy)));
}

const MAXIMUM_MESH_CROSSINGS = 64;
const MAXIMUM_MESH_SEGMENTS = MAXIMUM_MESH_CROSSINGS / 2;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export { countOpenEdges };

/**
 * Gives a mesh volume (shape "mesh", bound to its part by bindLocalVolumeParts) what the tracer needs: the part's triangles in
 * world space with their own BVH. A mesh that is not closed has no inside, so it throws with the number of open edges.
 */
export function prepareMeshVolume(volume, label) {
  const { geometry, matrix = IDENTITY_MATRIX } = volume.part;
  const source = geometry.positions;
  const positions = new Float32Array(source.length);
  for (let vertex = 0; vertex < source.length; vertex += 3) {
    const x = source[vertex];
    const y = source[vertex + 1];
    const z = source[vertex + 2];
    positions[vertex] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    positions[vertex + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    positions[vertex + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  const diagonal = Math.hypot(...volume.size);
  const openEdges = countOpenEdges(positions, geometry.indices, diagonal * 1e-6);
  if (openEdges > 0) throw new RangeError(`${label}.part "${volume.part.name}" is not a closed mesh (${openEdges} open edges), so it has no inside; close it or use fit "bounds"`);
  const bvh = buildTriangleBvh(positions, geometry.indices);
  return { ...volume, mesh: { tracer: createTracer({ positions, indices: geometry.indices, bvh }), stepOffset: diagonal * 1e-6, positions, indices: geometry.indices, bvh } };
}

/**
 * Where a ray is inside a closed mesh volume: writes `[entry, exit]` pairs into `out`, clipped to `[0, limit]`, and returns how
 * many. The ray is walked from crossing to crossing, so an L-shaped room gives two segments where a ray leaves and comes back.
 * Whether the origin is inside follows from the parity of the crossings ahead of it.
 */
export function meshVolumeSegments(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  const { tracer, stepOffset } = volume.mesh;
  const crossings = [];
  let cursor = 0;
  while (crossings.length < MAXIMUM_MESH_CROSSINGS) {
    const found = tracer.trace(originX + directionX * cursor, originY + directionY * cursor, originZ + directionZ * cursor, directionX, directionY, directionZ, Infinity, false);
    if (found.nearestTriangle < 0) break;
    cursor += found.nearestDistance;
    crossings.push(cursor);
    cursor += stepOffset;
  }
  let inside = crossings.length % 2 === 1;
  let start = 0;
  let count = 0;
  for (const crossing of crossings) {
    if (inside) {
      const end = Math.min(crossing, limit);
      if (end > start && count < MAXIMUM_MESH_SEGMENTS) {
        out[count * 2] = start;
        out[count * 2 + 1] = end;
        count++;
      }
    } else {
      start = crossing;
    }
    inside = !inside;
  }
  return count;
}

/** Marches the inside segments of a mesh volume; `volume.steps` are shared between them in proportion to their length. */
function marchMeshVolume(volume, spans, originX, originY, originZ, directionX, directionY, directionZ, jitter, throughput, emitted) {
  let total = 0;
  for (let slot = 0; slot < spans.length; slot += 2) total += spans[slot + 1] - spans[slot];
  for (let slot = 0; slot < spans.length; slot += 2) {
    const entry = spans[slot];
    const segmentLength = spans[slot + 1] - entry;
    const steps = Math.max(1, Math.round(volume.steps * segmentLength / total));
    const stepLength = segmentLength / steps;
    for (let step = 0; step < steps; step++) {
      const distance = entry + (step + jitter) * stepLength;
      const width = localVolumeProfile(volume, originX + directionX * distance, originY + directionY * distance, originZ + directionZ * distance) * stepLength;
      for (let channel = 0; channel < 3; channel++) {
        const opticalDepth = volume.absorption[channel] * volume.density * width;
        emitted[channel] += throughput[channel] * volume.emission[channel] * volume.emissionStrength * width * stepIntegralWeight(opticalDepth);
        throughput[channel] *= Math.exp(-opticalDepth);
      }
    }
  }
}

/** The mean radiance of an environment map over the sphere (rows weighted by their solid angle), the sky term of a scattering local volume. */
export function meanEnvironmentRadiance(environment) {
  const mean = [0, 0, 0];
  if (!environment) return mean;
  const { width, height, channels, data, intensity } = environment;
  let weightTotal = 0;
  for (let row = 0; row < height; row++) {
    const rowWeight = Math.sin(Math.PI * (row + 0.5) / height);
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < 3; channel++) mean[channel] += data[(row * width + column) * channels + channel] * rowWeight;
    }
    weightTotal += rowWeight * width;
  }
  return mean.map(total => total * intensity / weightTotal);
}

const SUN_DEPTH_TAPS = 3;
const SKY_DEPTH_TAPS = 1;
// The up and four side directions the sky light is gathered from (the rasterizer's localVolumeSkyLight holds the same list).
const SKY_DIRECTIONS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The phase function times the light left after `depth`, summed over the octaves of a volume's `scatterOctaves` (the octave sum of the rasterizer's localVolumeInScatter):
 * octave n weighs MULTI_SCATTER^n, sees MULTI_EXTINCTION^n of the depth and has MULTI_ANISOTROPY^n of the anisotropy. One octave is the single scatter.
 */
function scatterOctaveSum(volume, cosine, depth) {
  let total = 0;
  let weight = 1;
  let extinction = 1;
  let anisotropy = volume.anisotropy ?? 0;
  for (let octave = 0; octave < (volume.scatterOctaves ?? 1); octave++) {
    total += weight * henyeyGreensteinPhase(anisotropy, cosine) * Math.exp(-depth * extinction);
    weight *= LOCAL_VOLUME_MULTI_SCATTER;
    extinction *= LOCAL_VOLUME_MULTI_EXTINCTION;
    anisotropy *= LOCAL_VOLUME_MULTI_ANISOTROPY;
  }
  return total;
}

/**
 * The optical depth per colour channel between a point inside a volume and the volume's far side along a direction, from midpoint
 * taps of its profile: the rasterizer's `localVolumeDepth`, so the lit side of a volume is brighter than the shaded side.
 */
function writeOpticalDepth(volume, x, y, z, direction, taps, span, out, detailShadow = false) {
  const exitDistance = localVolumeInterval(volume, x, y, z, direction[0], direction[1], direction[2], Infinity, span) ? Math.max(span[1], 0) : 0;
  let profileSum = 0;
  for (let tap = 0; tap < taps; tap++) {
    const distance = exitDistance * (tap + 0.5) / taps;
    profileSum += Math.min(localVolumeProfile(volume, x + direction[0] * distance, y + direction[1] * distance, z + direction[2] * distance, detailShadow) * LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, 1);
  }
  for (let channel = 0; channel < 3; channel++) out[channel] = volume.absorption[channel] * volume.density * profileSum * exitDistance / taps;
}

// Which of a grid sample's three channels (density, temperature, flame) drives a ramp.
function rampSourceChannel(source) {
  return source === 'density' ? 0 : source === 'temperature' ? 1 : 2;
}

/**
 * Builds the function that carries a ray through the scene's local volumes (environment.localVolumes). Each volume is marched with
 * its own step count between its entry and exit, nearest entry first: the emitted light is added in proportion to the throughput
 * so far, then the throughput is dimmed by exp(-absorption * profile * step). A volume with `scatter` above 0 also returns that share
 * of the light it extinguishes in the step, lit by the sky term and by the sun (phase function, shadow ray, and the volume's own
 * optical depth toward the sun); `lighting` is `{ sun: { direction, color } | null, ambient: [red, green, blue], sunVisibility(x, y, z) }`,
 * where sunVisibility is 1 or 0 for a shadow ray toward the sun. A volume's `noiseAmount` modulates the profile with the rasterizer's
 * own noise field. `jitter` (0 to 1) offsets the samples within a step.
 * The returned function writes the emitted light into `emitted` and scales `throughput` in place.
 */
export function createLocalVolumeCrossing(volumes, lighting = null) {
  const entries = new Float64Array(volumes.length);
  const exits = new Float64Array(volumes.length);
  const dimming = new Float64Array(3);
  // The glow one step adds before the step's own dimming weights it (#1894).
  const stepLight = new Float64Array(3);
  const span = new Float64Array(2);
  const sunDepth = new Float64Array(3);
  const sunLight = new Float64Array(3);
  const skyLight = new Float64Array(3);
  const flattenedDirection = new Float64Array(3);

  // Writes the sky term of a point inside a scattering volume: the mean sky radiance times what the volume's own depth leaves open in five directions.
  function writeSkyLight(volume, x, y, z) {
    skyLight.fill(0);
    for (const direction of SKY_DIRECTIONS) {
      writeOpticalDepth(volume, x, y, z, direction, SKY_DEPTH_TAPS, span, sunDepth);
      for (let channel = 0; channel < 3; channel++) skyLight[channel] += Math.exp(-sunDepth[channel]) / SKY_DIRECTIONS.length;
    }
    for (let channel = 0; channel < 3; channel++) skyLight[channel] *= lighting.ambient[channel] * LOCAL_VOLUME_SKY_GAIN;
  }

  // Adds the light one step of a scattering volume sends back along the ray: scatter * (1 - exp(-extinction * width)) * (sky + sun).
  function addScatteredLight(volume, x, y, z, directionX, directionY, directionZ, width, throughput, emitted) {
    writeSkyLight(volume, x, y, z);
    sunLight.fill(0);
    const sun = lighting.sun;
    if (sun && lighting.sunVisibility(x, y, z) > 0) {
      const flattenedLength = Math.hypot(sun.direction[0], sun.direction[1] * LOCAL_VOLUME_SUN_FLATTEN, sun.direction[2]);
      flattenedDirection[0] = sun.direction[0] / flattenedLength;
      flattenedDirection[1] = sun.direction[1] * LOCAL_VOLUME_SUN_FLATTEN / flattenedLength;
      flattenedDirection[2] = sun.direction[2] / flattenedLength;
      const detailShadow = volume.shadowDetail === true && volume.shape !== 'grid';
      writeOpticalDepth(volume, x, y, z, flattenedDirection, detailShadow ? LOCAL_VOLUME_DETAIL_SHADOW_TAPS : SUN_DEPTH_TAPS, span, sunDepth, detailShadow);
      const cosine = sun.direction[0] * directionX + sun.direction[1] * directionY + sun.direction[2] * directionZ;
      for (let channel = 0; channel < 3; channel++) {
        sunLight[channel] = sun.color[channel] * LOCAL_VOLUME_KEY_GAIN * scatterOctaveSum(volume, cosine, sunDepth[channel] * LOCAL_VOLUME_SHADOW_STRENGTH);
      }
    }
    for (let channel = 0; channel < 3; channel++) {
      const scattered = volume.scatter * (1 - Math.exp(-volume.absorption[channel] * volume.density * width));
      emitted[channel] += throughput[channel] * scattered * (skyLight[channel] + sunLight[channel]);
    }
  }

  // The emission ramp (#1046), baked once per volume: the light per unit length is the ramp colour at the source value times the position along the ramp, as the
  // rasterizer's localVolumeRampLight does.
  const bakedRamps = new Map(volumes.filter(volume => volume.emissionRamp).map(volume => [volume, bakeEmissionRamp(volume.emissionRamp)]));
  const rampColor = new Float64Array(3);
  function addRampLight(volume, sourceValue, stepLength, stepGlow) {
    const position = emissionRampPosition(volume.emissionRamp, sourceValue);
    if (position <= 0) return;
    sampleBakedRamp(bakedRamps.get(volume), position, rampColor);
    for (let channel = 0; channel < 3; channel++) stepGlow[channel] += rampColor[channel] * volume.emissionStrength * position * stepLength;
  }

  const gridCell = new Float64Array(6);
  const motionPoint = new Float64Array(3);

  // One step through a grid volume (shape "grid"): extinction from the density, emission from the flame channel and, with blackbodyIntensity, from the
  // temperature channel. The rasterizer's march repeats it (fog-shader.js).
  // With a motion shutter (#1759) the step reads the grid back along the gas velocity by its place in the shutter, the same one-sample-per-step blur as the rasterizer's march.
  function crossGridStep(volume, x, y, z, directionX, directionY, directionZ, stepLength, throughput, emitted, timeFraction) {
    if (volume.motionShutter > 0) {
      localVolumeGridMotionPoint(volume, x, y, z, timeFraction, motionPoint);
      localVolumeGridSample(volume, motionPoint[0], motionPoint[1], motionPoint[2], gridCell, volume.blackbodyIntensity > 0);
    } else {
      localVolumeGridSample(volume, x, y, z, gridCell, volume.blackbodyIntensity > 0);
    }
    const width = gridCell[0] * stepLength;
    if (width > 0 && volume.scatter > 0 && lighting) addScatteredLight(volume, x, y, z, directionX, directionY, directionZ, width, throughput, emitted);
    const flameWidth = gridCell[2] * stepLength;
    const blackbodyWidth = volume.blackbodyIntensity * volume.emissionStrength * stepLength;
    stepLight.fill(0);
    if (volume.emissionRamp) addRampLight(volume, gridCell[rampSourceChannel(volume.emissionRamp.source)], stepLength, stepLight);
    for (let channel = 0; channel < 3; channel++) {
      const opticalDepth = volume.absorption[channel] * volume.density * width;
      stepLight[channel] += volume.emission[channel] * volume.emissionStrength * flameWidth + gridCell[3 + channel] * blackbodyWidth;
      emitted[channel] += throughput[channel] * stepLight[channel] * stepIntegralWeight(opticalDepth);
      throughput[channel] *= Math.exp(-opticalDepth);
    }
  }

  // Marches one grid volume over its whole span; a grid is never marched together with another volume.
  function crossGridVolume(volume, entry, exitDistance, directionX, directionY, directionZ, originX, originY, originZ, jitter, throughput, emitted) {
    const stepCount = localVolumeStepCount(volume, exitDistance - entry);
    const stepLength = (exitDistance - entry) / stepCount;
    for (let step = 0; step < stepCount; step++) {
      const distance = entry + (step + jitter) * stepLength;
      crossGridStep(volume, originX + directionX * distance, originY + directionY * distance, originZ + directionZ * distance, directionX, directionY, directionZ, stepLength, throughput, emitted, gridMotionTimeFraction(jitter, step));
    }
  }

  const meshScratch = new Float64Array(MAXIMUM_MESH_SEGMENTS * 2);
  const meshSpans = new Array(volumes.length);
  return function crossLocalVolumes(originX, originY, originZ, directionX, directionY, directionZ, length, jitter, throughput, emitted) {
    emitted[0] = 0;
    emitted[1] = 0;
    emitted[2] = 0;
    for (let index = 0; index < volumes.length; index++) {
      entries[index] = Infinity;
      if (volumes[index].mesh) {
        const segmentCount = meshVolumeSegments(volumes[index], originX, originY, originZ, directionX, directionY, directionZ, length, meshScratch);
        if (segmentCount === 0) continue;
        meshSpans[index] = meshScratch.slice(0, segmentCount * 2);
        span[0] = meshScratch[0];
        span[1] = meshScratch[segmentCount * 2 - 1];
      } else if (!localVolumeInterval(volumes[index], originX, originY, originZ, directionX, directionY, directionZ, length, span)) continue;
      entries[index] = span[0];
      exits[index] = span[1];
    }
    while (true) {
      let leader = -1;
      for (let index = 0; index < volumes.length; index++) {
        if (entries[index] < Infinity && (leader < 0 || entries[index] < entries[leader])) leader = index;
      }
      if (leader < 0) break;
      const volume = volumes[leader];
      const entry = entries[leader];
      entries[leader] = Infinity;
      if (volume.mesh) {
        marchMeshVolume(volume, meshSpans[leader], originX, originY, originZ, directionX, directionY, directionZ, jitter, throughput, emitted);
        continue;
      }
      if (volume.gridData) {
        crossGridVolume(volume, entry, exits[leader], directionX, directionY, directionZ, originX, originY, originZ, jitter, throughput, emitted);
        continue;
      }
      // Box and sphere volumes that overlap are marched together (#1722), as the rasterizer does: the volume that starts at the same distance joins in,
      // and the march stops where another one starts or one of the two ends, so glow and dimming add per step and no entry plane cuts a soft edge.
      let partner = -1;
      let segmentEnd = exits[leader];
      for (let other = 0; other < volumes.length; other++) {
        if (entries[other] === Infinity || volumes[other].mesh || volumes[other].gridData) continue;
        if (entries[other] <= entry) {
          if (partner < 0) partner = other;
        } else {
          segmentEnd = Math.min(segmentEnd, entries[other]);
        }
      }
      if (partner >= 0) segmentEnd = Math.min(segmentEnd, exits[partner]);
      let stepCount = localVolumeStepCount(volume, segmentEnd - entry);
      if (partner >= 0) stepCount = Math.max(stepCount, localVolumeStepCount(volumes[partner], segmentEnd - entry));
      const stepLength = (segmentEnd - entry) / stepCount;
      for (let step = 0; step < stepCount; step++) {
        const distance = entry + (step + jitter) * stepLength;
        const x = originX + directionX * distance;
        const y = originY + directionY * distance;
        const z = originZ + directionZ * distance;
        dimming.fill(0);
        stepLight.fill(0);
        for (let lane = 0; lane < (partner < 0 ? 1 : 2); lane++) {
          const member = lane === 0 ? volume : volumes[partner];
          const profile = localVolumeProfile(member, x, y, z);
          if (profile <= 0) continue;
          const width = profile * stepLength;
          if (member.scatter > 0 && lighting) addScatteredLight(member, x, y, z, directionX, directionY, directionZ, width, throughput, emitted);
          if (member.emissionRamp) addRampLight(member, profile, stepLength, stepLight);
          for (let channel = 0; channel < 3; channel++) {
            stepLight[channel] += member.emission[channel] * member.emissionStrength * width;
            dimming[channel] += member.absorption[channel] * member.density * width;
          }
        }
        for (let channel = 0; channel < 3; channel++) {
          emitted[channel] += throughput[channel] * stepLight[channel] * stepIntegralWeight(dimming[channel]);
          throughput[channel] *= Math.exp(-dimming[channel]);
        }
      }
      if (segmentEnd < exits[leader]) entries[leader] = segmentEnd;
      if (partner >= 0) entries[partner] = segmentEnd < exits[partner] ? segmentEnd : Infinity;
    }
  };
}

/**
 * Builds the function that dims the sun's direct light at a surface by the local volumes that cast shadows (#1047), or returns null when none does.
 * It writes `exp(-depth)` per channel into `out`, where depth sums, over the box and sphere volumes with `castShadow` true, the optical depth between
 * the point and the sun from midpoint taps of the saturated profile with its noise. The rasterizer's `localVolumeSurfaceShadow` repeats it
 * (its post pass scales the surface colour by mix(1, exp(-depth), sun visibility): the sky and fill light reach the frame after it and stay as they were).
 */
export function createLocalVolumeSurfaceShadow(volumes) {
  const casters = volumes.filter(volume => volume.castShadow === true && !volume.mesh && volume.shape !== 'mesh' && (volume.shape !== 'grid' || volume.gridData));
  if (casters.length === 0) return null;
  const span = new Float64Array(2);
  const depth = new Float64Array(3);
  return function writeSurfaceShadow(x, y, z, directionX, directionY, directionZ, out) {
    depth.fill(0);
    for (const volume of casters) {
      if (!localVolumeInterval(volume, x, y, z, directionX, directionY, directionZ, Infinity, span)) continue;
      const entry = Math.max(span[0], 0);
      const length = span[1] - entry;
      if (length <= 0) continue;
      // A grid reads its simulated density as it is, at its own tap count and strength; a box or sphere saturates its faded skin and counts its depth LOCAL_VOLUME_SHADOW_STRENGTH times.
      const isGrid = volume.shape === 'grid';
      const taps = isGrid ? LOCAL_VOLUME_GRID_SHADOW_TAPS : LOCAL_VOLUME_SURFACE_SHADOW_TAPS;
      const strength = isGrid ? 1 : LOCAL_VOLUME_SHADOW_STRENGTH;
      let profileSum = 0;
      for (let tap = 0; tap < taps; tap++) {
        const distance = entry + length * (tap + 0.5) / taps;
        const profile = localVolumeProfile(volume, x + directionX * distance, y + directionY * distance, z + directionZ * distance, true);
        profileSum += isGrid ? profile : Math.min(profile * LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, 1);
      }
      for (let channel = 0; channel < 3; channel++) depth[channel] += strength * volume.absorption[channel] * volume.density * profileSum * length / taps;
    }
    for (let channel = 0; channel < 3; channel++) out[channel] = Math.exp(-depth[channel]);
  };
}
