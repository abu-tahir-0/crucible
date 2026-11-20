import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_METHOD, SIZE_METHOD } from '../scripts/size-base.mjs';

const SCRIPTS_FOLDER = fileURLToPath(new URL('../scripts/', import.meta.url));
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function relativeImportsOf(file) {
  const found = [];
  for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
    const imported = resolve(dirname(file), match[1]);
    if (existsSync(imported)) found.push(imported);
  }
  return found;
}

// Every file a method's script reaches by relative imports, following the imports of the files the method already lists too,
// because the archive build reaches its helper plugins through config/vite.lib.config.js and not through the script.
function reachedFiles(method) {
  const reached = new Set();
  const pending = [method.script, ...method.files.map(file => resolve(SCRIPTS_FOLDER, file))];
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...relativeImportsOf(file));
  }
  return reached;
}

function missingFromKey(method) {
  const keyed = new Set([method.script, ...method.files.map(file => resolve(SCRIPTS_FOLDER, file))]);
  return [...reachedFiles(method)].filter(file => !keyed.has(file)).map(file => relative(SCRIPTS_FOLDER, file).replaceAll('\\', '/'));
}

test('the size measuring method hashes every file its script reaches', () => {
  assert.deepEqual(missingFromKey(SIZE_METHOD), [], 'add these files to SIZE_METHOD.files in scripts/size-base.mjs');
});

test('the archive measuring method hashes every file its build reaches', () => {
  assert.deepEqual(missingFromKey(ARCHIVE_METHOD), [], 'add these files to ARCHIVE_METHOD.files in scripts/size-base.mjs');
});

test('the files named in both methods exist', () => {
  for (const file of [...SIZE_METHOD.files, ...ARCHIVE_METHOD.files]) {
    assert.ok(existsSync(join(SCRIPTS_FOLDER, file)), `${file} is listed but missing`);
  }
});
