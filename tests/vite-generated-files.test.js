import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { devRelease, generatedFiles, GENERATED_FILES } from '../scripts/vite-generated-files.mjs';

function middlewareOf(root) {
  let handler;
  generatedFiles({ root }).configureServer({ middlewares: { use: middleware => { handler = middleware; } } });
  return handler;
}

async function answer(handler, url) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const response = {
      setHeader: (name, value) => { headers[name] = value; },
      end: body => resolve({ served: true, headers, body }),
    };
    handler({ url }, response, error => (error ? reject(error) : resolve({ served: false })));
  });
}

// The fields and checks src/home.js validateRelease applies before it shows a release.
function assertHomeAccepts(release) {
  for (const key of ['version', 'packageName', 'commit', 'installCommand', 'tarball', 'module', 'api']) {
    assert.equal(typeof release[key], 'string', key);
    assert.ok(release[key].trim(), key);
  }
  assert.equal(typeof release.registryPublished, 'boolean');
  assert.match(release.commit, /^[a-f0-9]{7,40}$/i);
  for (const key of ['tarball', 'module', 'api']) assert.match(release[key], /^\.?\//, `${key} stays on the current site`);
}

test('the dev release names the package version and commit in the shape the home page accepts', () => {
  const release = devRelease({ packageJson: { name: '@codepawlhq/crucible', version: '1.2.3' }, commit: 'a'.repeat(40) });
  assertHomeAccepts(release);
  assert.equal(release.version, '1.2.3');
  assert.equal(release.tarball, '/releases/codepawlhq-crucible-1.2.3.tgz');
  assert.equal(release.module, '/releases/1.2.3/crucible.module.js');
  assert.equal(release.registryPublished, false);
});

test('a checkout without public/ files gets the release built on request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-files-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@codepawlhq/crucible', version: '9.8.7' }));
    const reply = await answer(middlewareOf(root), '/release.json?commit=abc');
    assert.equal(reply.served, true);
    assert.equal(reply.headers['Content-Type'], 'application/json');
    const release = JSON.parse(reply.body);
    assertHomeAccepts(release);
    assert.equal(release.version, '9.8.7');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a copy in public/ wins, and other addresses pass through', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-files-'));
  try {
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'release.json'), '{}');
    const handler = middlewareOf(root);
    assert.equal((await answer(handler, '/release.json')).served, false);
    assert.equal((await answer(handler, '/index.html')).served, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every file the site pages fetch is covered', () => {
  assert.deepEqual(Object.keys(GENERATED_FILES).sort(), ['/api-reference.json', '/changelog.json', '/release.json']);
});
