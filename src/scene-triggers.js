// Declarative web triggers of <crucible-scene> (docs/pack.md#triggers): scroll scrubbing, hover tilt and named views.
// Everything here is plain data in and out, so the element only wires events and asks for frames.

export const SCROLL_KINDS = Object.freeze({
  orbit: { unit: 'degrees', min: -360, max: 360 },
  elevation: { unit: 'degrees', min: -85, max: 85 },
  dolly: { unit: 'distance scale', min: 0.1, max: 10 },
});
export const MAX_HOVER_TILT_DEGREES = 30;
export const MAX_ELEVATION_DEGREES = 85;
const NEUTRAL_VIEW = Object.freeze({ orbit: 0, elevation: 0, dolly: 1 });
const SETTLE_EPSILON = 0.001;
const TILT_HALF_LIFE_MS = 90;
const VIEW_HALF_LIFE_MS = 110;

function readNumber(token, label, kind) {
  const value = Number(token);
  const range = SCROLL_KINDS[kind];
  if (token === undefined || token === '' || !Number.isFinite(value) || value < range.min || value > range.max) {
    throw new RangeError(`${label}: "${token}" is not a ${range.unit} between ${range.min} and ${range.max}. Write ${kind} <from> <to>, such as scroll="orbit 0 90".`);
  }
  return value;
}

/** Reads scroll="orbit 0 90, dolly 1 0.6": one mapping per comma, each from the value at 0% to the value at 100% of the element's pass through the viewport. */
export function parseScrollAttribute(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new RangeError('scroll is empty. Write scroll="orbit 0 90" (kinds: orbit, elevation, dolly).');
  const seen = new Set();
  return text.split(',').map(part => {
    const [kind, from, to, ...extra] = part.trim().split(/\s+/);
    if (!Object.hasOwn(SCROLL_KINDS, kind)) throw new RangeError(`scroll: "${kind}" is not a kind. Use orbit, elevation or dolly, such as scroll="orbit 0 90".`);
    if (extra.length > 0) throw new RangeError(`scroll: "${part.trim()}" has too many values. Write ${kind} <from> <to>.`);
    if (seen.has(kind)) throw new RangeError(`scroll: ${kind} appears twice. Give each kind once.`);
    seen.add(kind);
    return { kind, from: readNumber(from, 'scroll', kind), to: readNumber(to, 'scroll', kind) };
  });
}

/** Reads hover-tilt="6": the most degrees the camera leans toward the pointer. */
export function parseHoverTiltAttribute(text) {
  const degrees = Number(text);
  if (typeof text !== 'string' || text.trim() === '' || !Number.isFinite(degrees) || degrees <= 0 || degrees > MAX_HOVER_TILT_DEGREES) {
    throw new RangeError(`hover-tilt: "${text}" is not a number of degrees above 0 and at most ${MAX_HOVER_TILT_DEGREES}. Write hover-tilt="6".`);
  }
  return degrees;
}

/** Reads the JSON of a <script type="application/json"> child: { "close": { "orbit": 40, "elevation": 10, "dolly": 0.6 } }. */
export function parseViews(jsonText) {
  let declared;
  try {
    declared = JSON.parse(jsonText);
  } catch (error) {
    throw new SyntaxError(`views: the <script type="application/json"> child is not valid JSON (${error.message}). Write { "name": { "orbit": 40 } }.`);
  }
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new TypeError('views: the JSON must be an object of named views, such as { "close": { "orbit": 40, "dolly": 0.6 } }.');
  }
  const views = {};
  for (const [name, fields] of Object.entries(declared)) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError(`views.${name}: write an object such as { "orbit": 40 }.`);
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(SCROLL_KINDS, key)) throw new RangeError(`views.${name}.${key}: use orbit, elevation or dolly.`);
    }
    views[name] = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, readNumber(String(value), `views.${name}.${key}`, key)]));
  }
  return views;
}

/** 0 when the element's top edge enters at the bottom of the viewport, 1 when its bottom edge leaves at the top. */
export function scrollProgress(rect, viewportHeight) {
  const travel = viewportHeight + rect.height;
  if (!(travel > 0)) return 0;
  return Math.min(1, Math.max(0, (viewportHeight - rect.top) / travel));
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

/** What the scroll mappings ask of the camera at one progress, as { orbit, elevation, dolly }. */
export function scrollView(mappings, progress) {
  const view = { ...NEUTRAL_VIEW };
  for (const { kind, from, to } of mappings) view[kind] = lerp(from, to, progress);
  return view;
}

/** Degrees of lean for a pointer at (x, y) in -1..1 across the element, clamped to maxDegrees; nothing under reduced motion. */
export function hoverTiltTarget(pointer, maxDegrees, reducedMotion) {
  if (reducedMotion || !pointer) return { orbit: 0, elevation: 0 };
  const clamp = value => Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));
  return { orbit: clamp(pointer.x) * maxDegrees, elevation: -clamp(pointer.y) * maxDegrees };
}

/** Moves a value toward its target: it covers half the remaining gap every halfLifeMs, whatever the frame rate. */
export function stepToward(current, target, deltaMs, halfLifeMs) {
  if (halfLifeMs <= 0 || deltaMs === Infinity) return target;
  const next = target + (current - target) * 0.5 ** (Math.max(0, deltaMs) / halfLifeMs);
  return Math.abs(next - target) < SETTLE_EPSILON ? target : next;
}

function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, factor) { return [a[0] * factor, a[1] * factor, a[2] * factor]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function length(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a) { return scale(a, 1 / length(a)); }

/** The camera moved around its target: orbit turns about the up axis, elevation raises it (kept under 85 degrees), dolly scales the distance. */
export function applyViewToCamera(camera, view) {
  const up = normalize(camera.up ?? [0, 1, 0]);
  const offset = subtract(camera.eye, camera.target);
  const distance = length(offset);
  if (!(distance > 0)) return camera;
  const height = dot(offset, up);
  const flat = subtract(offset, scale(up, height));
  const flatLength = length(flat);
  const primary = flatLength > 1e-9 ? scale(flat, 1 / flatLength) : normalize(cross(up, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]));
  const secondary = cross(up, primary);
  const limit = MAX_ELEVATION_DEGREES * Math.PI / 180;
  const elevation = Math.min(limit, Math.max(-limit, Math.asin(Math.min(1, Math.max(-1, height / distance))) + view.elevation * Math.PI / 180));
  const azimuth = view.orbit * Math.PI / 180;
  const radius = distance * view.dolly;
  const eye = camera.target.map((value, axis) => value + radius * (
    Math.cos(elevation) * (Math.cos(azimuth) * primary[axis] + Math.sin(azimuth) * secondary[axis]) + Math.sin(elevation) * up[axis]
  ));
  return { ...camera, eye };
}

function addViews(...views) {
  return { orbit: views.reduce((sum, view) => sum + view.orbit, 0), elevation: views.reduce((sum, view) => sum + view.elevation, 0), dolly: views.reduce((product, view) => product * view.dolly, 1) };
}

/** Holds the moving values of all three triggers. `advance` returns the camera view for this frame and whether another frame is needed. */
export class TriggerAnimator {
  constructor({ scroll = null, hoverTilt = 0, views = {}, reducedMotion = false } = {}) {
    this.scroll = scroll;
    this.hoverTilt = hoverTilt;
    this.views = views;
    this.reducedMotion = reducedMotion;
    this.progress = 0;
    this.pointer = null;
    this.viewName = null;
    this.tilt = { orbit: 0, elevation: 0 };
    this.named = { ...NEUTRAL_VIEW };
    this.lastTime = null;
  }

  setProgress(progress) { this.progress = progress; }
  setPointer(pointer) { this.pointer = pointer; }

  setViewName(name) {
    if (name !== null && !Object.hasOwn(this.views, name)) {
      throw new RangeError(`view="${name}" is not declared. Declared views: ${Object.keys(this.views).join(', ') || 'none'}. Add it to the <script type="application/json"> child.`);
    }
    this.viewName = name;
  }

  advance(now) {
    // The first frame lands on the goal, so a page that loads with view="close" does not swing there.
    const deltaMs = this.lastTime === null ? Infinity : now - this.lastTime;
    this.lastTime = now;
    const tiltGoal = hoverTiltTarget(this.pointer, this.hoverTilt, this.reducedMotion);
    const viewGoal = { ...NEUTRAL_VIEW, ...(this.viewName === null ? {} : this.views[this.viewName]) };
    const tiltHalfLife = this.reducedMotion ? 0 : TILT_HALF_LIFE_MS;
    const viewHalfLife = this.reducedMotion ? 0 : VIEW_HALF_LIFE_MS;
    this.tilt = { orbit: stepToward(this.tilt.orbit, tiltGoal.orbit, deltaMs, tiltHalfLife), elevation: stepToward(this.tilt.elevation, tiltGoal.elevation, deltaMs, tiltHalfLife) };
    this.named = {
      orbit: stepToward(this.named.orbit, viewGoal.orbit, deltaMs, viewHalfLife),
      elevation: stepToward(this.named.elevation, viewGoal.elevation, deltaMs, viewHalfLife),
      dolly: stepToward(this.named.dolly, viewGoal.dolly, deltaMs, viewHalfLife),
    };
    const scrolled = this.scroll ? scrollView(this.scroll, this.progress) : { ...NEUTRAL_VIEW };
    const settled = this.tilt.orbit === tiltGoal.orbit && this.tilt.elevation === tiltGoal.elevation
      && this.named.orbit === viewGoal.orbit && this.named.elevation === viewGoal.elevation && this.named.dolly === viewGoal.dolly;
    return { view: addViews(scrolled, { ...this.tilt, dolly: 1 }, this.named), animating: !settled };
  }
}
