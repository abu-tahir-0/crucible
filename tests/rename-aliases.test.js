import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import * as crucible from '../src/index.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('the Renderer67 alias from before the rename is gone', () => {
  assert.equal(typeof crucible.CrucibleRenderer, 'function');
  assert.equal('Renderer67' in crucible, false);
});

test('package.json lists only the Crucible commands', () => {
  assert.equal(packageMetadata.name, '@codepawlhq/crucible');
  assert.deepEqual(Object.keys(packageMetadata.bin).filter(name => name.startsWith('67js')), []);
  assert.equal(packageMetadata.bin['crucible-mcp'], './bin/crucible-mcp.mjs');
  assert.equal(packageMetadata.bin['crucible-addon-check'], './bin/crucible-addon-check.mjs');
  assert.equal(existsSync(`${repositoryRoot}bin/67js-mcp.mjs`), false);
  assert.equal(existsSync(`${repositoryRoot}bin/67js-addon-check.mjs`), false);
});
