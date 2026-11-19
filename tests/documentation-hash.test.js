import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTopicHash } from '../src/documentation-topics.js';

test('the hash names the topic and section, and an old link maps to its new topic', () => {
  assert.deepEqual(parseTopicHash('#install/setup'), { hashTopic: 'install', requestedTopic: 'install', requestedSection: 'setup' });
  assert.deepEqual(parseTopicHash('#overview'), { hashTopic: 'overview', requestedTopic: 'introduction', requestedSection: '' });
  assert.deepEqual(parseTopicHash('#install/step%202'), { hashTopic: 'install', requestedTopic: 'install', requestedSection: 'step 2' });
  assert.deepEqual(parseTopicHash(''), { hashTopic: '', requestedTopic: '', requestedSection: '' });
});

test('a malformed percent escape reads as empty and opens the first topic (#2620)', () => {
  // A cut or mistyped link such as "#%E0%A4%A" used to throw in decodeURIComponent and leave the whole page blank. An empty
  // topic is not in the topic list, so the page falls back to its introduction.
  assert.deepEqual(parseTopicHash('#%E0%A4%A'), { hashTopic: '', requestedTopic: '', requestedSection: '' });
  assert.deepEqual(parseTopicHash('#install/%E0%A4%A'), { hashTopic: 'install', requestedTopic: 'install', requestedSection: '' });
  assert.deepEqual(parseTopicHash('#install/%'), { hashTopic: 'install', requestedTopic: 'install', requestedSection: '' });
});

test('the docs page reads the location hash with the safe parser (#2620)', () => {
  const source = readFileSync(new URL('../src/documentation.js', import.meta.url), 'utf8');
  assert.match(source, /parseTopicHash\(location\.hash\)/);
  assert.doesNotMatch(source, /decodeURIComponent\(location\.hash/);
});
