import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAXIMUM_JOB_DEADLINE_MS, MAXIMUM_JOB_FRAME_BYTES, MAXIMUM_JOB_OUTPUT_BYTES, jobDeadlineMs, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES } from '../src/agent-scene-capabilities.js';
import { DEFAULT_ENCODER_TIMEOUT_MS } from '../scripts/frame-encoder.mjs';

test('the encoder waits 30 seconds by default and no caller sets a different value', async () => {
  assert.equal(DEFAULT_ENCODER_TIMEOUT_MS, 30000);
  for (const file of ['../scripts/render-media.mjs', '../scripts/agent-runtime.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /timeoutMs\s*:/, `${file} must use the shared encoder default.`);
  }
});

test('the job deadline grows with frames and pixels and never passes its ceiling', () => {
  const still = jobDeadlineMs({ frameCount: 1, width: 1920, height: 1080 });
  assert.ok(still > 60000 && still < 90000);
  // The film that missed five minutes on a loaded machine: 360 frames at 1024x576.
  assert.equal(jobDeadlineMs({ frameCount: 360, width: 1024, height: 576 }), 780000);
  assert.ok(jobDeadlineMs({ frameCount: 360, width: 1920, height: 1080 }) > jobDeadlineMs({ frameCount: 360, width: 1024, height: 576 }));
  assert.ok(jobDeadlineMs({ frameCount: 360, width: 64, height: 64 }) < jobDeadlineMs({ frameCount: 720, width: 64, height: 64 }));
  assert.equal(jobDeadlineMs({ frameCount: 900, width: 1920, height: 1080 }), MAXIMUM_JOB_DEADLINE_MS);
  assert.equal(jobDeadlineMs({ frameCount: 900, width: 1920, height: 1080 }, 5000), 5000);
  assert.equal(MAXIMUM_JOB_DEADLINE_MS, 30 * 60 * 1000);
});

test('capabilities report the job limits from the validator constants, not literals', async () => {
  const source = await readFile(new URL('../scripts/agent-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /maximumFps: MAXIMUM_JOB_FPS/);
  assert.match(source, /maximumFrames: MAXIMUM_JOB_FRAMES/);
  assert.match(source, /maximumOutputBytes: MAXIMUM_JOB_OUTPUT_BYTES/);
  assert.match(source, /maximumFrameBytes: MAXIMUM_JOB_FRAME_BYTES/);
  const videoSettings = { kind: 'video', width: 64, height: 64, duration: 1 };
  assert.equal(normalizeJobSettings({ ...videoSettings, fps: MAXIMUM_JOB_FPS }, [], null).fps, MAXIMUM_JOB_FPS);
  assert.throws(() => normalizeJobSettings({ ...videoSettings, fps: MAXIMUM_JOB_FPS + 1 }, [], null), /fps/);
  assert.throws(() => normalizeJobSettings({ ...videoSettings, fps: MAXIMUM_JOB_FPS, duration: MAXIMUM_JOB_FRAMES / MAXIMUM_JOB_FPS + 1 }, [], null), new RegExp(`${MAXIMUM_JOB_FRAMES} frames`));
});

test('animation settings on a scene without clips say so and what to pass instead', () => {
  const recipe = { format: 'crucible.scene' };
  const settings = { kind: 'image', width: 640, height: 360, animation: { clip: 0 } };
  for (const clips of [[], undefined]) {
    assert.throws(() => normalizeJobSettings(settings, clips, recipe), error => {
      assert.ok(error instanceof RangeError, `expected RangeError, got ${error.constructor.name}`);
      assert.match(error.message, /scene has none/);
      assert.match(error.message, /Drop animation/);
      return true;
    });
  }
});

test('a missing clips list is treated as empty when no animation is requested', () => {
  const settings = normalizeJobSettings({ kind: 'image', width: 640, height: 360 }, undefined, { format: 'crucible.scene' });
  assert.equal(settings.animation, undefined);
});
