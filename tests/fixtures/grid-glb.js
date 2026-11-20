/**
 * A flat square grid as a binary glTF: positions, normals and 32-bit indices, no textures. A side of 950 gives
 * 902,500 vertices, under the catalog's 1,000,000 vertex limit, and about 43 MiB of resident geometry.
 */
export function gridGlb(sideVertexCount, marker = 'grid') {
  const vertexCount = sideVertexCount * sideVertexCount;
  const cellCount = (sideVertexCount - 1) * (sideVertexCount - 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  for (let row = 0; row < sideVertexCount; row++) {
    for (let column = 0; column < sideVertexCount; column++) {
      const vertex = row * sideVertexCount + column;
      positions.set([column / sideVertexCount, 0, row / sideVertexCount], vertex * 3);
      normals.set([0, 1, 0], vertex * 3);
    }
  }
  const indices = new Uint32Array(cellCount * 6);
  let cursor = 0;
  for (let row = 0; row < sideVertexCount - 1; row++) {
    for (let column = 0; column < sideVertexCount - 1; column++) {
      const corner = row * sideVertexCount + column;
      indices.set([corner, corner + sideVertexCount, corner + 1, corner + 1, corner + sideVertexCount, corner + sideVertexCount + 1], cursor);
      cursor += 6;
    }
  }
  const chunks = [positions, normals, indices].map(array => Buffer.from(array.buffer));
  const document = {
    asset: { version: '2.0', generator: marker },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: marker, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [],
    buffers: [{ byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) }],
  };
  let offset = 0;
  for (const chunk of chunks) {
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: chunk.byteLength });
    offset += chunk.byteLength;
  }
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binary = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, binary]);
}
