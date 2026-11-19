import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_METHOD, SIZE_METHOD } from '../scripts/size-base.mjs';

const scriptsFolder = fileURLToPath(new URL('../scripts/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function relativeImports(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/);
    return match ? [resolve(dirname(file), match[1])] : [];
  });
}

function reachableScripts(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...relativeImports(file).filter(target => /\.(mjs|js)$/.test(target) && !target.split(sep).includes('src')));
  }
  return [...seen];
}

function listedFiles(method) {
  return new Set(method.files.map(file => resolve(scriptsFolder, file)));
}

for (const [name, method] of [['SIZE_METHOD', SIZE_METHOD], ['ARCHIVE_METHOD', ARCHIVE_METHOD]]) {
  test(`${name} lists every script its measuring script reaches through relative imports`, () => {
    const listed = listedFiles(method);
    for (const file of reachableScripts(method.script)) {
      if (!file.startsWith(scriptsFolder)) continue;
      const label = relative(repoRoot, file).split(sep).join('/');
      assert.ok(listed.has(file), `${label} is imported by ${relative(repoRoot, method.script)} but missing from ${name}.files`);
    }
  });
}
