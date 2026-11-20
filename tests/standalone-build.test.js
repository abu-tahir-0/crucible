import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import browserConfiguration, { STANDALONE_FILE_NAME } from '../config/vite.browser.config.js';

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const prepareRelease = await readFile(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
const installGuide = await readFile(new URL('../docs/learn/install.md', import.meta.url), 'utf8');
const standaloneUrl = new URL('../build/crucible.standalone.js', import.meta.url);
// A relative specifier in a static import or re-export at statement start, or in a dynamic import(). Text inside strings, such
// as an error message that says "add import './x.js'", is not at statement start and does not match.
const relativeImportPattern = /(?:^|[;}])\s*(?:import|export)\s*(?:[\w$*{},\s]+from\s*)?["']\.\.?\/|\bimport\s*\(\s*["']\.\.?\//gm;

test('the standalone module builds into build/ after the library build without emptying it', () => {
  assert.equal(STANDALONE_FILE_NAME, 'crucible.standalone.js');
  assert.equal(browserConfiguration.build.outDir, 'build');
  assert.equal(browserConfiguration.build.emptyOutDir, false);
  assert.deepEqual(browserConfiguration.build.lib.formats, ['es']);
  assert.equal(browserConfiguration.build.lib.fileName(), STANDALONE_FILE_NAME);
  const libraryStep = metadata.scripts['build:lib'].indexOf('config/vite.lib.config.js');
  const standaloneStep = metadata.scripts['build:lib'].indexOf('config/vite.browser.config.js');
  assert.ok(libraryStep >= 0 && standaloneStep > libraryStep, 'build:lib must run the standalone build after the library build.');
});

test('the package ships the standalone module and exports it', () => {
  assert.ok(metadata.files.includes('build'));
  assert.ok(!metadata.files.includes('!build/crucible.standalone.js'));
  assert.equal(metadata.exports['./standalone'], './build/crucible.standalone.js');
});

test('release preparation builds the standalone module before npm pack and checks the site copy byte for byte', () => {
  const standaloneBuild = prepareRelease.indexOf('config/vite.browser.config.js');
  const pack = prepareRelease.indexOf("'pack'");
  assert.ok(standaloneBuild >= 0 && standaloneBuild < pack, 'The standalone build must come before npm pack.');
  assert.match(prepareRelease, /sha512\(await readFile\(siteModulePath\)\) !== sha512\(standaloneBytes\)/);
});

test('the install guide shows a pinned jsdelivr snippet with a single module script', () => {
  assert.match(installGuide, /https:\/\/cdn\.jsdelivr\.net\/npm\/@codepawlhq\/crucible@\d+\.\d+\.\d+\/build\/crucible\.standalone\.js/);
});

test('the standalone build inlines every chunk, so no shared code splits into a file it imports (#2726)', () => {
  assert.equal(browserConfiguration.build.rolldownOptions.output.codeSplitting, false);
});

test('the built standalone module imports no relative file, so a CDN serves it from one URL (#2726)',
  { skip: !existsSync(standaloneUrl) && 'build/ has no standalone module; npm run build:lib makes it' }, async () => {
    const standalone = await readFile(standaloneUrl, 'utf8');
    const relativeImports = standalone.match(relativeImportPattern) ?? [];
    assert.deepEqual(relativeImports, [], 'The standalone module imports another file; set codeSplitting: false in config/vite.browser.config.js.');
});

test('the relative import pattern finds the chunk import the split build wrote', () => {
  assert.equal('import { a as b } from "./renderer-CmuzDXzP.js";'.match(relativeImportPattern)?.length, 1);
  assert.equal('const module = await import("../chunk.js");'.match(relativeImportPattern)?.length, 1);
  assert.equal('import"./side.js";'.match(relativeImportPattern)?.length, 1);
  assert.equal('throw Error("The explosion step needs its shader code: add import \'./explosion-shader.js\' (the film player does).");'.match(relativeImportPattern), null);
  assert.equal('export { a } from "./chunk.js";'.match(relativeImportPattern)?.length, 1);
  assert.equal('const url = "https://cdn.jsdelivr.net/npm/x/./y.js"; import { z } from "three";'.match(relativeImportPattern), null);
});
