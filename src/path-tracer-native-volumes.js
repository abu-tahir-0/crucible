// Local grid volumes for the native path tracer (Cook): the map from a bound Crucible grid volume to Cook's `gridVolumes` entry, and the
// step that appends the packed grids to a FORMAT-v2 input. Cook reads the box, the grid and the Principled Volume terms; a Crucible grid
// volume is the same box (centre and size, no rotation), so the terms carry over one for one.

import { floatToHalf, gridTemperature } from './volume-grid.js';

/** The most bytes a FORMAT-v2 texel pool holds (Cook's TEXTURE_POOL_MAX_BYTES): the textures and the grids share it. */
export const NATIVE_TEXEL_POOL_MAX_BYTES = 1 << 30;

const COOK_GRID_CHANNELS = ['density', 'temperature', 'flame'];

function halfFloatsOf(values) {
  return values ? Uint16Array.from(values, floatToHalf) : new Uint16Array(0);
}

function requireNativeGridVolume(volume, index) {
  if (volume.waterMedium === true) return;
  const label = `environment.localVolumes[${index}]`;
  if (volume.shape !== 'grid' || volume.part || !volume.gridData) {
    throw new RangeError(`${label} is a ${volume.part ? 'mesh' : volume.shape} volume; the native path tracer draws grid volumes only. Use backend "cpu" or "webgpu" for box, sphere and mesh volumes, or make the volume a grid.`);
  }
  if (volume.emissionRamp) {
    throw new RangeError(`${label}.emissionRamp is not drawn by the native path tracer: Cook colours a grid by emission and blackbody only. Use backend "cpu", or remove emissionRamp and set emission and blackbodyIntensity.`);
  }
}

/**
 * Cook's `gridVolumes` entry for one bound grid volume (a volume after bindLocalVolumeParts, so `gridData` is the frame at the render time).
 * `scatter` is Principled Volume's Color, so it scatters that share of the extinction `density * absorption`; the blackbody intensity is
 * multiplied by `emissionStrength`, as Blackbody Intensity is in scripts/cycles-volume-reference.py.
 */
export function cookGridVolume(volume) {
  const { resolution, channels } = volume.gridData;
  const cookChannels = {};
  for (const name of COOK_GRID_CHANNELS) {
    if (channels[name]) cookChannels[name] = channels[name];
  }
  // Cook takes the blackbody of the temperature channel, so a flame remap (#1735) travels as that channel: the flame grid as Blender makes the temperature grid.
  if (volume.flameTemperature) {
    const remapped = gridTemperature(volume.gridData, volume.flameTemperature);
    if (remapped) cookChannels.temperature = halfFloatsOf(remapped);
    else delete cookChannels.temperature;
  }
  return {
    resolution: Array.from(resolution),
    channels: cookChannels,
    center: Array.from(volume.center),
    size: Array.from(volume.size),
    density: volume.density,
    absorption: Array.from(volume.absorption),
    scatter: [volume.scatter, volume.scatter, volume.scatter],
    anisotropy: volume.anisotropy,
    emission: Array.from(volume.emission),
    emissionStrength: volume.emissionStrength,
    temperatureScale: volume.temperatureScale,
    blackbodyIntensity: volume.blackbodyIntensity * volume.emissionStrength,
  };
}

// The voxels of the grid that stands for a water medium. Cook reads a grid with trilinear weights and nothing outside it, so the field
// falls to half at the box faces; a voxel per few centimetres of depth keeps that fringe thin where the depth matters.
const WATER_MEDIUM_RESOLUTION = Object.freeze([16, 32, 16]);

/**
 * Cook's `gridVolumes` entry for a thin water medium (#2294): the same box as a grid of constant density 1, absorbing per channel
 * as the local volume does (density times absorption per metre), with no scatter and no emission.
 */
export function cookWaterMediumVolume(volume) {
  const voxelCount = WATER_MEDIUM_RESOLUTION.reduce((total, side) => total * side, 1);
  return {
    resolution: Array.from(WATER_MEDIUM_RESOLUTION),
    channels: { density: new Float32Array(voxelCount).fill(1) },
    center: Array.from(volume.center),
    size: Array.from(volume.size),
    density: volume.density,
    absorption: Array.from(volume.absorption),
    scatter: [0, 0, 0],
    anisotropy: 0,
    emission: [0, 0, 0],
    emissionStrength: 0,
    temperatureScale: 1,
    blackbodyIntensity: 0,
  };
}

/** The `gridVolumes` of a trace scene, or null when it has no local volumes. A volume that is not a grid is refused with what to use instead. */
export function nativeGridVolumes(localVolumes) {
  if (!localVolumes?.length) return null;
  return localVolumes.map((volume, index) => {
    requireNativeGridVolume(volume, index);
    return volume.waterMedium === true ? cookWaterMediumVolume(volume) : cookGridVolume(volume);
  });
}

/** The trace scene without its local volumes, which the Cook packers refuse: the grids travel by `appendNativeGridVolumes` instead. */
export function withoutLocalVolumes(traceScene) {
  const { localVolumes, ...rest } = traceScene;
  return rest;
}

/**
 * Appends the packed grids to the texel pool of a FORMAT-v2 input and sets the grid count, table offset and kernel flag, as Cook's
 * buildNativeInputV2 does for `scene.gridVolumes`. `gridVolumeInput` is `@codepawlhq/cook/grid-volume-input` (packGridVolumes,
 * writeGridVolumeKernelParams). Returns a new input; the arrays the packer made stay as they were.
 */
export function appendNativeGridVolumes(input, gridVolumes, gridVolumeInput) {
  const packed = gridVolumeInput.packGridVolumes(gridVolumes, input.textureTexels.length);
  if (!packed) return input;
  const poolBytes = (input.textureTexels.length + packed.words.length) * 4;
  if (poolBytes > NATIVE_TEXEL_POOL_MAX_BYTES) {
    throw new RangeError(`The textures and the grid volumes need ${poolBytes} bytes of texel pool, over its ${NATIVE_TEXEL_POOL_MAX_BYTES} byte limit. Resample the grids or use smaller textures.`);
  }
  const textureTexels = new Uint32Array(input.textureTexels.length + packed.words.length);
  textureTexels.set(input.textureTexels, 0);
  textureTexels.set(packed.words, input.textureTexels.length);
  const kernelParams = input.kernelParams.slice();
  gridVolumeInput.writeGridVolumeKernelParams(kernelParams, packed);
  return { ...input, textureTexels, kernelParams };
}
