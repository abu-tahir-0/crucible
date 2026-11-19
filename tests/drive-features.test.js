import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { findFeature, formatFeatureList, parseCommandLine, parseFeatures, requirePage } from '../scripts/drive-features.mjs';

const SAMPLE = `# Feature map

Intro text that is not a feature.

## Site pages

### \`object\`
- Name: Object studio
- Surface: Site
- Reach: \`/object.html\`
- Source: \`site/object.html\`, \`src/main.js\`
- Ready: \`window.__studio?.renderer\`
- Drive: \`node scripts/drive.mjs shot object\`

## MCP server tools

### \`scene_look\`
- Name: Render the active scene as a bounded PNG
- Surface: MCP
- Reach: MCP tool \`scene_look\`
- Source: \`scripts/mcp-server.mjs:969\`
- Drive: none: needs an MCP client
`;

test('parseFeatures reads the fields of each block and its section', () => {
  const [page, tool] = parseFeatures(SAMPLE);
  assert.equal(page.id, 'object');
  assert.equal(page.section, 'Site pages');
  assert.equal(page.route, '/object.html');
  assert.equal(page.ready, 'window.__studio?.renderer');
  assert.equal(page.source, '`site/object.html`, `src/main.js`');
  assert.equal(tool.section, 'MCP server tools');
  assert.equal(tool.route, null);
  assert.equal(tool.ready, null);
});

test('findFeature suggests similar ids and requirePage rejects non-pages', () => {
  const features = parseFeatures(SAMPLE);
  assert.throws(() => findFeature(features, 'obj'), /Did you mean: object/);
  assert.throws(() => findFeature(features, 'zzz'), /Run `node scripts\/drive.mjs list`/);
  assert.equal(requirePage(findFeature(features, 'object')), '/object.html');
  assert.throws(() => requirePage(findFeature(features, 'scene_look')), /not a page/);
});

test('formatFeatureList filters by surface', () => {
  const features = parseFeatures(SAMPLE);
  assert.equal(formatFeatureList(features, 'mcp').split('\n').length, 1);
  assert.equal(formatFeatureList(features).split('\n').length, 2);
});

test('parseCommandLine separates ids from flags and rejects unknown flags', () => {
  const parsed = parseCommandLine(['shot', 'home', '--out', 'a.png', '--no-gpu-lock']);
  assert.deepEqual(parsed, { command: 'shot', positional: ['home'], flags: { out: 'a.png', 'no-gpu-lock': true } });
  assert.throws(() => parseCommandLine(['shot', 'home', '--bogus']), /Unknown flag --bogus/);
  assert.throws(() => parseCommandLine(['shot', 'home', '--out']), /needs a value/);
});

test('parseCommandLine rejects a value that is the next flag', () => {
  for (const name of ['out', 'origin', 'width', 'height', 'surface', 'settle']) {
    assert.throws(() => parseCommandLine(['shot', 'home', `--${name}`, '--full-page']), new RegExp(`--${name} needs a value`), name);
  }
});

test('parseCommandLine rejects non-numeric and out-of-range numeric values', () => {
  for (const name of ['width', 'height']) {
    assert.throws(() => parseCommandLine(['shot', 'home', `--${name}`, 'abc']), /needs a number greater than 0/, name);
    assert.throws(() => parseCommandLine(['shot', 'home', `--${name}`, '0']), /needs a number greater than 0/, name);
    assert.throws(() => parseCommandLine(['shot', 'home', `--${name}`, '-5']), /needs a number greater than 0/, name);
    assert.equal(parseCommandLine(['shot', 'home', `--${name}`, '800']).flags[name], '800');
  }
  assert.throws(() => parseCommandLine(['shot', 'home', '--settle', 'abc']), /needs a number of milliseconds/);
  assert.throws(() => parseCommandLine(['shot', 'home', '--settle', '-1']), /needs a number of milliseconds/);
  assert.equal(parseCommandLine(['shot', 'home', '--settle', '0']).flags.settle, '0');
});

test('the real FEATURES.md has unique ids and every page route points at a file', () => {
  const features = parseFeatures(readFileSync(new URL('../FEATURES.md', import.meta.url), 'utf8'));
  const ids = features.map(feature => feature.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate feature ids');
  assert.equal(features.find(feature => feature.id === 'home')?.route, '/');
  for (const feature of features.filter(candidate => candidate.route)) {
    const relativePath = feature.route === '/' ? 'site/index.html' : feature.route.startsWith('/bench/') ? feature.route.slice(1) : `site${feature.route}`;
    assert.ok(existsSync(new URL(`../${relativePath}`, import.meta.url)), `${feature.id}: ${relativePath} is missing`);
  }
  for (const feature of features.filter(candidate => candidate.surface === 'MCP')) {
    assert.match(readFileSync(new URL('../scripts/mcp-server.mjs', import.meta.url), 'utf8'), new RegExp(`register\\('${feature.id}'`));
  }
});
