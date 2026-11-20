import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The optional native denoiser is its own npm package, so the server never carries it. The name sits in a variable so the
// bundler leaves the import alone and it resolves from the user's node_modules when a job asks for it.
const OIDN_PACKAGE = '@codepawlhq/crucible-denoise-oidn';

// A source checkout keeps the package in packages/, beside scripts/ or, from the bundled server, two folders above build/mcp.
const CHECKOUT_PACKAGE_URLS = ['../packages/denoise-oidn/index.mjs', '../../packages/denoise-oidn/index.mjs']
  .map(relative => new URL(/* @vite-ignore */ relative, import.meta.url));

async function loadOidnPackage() {
  const checkoutSpecifiers = CHECKOUT_PACKAGE_URLS.filter(packageUrl => existsSync(fileURLToPath(packageUrl))).map(packageUrl => packageUrl.href);
  for (const specifier of [OIDN_PACKAGE, ...checkoutSpecifiers]) {
    try {
      const denoiser = await import(/* @vite-ignore */ specifier);
      if (denoiser.findOidnBinary()) return denoiser;
    } catch {
      // Try the next place the package may live.
    }
  }
  return null;
}

/**
 * What a job's `settings.renderer.denoise` becomes. `true` (the default) and "oidn" mean OIDN with the albedo and normal
 * guides, which needs the optional package and its binary. Without them `note` says so and a filter runs instead, so the
 * job result never claims a denoiser that did not run: the CPU wavelet filter, or on the native backend (`native`) the GPU
 * a-trous filter ("atrous", biased: it smooths). `keepWavelet` makes a missing OIDN fall back to the wavelet filter on
 * native too; the `final` quality tier sets it, because it always ran the wavelet filter before it used OIDN. An explicit
 * "wavelet", "none" or false keeps its meaning everywhere, and OIDN is not loaded for them. The samples a job asked for are
 * never changed here: only an explicit "oidn" without `samples` gets OIDN_DEFAULT_SAMPLES, in agent-render-jobs.mjs.
 */
export async function chooseDenoiser(requested, { native = false, keepWavelet = false, loadOidn = loadOidnPackage } = {}) {
  const isDefault = requested === true;
  if (requested !== 'oidn' && !isDefault) return { denoise: requested };
  const denoiser = await loadOidn();
  if (denoiser) {
    return { denoise: 'oidn', denoiser };
  }
  const reason = `needs ${OIDN_PACKAGE}, and its binary: npm install it, run \`node node_modules/@codepawlhq/crucible-denoise-oidn/fetch-oidn.mjs\`, or set OIDN_DENOISE_PATH`;
  const lead = isDefault ? 'denoise true uses OIDN, which' : 'denoise "oidn"';
  if (native && !keepWavelet) return { denoise: 'atrous', note: `${lead} ${reason}: the GPU a-trous filter ran instead (it smooths, so it is biased; denoise "wavelet" picks the CPU filter).` };
  return { denoise: 'wavelet', note: `${lead} ${reason}: the wavelet filter ran instead.` };
}

function floatsFromBase64(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Filters the features a page returned for denoise "oidn" and gives the result back to the page to draw. If the tool fails,
 * the page filters the same pixels with the wavelet filter and the report says so. Returns the PNG as base64 and the report.
 */
export async function finishWithOidn({ traced, denoiser, drawLinear }) {
  const { width, height } = traced.report;
  const features = Object.fromEntries(['color', 'albedo', 'normal'].map(name => [name, floatsFromBase64(traced.features[name])]));
  const started = performance.now();
  let linear;
  let failure;
  try {
    linear = await denoiser.denoiseWithOidn({ width, height, ...features });
  } catch (error) {
    failure = error.message;
  }
  const denoiseSeconds = (performance.now() - started) / 1000;
  const drawn = await drawLinear({ width, height, ...(linear ? { linear: Buffer.from(linear.buffer, linear.byteOffset, linear.byteLength).toString('base64') } : {}) });
  const report = { ...traced.report, denoised: true, denoiser: linear ? 'oidn' : 'wavelet', denoiseSeconds, ...(linear ? { oidnVersion: denoiser.OIDN_VERSION } : { denoiserNote: `OIDN failed (${failure}): the wavelet filter ran instead.` }) };
  return { data: drawn.data, report };
}
