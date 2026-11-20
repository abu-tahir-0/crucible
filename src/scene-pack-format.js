// The file format of `crucible pack` (docs/pack.md): a compiled scene as one JSON header plus one binary block.
// This module is shared by the Node compiler (src/scene-pack.js) and the web runtime (src/crucible-scene.js), so it imports
// nothing: the runtime must not pull any agent-scene code through it.

export const PACK_FORMAT = 'crucible.pack';
export const PACK_VERSION = 1;

const TYPED_ARRAYS = Object.freeze({
  Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
});
const TYPED_MARKER = '$typed';
const RGBE_MARKER = '$rgbe';
const ALIGNMENT = 4;
const HEADER_BYTES = 8;
const MAGIC = 0x4b435243; // "CRCK" read as little endian

function padTo(length, alignment) {
  return Math.ceil(length / alignment) * alignment;
}

// Colour maps (the reflection probes of metal parts) are the bulk of a pack, so their linear RGB floats are stored as RGBE:
// three 8 bit mantissas and one shared 8 bit exponent, a third of the bytes with at most one part in 128 of error on the
// brightest channel of a pixel. The runtime expands them back to the Float32Array the renderer takes.
function isColourMap(value) {
  return value.kind === 'environment-map' && value.channels === 3 && value.data instanceof Float32Array;
}

/** Packs linear RGB floats as RGBE bytes (four per pixel). Negative values clamp to zero; the exponent is shared per pixel. */
export function encodeRgbe(rgb) {
  const bytes = new Uint8Array(rgb.length / 3 * 4);
  for (let pixel = 0; pixel * 3 < rgb.length; pixel++) {
    const red = Math.max(0, rgb[pixel * 3]);
    const green = Math.max(0, rgb[pixel * 3 + 1]);
    const blue = Math.max(0, rgb[pixel * 3 + 2]);
    const brightest = Math.max(red, green, blue);
    if (brightest < 1e-32) continue;
    const exponent = Math.floor(Math.log2(brightest)) + 1;
    const scale = 256 / 2 ** exponent;
    bytes[pixel * 4] = Math.min(255, Math.round(red * scale));
    bytes[pixel * 4 + 1] = Math.min(255, Math.round(green * scale));
    bytes[pixel * 4 + 2] = Math.min(255, Math.round(blue * scale));
    bytes[pixel * 4 + 3] = exponent + 128;
  }
  return bytes;
}

/** The inverse of encodeRgbe: a Float32Array of linear RGB, three values per pixel. */
export function decodeRgbe(bytes) {
  const rgb = new Float32Array(bytes.length / 4 * 3);
  for (let pixel = 0; pixel * 4 < bytes.length; pixel++) {
    if (bytes[pixel * 4 + 3] === 0) continue;
    const scale = 2 ** (bytes[pixel * 4 + 3] - 128) / 256;
    rgb[pixel * 3] = bytes[pixel * 4] * scale;
    rgb[pixel * 3 + 1] = bytes[pixel * 4 + 1] * scale;
    rgb[pixel * 3 + 2] = bytes[pixel * 4 + 2] * scale;
  }
  return rgb;
}

function describeKind(value) {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * Splits a value into JSON and binary: every typed array becomes a { $typed, offset, length } marker and its bytes go to
 * the binary block, so geometry is never written as text. Anything JSON cannot hold throws and names where it sits.
 */
function encodeValue(value, path, chunks, cursor) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: got ${value}; expected a finite number. Fix the recipe field that produced it.`);
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor.name;
    if (!Object.hasOwn(TYPED_ARRAYS, name)) throw new TypeError(`${path}: got ${name}; expected a typed array such as Float32Array or Uint32Array.`);
    const offset = padTo(cursor.bytes, ALIGNMENT);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    chunks.push({ offset, bytes });
    cursor.bytes = offset + bytes.byteLength;
    return { [TYPED_MARKER]: name, offset, length: value.length };
  }
  if (Array.isArray(value)) return value.map((entry, index) => encodeValue(entry, `${path}[${index}]`, chunks, cursor));
  if (value !== undefined && typeof value === 'object') {
    const kind = describeKind(value);
    if (kind !== 'Object') throw new TypeError(`${path}: got a ${kind}; expected plain data. A pack holds numbers, strings, arrays, objects and typed arrays only.`);
    const encoded = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      encoded[key] = key === 'data' && isColourMap(value)
        ? { [RGBE_MARKER]: encodeValue(encodeRgbe(value.data), `${path}.data`, chunks, cursor) }
        : encodeValue(value[key], `${path}.${key}`, chunks, cursor);
    }
    return encoded;
  }
  throw new TypeError(`${path}: got ${typeof value}; expected plain data. A pack holds numbers, strings, arrays, objects and typed arrays only.`);
}

function decodeValue(value, binary) {
  if (Array.isArray(value)) return value.map(entry => decodeValue(entry, binary));
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, TYPED_MARKER)) {
    const Constructor = TYPED_ARRAYS[value[TYPED_MARKER]];
    if (!Constructor) throw new TypeError(`pack: unknown typed array "${value[TYPED_MARKER]}"; repack the scene with this version of crucible pack.`);
    return new Constructor(binary.buffer, binary.byteOffset + value.offset, value.length);
  }
  if (Object.hasOwn(value, RGBE_MARKER)) return decodeRgbe(decodeValue(value[RGBE_MARKER], binary));
  const decoded = {};
  for (const key of Object.keys(value)) decoded[key] = decodeValue(value[key], binary);
  return decoded;
}

/** Encodes a scene description into one deterministic Uint8Array: the same input always gives the same bytes. */
export function encodePack(scene) {
  if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
    throw new TypeError('encodePack: pass the scene object to pack, such as { camera, environment, parts }.');
  }
  const chunks = [];
  const cursor = { bytes: 0 };
  const body = encodeValue(scene, 'scene', chunks, cursor);
  const header = new TextEncoder().encode(JSON.stringify({ format: PACK_FORMAT, version: PACK_VERSION, scene: body }));
  const binaryStart = padTo(HEADER_BYTES + header.length, ALIGNMENT);
  const output = new Uint8Array(binaryStart + cursor.bytes);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.length, true);
  output.set(header, HEADER_BYTES);
  for (const { offset, bytes } of chunks) output.set(bytes, binaryStart + offset);
  return output;
}

/** Reads what encodePack wrote. Typed arrays are views on `bytes`, so the caller must keep it alive. */
export function decodePack(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodePack: pass the bytes of a .pack file as an ArrayBuffer or Uint8Array.');
  if (bytes.length < HEADER_BYTES || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== MAGIC) {
    throw new TypeError('decodePack: these bytes are not a crucible pack. Pass a file written by `crucible pack`.');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (HEADER_BYTES + headerLength > bytes.length) throw new TypeError('decodePack: the pack is cut short. Download or copy it again.');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + headerLength)));
  if (header.format !== PACK_FORMAT || header.version !== PACK_VERSION) {
    throw new TypeError(`decodePack: got ${header.format} version ${header.version}; expected ${PACK_FORMAT} version ${PACK_VERSION}. Repack the scene with this version of crucible pack.`);
  }
  const binaryStart = padTo(HEADER_BYTES + headerLength, ALIGNMENT);
  // The typed array views need a 4 byte aligned buffer offset, so a pack read from an odd offset is copied once.
  const aligned = (bytes.byteOffset + binaryStart) % ALIGNMENT === 0 ? bytes.subarray(binaryStart) : bytes.slice(binaryStart);
  return decodeValue(header.scene, aligned);
}
