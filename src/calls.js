'use strict';

const { randomUUID } = require('node:crypto');

// Call metadata is transient. SDP, ICE and media are never persisted or broadcast.
function createCallController({ io, onlineUsers, listUsers, validateSession,
  ringMs = 45000, connectMs = 45000, maxCallMs = 60 * 60 * 1000 }) {
  const calls = new Map();
  const occupied = new Map();

  function emit(socketId, event, payload) {
    io.to(socketId).emit(event, payload);
  }

  function finish(call, reason) {
    if (!calls.delete(call.id)) return;
    clearTimeout(call.timer);
    occupied.delete(call.caller.id);
    occupied.delete(call.callee.id);
    for (const id of new Set([call.callerSocket, ...call.ringingSockets, call.calleeSocket].filter(Boolean))) {
      emit(id, 'call:ended', { callId: call.id, reason });
    }
  }

  function deadline(call, duration, reason) {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => finish(call, reason), duration);
    call.timer.unref?.();
  }

  function participant(socket, input, ringing = false) {
    const call = calls.get(input?.callId);
    if (!call || !(call.callerSocket === socket.id || call.calleeSocket === socket.id ||
      (ringing && call.state === 'ringing' && call.ringingSockets.has(socket.id)))) {
      throw new Error('Call is no longer available on this device.');
    }
    return call;
  }

  function attach(socket) {
    let queue = Promise.resolve();
    let pending = 0;
    let windowStart = Date.now();
    let count = 0;
    let invites = 0;
    function on(event, handler) {
      socket.on(event, (input, ack) => {
        const reply = (value) => { if (typeof ack === 'function') ack(value); };
        if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; invites = 0; }
        if (++count > 400 || (event === 'call:invite' && ++invites > 6) || pending >= 64) {
          reply({ ok: false, error: 'Too many call requests. Please wait a moment.' });
          return;
        }
        pending++;
        // Preserve invite/cancel ordering even while session checks await storage.
        queue = queue.then(async () => {
          if (!socket.connected || !await validateSession(socket)) {
            socket.disconnect(true);
            throw new Error('Sign in again to call.');
          }
          if (!socket.connected) throw new Error('Connection closed.');
          return handler(input || {});
        }).then((result) => reply({ ok: true, ...result })).catch((error) => {
          reply({ ok: false, error: error.message });
        }).finally(() => { pending--; });
      });
    }

    on('call:invite', async (input) => {
      if (!['voice', 'video'].includes(input.kind) || typeof input.toUserId !== 'string') {
        throw new Error('Choose a person and a voice or video call.');
      }
      const people = await listUsers();
      const callee = people.find((user) => user.id === input.toUserId && user.id !== socket.user.id);
      if (!callee) throw new Error('This person is not in your chat.');
      if (!socket.connected) throw new Error('Connection closed.');
      if (occupied.has(socket.user.id) || occupied.has(callee.id)) throw new Error('One of you is already in a call.');
      const ringingSockets = new Set([...(onlineUsers.get(callee.id) || [])]
        .filter((id) => io.sockets.sockets.get(id)?.connected));
      if (!ringingSockets.size) throw new Error(`${callee.displayName} is offline. Ask them to open the chat.`);
      const call = {
        id: randomUUID(), kind: input.kind, caller: { id: socket.user.id, displayName: socket.user.displayName },
        callee: { id: callee.id, displayName: callee.displayName }, callerSocket: socket.id,
        calleeSocket: null, ringingSockets, state: 'ringing', offerSent: false, answerSent: false,
        candidates: new Map(), connected: new Set()
      };
      calls.set(call.id, call);
      occupied.set(call.caller.id, call.id);
      occupied.set(call.callee.id, call.id);
      deadline(call, ringMs, 'missed');
      const summary = { callId: call.id, kind: call.kind, caller: call.caller, callee: call.callee };
      for (const id of ringingSockets) emit(id, 'call:incoming', summary);
      return summary;
    });

    on('call:accept', (input) => {
      const call = participant(socket, input, true);
      if (call.state !== 'ringing' || socket.user.id !== call.callee.id) throw new Error('Call was already answered or ended.');
      call.calleeSocket = socket.id;
      call.state = 'connecting';
      deadline(call, connectMs, 'connection_failed');
      emit(call.callerSocket, 'call:accepted', { callId: call.id });
      for (const id of call.ringingSockets) {
        if (id !== socket.id) emit(id, 'call:ended', { callId: call.id, reason: 'answered_elsewhere' });
      }
      return {};
    });

    on('call:signal', (input) => {
      const call = participant(socket, input);
      if (!['connecting', 'connected'].includes(call.state)) throw new Error('Call has not been accepted.');
      const caller = socket.id === call.callerSocket;
      let signal;
      if (input.description) {
        const { type, sdp } = input.description;
        if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536 ||
          (caller ? type !== 'offer' || call.offerSent : type !== 'answer' || !call.offerSent || call.answerSent)) {
          throw new Error('Invalid call description.');
        }
        if (caller) call.offerSent = true;
        else call.answerSent = true;
        signal = { description: { type, sdp } };
      } else {
        const candidate = input.candidate;
        if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096 ||
          !(candidate.sdpMid == null || typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 64) ||
          !(candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 16)) {
          throw new Error('Invalid call network candidate.');
        }
        const total = (call.candidates.get(socket.id) || 0) + 1;
        if (total > 256) throw new Error('Too many call network candidates.');
        call.candidates.set(socket.id, total);
        signal = { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null } };
      }
      emit(caller ? call.calleeSocket : call.callerSocket, 'call:signal', { callId: call.id, ...signal });
      return {};
    });

    on('call:connected', (input) => {
      const call = participant(socket, input);
      if (!call.answerSent) throw new Error('Call is still connecting.');
      call.connected.add(socket.id);
      if (call.connected.size === 2 && call.state !== 'connected') {
        call.state = 'connected';
        deadline(call, maxCallMs, 'duration_limit');
      }
      return {};
    });

    on('call:end', (input) => {
      if (!calls.has(input.callId)) return {};
      const call = participant(socket, input, true);
      const reason = call.state === 'ringing'
        ? (socket.id === call.callerSocket ? 'cancelled' : 'declined')
        : (input.reason === 'failed' ? 'connection_failed' : 'ended');
      finish(call, reason);
      return {};
    });

    socket.on('disconnect', () => {
      for (const call of calls.values()) {
        if (call.callerSocket === socket.id || call.calleeSocket === socket.id) finish(call, 'disconnected');
        else if (call.ringingSockets.delete(socket.id) && call.state === 'ringing' && !call.ringingSockets.size) {
          finish(call, 'disconnected');
        }
      }
    });
  }

  return { attach, close: () => { for (const call of calls.values()) finish(call, 'disconnected'); } };
}

module.exports = { createCallController };
