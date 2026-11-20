import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// One self-contained ES module with no relative chunk import. It lands in build/ beside the library files, so the npm package
// carries it and a CDN that mirrors npm (jsdelivr, unpkg) serves it from a single URL. The library build runs first and empties
// build/, so this build must not empty it again. The site copies the same bytes to /releases/<version>/crucible.module.js.
export const STANDALONE_FILE_NAME = 'crucible.standalone.js';

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    // The entry imports some modules lazily, and those share the renderer with the entry, so by default the shared code
    // splits into a renderer chunk the standalone file imports (#2726). codeSplitting false inlines every chunk into the one file.
    rolldownOptions: { output: { banner: `/*! ${readFileSync('LICENSE', 'utf8')} */`, codeSplitting: false } },
    outDir: 'build',
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => STANDALONE_FILE_NAME },
    minify: true,
  },
});
