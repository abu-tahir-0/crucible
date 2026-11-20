import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { setupMapShowsBackground } from '../src/lighting-setups.js';

function environmentOf(fields) {
  return normalizeAgentLook({ environment: { world: true, setup: 'daylight', ...fields } }).environment;
}

test('skyTop and skyBottom beside a setup sky replace its background and keep its light (#2280)', () => {
  const environment = environmentOf({ skyTop: [1, 0, 0], skyBottom: [0, 1, 0] });
  assert.equal(agentEnvironmentMap(environment).showBackground, false);
  assert.equal(setupMapShowsBackground(environment), false);
});

test('either field alone is enough to ask for the gradient (#2280)', () => {
  assert.equal(agentEnvironmentMap(environmentOf({ skyTop: [1, 0, 0] })).showBackground, false);
  assert.equal(agentEnvironmentMap(environmentOf({ skyBottom: [0, 1, 0] })).showBackground, false);
});

test('the lit map is the same with or without the gradient fields (#2280)', () => {
  const plain = agentEnvironmentMap(environmentOf({}));
  const colored = agentEnvironmentMap(environmentOf({ skyTop: [1, 0, 0], skyBottom: [0, 1, 0] }));
  assert.equal(colored.data, plain.data);
});

test('a world scene without the fields still draws the setup sky (#2280)', () => {
  assert.equal(agentEnvironmentMap(environmentOf({})).showBackground, true);
  assert.equal(agentEnvironmentMap(environmentOf({ skyTop: [0.2, 0.38, 0.52] })).showBackground, true);
  assert.equal(agentEnvironmentMap(environmentOf({ setup: 'sunset' })).showBackground, true);
});

test('a scene without world never shows the background', () => {
  const environment = normalizeAgentLook({ environment: { skyTop: [1, 0, 0] } }).environment;
  assert.equal(agentEnvironmentMap(environment).showBackground, false);
});
