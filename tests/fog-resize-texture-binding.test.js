// Volume fog leaves the frame texture on a mipmapped filter. After a canvas resize deleted that texture, the next frame bound the
// deleted texture to restore the filter and the GL error reached scene_look as "WebGL render failed with error 1282" (#2205).
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

async function renderFogThenResize(page) {
  const task = async () => {
    await import('/src/fog-shader.js');
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const matrix = new Float32Array([8, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
    const material = { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 };
    const canvas = document.createElement('canvas');
    canvas.style.width = '96px';
    canvas.style.height = '54px';
    document.body.append(canvas);
    const environment = { volumeFog: { density: 0.008, minimum: [-220, -2, -220], maximum: [220, 14, 220] } };
    const renderer = new CrucibleRenderer(canvas, [{ name: 'floor', geometry: box(0, 1), matrix, material }], { samples: 1, pixelRatio: 1, depth: true, hdr: true, environment });
    const frame = { eye: [0, 2, 8], target: [0, 1, 0], environment };
    const errors = [];
    renderer.render(frame);
    errors.push(renderer.context.getError());
    canvas.style.width = '128px';
    canvas.style.height = '72px';
    renderer.resize();
    renderer.render(frame);
    errors.push(renderer.context.getError());
    return errors;
  };
  return page.evaluate(task);
}

test('the first fog frame after a canvas resize raises no WebGL error', async (context) => {
  await withDevServerPage(context, async (page) => {
    const [beforeResize, afterResize] = await renderFogThenResize(page);
    assert.equal(beforeResize, 0, 'the first frame is clean');
    assert.equal(afterResize, 0, 'the frame after the resize must not bind the deleted fog texture');
  });
});
