// Water bodies. A material with the water tag can carry `absorption` (RGB per metre: how fast each colour fades going down) and
// `turbidity` (0 clear to 1 murky: how much light the water scatters into shadows). The rasterizer (world-material-shader.js) and the
// path tracer export (path-tracer-scene.js) read the same fields through here.
/** Water the way people name it: where the light goes and how far a shadow stays sharp. */
export const WATER_PRESETS = Object.freeze({
  lake: Object.freeze({ absorption: Object.freeze([0.35, 0.07, 0.04]), turbidity: 0.02 }),
  sea: Object.freeze({ absorption: Object.freeze([0.4, 0.06, 0.02]), turbidity: 0.1 }),
  river: Object.freeze({ absorption: Object.freeze([0.8, 0.9, 1.6]), turbidity: 0.75 }),
});
export const WATER_DEFAULT_PRESET = 'lake';
export const WATER_MAXIMUM_ABSORPTION = 20;

/** Resolves a material's water fields: an explicit absorption or turbidity beats the preset, which beats the default lake. */
export function resolveWaterMaterial({ waterPreset, absorption, turbidity } = {}) {
  const preset = waterPreset ?? WATER_DEFAULT_PRESET;
  if (!Object.hasOwn(WATER_PRESETS, preset)) {
    throw new RangeError(`waterPreset must be one of ${Object.keys(WATER_PRESETS).join(', ')}.`);
  }
  const resolvedAbsorption = absorption ?? WATER_PRESETS[preset].absorption;
  const absorptionValid = Array.isArray(resolvedAbsorption) && resolvedAbsorption.length === 3
    && resolvedAbsorption.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= WATER_MAXIMUM_ABSORPTION);
  if (!absorptionValid) {
    throw new RangeError(`absorption must be three numbers from 0 to ${WATER_MAXIMUM_ABSORPTION} (per metre).`);
  }
  const resolvedTurbidity = turbidity ?? WATER_PRESETS[preset].turbidity;
  if (!Number.isFinite(resolvedTurbidity) || resolvedTurbidity < 0 || resolvedTurbidity > 1) {
    throw new RangeError('turbidity must be within zero and one.');
  }
  return { waterPreset: preset, absorption: [...resolvedAbsorption], turbidity: resolvedTurbidity };
}
