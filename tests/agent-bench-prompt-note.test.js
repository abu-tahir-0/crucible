import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PROMPT_NOTE_MAX_LENGTH, resolvePromptNote, withPromptNote } from '../bench/agent-modeling/prompt-note.mjs';

const repository = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const benchDirectory = join(repository, 'bench', 'agent-modeling');
const threeJsNote = 'use Crucible, you may write it like three.js';

function runScript(name, argumentsList) {
  return spawnSync(process.execPath, [join(benchDirectory, name), ...argumentsList], { encoding: 'utf8', windowsHide: true });
}

test('no note leaves the prompt as it was, and a note becomes its last paragraph', () => {
  assert.equal(resolvePromptNote(undefined), null);
  assert.equal(withPromptNote('Build a crate.', null), 'Build a crate.');
  assert.equal(withPromptNote('Build a crate.', resolvePromptNote(`  ${threeJsNote} `)), `Build a crate.\n\n${threeJsNote}`);
});

test('an empty, multi-line or overlong note is refused with the fix', () => {
  assert.throws(() => resolvePromptNote('   '), /must not be empty/);
  assert.throws(() => resolvePromptNote('first line\nsecond line'), /one line of plain text/);
  assert.throws(() => resolvePromptNote('x'.repeat(PROMPT_NOTE_MAX_LENGTH + 1)), new RegExp(`at most ${PROMPT_NOTE_MAX_LENGTH} characters`));
  assert.equal(resolvePromptNote('x'.repeat(PROMPT_NOTE_MAX_LENGTH)).length, PROMPT_NOTE_MAX_LENGTH);
});

test('bench.mjs --dry-run shows the note it would append', () => {
  const result = runScript('bench.mjs', ['--dry-run', '--tasks', 'crate', '--prompt-note', threeJsNote]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 of \d+ tasks: crate/);
  assert.match(result.stdout, new RegExp(`Prompt note: ${threeJsNote}`));
});

test('bench.mjs and run.mjs refuse a bad note before any agent starts', () => {
  const overlong = 'x'.repeat(PROMPT_NOTE_MAX_LENGTH + 1);
  const bench = runScript('bench.mjs', ['--dry-run', '--tasks', 'crate', '--prompt-note', overlong]);
  assert.notEqual(bench.status, 0);
  assert.match(bench.stderr, /--prompt-note must be at most/);
  const run = runScript('run.mjs', ['--claude', 'no-such-claude-executable', '--tasks', 'crate', '--prompt-note', '']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--prompt-note must not be empty/);
});
