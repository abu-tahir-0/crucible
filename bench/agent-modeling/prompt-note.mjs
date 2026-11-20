// A short note appended to every task prompt of a bench run (bench.mjs and run.mjs --prompt-note), so two runs can compare
// prompt wording on the same tasks, for example the plain prompt against "use Crucible, you may write it like three.js" (#986).
// The note only adds words to the prompt: the run keeps the MCP arm and its tools, and the note is recorded in the result file.

export const PROMPT_NOTE_MAX_LENGTH = 300;

/** The validated note, or null when none was passed. Throws for an empty, multi-line or overlong note. */
export function resolvePromptNote(note) {
  if (note === undefined) return null;
  const trimmed = String(note).trim();
  if (trimmed.length === 0) throw new RangeError('--prompt-note must not be empty. Leave the flag out for the plain prompt.');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new RangeError('--prompt-note must be one line of plain text, without line breaks or control characters.');
  if (trimmed.length > PROMPT_NOTE_MAX_LENGTH) throw new RangeError(`--prompt-note must be at most ${PROMPT_NOTE_MAX_LENGTH} characters, got ${trimmed.length}. Shorten the note.`);
  return trimmed;
}

/** The task prompt with the note appended as its last paragraph; the prompt unchanged when there is no note. */
export function withPromptNote(prompt, note) {
  if (note === null) return prompt;
  return `${prompt}\n\n${note}`;
}
