import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { createAudioLibrary } from '../scripts/job-audio.mjs';

const videoSettings = audio => ({ kind: 'video', width: 64, height: 64, fps: 2, duration: 1, audio });

test('a refused audio file name is quoted with the rule and the fix, in the job settings and the library', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crucible-audio-names-'));
  const library = createAudioLibrary(folder);
  for (const name of ['UP.WAV', 'a b.wav', 'Fx.Wav', 'x.mp4', 'noext', 'é.wav', `${'a'.repeat(70)}.wav`]) {
    await writeFile(join(folder, 'present.wav'), 'x');
    const expected = new RegExp(`Audio file ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not allowed: use a plain file name of letters, digits, "\\.", "_" or "-" \\(starting with a letter or digit, up to 64 characters\\) with a lower-case extension \\.wav, \\.mp3, \\.ogg or \\.flac\\. Rename the file`);
    assert.throws(() => normalizeJobSettings(videoSettings({ file: name })), expected, `settings: ${name}`);
    await assert.rejects(library.resolve(name), expected, `library: ${name}`);
  }
  assert.throws(() => normalizeJobSettings(videoSettings({ file: 7 })), /Audio file a number value is not allowed/);
});

test('time range errors name the fields the caller sent and the end they produce', () => {
  const loopingMotion = { format: 'crucible.scene', motion: { duration: 1, loop: true } };
  const video = extra => ({ kind: 'video', width: 64, height: 64, fps: 2, duration: 1, ...extra });
  assert.throws(
    () => normalizeJobSettings(video({ motion: { start: 3599.9 } }), [], loopingMotion),
    /^RangeError: motion\.start 3599\.9 plus the last sample at 0\.5 s is 3600\.4\d* s; the motion clock stops at 3600 s\. Lower motion\.start or duration\.$/,
  );
  assert.throws(
    () => normalizeJobSettings(video({ fps: 4, rendererTime: { start: 0, rate: -3 } })),
    /^RangeError: rendererTime\.start 0 with rate -3 reaches -2\.25 s; the renderer clock cannot go below 0\. Raise rendererTime\.start to at least 2\.25 or use a positive rate\.$/,
  );
  assert.throws(
    () => normalizeJobSettings(video({ rendererTime: { start: 3599, rate: 16 } })),
    /^RangeError: rendererTime\.start 3599 with rate 16 reaches 3607 s; the renderer clock stops at 3600 s\. Lower rendererTime\.start, rate or duration\.$/,
  );
});

test('an image job refuses duration and fps and says what to use instead', () => {
  const image = extra => ({ kind: 'image', width: 64, height: 64, ...extra });
  assert.throws(() => normalizeJobSettings(image({ duration: 5 })), /^TypeError: duration needs kind stills or video; an image is one frame at motion\.start \(received kind image with duration 5\)\. Drop duration, or use kind stills or video\.$/);
  assert.throws(() => normalizeJobSettings(image({ fps: 30 })), /^TypeError: fps needs kind stills or video; .*received kind image with fps 30\)/);
  assert.throws(() => normalizeJobSettings(image({ duration: 5, fps: 30 })), /duration and fps need kind stills or video.*duration 5 and fps 30/);
  assert.equal(normalizeJobSettings(image({})).frameCount, 1);
  assert.equal(normalizeJobSettings({ kind: 'stills', width: 64, height: 64, fps: 4, duration: 1 }).fps, 4);
});
