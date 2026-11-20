import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createLoopbackNetwork, createNetcode } from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const idleScheduler = { request: () => 1, cancel: () => {} };

function createPeer(network, id, extraOptions = {}) {
  const netcode = createNetcode({ authority: 'peer', transport: network.createTransport(id), snapshotEveryTicks: 1, ...extraOptions });
  const runtime = createRuntime({ render() {} }, { mode: 'both', fixedRate: 50, scheduler: idleScheduler, systems: [netcode] });
  return { netcode, runtime };
}

function run(network, peers, frames, onFrame) {
  for (let frame = 0; frame < frames; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    peers.forEach(peer => peer.runtime.step(FRAME_MILLISECONDS));
    onFrame?.(frame);
  }
}

test('each peer owns and moves its own player and sees the other one', () => {
  const network = createLoopbackNetwork({ seed: 3, latencyMilliseconds: 60 });
  const alice = createPeer(network, 'alice', { localEntityId: 'alice', readInput: () => ({ moveX: 1, moveZ: 0 }) });
  const bob = createPeer(network, 'bob', { localEntityId: 'bob', readInput: () => ({ moveX: 0, moveZ: -1 }) });
  alice.netcode.addEntity('alice', { tag: 'player' });
  bob.netcode.addEntity('bob', { tag: 'player', state: { position: [0, 0, 10] } });
  run(network, [alice, bob], 150);

  assert.equal(alice.netcode.role, 'peer');
  assert.equal(alice.netcode.getEntityOwner('bob'), 'bob');
  assert.deepEqual(alice.netcode.entityIds.sort(), ['alice', 'bob']);
  const ownOnBob = bob.netcode.getEntityState('alice');
  const truth = alice.netcode.getEntityState('alice');
  assert.ok(truth.position[0] > 5, 'the owner moved its own entity at once');
  assert.ok(Math.abs(ownOnBob.position[0] - truth.position[0]) < 1.5, `the remote view trails by the delay, got ${truth.position[0] - ownOnBob.position[0]}`);
  assert.ok(bob.netcode.getEntityState('bob').position[2] < 5);
  assert.ok(alice.netcode.stats.snapshotsReceived > 50);
});

test('two peers that claim one entity settle on the same owner whatever the arrival order', () => {
  const outcomes = [];
  for (const seed of [1, 2, 3, 4]) {
    const network = createLoopbackNetwork({ seed, latencyMilliseconds: 40, jitterMilliseconds: 30 });
    const alpha = createPeer(network, 'alpha');
    const zulu = createPeer(network, 'zulu');
    alpha.netcode.addEntity('crate', { state: { position: [1, 0, 0] } });
    zulu.netcode.addEntity('crate', { state: { position: [9, 0, 0] } });
    run(network, [alpha, zulu], 60);
    outcomes.push([alpha.netcode.getEntityOwner('crate'), zulu.netcode.getEntityOwner('crate')]);
    assert.throws(() => zulu.netcode.setEntityState('crate', { position: [2, 0, 0] }), /owned by peer "alpha".*claimEntity/);
    assert.ok(zulu.netcode.stats.ownershipChanges >= 1);
  }
  assert.deepEqual(outcomes, outcomes.map(() => ['alpha', 'alpha']), 'equal terms: the lower peer id wins on both sides');
});

test('claimEntity raises the term, beats the lower-id owner and starts from the state the claimer saw', () => {
  const network = createLoopbackNetwork({ seed: 5, latencyMilliseconds: 40 });
  const alpha = createPeer(network, 'alpha');
  const zulu = createPeer(network, 'zulu');
  alpha.netcode.addEntity('ball', { state: { position: [4, 0, 0], velocity: [0, 0, 0] } });
  run(network, [alpha, zulu], 40);
  zulu.netcode.claimEntity('ball');
  zulu.netcode.setEntityState('ball', { position: [7, 0, 0] });
  run(network, [alpha, zulu], 40);

  assert.equal(alpha.netcode.getEntityOwner('ball'), 'zulu');
  assert.equal(zulu.netcode.getEntityOwner('ball'), 'zulu');
  assert.ok(Math.abs(alpha.netcode.getEntityState('ball').position[0] - 7) < 0.01);
  assert.throws(() => alpha.netcode.setEntityState('ball', { position: [0, 0, 0] }), /owned by peer "zulu"/);
  alpha.netcode.claimEntity('ball');
  run(network, [alpha, zulu], 40);
  assert.equal(zulu.netcode.getEntityOwner('ball'), 'alpha', 'a later claim has a higher term and takes the entity back');
});

test('an entity of a peer that left is dropped, and bad messages and options are refused', () => {
  const network = createLoopbackNetwork({ seed: 8, latencyMilliseconds: 20 });
  const alice = createPeer(network, 'alice');
  const bob = createPeer(network, 'bob');
  bob.netcode.addEntity('bob');
  run(network, [alice, bob], 20);
  assert.deepEqual(alice.netcode.entityIds, ['bob']);
  assert.equal(alice.netcode.getEntityState('nobody'), null);

  const transport = { id: 'x', peers: () => ['y'], send() {}, receive() { return () => {}; } };
  assert.throws(() => createNetcode({ authority: 'peer', role: 'client', transport }), /Leave role out/);
  assert.throws(() => alice.netcode.addEntity('hers', { owner: 'bob' }), /adds only entities it owns/);
  assert.throws(() => createNetcode({ authority: 'server', role: 'authority', transport }).claimEntity('a'), /only for peer to peer/);

  const before = alice.netcode.stats.rejectedMessages;
  const mallory = network.createTransport('mallory');
  for (const message of [null, { type: 'peer-state' }, { type: 'peer-state', session: 's', tick: 1, entities: { crate: { m: 0 } } }, { type: 'peer-state', session: 's', tick: 2, entities: { crate: { p: [1, 2, 3], r: [0, 0, 0, 1000], v: [0, 0, 0], x: {}, m: -1 } } }]) {
    mallory.send('alice', message);
  }
  run(network, [alice, bob], 5);
  assert.equal(alice.netcode.stats.rejectedMessages - before, 4);
  assert.deepEqual(alice.netcode.entityIds, ['bob']);
});

test('a peer entity without variables or with a null variable is read as no variables (#2606)', () => {
  const network = createLoopbackNetwork({ seed: 12, latencyMilliseconds: 10 });
  const observer = createPeer(network, 'observer');
  const sender = network.createTransport('sender');
  run(network, [observer], 1);
  const message = (variables, tick) => ({
    type: 'peer-state',
    session: 'a',
    tick,
    entities: { crate: { p: [100, 0, 0], r: [0, 0, 0, 1000], v: [0, 0, 0], ...(variables && { x: variables }), m: 0 } },
  });
  sender.send('observer', message(undefined, 1));
  sender.send('observer', message({ door: null }, 2));
  run(network, [observer], 3);
  assert.equal(observer.netcode.getEntityOwner('crate'), 'sender');
  assert.deepEqual(observer.netcode.getEntityState('crate').variables, {});
});

test('an older run of a peer is stale and a restart on the same id is followed', () => {
  const network = createLoopbackNetwork({ seed: 9, latencyMilliseconds: 10 });
  const observer = createPeer(network, 'observer');
  const sender = network.createTransport('sender');
  run(network, [observer], 1);
  const entity = (x, term) => ({ p: [x * 100, 0, 0], r: [0, 0, 0, 1000], v: [0, 0, 0], x: {}, m: term });
  sender.send('observer', { type: 'peer-state', session: 'b', tick: 5, entities: { ball: entity(2, 0) } });
  sender.send('observer', { type: 'peer-state', session: 'a', tick: 9, entities: { ball: entity(8, 0) } });
  sender.send('observer', { type: 'peer-state', session: 'b', tick: 4, entities: { ball: entity(8, 0) } });
  run(network, [observer], 5);
  assert.equal(observer.netcode.stats.staleSnapshots, 2);
  assert.ok(Math.abs(observer.netcode.getEntityState('ball').position[0] - 2) < 0.01);
  sender.send('observer', { type: 'peer-state', session: 'c', tick: 0, entities: { ball: entity(5, 0) } });
  run(network, [observer], 20);
  assert.ok(Math.abs(observer.netcode.getEntityState('ball').position[0] - 5) < 0.01);
});

test('a peer that left frees its sender slot, so the table does not stay full (#2607)', () => {
  const network = createLoopbackNetwork({ seed: 14 });
  const observer = createPeer(network, 'observer');
  run(network, [observer], 1);
  const emptyState = tick => ({ type: 'peer-state', session: 'a', tick, entities: {} });
  const past = Array.from({ length: 32 }, (_, index) => network.createTransport(`past-${index}`));
  past.forEach((sender, index) => sender.send('observer', emptyState(index + 1)));
  network.advance(FRAME_MILLISECONDS);
  assert.equal(observer.netcode.stats.rejectedMessages, 0);
  const refused = network.createTransport('refused');
  refused.send('observer', emptyState(1));
  network.advance(FRAME_MILLISECONDS);
  assert.equal(observer.netcode.stats.rejectedMessages, 1, 'the 33rd sender is refused while 32 slots are held');

  past.forEach(sender => sender.close());
  run(network, [observer], 1);
  const late = network.createTransport('late');
  late.send('observer', emptyState(1));
  network.advance(FRAME_MILLISECONDS);
  assert.equal(observer.netcode.stats.rejectedMessages, 1, 'a peer that left should have freed its slot');
  assert.equal(observer.netcode.stats.snapshotsReceived, 33);
});
