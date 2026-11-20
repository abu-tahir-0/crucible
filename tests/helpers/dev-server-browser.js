// Starts the Vite dev server and headless Chrome for the tests that need a real WebGL context.
import { spawn } from 'node:child_process';
import { freePort } from './free-port.js';

const CHROME_ARGUMENTS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];

async function startServer(port, serverLog) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (data) => serverLog.push(data.toString()));
  server.stderr.on('data', (data) => serverLog.push(data.toString()));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// Playwright's own browser download is not installed on CI, so fall back to the Google Chrome the runner already has.
export async function launchChrome(chromium) {
  try {
    return await chromium.launch({ headless: true, args: CHROME_ARGUMENTS });
  } catch {
    return chromium.launch({ headless: true, channel: 'chrome', args: CHROME_ARGUMENTS });
  }
}

// Where Chrome or playwright is missing a test skips on a developer machine and fails on CI, where Chrome is required.
export function skipOrThrow(testContext, message) {
  if (process.env.CI) throw new Error(message);
  testContext.skip(message);
}

// What the browser saw go wrong (a failed or rejected request, a console error), so a failure that only shows as "Failed to fetch" names the request behind it.
function watchPageProblems(page) {
  const problems = [];
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`response ${response.status()}: ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

// The tests import /src modules into a blank page of the dev server's origin. The home page would start the live hero, whose
// world load keeps a software renderer (SwiftShader on CI) busy for minutes beside the code under test (#2684, #2686).
export const BLANK_PAGE_PATH = '/__test-page.html';
const BLANK_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};

/** Opens a blank page of the dev server's origin, with its isolation headers, so `/src` modules import without the site's page scripts. */
export async function openBlankPage(page, port) {
  const address = `http://127.0.0.1:${port}${BLANK_PAGE_PATH}`;
  await page.route(address, (route) => route.fulfill({ status: 200, headers: BLANK_PAGE_HEADERS, body: '<!doctype html><title>Test page</title>' }));
  await page.goto(address);
}

/**
 * Runs `body(page)` on a blank page of the dev server in headless Chrome and cleans up.
 * Where Chrome or playwright is missing the test skips on a developer machine and fails on CI, where Chrome is required.
 */
export async function withDevServerPage(testContext, body) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(testContext, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const serverLog = [];
  const server = await startServer(port, serverLog);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(testContext, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    const pageProblems = watchPageProblems(page);
    await openBlankPage(page, port);
    try {
      await body(page);
    } catch (error) {
      error.message += `\nDev server output:\n${serverLog.join('').trim()}\nPage problems:\n${pageProblems.join('\n')}`;
      throw error;
    }
  } finally {
    await browser?.close();
    server.kill();
  }
}
