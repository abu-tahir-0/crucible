import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChangelogData } from './changelog-fragments.mjs';
import { buildApiReference } from './api-reference.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function currentCommit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  const commit = result.stdout?.trim() ?? '';
  return /^[a-f0-9]{40}$/.test(commit) ? commit : '0000000000000000000000000000000000000000';
}

// The release metadata src/home.js reads, for a checkout that never ran `npm run prepare:release`. It names the version in
// package.json and the commit checked out; the download links point where prepare:release would put the files.
export function devRelease({ packageJson, commit }) {
  const { name, version } = packageJson;
  return {
    version,
    packageName: name,
    packageAlias: 'crucible',
    commit,
    installCommand: `npm install crucible@npm:${name}@${version}`,
    tarball: `/releases/${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`,
    module: `/releases/${version}/crucible.module.js`,
    registryPublished: false,
    registryVersion: null,
    api: './docs.html#renderer-reference',
    changelog: '/changelog.md',
    changelogData: '/changelog.json',
    devPreview: true,
  };
}

async function readPackageJson(root) {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
}

// Each file `npm run prepare:release` writes into public/ and a site page fetches, with how to build it on request.
export const GENERATED_FILES = {
  '/release.json': async root => devRelease({ packageJson: await readPackageJson(root), commit: currentCommit(root) }),
  '/changelog.json': async root => readChangelogData({
    changelogText: await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    version: (await readPackageJson(root)).version,
  }),
  '/api-reference.json': async () => buildApiReference(),
};

// A fresh checkout has none of these files, so the dev server answered 404 and every console check of the home, changelog and
// docs pages failed (#2278). The dev server builds them on request; a copy in public/ still wins, and the build is unchanged.
export function generatedFiles({ root = projectRoot } = {}) {
  return {
    name: 'generated-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url.split('?')[0];
        const build = GENERATED_FILES[pathname];
        if (!build || existsSync(join(root, 'public', pathname))) return next();
        try {
          const body = JSON.stringify(await build(root));
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
