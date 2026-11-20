// Starts the Vite dev server and headless Chrome with a WebGPU adapter for the tests that run the WebGPU path tracer on real hardware.
// Where Chrome, playwright or an adapter is missing the test skips on a developer machine and fails on CI, as withDevServerPage does.
import { spawn } from 'node:child_process';
import { freePort } from './free-port.js';
import { openBlankPage, skipOrThrow } from './dev-server-browser.js';

export { BLANK_PAGE_PATH } from './dev-server-browser.js';

const WEBGPU_ARGUMENTS = [process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan'];

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// The Google Chrome install ships dxcompiler.dll, which Dawn uses to compile the path tracer kernel for D3D12 on Windows. The bundled test Chromium does not,
// so there Dawn is told to use FXC, which compiles the kernel since #1350 (without that flag the bundled Chromium cannot create a device at all).
const BUNDLED_WINDOWS_ARGUMENTS = process.platform === 'win32' ? ['--disable-dawn-features=use_dxc'] : [];

async function launchWebGpuChrome(chromium, { bundled = false } = {}) {
  if (!bundled) {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome', args: WEBGPU_ARGUMENTS });
    } catch {
      // Falls through to the bundled Chromium.
    }
  }
  return chromium.launch({ headless: true, args: [...WEBGPU_ARGUMENTS, ...BUNDLED_WINDOWS_ARGUMENTS] });
}

/** Runs `body(page)` on the dev server's page in headless Chrome with a WebGPU adapter, and cleans up. `{ bundled: true }` uses the bundled Chromium, not the Chrome install. */
export async function withWebGpuPage(testContext, body, options = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(testContext, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchWebGpuChrome(chromium, options);
    } catch (error) {
      skipOrThrow(testContext, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await openBlankPage(page, port);
    if (!await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()))) {
      skipOrThrow(testContext, 'Chrome has no WebGPU adapter');
      return;
    }
    if (options.hardwareOnly) {
      // WEBGPU_TEST_SOFTWARE_ONLY=1 forces the skip, to check the gate on a machine with a real adapter.
      // The CI runners expose a software adapter (SwiftShader) that is far too slow for a CPU-against-GPU comparison, so such a check runs on real hardware only.
      const description = await page.evaluate(async () => {
        const found = await navigator.gpu.requestAdapter();
        const info = found.info ?? {};
        const software = Boolean(found.isFallbackAdapter || info.isFallbackAdapter);
        return { software, text: [info.vendor, info.architecture, info.device, info.description].join(' ') };
      });
      if (description.software || /swiftshader|llvmpipe|software|lavapipe/i.test(description.text) || process.env.WEBGPU_TEST_SOFTWARE_ONLY === '1') {
        testContext.skip(`the WebGPU adapter is software (${description.text.trim()}) and too slow for this comparison`);
        return;
      }
    }
    await body(page);
  } finally {
    await browser?.close();
    server.kill();
  }
}
