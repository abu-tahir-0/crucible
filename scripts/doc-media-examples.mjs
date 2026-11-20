// Parsing and checking for scripts/render-doc-media.mjs, kept free of browser work so tests can run it.
import { resolve, relative, isAbsolute, basename } from 'node:path';

const plainFileName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function selectPages(availablePages, requestedPages) {
  if (!requestedPages.length) return availablePages;
  const unknown = requestedPages.filter(page => !availablePages.includes(page));
  if (unknown.length) {
    throw new Error(`Unknown documentation page ${unknown.map(page => `"${page}"`).join(', ')}. Pass one of: ${availablePages.join(', ')}.`);
  }
  return availablePages.filter(page => requestedPages.includes(page));
}

export function checkPosterName(poster, outputFolder) {
  const isPlain = typeof poster === 'string' && plainFileName.test(poster) && basename(poster) === poster && !poster.includes('..');
  if (!isPlain) {
    throw new Error(`poster must be a plain file name such as "water-pour" (letters, digits, ".", "_" or "-"), got "${poster}". Remove folders and ".." from the poster= flag.`);
  }
  const target = resolve(outputFolder, `${poster}.webp`);
  const inside = relative(resolve(outputFolder), target);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`poster "${poster}" resolves outside ${outputFolder}. Pass a plain file name.`);
  }
  return poster;
}

function checkLoopSeconds(page, poster, loopFlag) {
  const seconds = Number(loopFlag);
  if (loopFlag === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${page}: the page shows /docs-media/${poster}.webm but its example has loop=${loopFlag === undefined ? '(missing)' : loopFlag}. Pass loop=<seconds> greater than 0 on the live example, for example loop=4.`);
  }
  return seconds;
}

export function parseExamples(page, text, outputFolder) {
  const examples = [];
  for (const match of text.matchAll(/^```js live([^\n]*)$/gm)) {
    const options = Object.fromEntries(match[1].trim().split(/\s+/).filter(Boolean).map(flag => flag.split('=')));
    if (!('poster' in options)) continue;
    const poster = checkPosterName(options.poster, outputFolder);
    const wantsLoop = text.includes(`/docs-media/${poster}.webm`);
    examples.push({ poster, loopSeconds: wantsLoop ? checkLoopSeconds(page, poster, options.loop) : 0 });
  }
  return examples;
}
