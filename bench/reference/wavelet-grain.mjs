// Scores the wavelet denoiser against a high-sample reference on a flat-walled interior (issue #1335):
//   node bench/reference/wavelet-grain.mjs [--oidn] [--samples 256] [--reference 4096] [--width 160] [--height 90] [--directory artifacts/1335]
// Draws the room once at the sample count and once at the reference count with the CPU path tracer (no denoiser), filters the
// first with the settings listed in VARIANTS, and prints RMSE and flat-wall grain of each against the reference. Writes PNGs.
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { renderPathTracedImage, toneMapToRgba8 } from '../../src/path-tracer.js';
import { denoiseWithOidn, findOidnBinary } from '../../packages/denoise-oidn/index.mjs';
import { denoiseRadiance, DEFAULT_DENOISE_SETTINGS } from '../../src/path-tracer-denoise.js';

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function quadPart(name, corners, normal, material) {
  const geometry = {
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array([...normal, ...normal, ...normal, ...normal]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return { name, geometry, matrix: new Float32Array(IDENTITY), material: { tag: 'surface', metallic: 0, roughness: 1, ...material } };
}

/** A 5 by 3 by 4 metre room lit by a ceiling area light and a point light, a cabinet block and a window-less back wall: flat, mostly diffuse. */
function buildRoom() {
  const wall = { color: [0.75, 0.72, 0.65] };
  const floor = { color: [0.45, 0.32, 0.22] };
  const cabinet = { color: [0.35, 0.5, 0.4] };
  const parts = [
    quadPart('floor', [[-2.5, 0, -2], [2.5, 0, -2], [2.5, 0, 2], [-2.5, 0, 2]], [0, 1, 0], floor),
    quadPart('ceiling', [[-2.5, 3, 2], [2.5, 3, 2], [2.5, 3, -2], [-2.5, 3, -2]], [0, -1, 0], wall),
    quadPart('back', [[-2.5, 0, -2], [-2.5, 3, -2], [2.5, 3, -2], [2.5, 0, -2]], [0, 0, 1], wall),
    quadPart('left', [[-2.5, 0, 2], [-2.5, 3, 2], [-2.5, 3, -2], [-2.5, 0, -2]], [1, 0, 0], wall),
    quadPart('right', [[2.5, 0, -2], [2.5, 3, -2], [2.5, 3, 2], [2.5, 0, 2]], [-1, 0, 0], wall),
    quadPart('cabinet-front', [[-2.4, 0, -1.4], [-0.4, 0, -1.4], [-0.4, 1.6, -1.4], [-2.4, 1.6, -1.4]], [0, 0, 1], cabinet),
    quadPart('cabinet-top', [[-2.4, 1.6, -1.4], [-0.4, 1.6, -1.4], [-0.4, 1.6, -2], [-2.4, 1.6, -2]], [0, 1, 0], cabinet),
  ];
  return parts;
}

const ENVIRONMENT = {
  keyColor: [0, 0, 0],
  lightDirection: [0, 1, 0],
  areaLights: [{ position: [0, 2.95, 0], direction: [0, -1, 0], width: 1.6, height: 0.8, color: [1, 0.95, 0.85], intensity: 90 }],
};

const CAMERA = { eye: [0.8, 1.5, 1.9], target: [-0.6, 1.3, -2], up: [0, 1, 0], fov: 60 };

function luminance(buffer, index) {
  return 0.2126 * buffer[index * 3] + 0.7152 * buffer[index * 3 + 1] + 0.0722 * buffer[index * 3 + 2];
}

/** Root mean square error of the tone mapped colour, 0 to 1, over the pixels of the mask. */
function toneMappedRmse(candidate, reference, mask, options) {
  const candidateRgba = toneMapToRgba8(candidate, options.width, options.height, options);
  const referenceRgba = toneMapToRgba8(reference, options.width, options.height, options);
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < options.width * options.height; pixel++) {
    if (!mask[pixel]) continue;
    for (let channel = 0; channel < 3; channel++) {
      const difference = (candidateRgba[pixel * 4 + channel] - referenceRgba[pixel * 4 + channel]) / 255;
      sum += difference * difference;
    }
    count += 3;
  }
  return Math.sqrt(sum / count);
}

/** Pixels whose 5 by 5 neighbourhood is one flat surface (same normal, depth within 2 percent): walls, floor and cabinet faces. */
function flatMask({ normal, depth }, { width, height }) {
  const mask = new Uint8Array(width * height);
  for (let row = 2; row < height - 2; row++) {
    for (let column = 2; column < width - 2; column++) {
      const center = row * width + column;
      let flat = depth[center] > 0;
      for (let rowOffset = -2; rowOffset <= 2 && flat; rowOffset++) {
        for (let columnOffset = -2; columnOffset <= 2; columnOffset++) {
          const neighbor = (row + rowOffset) * width + column + columnOffset;
          const agreement = normal[center * 3] * normal[neighbor * 3] + normal[center * 3 + 1] * normal[neighbor * 3 + 1] + normal[center * 3 + 2] * normal[neighbor * 3 + 2];
          const depthGap = Math.abs(depth[center] - depth[neighbor]) / depth[center];
          if (agreement < 0.99 || depthGap > 0.02) {
            flat = false;
            break;
          }
        }
      }
      mask[center] = flat ? 1 : 0;
    }
  }
  return mask;
}

/** Mean absolute difference from a 3 by 3 median of the luminance, on lit pixels: the grain metric of the issue. */
function medianGrain(buffer, options) {
  const { width, height } = options;
  let sum = 0;
  let count = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let column = 1; column < width - 1; column++) {
      const values = [];
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) values.push(luminance(buffer, (row + rowOffset) * width + column + columnOffset));
      }
      values.sort((first, second) => first - second);
      const center = luminance(buffer, row * width + column);
      if (center < 0.02) continue;
      sum += Math.abs(center - values[4]);
      count++;
    }
  }
  return sum / count;
}

/** The tone mapped difference from the reference, times 8, as grey: where the filter is wrong, not how it looks. */
function errorImage(candidate, reference, options) {
  const candidateRgba = toneMapToRgba8(candidate, options.width, options.height, options);
  const referenceRgba = toneMapToRgba8(reference, options.width, options.height, options);
  const image = new Uint8ClampedArray(candidateRgba.length);
  for (let pixel = 0; pixel < candidateRgba.length / 4; pixel++) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) difference += Math.abs(candidateRgba[pixel * 4 + channel] - referenceRgba[pixel * 4 + channel]) / 3;
    image.fill(Math.min(255, difference * 8), pixel * 4, pixel * 4 + 3);
    image[pixel * 4 + 3] = 255;
  }
  return image;
}

function encodePng(rgba, width, height) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    rows[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(rows, row * (width * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export const VARIANTS = JSON.parse(optionValue('--variants', JSON.stringify({ before: { ...DEFAULT_DENOISE_SETTINGS } })));

async function trace(samples, width, height, seed, threads) {
  const options = { width, height, samples, bounces: 3, seed, threads, denoise: false, maxSeconds: 1800 };
  const traced = await renderPathTracedImage({ parts: buildRoom(), environment: ENVIRONMENT, camera: CAMERA }, options);
  return traced;
}

async function main() {
  const width = Number(optionValue('--width', '160'));
  const height = Number(optionValue('--height', '90'));
  const samples = Number(optionValue('--samples', '256'));
  const referenceSamples = Number(optionValue('--reference', '4096'));
  const directory = resolve(optionValue('--directory', 'artifacts/1335'));
  const threads = Number(optionValue('--threads', String(Math.min(8, Math.max(1, availableParallelism() - 4)))));
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  await mkdir(directory, { recursive: true });
  const tone = { width, height, viewTransform: 'aces' };
  // One render takes at most 1024 samples, so the reference is the mean of several renders with other seeds.
  const referenceRenders = Math.ceil(referenceSamples / 1024);
  const referenceLinear = new Float32Array(width * height * 3);
  for (let render = 0; render < referenceRenders; render++) {
    const traced = await trace(Math.min(1024, referenceSamples), width, height, 100 + render, threads);
    for (let index = 0; index < referenceLinear.length; index++) referenceLinear[index] += traced.linear[index] / referenceRenders;
  }
  const reference = { linear: referenceLinear };
  const noisy = await trace(samples, width, height, 1, threads);
  const features = noisy.features;
  const rows = [{ name: 'unfiltered', linear: features.color }];
  for (const [name, settings] of Object.entries(VARIANTS)) {
    rows.push({ name, linear: denoiseRadiance({ width, height, ...features }, settings) });
  }
  // Pass --oidn to add the row `denoise: true` now produces when the OIDN package and its binary are installed (OIDN_DENOISE_PATH or the fetched vendor folder).
  if (process.argv.includes('--oidn')) {
    if (!findOidnBinary()) throw new Error('--oidn needs the OIDN binary: run node packages/denoise-oidn/fetch-oidn.mjs or set OIDN_DENOISE_PATH.');
    rows.push({ name: 'oidn', linear: await denoiseWithOidn({ width, height, color: features.color, albedo: features.albedo, normal: features.normal }) });
  }
  const allSurfaces = features.depth.map(depthValue => (depthValue > 0 ? 1 : 0));
  const flat = flatMask(features, tone);
  const report = [];
  for (const row of rows) {
    const rmse = toneMappedRmse(row.linear, reference.linear, allSurfaces, tone);
    const flatRmse = toneMappedRmse(row.linear, reference.linear, flat, tone);
    const grain = medianGrain(row.linear, tone);
    report.push({ name: row.name, rmse: Number(rmse.toFixed(5)), flatRmse: Number(flatRmse.toFixed(5)), grain: Number(grain.toFixed(5)) });
    await writeFile(`${directory}/${samples}-${row.name}-error.png`, encodePng(errorImage(row.linear, reference.linear, tone), width, height));
    await writeFile(`${directory}/${samples}-${row.name}.png`, encodePng(toneMapToRgba8(row.linear, width, height, tone), width, height));
  }
  report.push({ name: 'reference', rmse: 0, flatRmse: 0, grain: Number(medianGrain(reference.linear, tone).toFixed(5)) });
  await writeFile(`${directory}/reference.png`, encodePng(toneMapToRgba8(reference.linear, width, height, tone), width, height));
  console.log(JSON.stringify({ width, height, samples, referenceSamples, report }, null, 1));
}

await main();
