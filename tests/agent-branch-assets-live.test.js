import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs the real MCP server on SwiftShader: a branch of a scene that places catalog GLBs forks and reviews (#2267).
// It needs the prepared preview bundle (npm run prepare:release), so it skips without it.
const preview = fileURLToPath(new URL('../build/mcp/preview.js', import.meta.url));
const smoke = fileURLToPath(new URL('../scripts/smoke-agent-branch-assets.mjs', import.meta.url));

test('live MCP scene_apply with a branch works on a scene that places catalog assets', {
  skip: !existsSync(preview) ? 'needs build/mcp (prepare:release)' : false,
  timeout: 240000,
}, () => {
  const result = spawnSync(process.execPath, [smoke], { encoding: 'utf8', windowsHide: true, timeout: 230000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"branches":\["moved","crowd"\]/);
});
