import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SHADER_CACHE_PROFILE_FOLDER, folderBytes, isWriteLocked, launchWithShaderCache, saveShaderCache, seedShaderCache, shaderCacheDirectory,
} from '../scripts/agent-shader-cache.mjs';

function makeFolder() {
  return mkdtempSync(join(tmpdir(), 'crucible-shader-cache-test-'));
}

function writeCache(root, files) {
  const folder = join(root, SHADER_CACHE_PROFILE_FOLDER);
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
}

function readCache(root) {
  const folder = join(root, SHADER_CACHE_PROFILE_FOLDER);
  return Object.fromEntries(readdirSync(folder).map(name => [name, readFileSync(join(folder, name), 'utf8')]));
}

test('the cache folder follows the platform, an absolute override, and the off switch', () => {
  assert.equal(shaderCacheDirectory({ LOCALAPPDATA: 'C:\\Local' }, 'win32'), join('C:\\Local', 'crucible', 'shader-cache'));
  assert.equal(shaderCacheDirectory({ XDG_CACHE_HOME: '/xdg' }, 'linux'), join('/xdg', 'crucible', 'shader-cache'));
  assert.match(shaderCacheDirectory({}, 'linux'), /\.cache[\\/]crucible[\\/]shader-cache$/);
  assert.equal(shaderCacheDirectory({ CRUCIBLE_SHADER_CACHE: join(tmpdir(), 'mine') }, 'linux'), join(tmpdir(), 'mine'));
  assert.match(shaderCacheDirectory({ SIXTYSEVENJS_SHADER_CACHE: join(tmpdir(), 'legacy') }, 'linux'), /\.cache[\\/]crucible[\\/]shader-cache$/);
});

test('CRUCIBLE_SHADER_CACHE=0 or off turns the cache off, and a relative folder says what to pass', () => {
  assert.equal(shaderCacheDirectory({ CRUCIBLE_SHADER_CACHE: '0' }), null);
  assert.equal(shaderCacheDirectory({ CRUCIBLE_SHADER_CACHE: 'off' }), null);
  assert.throws(() => shaderCacheDirectory({ CRUCIBLE_SHADER_CACHE: 'cache' }), /absolute folder, "0" or "off", got "cache"/);
});

test('seeding copies only the GPUCache folder into the profile', () => {
  const cache = makeFolder();
  const profile = makeFolder();
  writeCache(cache, { data_0: 'compiled' });
  writeFileSync(join(cache, 'cookies'), 'not a shader');
  assert.equal(seedShaderCache(cache, profile), 'seeded');
  assert.deepEqual(readCache(profile), { data_0: 'compiled' });
  assert.deepEqual(readdirSync(profile), ['Default']);
  assert.equal(seedShaderCache(makeFolder(), makeFolder()), 'empty');
});

test('saving copies only the GPUCache folder, replaces the old cache and leaves no temporary folders', () => {
  const cache = makeFolder();
  const profile = makeFolder();
  writeCache(cache, { old: 'old' });
  writeCache(profile, { fresh: 'fresh' });
  mkdirSync(join(profile, 'Default', 'Local Storage'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Cookies'), 'secret');
  assert.equal(saveShaderCache(cache, profile), 'saved');
  assert.deepEqual(readCache(cache), { fresh: 'fresh' });
  assert.deepEqual(readdirSync(join(cache, 'Default')), ['GPUCache']);
  assert.deepEqual(readdirSync(cache), ['Default']);
  assert.equal(saveShaderCache(cache, makeFolder()), 'nothing');
});

test('a cache over the size cap is dropped instead of grown, on save and on seed', () => {
  const cache = makeFolder();
  const profile = makeFolder();
  writeCache(cache, { old: 'x'.repeat(10) });
  writeCache(profile, { big: 'x'.repeat(100) });
  assert.equal(saveShaderCache(cache, profile, 50), 'too-large');
  assert.equal(existsSync(join(cache, SHADER_CACHE_PROFILE_FOLDER)), false);
  writeCache(cache, { big: 'x'.repeat(100) });
  const next = makeFolder();
  assert.equal(seedShaderCache(cache, next, 50), 'too-large');
  assert.equal(existsSync(join(cache, SHADER_CACHE_PROFILE_FOLDER)), false);
  assert.equal(existsSync(join(next, SHADER_CACHE_PROFILE_FOLDER)), false);
  assert.equal(folderBytes(join(tmpdir(), 'crucible-no-such-folder')), 0);
});

test('a cache another process is saving is skipped on seed and on save, a dead writer lock is not', () => {
  const cache = makeFolder();
  const profile = makeFolder();
  writeCache(cache, { old: 'old' });
  writeCache(profile, { fresh: 'fresh' });
  const lock = join(cache, '.write-lock');
  mkdirSync(lock);
  assert.equal(isWriteLocked(cache), true);
  assert.equal(seedShaderCache(cache, makeFolder()), 'locked');
  assert.equal(saveShaderCache(cache, profile), 'locked');
  assert.deepEqual(readCache(cache), { old: 'old' });
  assert.deepEqual(readdirSync(cache).sort(), ['.write-lock', 'Default']);
  const longAgo = new Date(Date.now() - 120_000);
  utimesSync(lock, longAgo, longAgo);
  assert.equal(isWriteLocked(cache), false);
  assert.equal(saveShaderCache(cache, profile), 'saved');
  assert.deepEqual(readCache(cache), { fresh: 'fresh' });
  assert.equal(existsSync(lock), false);
});

test('a browser started with the cache gets the seed, and closing saves the new cache and deletes the profile', async () => {
  const cache = makeFolder();
  writeCache(cache, { first: 'one' });
  let profileFolder;
  const fakeChromium = {
    async launchPersistentContext(folder, options) {
      profileFolder = folder;
      assert.equal(options.headless, true);
      assert.deepEqual(readCache(folder), { first: 'one' });
      return {
        on() {},
        async newPage() { return { setViewportSize: async () => {} }; },
        async close() { writeFileSync(join(folder, SHADER_CACHE_PROFILE_FOLDER, 'second'), 'two'); },
      };
    },
  };
  const browser = await launchWithShaderCache(fakeChromium, { headless: true }, cache);
  assert.equal(browser.isConnected(), true);
  await browser.close();
  assert.deepEqual(readCache(cache), { first: 'one', second: 'two' });
  assert.equal(existsSync(profileFolder), false);
});

test('a browser that fails to start leaves no profile behind', async () => {
  let profileFolder;
  const failingChromium = { async launchPersistentContext(folder) { profileFolder = folder; throw new Error('no chrome'); } };
  await assert.rejects(() => launchWithShaderCache(failingChromium, {}, makeFolder()), /no chrome/);
  assert.equal(existsSync(profileFolder), false);
  rmSync(profileFolder, { recursive: true, force: true });
});
