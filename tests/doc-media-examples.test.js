import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPages, parseExamples, checkPosterName } from '../scripts/doc-media-examples.mjs';

const folder = '/site/public/docs-media';

test('an unknown page id throws and names the valid pages', () => {
  assert.throws(() => selectPages(['water', 'fire'], ['typo-page']), /Unknown documentation page "typo-page".*water, fire/);
  assert.deepEqual(selectPages(['water', 'fire'], ['fire']), ['fire']);
  assert.deepEqual(selectPages(['water', 'fire'], []), ['water', 'fire']);
});

test('a poster must be a plain file name inside the folder', () => {
  for (const bad of ['../../x', '..', 'a/b', 'a\\b', '/abs', '', 'a..b/c']) {
    assert.throws(() => checkPosterName(bad, folder), /poster must be a plain file name/, bad);
  }
  assert.equal(checkPosterName('water-pour_2', folder), 'water-pour_2');
});

test('parseExamples rejects an escaping poster', () => {
  const text = '```js live poster=../../x\ncode\n```\n';
  assert.throws(() => parseExamples('page', text, folder), /poster must be a plain file name/);
});

test('a shown WebM needs a positive loop', () => {
  const page = flags => `![](/docs-media/wave.webm)\n\n\`\`\`js live poster=wave${flags}\ncode\n\`\`\`\n`;
  assert.throws(() => parseExamples('sea', page(''), folder), /sea:.*loop=\(missing\).*loop=<seconds>/);
  assert.throws(() => parseExamples('sea', page(' loop=0'), folder), /loop=0/);
  assert.throws(() => parseExamples('sea', page(' loop=abc'), folder), /loop=abc/);
  assert.deepEqual(parseExamples('sea', page(' loop=4'), folder), [{ poster: 'wave', loopSeconds: 4 }]);
});

test('a poster without a WebM needs no loop, and examples without a poster are skipped', () => {
  const text = '```js live poster=still\ncode\n```\n```js live\ncode\n```\n';
  assert.deepEqual(parseExamples('page', text, folder), [{ poster: 'still', loopSeconds: 0 }]);
});
