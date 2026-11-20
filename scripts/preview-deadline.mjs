// How long one preview call or one review may run before the runtime gives up on it.
// CRUCIBLE_TEST_PREVIEW_DEADLINE_SECONDS is test-only and is set only by whoever starts the server: the live smokes that render
// on SwiftShader set it so a loaded CI runner does not fail them (#2741). No tool call can set it and it is in no tool schema.
import { readEnvironmentVariable } from '../src/environment-variable.js';

export const PREVIEW_DEADLINE_SUFFIX = 'TEST_PREVIEW_DEADLINE_SECONDS';
export const PREVIEW_DEADLINE_VARIABLE = `CRUCIBLE_${PREVIEW_DEADLINE_SUFFIX}`;
export const DEFAULT_PREVIEW_DEADLINE_SECONDS = 30;
export const MAXIMUM_PREVIEW_DEADLINE_SECONDS = 180;

export function previewDeadlineMilliseconds(env = process.env) {
  const text = readEnvironmentVariable(PREVIEW_DEADLINE_SUFFIX, env);
  if (text === undefined) return DEFAULT_PREVIEW_DEADLINE_SECONDS * 1000;
  const seconds = Number(text);
  const inRange = Number.isInteger(seconds) && seconds >= DEFAULT_PREVIEW_DEADLINE_SECONDS && seconds <= MAXIMUM_PREVIEW_DEADLINE_SECONDS;
  if (!/^\d+$/.test(text.trim()) || !inRange) {
    throw new RangeError(`${PREVIEW_DEADLINE_VARIABLE} is "${text}"; pass a whole number of seconds from ${DEFAULT_PREVIEW_DEADLINE_SECONDS} to ${MAXIMUM_PREVIEW_DEADLINE_SECONDS}, or leave it unset for ${DEFAULT_PREVIEW_DEADLINE_SECONDS}.`);
  }
  return seconds * 1000;
}
