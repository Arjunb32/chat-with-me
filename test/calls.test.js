'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { io: client } = require(path.join(path.dirname(require.resolve('socket.io')), '../client-dist/socket.io.js'));
const { createCallController } = require('../src/calls');

const people = [{ id: 'alice', displayName: 'Alice' }, { id: 'bob', displayName: 'Bob' }];

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, handler); reject(new Error(`Missing ${name}`)); }, 2500);
    function handler(payload) { clearTimeout(timeout); resolve(payload); }
    socket.once(name, handler);
  });
}

async function fixture(t, options = {}) {
  const server = http.createServer();
  const io = new Server(server);
  const onlineUsers = new Map();
  const revoked = new Set();
  const sockets = [];
  const controller = createCallController({ io, onlineUsers, listUsers: async () => people,
    validateSession: async (socket) => !revoked.has(socket.user.id), ...options });
  io.use((socket, next) => {
    socket.user = people.find((user) => user.id === socket.handshake.auth.user) || { id: 'outsider', displayName: 'Outsider' };
    next();
  });
  io.on('connection', (socket) => {
    const ids = onlineUsers.get(socket.user.id) || new Set();
    ids.add(socket.id);
    onlineUsers.set(socket.user.id, ids);
    controller.attach(socket);
    socket.on('disconnect', () => ids.delete(socket.id));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    controller.close();
    await new Promise((resolve) => io.close(resolve));
  });
  async function connect(user) {
    const socket = client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], auth: { user }, forceNew: true, reconnection: false });
    sockets.push(socket);
    await event(socket, 'connect');
    return socket;
  }
  const alice = await connect('alice');
  const bob = await connect('bob');
  return { alice, bob, connect, revoked };
}

const send = (socket, name, payload) => socket.timeout(2000).emitWithAck(name, payload);
async function invite(alice, bob, kind = 'voice') {
  const incoming = event(bob, 'call:incoming');
  const response = await send(alice, 'call:invite', { toUserId: 'bob', kind });
  assert.equal(response.ok, true);
  assert.equal((await incoming).callId, response.callId);
  return response.callId;
}

test('voice and video calls relay only between accepted devices and allow a second call', async (t) => {
  const { alice, bob } = await fixture(t);
  for (const kind of ['voice', 'video']) {
    const callId = await invite(alice, bob, kind);
    const accepted = event(alice, 'call:accepted');
    assert.equal((await send(bob, 'call:accept', { callId })).ok, true);
    await accepted;
    const offer = event(bob, 'call:signal');
    assert.equal((await send(alice, 'call:signal', { callId, description: { type: 'offer', sdp: 'v=0\r\n' } })).ok, true);
    assert.equal((await offer).description.type, 'offer');
    const answer = event(alice, 'call:signal');
    assert.equal((await send(bob, 'call:signal', { callId, description: { type: 'answer', sdp: 'v=0\r\n' } })).ok, true);
    await answer;
    assert.equal((await send(alice, 'call:connected', { callId })).ok, true);
    assert.equal((await send(bob, 'call:connected', { callId })).ok, true);
    const ended = event(bob, 'call:ended');
    assert.equal((await send(alice, 'call:end', { callId })).ok, true);
    assert.equal((await ended).reason, 'ended');
  }
});

test('rejects self, unknown, offline, invalid and simultaneous invitations', async (t) => {
  const { alice, bob } = await fixture(t);
  for (const input of [{ toUserId: 'alice', kind: 'voice' }, { toUserId: 'unknown', kind: 'voice' }, { toUserId: 'bob', kind: 'screen' }]) {
    assert.equal((await send(alice, 'call:invite', input)).ok, false);
  }
  const responses = await Promise.all([
    send(alice, 'call:invite', { toUserId: 'bob', kind: 'voice' }),
    send(bob, 'call:invite', { toUserId: 'alice', kind: 'voice' })
  ]);
  assert.equal(responses.filter((response) => response.ok).length, 1);
  const winner = responses[0].ok ? alice : bob;
  await send(winner, 'call:end', { callId: responses.find((response) => response.ok).callId });
  bob.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await send(alice, 'call:invite', { toUserId: 'bob', kind: 'voice' })).ok, false);
});

test('first answer wins across tabs; other devices and strangers cannot signal or end calls', async (t) => {
  const { alice, bob, connect } = await fixture(t);
  const bobOther = await connect('bob');
  const aliceOther = await connect('alice');
  const outsider = await connect('outsider');
  const callId = await invite(alice, bob);
  const dismissed = event(bobOther, 'call:ended');
  await send(bob, 'call:accept', { callId });
  assert.equal((await dismissed).reason, 'answered_elsewhere');
  for (const socket of [bobOther, aliceOther, outsider]) {
    assert.equal((await send(socket, 'call:accept', { callId })).ok, false);
    assert.equal((await send(socket, 'call:signal', { callId, description: { type: 'offer', sdp: 'v=0\r\n' } })).ok, false);
    assert.equal((await send(socket, 'call:end', { callId })).ok, false);
  }
  const ended = event(alice, 'call:ended');
  bob.disconnect();
  assert.equal((await ended).reason, 'disconnected');
});

test('cancelling a ringing call makes late acceptance and ICE harmless', async (t) => {
  const { alice, bob } = await fixture(t);
  const callId = await invite(alice, bob);
  const ended = event(bob, 'call:ended');
  await send(alice, 'call:end', { callId });
  assert.equal((await ended).reason, 'cancelled');
  assert.equal((await send(bob, 'call:accept', { callId })).ok, false);
  assert.equal((await send(bob, 'call:signal', { callId, candidate: { candidate: 'candidate:test' } })).ok, false);
  assert.equal((await send(alice, 'call:end', { callId })).ok, true);
});

test('declined and unanswered calls release both people', async (t) => {
  const { alice, bob } = await fixture(t, { ringMs: 120 });
  const callId = await invite(alice, bob);
  const declined = event(alice, 'call:ended');
  await send(bob, 'call:end', { callId });
  assert.equal((await declined).reason, 'declined');
  const missed = event(alice, 'call:ended');
  await invite(alice, bob);
  assert.equal((await missed).reason, 'missed');
});

test('revoked sessions are disconnected and terminate a call', async (t) => {
  const { alice, bob, revoked } = await fixture(t);
  const callId = await invite(alice, bob);
  await send(bob, 'call:accept', { callId });
  const ended = event(bob, 'call:ended');
  const disconnected = event(alice, 'disconnect');
  revoked.add('alice');
  alice.emit('call:signal', { callId, description: { type: 'offer', sdp: 'v=0\r\n' } });
  await disconnected;
  assert.equal((await ended).reason, 'disconnected');
});

test('rejects signaling before acceptance, oversized SDP and invalid candidate fields', async (t) => {
  const { alice, bob } = await fixture(t);
  const callId = await invite(alice, bob);
  assert.equal((await send(alice, 'call:signal', { callId, description: { type: 'offer', sdp: 'v=0\r\n' } })).ok, false);
  await send(bob, 'call:accept', { callId });
  for (const input of [
    { description: { type: 'offer', sdp: `v=0${'x'.repeat(66000)}` } },
    { description: { type: 'answer', sdp: 'v=0\r\n' } },
    { candidate: { candidate: 'candidate:test', sdpMLineIndex: -1 } },
    { candidate: { candidate: 'x'.repeat(5000) } }
  ]) assert.equal((await send(alice, 'call:signal', { callId, ...input })).ok, false);
});
