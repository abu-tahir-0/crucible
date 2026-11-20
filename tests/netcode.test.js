import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import {
  NETCODE_LIMITS,
  createLoopbackNetwork,
  createNetcode,
  createPlanarMovement,
  createWebSocketTransport,
} from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const FIXED_RATE = 50;
const PLAYER_SPEED = 5;

const idleScheduler = { request: () => 1, cancel: () => {} };

function createPeer(netcodeOptions) {
  const netcode = createNetcode(netcodeOptions);
  const runtime = createRuntime({ render() {} }, { mode: 'both', fixedRate: FIXED_RATE, scheduler: idleScheduler, systems: [netcode] });
  return { netcode, runtime };
}

// A scripted input for one player: a function of the frame number.
function scriptFor(pattern) {
  return frame => {
    const segment = pattern.find(entry => frame < entry.untilFrame);
    return segment ? { moveX: segment.moveX, moveZ: segment.moveZ } : { moveX: 0, moveZ: 0 };
  };
}

const SCRIPT_A = scriptFor([
  { untilFrame: 100, moveX: 1, moveZ: 0 },
  { untilFrame: 160, moveX: 0, moveZ: 1 },
  { untilFrame: 230, moveX: -1, moveZ: 0 },
  { untilFrame: 300, moveX: 0.5, moveZ: -0.5 },
]);
const SCRIPT_B = scriptFor([
  { untilFrame: 80, moveX: 0, moveZ: -1 },
  { untilFrame: 170, moveX: 1, moveZ: 0 },
  { untilFrame: 260, moveX: 0, moveZ: 1 },
]);

// Two clients and a server on a 100 ms, plus or minus 30 ms, 2 percent loss network, driven frame by frame.
function runSession({ seed = 11, frames = 520, lossRate = 0.02, onFrame, teleportAtFrame = null } = {}) {
  const network = createLoopbackNetwork({ seed, latencyMilliseconds: 100, jitterMilliseconds: 30, lossRate });
  const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
  server.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
  server.netcode.addEntity('b', { owner: 'client-b', tag: 'player' });
  server.netcode.addEntity('crate', { tag: 'prop', state: { position: [3, 1, 3], variables: { health: 10 } } });
  let frame = 0;
  const clientA = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: () => SCRIPT_A(frame) });
  const clientB = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-b'), localEntityId: 'b', readInput: () => SCRIPT_B(frame) });
  const peers = [server, clientA, clientB];
  for (frame = 0; frame < frames; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    if (frame === teleportAtFrame) server.netcode.setEntityState('a', { position: [-20, 0, 15] });
    if (frame === 200) server.netcode.setEntityState('crate', { position: [4, 1, 3], variables: { health: 7 } });
    for (const peer of peers) peer.runtime.step(FRAME_MILLISECONDS);
    onFrame?.({ frame, server, clientA, clientB });
  }
  return { network, server, clientA, clientB };
}

function distance(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

test('a predicted local player converges to the authority after reconciliation', () => {
  const { server, clientA, clientB } = runSession();
  for (const [client, id] of [[clientA, 'a'], [clientB, 'b']]) {
    const truth = server.netcode.getEntityState(id).position;
    const predicted = client.netcode.getEntityState(id).position;
    assert.ok(distance(truth, predicted) < 0.05, `${id}: predicted ${predicted} vs authority ${truth}`);
    assert.ok(client.netcode.stats.reconciliations > 50);
    assert.equal(client.netcode.pendingInputCount < NETCODE_LIMITS.maximumPendingInputs, true);
  }
  const moved = server.netcode.getEntityState('a').position;
  assert.ok(Math.abs(moved[0]) + Math.abs(moved[2]) > 1, 'the scripted input moved the player');
});

test('a correction from the authority pulls the prediction back within a bound', () => {
  const { server, clientA } = runSession({ teleportAtFrame: 300, frames: 520 });
  const truth = server.netcode.getEntityState('a').position;
  assert.ok(distance(truth, clientA.netcode.getEntityState('a').position) < 0.05);
  assert.ok(clientA.netcode.stats.maximumCorrection > 10, 'the teleport showed up as one large correction');
  assert.ok(truth[0] < -15, 'the authority state holds the teleport');
});

test('remote entities move without jumps above a bound', () => {
  let previous = null;
  let largestStep = 0;
  let frames = 0;
  runSession({
    onFrame({ frame, clientB }) {
      const seen = clientB.netcode.getEntityState('a');
      if (!seen || frame < 40) return;
      if (previous) largestStep = Math.max(largestStep, distance(previous, seen.position));
      previous = seen.position;
      frames += 1;
    },
  });
  const nominalStep = PLAYER_SPEED * (FRAME_MILLISECONDS / 1000);
  assert.ok(frames > 400);
  assert.ok(largestStep <= nominalStep * 1.6, `largest per-frame step ${largestStep} vs nominal ${nominalStep}`);
});

test('a remote view settles on the authority state and carries variables', () => {
  const { server, clientA, clientB } = runSession();
  const truth = server.netcode.getEntityState('a').position;
  assert.ok(distance(truth, clientB.netcode.getEntityState('a').position) < 0.05);
  const crate = clientA.netcode.getEntityState('crate');
  assert.ok(distance(crate.position, [4, 1, 3]) < 0.02);
  assert.ok(Math.abs(crate.variables.health - 7) < 0.02);
  assert.deepEqual(clientA.netcode.entityIds.sort(), ['a', 'b', 'crate']);
});

test('the same seed gives the same run and another seed gives another', () => {
  const trace = seed => {
    const positions = [];
    const { network, server } = runSession({
      seed,
      frames: 300,
      onFrame: ({ frame, clientB }) => {
        if (frame % 25 === 0) positions.push(clientB.netcode.getEntityState('a')?.position ?? null);
      },
    });
    return JSON.stringify({ positions, network: network.stats, bytes: server.netcode.stats.bytesSent });
  };
  assert.equal(trace(5), trace(5));
  assert.notEqual(trace(5), trace(6));
});

test('delta snapshots are mostly deltas and loss only costs a resend', () => {
  const { server } = runSession({ lossRate: 0.02 });
  const { snapshotsSent, fullSnapshotsSent } = server.netcode.stats;
  assert.ok(fullSnapshotsSent < snapshotsSent * 0.2, `${fullSnapshotsSent} full of ${snapshotsSent}`);
  const lossless = runSession({ lossRate: 0, frames: 300 });
  assert.ok(lossless.server.netcode.stats.fullSnapshotsSent <= 12);
});

test('a host also plays its own entity with no prediction', () => {
  const network = createLoopbackNetwork({ seed: 3, latencyMilliseconds: 40 });
  const host = createPeer({ role: 'authority', authority: 'host', transport: network.createTransport('host'), readInput: () => ({ moveX: 1 }) });
  host.netcode.addEntity('host-player', { owner: 'host' });
  const guest = createPeer({ role: 'client', serverId: 'host', transport: network.createTransport('guest'), localEntityId: 'guest-player', readInput: () => ({ moveZ: 1 }) });
  host.netcode.addEntity('guest-player', { owner: 'guest' });
  for (let frame = 0; frame < 150; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    host.runtime.step(FRAME_MILLISECONDS);
    guest.runtime.step(FRAME_MILLISECONDS);
  }
  const hostPosition = host.netcode.getEntityState('host-player').position;
  assert.ok(hostPosition[0] > 10);
  assert.ok(Math.abs(guest.netcode.getEntityState('host-player').position[0] - hostPosition[0]) < PLAYER_SPEED * 0.3);
});

test('custom simulation, removed entities and variables sync', () => {
  const network = createLoopbackNetwork({ seed: 2 });
  const jumper = (state, input, step) => ({
    ...state,
    variables: { ...state.variables, jumps: (state.variables.jumps ?? 0) + (input.jump ? 1 : 0) },
    position: [state.position[0] + step, 0, 0],
  });
  const server = createPeer({ role: 'authority', transport: network.createTransport('server'), simulate: jumper });
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c'), simulate: jumper, localEntityId: 'p', readInput: () => ({ jump: true }) });
  server.netcode.addEntity('p', { owner: 'c' });
  server.netcode.addEntity('gone');
  for (let frame = 0; frame < 60; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    if (frame === 30) server.netcode.removeEntity('gone');
    server.runtime.step(FRAME_MILLISECONDS);
    client.runtime.step(FRAME_MILLISECONDS);
  }
  assert.deepEqual(client.netcode.entityIds, ['p']);
  assert.ok(client.netcode.getEntityState('p').variables.jumps > 30);
});

test('invalid options and calls throw errors that say what to pass', () => {
  const transport = createLoopbackNetwork().createTransport('t');
  assert.throws(() => createNetcode(), /options object/);
  assert.throws(() => createNetcode({ transport: {} }), /transport\.id/);
  assert.throws(() => createNetcode({ transport: { id: 'x' } }), /transport\.peers must be a function/);
  assert.throws(() => createNetcode({ transport, role: 'spectator' }), /role must be one of authority, client/);
  assert.throws(() => createNetcode({ transport, role: 'client' }), /serverId/);
  assert.throws(() => createNetcode({ transport, role: 'authority', authority: 'peer' }), /authority "peer" has no authority or client role/);
  assert.throws(() => createNetcode({ transport, role: 'authority', authority: 'cloud' }), /authority must be one of server, host/);
  assert.throws(() => createNetcode({ transport, role: 'authority', snapshotEveryTicks: 0 }), /snapshotEveryTicks/);
  assert.throws(() => createNetcode({ transport, role: 'authority', simulate: 3 }), /simulate must be a function/);
  const authority = createNetcode({ transport, role: 'authority' });
  assert.throws(() => authority.addEntity('', {}), /1 to 64 characters/);
  authority.addEntity('p', { owner: 'x', state: { position: [1, 2, 3] } });
  assert.throws(() => authority.addEntity('p'), /already exists/);
  assert.throws(() => authority.addEntity('q', { owner: 'x' }), /already owns/);
  assert.throws(() => authority.addEntity('q', { state: { position: [1, 2] } }), /array of 3 numbers/);
  assert.throws(() => authority.addEntity('q', { state: { position: [1e9, 0, 0] } }), /position\[0\] must be a number/);
  assert.throws(() => authority.addEntity('q', { state: { variables: { score: 'high' } } }), /score must be a number/);
  assert.throws(() => authority.setEntityState('nope', {}), /no entity named "nope"/);
  assert.throws(() => authority.removeEntity('nope'), /no entity named "nope"/);
  const client = createNetcode({ transport, role: 'client', serverId: 's' });
  assert.throws(() => client.addEntity('p'), /only for the authority/);
  assert.throws(() => createLoopbackNetwork({ lossRate: 2 }), /lossRate must be a number from 0 to 1/);
  assert.throws(() => createLoopbackNetwork().createTransport(''), /1 to 64 characters/);
  const network = createLoopbackNetwork();
  const first = network.createTransport('one');
  assert.throws(() => network.createTransport('one'), /already connected/);
  assert.throws(() => first.send('ghost', {}), /no transport named "ghost"/);
  assert.throws(() => createWebSocketTransport({}), /socket-like/);
});

test('bad network input is counted and ignored, and too many entities are refused', () => {
  const network = createLoopbackNetwork();
  const server = createPeer({ role: 'authority', transport: network.createTransport('server') });
  const rogue = network.createTransport('rogue');
  server.netcode.addEntity('p', { owner: 'rogue' });
  server.runtime.step(FRAME_MILLISECONDS);
  rogue.send('server', { type: 'input', inputs: 'nope' });
  rogue.send('server', { type: 'input', inputs: [{ sequence: 1, input: { moveX: 'fast' } }] });
  rogue.send('server', { type: 'input', inputs: [{ sequence: 1, input: { moveX: 1 } }, { sequence: 1, input: { moveX: -1 } }] });
  network.advance(1);
  server.runtime.step(FRAME_MILLISECONDS);
  assert.equal(server.netcode.stats.rejectedMessages, 2);
  assert.equal(server.netcode.stats.inputsProcessed, 1);
  assert.ok(server.netcode.getEntityState('p').position[0] > 0);

  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c') });
  client.runtime.step(FRAME_MILLISECONDS);
  const lookalike = network.createTransport('server-lookalike');
  lookalike.send('c', { type: 'snapshot', tick: 'x' });
  network.advance(1);
  assert.equal(client.netcode.stats.rejectedMessages, 0, 'a message from a peer that is not the server is ignored');
  const garbage = network.createTransport('garbage');
  garbage.send('server', 7);
  network.advance(1);
  assert.equal(server.netcode.stats.rejectedMessages, 3);
  rogue.send('server', { type: 'input', session: 7, inputs: [] });
  rogue.send('server', { type: 'input', session: 'x'.repeat(65), inputs: [] });
  network.advance(1);
  assert.equal(server.netcode.stats.rejectedMessages, 5, 'a present but invalid session is counted on the authority');
  for (let index = 0; index < NETCODE_LIMITS.maximumEntities - 1; index += 1) server.netcode.addEntity(`e${index}`);
  assert.throws(() => server.netcode.addEntity('overflow'), /at most 256 entities/);
});

test('a client counts a snapshot with an invalid session and drops an older run by its id', () => {
  const network = createLoopbackNetwork();
  const serverTransport = network.createTransport('server');
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c') });
  client.runtime.step(FRAME_MILLISECONDS);
  const snapshot = session => ({ type: 'snapshot', tick: 1, base: null, entities: {}, removed: [], lastProcessedInput: 0, session });
  serverTransport.send('c', snapshot(7));
  network.advance(1);
  assert.equal(client.netcode.stats.rejectedMessages, 1);
  serverTransport.send('c', snapshot('run-one'));
  serverTransport.send('c', { ...snapshot('run-two'), tick: 2 });
  serverTransport.send('c', { ...snapshot('run-one'), tick: 3 });
  network.advance(1);
  assert.equal(client.netcode.stats.authorityRestarts, 1);
  assert.equal(client.netcode.stats.staleSnapshots, 1, 'the late snapshot of the retired run is dropped, not a second reset');
});

test('a snapshot over the byte limit fails loudly instead of being cut', () => {
  const network = createLoopbackNetwork();
  const server = createPeer({ role: 'authority', transport: network.createTransport('server'), maximumMessageBytes: 300 });
  network.createTransport('c');
  for (let index = 0; index < 20; index += 1) server.netcode.addEntity(`entity-${index}`);
  server.runtime.step(FRAME_MILLISECONDS);
  assert.throws(() => server.runtime.step(FRAME_MILLISECONDS), /over maximumMessageBytes 300/);
});

test('planar movement turns input into a flat velocity', () => {
  const simulate = createPlanarMovement({ speed: 2 });
  const state = { position: [0, 1, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], variables: {} };
  const moved = simulate(state, { moveX: 5, moveZ: -1 }, 0.5);
  assert.deepEqual(moved.position, [1, 1, -1]);
  assert.deepEqual(moved.velocity, [2, 0, -2]);
  assert.throws(() => createPlanarMovement({ speed: -1 }), /speed must be a number/);
});

function createFakeSocket() {
  const listeners = new Map();
  return {
    readyState: 1,
    sent: [],
    send(text) { this.sent.push(text); },
    close() { this.readyState = 3; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    emit(type, event) { listeners.get(type)?.(event); },
  };
}

test('the WebSocket transport wraps a passed-in socket and opens nothing', () => {
  const socket = createFakeSocket();
  const transport = createWebSocketTransport(socket, { id: 'me', remoteId: 'host' });
  const received = [];
  const stop = transport.receive((peerId, message) => received.push([peerId, message]));
  assert.deepEqual(transport.peers(), ['host']);
  transport.send('host', { type: 'input', inputs: [] });
  assert.equal(socket.sent[0], '{"type":"input","inputs":[]}');
  socket.emit('message', { data: '{"type":"snapshot","tick":1}' });
  socket.emit('message', { data: 'not json' });
  socket.emit('message', { data: 42 });
  assert.deepEqual(received, [['host', { type: 'snapshot', tick: 1 }]]);
  assert.equal(transport.stats.rejected, 2);
  stop();
  socket.emit('message', { data: '{"a":1}' });
  assert.equal(received.length, 1);
  socket.readyState = 3;
  assert.deepEqual(transport.peers(), []);
  transport.send('host', {});
  assert.equal(socket.sent.length, 1);
  assert.throws(() => createWebSocketTransport(socket, { maximumMessageBytes: 10 }), /maximumMessageBytes must be/);
});

test('a multiplexed WebSocket transport addresses peers through a relay envelope', () => {
  const socket = createFakeSocket();
  const transport = createWebSocketTransport(socket, { id: 'server', multiplexed: true });
  const received = [];
  transport.receive((peerId, message) => received.push([peerId, message]));
  socket.emit('message', { data: '{"from":"alice","data":{"type":"input","inputs":[]}}' });
  socket.emit('message', { data: '{"from":"bob","data":{"type":"input","inputs":[]}}' });
  socket.emit('message', { data: '{"data":{}}' });
  assert.deepEqual(transport.peers(), ['alice', 'bob']);
  transport.send('alice', { type: 'snapshot' });
  assert.equal(socket.sent[0], '{"to":"alice","data":{"type":"snapshot"}}');
  socket.emit('message', { data: '{"from":"alice","left":true}' });
  assert.deepEqual(transport.peers(), ['bob']);
  assert.equal(received.length, 2);
  assert.equal(transport.stats.rejected, 1);
});

test('netcode over a WebSocket pair syncs a client to a host', () => {
  const clientSocket = createFakeSocket();
  const serverSocket = createFakeSocket();
  clientSocket.send = text => serverSocket.emit('message', { data: text });
  serverSocket.send = text => clientSocket.emit('message', { data: text });
  const server = createPeer({ role: 'authority', transport: createWebSocketTransport(serverSocket, { id: 'server', remoteId: 'client' }) });
  const client = createPeer({ role: 'client', serverId: 'server', localEntityId: 'p', transport: createWebSocketTransport(clientSocket, { id: 'client', remoteId: 'server' }), readInput: () => ({ moveX: 1 }) });
  server.netcode.addEntity('p', { owner: 'client' });
  for (let frame = 0; frame < 100; frame += 1) {
    server.runtime.step(FRAME_MILLISECONDS);
    client.runtime.step(FRAME_MILLISECONDS);
  }
  assert.ok(distance(server.netcode.getEntityState('p').position, client.netcode.getEntityState('p').position) < 0.3);
  assert.ok(server.netcode.getEntityState('p').position[0] > 5);
});

// ----- Restarted peers (#1262) -----

function runFrames(network, peers, frames) {
  for (let frame = 0; frame < frames; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    for (const peer of peers) peer.runtime.step(FRAME_MILLISECONDS);
  }
}

test('a client restarted on the same peer id gets a full snapshot and its inputs from sequence 1 apply', () => {
  const network = createLoopbackNetwork({ latencyMilliseconds: 40 });
  const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
  server.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
  const clientTransport = network.createTransport('client-a');
  const moveRight = () => ({ moveX: 1, moveZ: 0 });
  const firstClient = createPeer({ role: 'client', serverId: 'server', transport: clientTransport, localEntityId: 'a', readInput: moveRight });
  runFrames(network, [server, firstClient], 100);
  assert.ok(firstClient.netcode.stats.snapshotsReceived > 0);
  firstClient.netcode.dispose();

  const secondClient = createPeer({ role: 'client', serverId: 'server', transport: clientTransport, localEntityId: 'a', readInput: moveRight });
  const serverXBefore = server.netcode.getEntityState('a').position[0];
  runFrames(network, [server, secondClient], 100);
  assert.ok(secondClient.netcode.stats.snapshotsReceived > 20, `snapshots received ${secondClient.netcode.stats.snapshotsReceived}`);
  assert.ok(secondClient.netcode.stats.missingBaseSnapshots < 5, `missing bases ${secondClient.netcode.stats.missingBaseSnapshots}`);
  assert.ok(secondClient.netcode.tick > 90);
  assert.ok(secondClient.netcode.entityIds.includes('a'));
  const serverXAfter = server.netcode.getEntityState('a').position[0];
  assert.ok(serverXAfter - serverXBefore > 0.5, `the restarted client's inputs moved the entity by ${serverXAfter - serverXBefore}`);
  const restartedClientX = secondClient.netcode.getEntityState('a').position[0];
  assert.ok(Math.abs(serverXAfter - restartedClientX) < 1, `restarted client x ${restartedClientX} vs server x ${serverXAfter}`);
});

test('a restarted authority on the same peer id resyncs its clients without a reload', () => {
  const network = createLoopbackNetwork({ latencyMilliseconds: 40 });
  const serverTransport = network.createTransport('server');
  const firstServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
  firstServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
  const moveRight = () => ({ moveX: 1, moveZ: 0 });
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: moveRight });
  runFrames(network, [firstServer, client], 300);
  assert.ok(client.netcode.tick > 250);
  firstServer.netcode.dispose();

  const secondServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
  secondServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
  runFrames(network, [secondServer, client], 3);
  const restartsAfterThreeFrames = client.netcode.stats.authorityRestarts;
  runFrames(network, [secondServer, client], 97);
  assert.equal(client.netcode.stats.authorityRestarts, 1);
  assert.ok(restartsAfterThreeFrames <= 1);
  // The guard on old acks keeps the base free, so almost every snapshot after the restart is a delta.
  assert.ok(secondServer.netcode.stats.fullSnapshotsSent < 5, `full snapshots sent ${secondServer.netcode.stats.fullSnapshotsSent}`);
  assert.ok(secondServer.netcode.tick <= 103);
  assert.ok(Math.abs(client.netcode.tick - secondServer.netcode.tick) < 10, `client tick ${client.netcode.tick}, server tick ${secondServer.netcode.tick}`);
  const serverX = secondServer.netcode.getEntityState('a').position[0];
  const clientX = client.netcode.getEntityState('a').position[0];
  assert.ok(Math.abs(serverX - clientX) < 1, `client x ${clientX} vs server x ${serverX}`);
});

test('a jittered authority restart leaves the client within a few ticks after about 20 frames, across seeds', () => {
  const seeds = Array.from({ length: 60 }, (_, index) => index + 1);
  for (const lossRate of [0, 0.1]) {
    for (const seed of seeds) {
      const network = createLoopbackNetwork({ seed, latencyMilliseconds: 40, jitterMilliseconds: 30, lossRate });
      const serverTransport = network.createTransport('server');
      const firstServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
      firstServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
      const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: () => ({ moveX: 1, moveZ: 0 }) });
      runFrames(network, [firstServer, client], 100);
      firstServer.netcode.dispose();
      const secondServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
      secondServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
      runFrames(network, [secondServer, client], 40);
      const gap = secondServer.netcode.tick - client.netcode.tick;
      assert.ok(Math.abs(gap) <= 8, `seed ${seed} loss ${lossRate}: client ${client.netcode.tick} vs server ${secondServer.netcode.tick}`);
      assert.equal(client.netcode.stats.authorityRestarts, 1, `seed ${seed} loss ${lossRate}: the client reset ${client.netcode.stats.authorityRestarts} times`);
    }
  }
});

test('an authority restarted within its first frames still resyncs its client, across seeds', () => {
  for (const lossRate of [0, 0.1]) {
    for (let framesBeforeRestart = 1; framesBeforeRestart <= 8; framesBeforeRestart += 1) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const label = `restart after ${framesBeforeRestart} frames, seed ${seed}, loss ${lossRate}`;
        const network = createLoopbackNetwork({ seed, latencyMilliseconds: 40, jitterMilliseconds: 30, lossRate });
        const serverTransport = network.createTransport('server');
        const firstServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
        firstServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
        const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: () => ({ moveX: 1, moveZ: 0 }) });
        runFrames(network, [firstServer, client], framesBeforeRestart);
        firstServer.netcode.dispose();
        const secondServer = createPeer({ role: 'authority', authority: 'server', transport: serverTransport });
        secondServer.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
        runFrames(network, [secondServer, client], 60);
        const gap = secondServer.netcode.tick - client.netcode.tick;
        assert.ok(Math.abs(gap) <= 8, `${label}: client ${client.netcode.tick} vs server ${secondServer.netcode.tick}`);
        assert.ok(client.netcode.stats.authorityRestarts <= 1, `${label}: the client reset ${client.netcode.stats.authorityRestarts} times`);
        const serverX = secondServer.netcode.getEntityState('a').position[0];
        const clientX = client.netcode.getEntityState('a').position[0];
        assert.ok(Math.abs(serverX - clientX) < 1, `${label}: client x ${clientX} vs server x ${serverX}`);
      }
    }
  }
});

test('a jittered client restart leaves the new client in step with the authority, across seeds', () => {
  for (const lossRate of [0, 0.1]) {
    for (let seed = 1; seed <= 40; seed += 1) {
      const label = `seed ${seed}, loss ${lossRate}`;
      const network = createLoopbackNetwork({ seed, latencyMilliseconds: 40, jitterMilliseconds: 30, lossRate });
      const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
      server.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
      const clientTransport = network.createTransport('client-a');
      const moveRight = () => ({ moveX: 1, moveZ: 0 });
      const firstClient = createPeer({ role: 'client', serverId: 'server', transport: clientTransport, localEntityId: 'a', readInput: moveRight });
      runFrames(network, [server, firstClient], 60 + (seed % 7));
      firstClient.netcode.dispose();
      const secondClient = createPeer({ role: 'client', serverId: 'server', transport: clientTransport, localEntityId: 'a', readInput: moveRight });
      runFrames(network, [server, secondClient], 60);
      const gap = server.netcode.tick - secondClient.netcode.tick;
      assert.ok(Math.abs(gap) <= 8, `${label}: client ${secondClient.netcode.tick} vs server ${server.netcode.tick}`);
      assert.ok(secondClient.netcode.stats.snapshotsReceived > 10, `${label}: snapshots received ${secondClient.netcode.stats.snapshotsReceived}`);
      const serverX = server.netcode.getEntityState('a').position[0];
      const clientX = secondClient.netcode.getEntityState('a').position[0];
      assert.ok(Math.abs(serverX - clientX) < 1, `${label}: client x ${clientX} vs server x ${serverX}`);
    }
  }
});

// A bare transport that plays the client by hand, so each ack the authority sees is chosen by the test.
function createHandPlayedClient() {
  const network = createLoopbackNetwork();
  const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
  server.netcode.addEntity('p', { owner: 'hand' });
  const transport = network.createTransport('hand');
  let latestSnapshot = null;
  transport.receive((peerId, message) => {
    if (message.type === 'snapshot') latestSnapshot = message;
  });
  function stepServer() {
    server.runtime.step(FRAME_MILLISECONDS);
    network.advance(1);
  }
  stepServer();
  stepServer();
  return { server, transport, stepServer, snapshot: () => latestSnapshot };
}

function handInput(sequence, fields) {
  return { type: 'input', session: 'hand-run', inputs: [{ sequence, input: { moveX: 1, moveZ: 0 } }], ...fields };
}

test('the authority forgets its base when the newest message acks null, and keeps it for an older reordered one', () => {
  const { transport, stepServer, snapshot } = createHandPlayedClient();
  const run = snapshot().session;
  transport.send('server', handInput(1, { authoritySession: run, acknowledgedTick: snapshot().tick }));
  stepServer();
  stepServer();
  assert.notEqual(snapshot().base, null, 'an ack of this run names the base');
  transport.send('server', handInput(2, { authoritySession: run, acknowledgedTick: snapshot().tick }));
  stepServer();
  transport.send('server', handInput(1, { authoritySession: null, acknowledgedTick: null }));
  stepServer();
  stepServer();
  assert.notEqual(snapshot().base, null, 'a null ack on an older reordered message does not reset the base');
  transport.send('server', handInput(3, { authoritySession: null, acknowledgedTick: null }));
  stepServer();
  stepServer();
  stepServer();
  assert.equal(snapshot().base, null, 'a null ack on the newest message resets the base to a full snapshot');
});

test('the authority ignores an ack that names an earlier run of itself', () => {
  const { transport, stepServer, snapshot } = createHandPlayedClient();
  transport.send('server', handInput(1, { authoritySession: 'an-older-run', acknowledgedTick: snapshot().tick }));
  stepServer();
  stepServer();
  assert.equal(snapshot().base, null, 'an ack from another run keeps the next snapshot full');
  transport.send('server', handInput(2, { authoritySession: 7, acknowledgedTick: 1 }));
  stepServer();
  assert.equal(snapshot().base, null);
});

test('a client drops a snapshot of an older run even when it never saw that run before', () => {
  const network = createLoopbackNetwork();
  const serverTransport = network.createTransport('server');
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c') });
  client.runtime.step(FRAME_MILLISECONDS);
  const snapshot = (session, tick) => ({ type: 'snapshot', tick, base: null, entities: {}, removed: [], lastProcessedInput: 0, session });
  serverTransport.send('c', snapshot('run-b', 1));
  serverTransport.send('c', snapshot('run-a', 2));
  serverTransport.send('c', snapshot('run-b', 3));
  network.advance(1);
  assert.equal(client.netcode.stats.authorityRestarts, 0, 'the older run arrives second and is stale, not a restart');
  assert.equal(client.netcode.stats.staleSnapshots, 1);
  assert.equal(client.netcode.tick, 3);
  serverTransport.send('c', snapshot('run-c', 1));
  network.advance(1);
  assert.equal(client.netcode.stats.authorityRestarts, 1);
  assert.equal(client.netcode.tick, 1);
});

test('an ack without a run id counts only when its tick is not beyond the authority tick', () => {
  const { transport, stepServer, snapshot } = createHandPlayedClient();
  transport.send('server', handInput(1, { acknowledgedTick: snapshot().tick + 1000 }));
  stepServer();
  stepServer();
  assert.equal(snapshot().base, null, 'a tick this run has not reached cannot name a base');
  transport.send('server', handInput(2, { acknowledgedTick: snapshot().tick }));
  stepServer();
  stepServer();
  assert.notEqual(snapshot().base, null, 'a tick this run has reached names the base');
});

test('the authority counts an invalid authoritySession and ignores the message', () => {
  const { server, transport, stepServer, snapshot } = createHandPlayedClient();
  const before = server.netcode.stats.rejectedMessages;
  transport.send('server', handInput(1, { authoritySession: 7, acknowledgedTick: snapshot().tick }));
  stepServer();
  assert.equal(server.netcode.stats.rejectedMessages, before + 1);
});

test('a client adopts a lower run id when only that run keeps arriving, and a snapshot of the tracked run resets the count', () => {
  const network = createLoopbackNetwork();
  const serverTransport = network.createTransport('server');
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c') });
  client.runtime.step(FRAME_MILLISECONDS);
  const snapshot = (session, tick) => ({ type: 'snapshot', tick, base: null, entities: {}, removed: [], lastProcessedInput: 0, session });
  serverTransport.send('c', snapshot('run-b', 100));
  for (let tick = 1; tick <= 29; tick += 1) serverTransport.send('c', snapshot('run-a', tick));
  network.advance(1);
  assert.equal(client.netcode.tick, 100, 'a short burst of a lower run is still stale');
  assert.equal(client.netcode.stats.authorityRestarts, 0);
  serverTransport.send('c', snapshot('run-b', 101));
  for (let tick = 30; tick <= 58; tick += 1) serverTransport.send('c', snapshot('run-a', tick));
  network.advance(1);
  assert.equal(client.netcode.tick, 101, 'a snapshot of the tracked run resets the count');
  assert.equal(client.netcode.stats.authorityRestarts, 0);
  serverTransport.send('c', snapshot('run-a', 59));
  network.advance(1);
  assert.equal(client.netcode.stats.authorityRestarts, 1, 'the 30th in a row of the lower run is adopted');
  assert.equal(client.netcode.tick, 59);
});

// ----- A bad frame time (#2608) -----

test('a client ignores a NaN, infinite or negative frame time and keeps drawing real positions', () => {
  const network = createLoopbackNetwork({ latencyMilliseconds: 40 });
  const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
  server.netcode.addEntity('other', { owner: 'someone-else', tag: 'player' });
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: () => ({ moveX: 0, moveZ: 0 }) });
  runFrames(network, [server, client], 100);
  const before = client.netcode.getEntityState('other');
  assert.ok(before.position.every(Number.isFinite));
  for (const badDelta of [NaN, Infinity, -Infinity, -0.5, undefined]) client.netcode.update(badDelta);
  const after = client.netcode.getEntityState('other');
  assert.deepEqual(after, before, 'a bad frame time leaves the drawing clock where it was');
  runFrames(network, [server, client], 50);
  assert.ok(client.netcode.getEntityState('other').position.every(Number.isFinite));
});
