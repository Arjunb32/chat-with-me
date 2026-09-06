(() => {
  'use strict';

  function create({ api, getPeer, canCall, isRecording, notice }) {
    const el = Object.fromEntries(['voiceCallButton', 'videoCallButton', 'callDialog', 'callTitle',
      'callStatus', 'callTimer', 'callVideos', 'callLocalVideo', 'callRemoteVideo', 'callRemoteAudio',
      'callAcceptButton', 'callDeclineButton', 'callEndButton', 'callMuteButton', 'callCameraButton',
      'callPlayButton'].map((id) => [id, document.getElementById(id)]));
    let socket = null;
    let active = null;
    let bindings = [];

    function current(call) { return active === call; }
    function status(call, text) { if (current(call)) el.callStatus.textContent = text; }

    function request(event, input) {
      const connection = socket;
      return new Promise((resolve, reject) => {
        if (!connection?.connected) { reject(new Error('Reconnect to the chat to call.')); return; }
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          reject(new Error('The call request timed out. Please try again.'));
        }, 10000);
        connection.emit(event, input, (response) => {
          clearTimeout(timer);
          // A cancelled/timed-out invite must not leave the other device ringing.
          if (expired) {
            if (event === 'call:invite' && response?.callId) connection.emit('call:end', { callId: response.callId });
            return;
          }
          if (!response?.ok) reject(new Error(response?.error || 'Call request failed.'));
          else resolve(response);
        });
      });
    }

    function refresh() {
      const disabled = Boolean(active) || !canCall() || !getPeer()?.online || isRecording() ||
        !socket?.connected || !window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia;
      el.voiceCallButton.disabled = disabled;
      el.videoCallButton.disabled = disabled;
    }

    function show(call) {
      el.callTitle.textContent = `${call.kind === 'video' ? 'Video' : 'Voice'} call with ${call.peer.displayName}`;
      el.callTimer.textContent = '';
      el.callVideos.hidden = call.kind !== 'video';
      el.callAcceptButton.hidden = !call.incoming;
      el.callDeclineButton.hidden = !call.incoming;
      el.callEndButton.hidden = call.incoming;
      el.callMuteButton.hidden = true;
      el.callCameraButton.hidden = true;
      el.callPlayButton.hidden = true;
      el.callAcceptButton.disabled = false;
      el.callMuteButton.textContent = 'Mute microphone';
      el.callMuteButton.setAttribute('aria-pressed', 'false');
      el.callCameraButton.textContent = 'Turn camera off';
      el.callCameraButton.setAttribute('aria-pressed', 'false');
      el.callStatus.textContent = call.incoming ? `Incoming ${call.kind} call` : 'Preparing your call…';
      if (!el.callDialog.open) el.callDialog.showModal();
      refresh();
    }

    function stop(reason = '', tellPeer = true) {
      const call = active;
      if (!call) return;
      active = null;
      clearTimeout(call.deadline);
      clearTimeout(call.disconnectTimer);
      clearInterval(call.clock);
      if (tellPeer && call.id && socket?.connected) socket.emit('call:end', { callId: call.id, reason: call.failed ? 'failed' : 'ended' });
      if (call.pc) {
        call.pc.onicecandidate = null;
        call.pc.ontrack = null;
        call.pc.onconnectionstatechange = null;
        call.pc.close();
      }
      call.stream?.getTracks().forEach((track) => track.stop());
      call.remote?.getTracks().forEach((track) => track.stop());
      call.candidates.length = 0;
      for (const media of [el.callLocalVideo, el.callRemoteVideo, el.callRemoteAudio]) {
        media.pause();
        media.srcObject = null;
      }
      if (el.callDialog.open) el.callDialog.close();
      if (reason) notice(reason);
      refresh();
    }

    function fail(call, error) {
      if (!current(call)) return;
      call.failed = true;
      const messages = {
        NotAllowedError: 'Camera or microphone permission was denied. Allow access in your browser and try again.',
        NotFoundError: 'A microphone or camera could not be found.',
        NotReadableError: 'Your microphone or camera is busy. Close the other app and try again.'
      };
      stop(messages[error.name] || error.message || 'The call could not connect. Please try again.');
    }

    function newCall(kind, peer, incoming, id = null) {
      const call = { kind, peer, incoming, id, candidates: [], signals: Promise.resolve(), stream: null, pc: null };
      active = call;
      call.deadline = setTimeout(() => fail(call, new Error('The call timed out. Please try again.')), 90000);
      show(call);
      return call;
    }

    async function capture(call) {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Use an up-to-date browser with HTTPS to call.');
      call.config = await api('/api/calls/config');
      if (!current(call)) return false;
      status(call, call.kind === 'video' ? 'Allow your camera and microphone to continue…' : 'Allow your microphone to continue…');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: call.kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
      });
      if (!current(call)) { stream.getTracks().forEach((track) => track.stop()); return false; }
      call.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(call, new Error('Your microphone or camera was disconnected.')));
      el.callLocalVideo.srcObject = stream;
      el.callLocalVideo.play().catch(() => {});
      el.callMuteButton.hidden = false;
      el.callCameraButton.hidden = call.kind !== 'video';
      return true;
    }

    function playRemote() {
      el.callRemoteVideo.play().catch(() => {});
      el.callRemoteAudio.play().then(() => { el.callPlayButton.hidden = true; }).catch(() => {
        if (active) el.callPlayButton.hidden = false;
      });
    }

    function makePeer(call) {
      const pc = new RTCPeerConnection({ iceServers: call.config.iceServers, iceTransportPolicy: call.config.iceTransportPolicy });
      call.pc = pc;
      call.remote = new MediaStream();
      el.callRemoteVideo.srcObject = call.remote;
      el.callRemoteAudio.srcObject = call.remote;
      call.stream.getTracks().forEach((track) => pc.addTrack(track, call.stream));
      pc.onicecandidate = ({ candidate }) => {
        if (current(call) && candidate) request('call:signal', { callId: call.id, candidate: candidate.toJSON() }).catch((error) => fail(call, error));
      };
      pc.ontrack = ({ track }) => {
        if (!current(call)) return;
        call.remote.addTrack(track);
        playRemote();
      };
      pc.onconnectionstatechange = () => {
        if (!current(call)) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(call.deadline);
          clearTimeout(call.disconnectTimer);
          status(call, 'Connected');
          if (!call.startedAt) {
            call.startedAt = Date.now();
            request('call:connected', { callId: call.id }).catch((error) => fail(call, error));
            call.clock = setInterval(() => {
              const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
              el.callTimer.textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
            }, 1000);
          }
        } else if (pc.connectionState === 'disconnected') {
          status(call, 'Connection interrupted. Reconnecting…');
          clearTimeout(call.disconnectTimer);
          call.disconnectTimer = setTimeout(() => fail(call, new Error('The call connection was lost. Please call again.')), 15000);
        } else if (pc.connectionState === 'failed') {
          fail(call, new Error('The call could not connect on this network. Please try again.'));
        }
      };
      return pc;
    }

    async function start(kind) {
      if (active || !canCall() || isRecording()) return;
      const peer = getPeer();
      if (!peer?.online || !socket?.connected) { notice('Both people need to have the chat open to call.'); return; }
      const call = newCall(kind, peer, false);
      try {
        if (!await capture(call)) return;
        status(call, `Calling ${peer.displayName}…`);
        const connection = socket;
        const result = await request('call:invite', { toUserId: peer.id, kind });
        call.id = result.callId;
        if (!current(call)) connection.emit('call:end', { callId: call.id });
      } catch (error) { fail(call, error); }
    }

    async function accept() {
      const call = active;
      if (!call?.incoming || call.accepting) return;
      call.accepting = true;
      el.callAcceptButton.disabled = true;
      el.callAcceptButton.hidden = true;
      el.callDeclineButton.hidden = true;
      el.callEndButton.hidden = false;
      // Unlock audio playback during the explicit answer gesture where possible.
      el.callRemoteAudio.play().catch(() => {});
      try {
        if (!await capture(call)) return;
        makePeer(call);
        status(call, 'Connecting…');
        await request('call:accept', { callId: call.id });
      } catch (error) { fail(call, error); }
    }

    async function signal(call, input) {
      if (!current(call)) return;
      if (input.candidate) {
        if (!call.pc?.remoteDescription) {
          if (call.candidates.length >= 256) throw new Error('Too many call network candidates.');
          call.candidates.push(input.candidate);
        } else await call.pc.addIceCandidate(input.candidate);
        return;
      }
      const pc = call.pc;
      if (!pc || !input.description) throw new Error('Call connection is not ready.');
      await pc.setRemoteDescription(input.description);
      if (!current(call)) return;
      for (const candidate of call.candidates.splice(0)) {
        if (!current(call)) return;
        await pc.addIceCandidate(candidate);
      }
      if (input.description.type === 'offer') {
        const answer = await pc.createAnswer();
        if (!current(call)) return;
        await pc.setLocalDescription(answer);
        if (current(call)) await request('call:signal', { callId: call.id, description: { type: answer.type, sdp: answer.sdp } });
      }
    }

    function bindSocket(next) {
      stop('', true);
      for (const [event, handler] of bindings) socket?.off(event, handler);
      bindings = [];
      socket = next;
      if (!socket) { refresh(); return; }
      function on(event, handler) { socket.on(event, handler); bindings.push([event, handler]); }
      on('connect', refresh);
      on('disconnect', () => { stop('The call ended because your chat disconnected.', false); refresh(); });
      on('call:incoming', (input) => {
        if (active || !canCall() || isRecording()) return;
        newCall(input.kind, input.caller, true, input.callId);
      });
      on('call:accepted', async (input) => {
        const call = active;
        if (!call || call.id !== input.callId || call.incoming) return;
        try {
          status(call, 'Connecting…');
          const pc = makePeer(call);
          const offer = await pc.createOffer();
          if (!current(call)) return;
          await pc.setLocalDescription(offer);
          if (current(call)) await request('call:signal', { callId: call.id, description: { type: offer.type, sdp: offer.sdp } });
        } catch (error) { fail(call, error); }
      });
      on('call:signal', (input) => {
        const call = active;
        if (!call || input.callId !== call.id) return;
        call.signals = call.signals.then(() => signal(call, input)).catch((error) => fail(call, error));
      });
      on('call:ended', (input) => {
        if (active?.id !== input.callId) return;
        const messages = { missed: 'Call was not answered.', declined: 'Call declined.', cancelled: 'Call cancelled.',
          answered_elsewhere: 'Call answered on another device.', disconnected: 'The other person disconnected.',
          connection_failed: 'The call could not connect. Please try again.', duration_limit: 'The one-hour call limit was reached. You can start another call.' };
        stop(messages[input.reason] || 'Call ended.', false);
      });
      refresh();
    }

    el.voiceCallButton.addEventListener('click', () => start('voice'));
    el.videoCallButton.addEventListener('click', () => start('video'));
    el.callAcceptButton.addEventListener('click', accept);
    el.callDeclineButton.addEventListener('click', () => stop());
    el.callEndButton.addEventListener('click', () => stop('Call ended.'));
    el.callDialog.addEventListener('cancel', (event) => { event.preventDefault(); stop('Call ended.'); });
    el.callPlayButton.addEventListener('click', playRemote);
    el.callMuteButton.addEventListener('click', () => {
      const tracks = active?.stream?.getAudioTracks() || [];
      const mute = tracks.some((track) => track.enabled);
      tracks.forEach((track) => { track.enabled = !mute; });
      el.callMuteButton.textContent = mute ? 'Unmute microphone' : 'Mute microphone';
      el.callMuteButton.setAttribute('aria-pressed', String(mute));
    });
    el.callCameraButton.addEventListener('click', () => {
      const tracks = active?.stream?.getVideoTracks() || [];
      const off = tracks.some((track) => track.enabled);
      tracks.forEach((track) => { track.enabled = !off; });
      el.callCameraButton.textContent = off ? 'Turn camera on' : 'Turn camera off';
      el.callCameraButton.setAttribute('aria-pressed', String(off));
    });
    window.addEventListener('pagehide', () => stop());
    return { bindSocket, stop, refresh, isActive: () => Boolean(active) };
  }

  window.ChatCalls = { create };
})();
