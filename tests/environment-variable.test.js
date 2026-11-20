import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironmentVariable } from '../src/environment-variable.js';
import { CALL_LOG_ENVIRONMENT_VARIABLE } from '../scripts/mcp-call-log.mjs';

test('the CRUCIBLE_ name is read', () => {
  assert.equal(readEnvironmentVariable('MCP_LOG', { CRUCIBLE_MCP_LOG: 'new.jsonl' }), 'new.jsonl');
});

test('the SIXTYSEVENJS_ name from before the rename is no longer read', () => {
  assert.equal(readEnvironmentVariable('MCP_LOG', { SIXTYSEVENJS_MCP_LOG: 'old.jsonl' }), undefined);
});

test('an empty or missing CRUCIBLE_ name counts as not set', () => {
  assert.equal(readEnvironmentVariable('MCP_LOG', { CRUCIBLE_MCP_LOG: '' }), undefined);
  assert.equal(readEnvironmentVariable('MCP_LOG', {}), undefined);
});

test('the call log looks its path up by the name without a prefix', () => {
  assert.equal(CALL_LOG_ENVIRONMENT_VARIABLE, 'MCP_LOG');
});
