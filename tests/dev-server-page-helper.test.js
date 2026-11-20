import assert from 'node:assert/strict';
import test from 'node:test';

import { BLANK_PAGE_PATH, withDevServerPage } from './helpers/dev-server-browser.js';

// Issue #2686: the WebGL tests opened the home page, whose live hero shares SwiftShader on CI with the code under test,
// as #2684 found for the WebGPU tests. They run on a blank page of the dev server's origin instead.
test('WebGL tests run on a blank page of the dev server, with no page script beside them, and can import /src', async context => {
  await withDevServerPage(context, async page => {
    const state = await page.evaluate(async () => {
      const geometry = await import('/src/geometry.js');
      return {
        path: location.pathname,
        scripts: document.scripts.length,
        canvases: document.querySelectorAll('canvas').length,
        isolated: crossOriginIsolated,
        imported: typeof geometry.box,
      };
    });
    assert.deepEqual(state, { path: BLANK_PAGE_PATH, scripts: 0, canvases: 0, isolated: true, imported: 'function' });
  });
});
