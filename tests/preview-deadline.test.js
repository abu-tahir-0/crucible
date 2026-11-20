import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewDeadlineMilliseconds, PREVIEW_DEADLINE_VARIABLE } from '../scripts/preview-deadline.mjs';

test('the preview deadline stays 30 seconds when no harness sets it', () => {
  assert.equal(previewDeadlineMilliseconds({}), 30000);
  assert.equal(previewDeadlineMilliseconds({ [PREVIEW_DEADLINE_VARIABLE]: '' }), 30000);
});

test('a test harness can give the preview calls a longer deadline (#2741)', () => {
  assert.equal(previewDeadlineMilliseconds({ [PREVIEW_DEADLINE_VARIABLE]: '90' }), 90000);
  assert.equal(previewDeadlineMilliseconds({ [PREVIEW_DEADLINE_VARIABLE]: '180' }), 180000);
});

test('a deadline that is not whole seconds from 30 to 180 says what to pass', () => {
  for (const value of ['29', '181', '4.5', '1e2', 'soon', '-60']) {
    assert.throws(() => previewDeadlineMilliseconds({ [PREVIEW_DEADLINE_VARIABLE]: value }),
      new RegExp(`${PREVIEW_DEADLINE_VARIABLE} is "${value.replace('.', '\\.')}"; pass a whole number of seconds from 30 to 180`));
  }
});

test('the live branch assets smoke starts its server with the harness deadline', () => {
  const smoke = readFileSync(new URL('../scripts/smoke-agent-branch-assets.mjs', import.meta.url), 'utf8');
  assert.match(smoke, /\[PREVIEW_DEADLINE_VARIABLE\]: '90'/);
});
