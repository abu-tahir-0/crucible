import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFigure } from '../src/documentation-figure.js';

test('parseFigure reads an image, a video and an optional caption', () => {
  assert.deepEqual(parseFigure('![a](b.png)'), { alt: 'a', source: 'b.png', caption: null });
  assert.deepEqual(parseFigure('![clip](/docs-media/demo.webm "A caption")'), { alt: 'clip', source: '/docs-media/demo.webm', caption: 'A caption' });
});

test('parseFigure returns null for a malformed image paragraph', () => {
  assert.equal(parseFigure('![a](b c.png)'), null);
  assert.equal(parseFigure('![a](b.png "unclosed)'), null);
  assert.equal(parseFigure('just text'), null);
});
