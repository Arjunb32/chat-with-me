(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state = {
    setup: null,
    me: null,
    people: [],
    onlineUserIds: [],
    cryptoKey: null,
    socket: null,
    messages: [],
    decryptedMessages: new Map(),
    attachmentCache: new Map(),
    recording: null,
    typingTimer: null,
    peerTypingTimer: null,
    olderExhausted: false
  };

  const els = {
    authView: document.querySelector('#authView'),
    unlockView: document.querySelector('#unlockView'),
    chatView: document.querySelector('#chatView'),
    ownerForm: document.querySelector('#ownerForm'),
    setupCodeField: document.querySelector('#setupCodeField'),
    returningForms: document.querySelector('#returningForms'),
    loginForm: document.querySelector('#loginForm'),
    signupForm: document.querySelector('#signupForm'),
    authNotice: document.querySelector('#authNotice'),
    unlockForm: document.querySelector('#unlockForm'),
    unlockName: document.querySelector('#unlockName'),
    logoutFromUnlock: document.querySelector('#logoutFromUnlock'),
    presenceText: document.querySelector('#presenceText'),
    inviteButton: document.querySelector('#inviteButton'),
    codesButton: document.querySelector('#codesButton'),
    lockButton: document.querySelector('#lockButton'),
    logoutButton: document.querySelector('#logoutButton'),
    loadOlderButton: document.querySelector('#loadOlderButton'),
    messageList: document.querySelector('#messageList'),
    typingLine: document.querySelector('#typingLine'),
    uploadLine: document.querySelector('#uploadLine'),
    composerForm: document.querySelector('#composerForm'),
    photoButton: document.querySelector('#photoButton'),
    photoInput: document.querySelector('#photoInput'),
    recordButton: document.querySelector('#recordButton'),
    messageInput: document.querySelector('#messageInput'),
    expirySelect: document.querySelector('#expirySelect'),
    sendButton: document.querySelector('#sendButton'),
    inviteDialog: document.querySelector('#inviteDialog'),
    inviteCodeOutput: document.querySelector('#inviteCodeOutput'),
    copyInviteButton: document.querySelector('#copyInviteButton'),
    codesDialog: document.querySelector('#codesDialog'),
    codesOutput: document.querySelector('#codesOutput'),
    copyCodesButton: document.querySelector('#copyCodesButton'),
    viewerDialog: document.querySelector('#viewerDialog'),
    viewerImage: document.querySelector('#viewerImage')
  };

  function setView(viewName) {
    els.authView.hidden = viewName !== 'auth';
    els.unlockView.hidden = viewName !== 'unlock';
    els.chatView.hidden = viewName !== 'chat';
  }

  function showAuthNotice(message) {
    els.authNotice.textContent = message;
    els.authNotice.hidden = !message;
  }

  function setUploadLine(message) {
    els.uploadLine.textContent = message || '';
    els.uploadLine.hidden = !message;
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function api(path, options = {}) {
    const init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: new Headers(options.headers || {})
    };

    if (options.body !== undefined) {
      init.headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, init);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : {};

    if (!response.ok) {
      throw new Error(payload.error || 'Request failed.');
    }

    return payload;
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  async function deriveChatKey(phrase, saltBase64) {
    const imported = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(phrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(saltBase64),
        iterations: 250000,
        hash: 'SHA-256'
      },
      imported,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(bytes) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      state.cryptoKey,
      bytes
    );

    return {
      v: 1,
      alg: 'AES-GCM',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  async function decryptBytes(envelope) {
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
      state.cryptoKey,
      base64ToBytes(envelope.ciphertext)
    );

    return new Uint8Array(plaintext);
  }

  async function encryptJson(value) {
    return encryptBytes(encoder.encode(JSON.stringify(value)));
  }

  async function decryptJson(envelope) {
    const bytes = await decryptBytes(envelope);
    return JSON.parse(decoder.decode(bytes));
  }

  function renderAuth() {
    els.ownerForm.hidden = !state.setup.needsOwner;
    els.returningForms.hidden = state.setup.needsOwner;
    els.setupCodeField.hidden = !state.setup.setupCodeRequired;
    els.signupForm.hidden = !state.setup.canUseInvite;

    const inviteCode = new URLSearchParams(window.location.search).get('invite');
    if (inviteCode) {
      els.signupForm.elements.inviteCode.value = inviteCode;
    }

    setView('auth');
  }

  function applyAuthPayload(payload) {
    state.me = payload.me;
    state.people = payload.people || [];
    state.setup = {
      ...(state.setup || {}),
      cryptoSalt: payload.cryptoSalt || (state.setup && state.setup.cryptoSalt),
      maxUploadMb: payload.maxUploadMb || (state.setup && state.setup.maxUploadMb)
    };
    els.unlockName.textContent = state.me.displayName;
    showAuthNotice('');
    setView('unlock');
    if (Array.isArray(payload.recoveryCodes) && payload.recoveryCodes.length) {
      showRecoveryCodes(payload.recoveryCodes);
    }
  }

  async function refreshSetup() {
    state.setup = await api('/api/setup/status');
  }

  async function submitAuthForm(event, path) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(form);
    setFormBusy(form, true);
    showAuthNotice('');

    try {
      const payload = await api(path, {
        method: 'POST',
        body: values
      });
      form.reset();
      applyAuthPayload(payload);
    } catch (error) {
      showAuthNotice(error.message);
    } finally {
      setFormBusy(form, false);
    }
  }

  function setFormBusy(form, isBusy) {
    for (const control of form.querySelectorAll('button, input, textarea, select')) {
      control.disabled = isBusy;
    }
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      clearLocalSession();
    }

    clearLocalSession();
    await refreshSetup();
    renderAuth();
  }

  function clearLocalSession() {
    if (state.socket) {
      state.socket.disconnect();
    }

    for (const attachment of state.attachmentCache.values()) {
      URL.revokeObjectURL(attachment.url);
    }

    state.me = null;
    state.people = [];
    state.cryptoKey = null;
    state.socket = null;
    state.messages = [];
    state.decryptedMessages.clear();
    state.attachmentCache.clear();
    state.onlineUserIds = [];
    state.olderExhausted = false;
    setUploadLine('');
  }

  function lockChat() {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    state.cryptoKey = null;
    state.decryptedMessages.clear();
    setView('unlock');
  }

  async function unlockChat(event) {
    event.preventDefault();
    setFormBusy(els.unlockForm, true);

    try {
      const phrase = els.unlockForm.elements.phrase.value;
      state.cryptoKey = await deriveChatKey(phrase, state.setup.cryptoSalt);
      els.unlockForm.reset();
      setView('chat');
      connectSocket();
      await loadMessages({ stickToBottom: true });
    } catch (error) {
      showAuthNotice(error.message);
    } finally {
      setFormBusy(els.unlockForm, false);
    }
  }

  function connectSocket() {
    if (state.socket) {
      state.socket.disconnect();
    }

    state.socket = io({
      transports: ['websocket', 'polling']
    });

    state.socket.on('connect', () => {
      renderPresence();
    });

    state.socket.on('connect_error', (error) => {
      setUploadLine(error.message || 'Realtime connection failed.');
    });

    state.socket.on('presence:update', (payload) => {
      state.onlineUserIds = payload.onlineUserIds || [];
      renderPresence();
    });

    state.socket.on('message:new', async (message) => {
      mergeMessages([message]);
      await renderMessages({ stickToBottom: true });
    });

    state.socket.on('message:status', async (payload) => {
      mergeMessages(payload.messages || []);
      await renderMessages();
    });

    state.socket.on('message:deleted', async (message) => {
      removeAttachmentCacheForMessage(message.id);
      state.decryptedMessages.delete(message.id);
      mergeMessages([message]);
      await renderMessages();
    });

    state.socket.on('messages:expired', async (payload) => {
      for (const message of payload.messages || []) {
        removeAttachmentCacheForMessage(message.id);
        state.decryptedMessages.delete(message.id);
      }
      mergeMessages(payload.messages || []);
      await renderMessages();
    });

    state.socket.on('typing', (payload) => {
      if (!payload || payload.userId === state.me.id) return;
      els.typingLine.textContent = payload.isTyping ? `${payload.displayName} is typing` : '';
      els.typingLine.hidden = !payload.isTyping;
      clearTimeout(state.peerTypingTimer);
      state.peerTypingTimer = setTimeout(() => {
        els.typingLine.hidden = true;
      }, 2200);
    });
  }

  function renderPresence() {
    const peer = state.people.find((person) => person.id !== state.me.id);
    if (!peer) {
      els.presenceText.textContent = 'Waiting for invite';
      return;
    }

    els.presenceText.textContent = state.onlineUserIds.includes(peer.id)
      ? `${peer.displayName} online`
      : `${peer.displayName} offline`;
  }

  function mergeMessages(messages) {
    const map = new Map(state.messages.map((message) => [message.id, message]));

    for (const message of messages) {
      const previous = map.get(message.id) || {};
      map.set(message.id, { ...previous, ...message });
    }

    state.messages = [...map.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  function removeAttachmentCacheForMessage(messageId) {
    const oldMessage = state.messages.find((message) => message.id === messageId);
    if (!oldMessage || !oldMessage.attachmentId) return;
    const cached = state.attachmentCache.get(oldMessage.attachmentId);
    if (cached) {
      URL.revokeObjectURL(cached.url);
      state.attachmentCache.delete(oldMessage.attachmentId);
    }
  }

  async function loadMessages(options = {}) {
    const before = options.before || null;
    const query = new URLSearchParams({ limit: '50' });
    if (before) query.set('before', before);
    const payload = await api(`/api/messages?${query.toString()}`);

    if (before && payload.messages.length === 0) {
      state.olderExhausted = true;
    }

    mergeMessages(payload.messages || []);
    await renderMessages({ stickToBottom: options.stickToBottom });
  }

  async function renderMessages(options = {}) {
    const shouldStick = options.stickToBottom || isNearBottom();
    els.messageList.replaceChildren();

    for (const message of state.messages) {
      els.messageList.append(await buildMessageNode(message));
    }

    els.loadOlderButton.hidden = state.messages.length === 0 || state.olderExhausted;
    markReadMessages();

    if (shouldStick) {
      requestAnimationFrame(() => {
        const shell = document.querySelector('.messages-shell');
        shell.scrollTop = shell.scrollHeight;
      });
    }
  }

  function isNearBottom() {
    const shell = document.querySelector('.messages-shell');
    return shell.scrollHeight - shell.scrollTop - shell.clientHeight < 160;
  }

  async function buildMessageNode(message) {
    const row = document.createElement('article');
    row.className = `message-row ${message.senderId === state.me.id ? 'mine' : 'theirs'}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    row.append(bubble);

    if (message.deletedAt) {
      bubble.classList.add('deleted');
      bubble.textContent = 'Message deleted';
      return row;
    }

    const decrypted = await getDecryptedMessage(message);
    if (!decrypted.ok) {
      bubble.classList.add('deleted');
      bubble.textContent = 'Could not decrypt';
      return row;
    }

    if (message.type === 'text') {
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = decrypted.data.text || '';
      bubble.append(text);
    } else {
      bubble.append(await buildMediaNode(message, decrypted.data));
    }

    bubble.append(buildMessageMeta(message));
    return row;
  }

  async function getDecryptedMessage(message) {
    if (state.decryptedMessages.has(message.id)) {
      return state.decryptedMessages.get(message.id);
    }

    try {
      const data = await decryptJson(message.payload);
      const result = { ok: true, data };
      state.decryptedMessages.set(message.id, result);
      return result;
    } catch {
      const result = { ok: false, data: null };
      state.decryptedMessages.set(message.id, result);
      return result;
    }
  }

  async function buildMediaNode(message, data) {
    const frame = document.createElement('div');
    frame.className = 'media-frame';

    const placeholder = document.createElement('div');
    placeholder.className = 'media-placeholder';
    placeholder.textContent = message.type === 'photo' ? 'Photo' : 'Voice message';
    frame.append(placeholder);

    try {
      const media = await loadAttachment(message, data);
      frame.replaceChildren();

      if (message.type === 'photo') {
        const image = document.createElement('img');
        image.src = media.url;
        image.alt = data.name || 'Photo message';
        image.addEventListener('click', () => openImageViewer(media.url, image.alt));
        frame.append(image);
      } else {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = media.url;
        frame.append(audio);
      }
    } catch {
      placeholder.textContent = 'Media unavailable';
    }

    return frame;
  }

  async function loadAttachment(message, data) {
    const attachmentId = message.attachmentId || data.attachmentId;
    if (!attachmentId) {
      throw new Error('Attachment missing.');
    }

    if (state.attachmentCache.has(attachmentId)) {
      return state.attachmentCache.get(attachmentId);
    }

    const response = await fetch(`/api/attachments/${encodeURIComponent(attachmentId)}/blob`, {
      credentials: 'same-origin'
    });

    if (!response.ok) {
      throw new Error('Attachment unavailable.');
    }

    const envelope = await response.json();
    const bytes = await decryptBytes(envelope);
    const blob = new Blob([bytes], {
      type: data.mime || (message.type === 'photo' ? 'image/jpeg' : 'audio/webm')
    });
    const media = {
      blob,
      url: URL.createObjectURL(blob)
    };
    state.attachmentCache.set(attachmentId, media);
    return media;
  }

  function buildMessageMeta(message) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const time = document.createElement('span');
    time.textContent = formatTime(message.createdAt);
    meta.append(time);

    if (message.expiresAt) {
      const expiry = document.createElement('span');
      expiry.textContent = `expires ${formatShortDate(message.expiresAt)}`;
      meta.append(expiry);
    }

    if (message.senderId === state.me.id) {
      const status = document.createElement('span');
      status.textContent = messageStatus(message);
      meta.append(status);

      const deleteButton = document.createElement('button');
      deleteButton.className = 'delete-message';
      deleteButton.type = 'button';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deleteMessage(message.id));
      meta.append(deleteButton);
    }

    return meta;
  }

  function messageStatus(message) {
    const peer = state.people.find((person) => person.id !== state.me.id);
    if (!peer) return 'Sent';
    if (message.readBy && message.readBy[peer.id]) return 'Read';
    if (message.deliveredBy && message.deliveredBy[peer.id]) return 'Delivered';
    return 'Sent';
  }

  function formatTime(isoDate) {
    return new Intl.DateTimeFormat([], {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(isoDate));
  }

  function formatShortDate(isoDate) {
    return new Intl.DateTimeFormat([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(isoDate));
  }

  function markReadMessages() {
    if (!state.socket || !state.socket.connected) return;

    const unreadIds = state.messages
      .filter((message) => {
        return !message.deletedAt && message.senderId !== state.me.id && !(message.readBy && message.readBy[state.me.id]);
      })
      .map((message) => message.id);

    if (unreadIds.length) {
      state.socket.emit('message:read', { messageIds: unreadIds });
    }
  }

  function emitMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!state.socket || !state.socket.connected) {
        reject(new Error('Realtime connection is offline.'));
        return;
      }

      const timer = setTimeout(() => reject(new Error('Message send timed out.')), 12000);
      state.socket.emit('message:send', payload, (response) => {
        clearTimeout(timer);
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || 'Message failed.'));
          return;
        }
        resolve(response.message);
      });
    });
  }

  async function sendText(event) {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    if (!text) return;

    els.sendButton.disabled = true;
    setUploadLine('');

    try {
      const payload = await encryptJson({ text });
      await emitMessage({
        type: 'text',
        payload,
        expiresInMs: Number(els.expirySelect.value || 0),
        clientId: window.crypto.randomUUID()
      });
      els.messageInput.value = '';
      resizeComposer();
      emitTyping(false);
    } catch (error) {
      setUploadLine(error.message);
    } finally {
      els.sendButton.disabled = false;
    }
  }

  async function sendMedia(kind, blob, meta) {
    if (!state.cryptoKey) {
      throw new Error('Unlock the chat first.');
    }

    const maxBytes = Math.floor(((state.setup && state.setup.maxUploadMb) || 12) * 1024 * 1024 * 0.72);
    if (blob.size > maxBytes) {
      throw new Error('Media is too large.');
    }

    setUploadLine(`Encrypting ${kind}`);
    const encryptedAttachment = await encryptBytes(new Uint8Array(await blob.arrayBuffer()));
    const rawBody = encoder.encode(JSON.stringify(encryptedAttachment));

    setUploadLine(`Uploading ${kind}`);
    const response = await fetch('/api/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'x-attachment-kind': kind
      },
      body: rawBody
    });

    const uploadPayload = await response.json();
    if (!response.ok) {
      throw new Error(uploadPayload.error || 'Upload failed.');
    }

    const payload = await encryptJson({
      ...meta,
      kind,
      attachmentId: uploadPayload.attachmentId
    });

    setUploadLine(`Sending ${kind}`);
    await emitMessage({
      type: kind,
      payload,
      attachmentId: uploadPayload.attachmentId,
      expiresInMs: Number(els.expirySelect.value || 0),
      clientId: window.crypto.randomUUID()
    });

    setUploadLine('');
  }

  async function handlePhotoFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      throw new Error('Choose an image file.');
    }

    setUploadLine('Preparing photo');
    const prepared = await compressImage(file);
    await sendMedia('photo', prepared.blob, {
      name: file.name,
      mime: prepared.blob.type || 'image/jpeg',
      size: prepared.blob.size,
      originalSize: file.size
    });
  }

  async function compressImage(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return { blob: file };
    }

    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('Photo compression failed.'));
      }, 'image/jpeg', 0.84);
    });

    return { blob };
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      throw new Error('Voice recording is not supported in this browser.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const recording = {
      recorder,
      stream,
      chunks: [],
      startedAt: Date.now(),
      mimeType: recorder.mimeType || 'audio/webm'
    };

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) {
        recording.chunks.push(event.data);
      }
    });

    recorder.addEventListener('stop', async () => {
      state.recording = null;
      els.recordButton.classList.remove('recording');
      els.recordButton.querySelector('span').textContent = 'Voice';
      stream.getTracks().forEach((track) => track.stop());

      if (!recording.chunks.length) return;

      try {
        const blob = new Blob(recording.chunks, { type: recording.mimeType });
        await sendMedia('voice', blob, {
          mime: recording.mimeType,
          durationMs: Date.now() - recording.startedAt,
          size: blob.size
        });
      } catch (error) {
        setUploadLine(error.message);
      }
    });

    state.recording = recording;
    recorder.start();
    els.recordButton.classList.add('recording');
    els.recordButton.querySelector('span').textContent = 'Stop';
  }

  function stopRecording() {
    if (state.recording && state.recording.recorder.state !== 'inactive') {
      state.recording.recorder.stop();
    }
  }

  function emitTyping(isTyping) {
    if (state.socket && state.socket.connected) {
      state.socket.emit('typing', { isTyping });
    }
  }

  function resizeComposer() {
    els.messageInput.style.height = 'auto';
    els.messageInput.style.height = `${Math.min(130, els.messageInput.scrollHeight)}px`;
  }

  function openImageViewer(url, alt) {
    els.viewerImage.src = url;
    els.viewerImage.alt = alt || 'Photo message';
    if (typeof els.viewerDialog.showModal === 'function') {
      els.viewerDialog.showModal();
    }
  }

  function deleteMessage(messageId) {
    if (!state.socket || !state.socket.connected) return;

    state.socket.emit('message:delete', { messageId }, (response) => {
      if (!response || !response.ok) {
        setUploadLine((response && response.error) || 'Delete failed.');
      }
    });
  }

  async function createInvite() {
    setUploadLine('');
    try {
      const payload = await api('/api/invites', { method: 'POST' });
      els.inviteCodeOutput.value = `${payload.inviteUrl}\n\nInvite code:\n${payload.inviteCode}\n\nExpires:\n${formatShortDate(payload.expiresAt)}`;
      if (typeof els.inviteDialog.showModal === 'function') {
        els.inviteDialog.showModal();
      }
    } catch (error) {
      setUploadLine(error.message);
    }
  }

  function showRecoveryCodes(codes) {
    els.codesOutput.value = [
      'Save these one-time codes somewhere private.',
      'A code is required when signing in from a new device.',
      '',
      ...codes
    ].join('\n');

    if (typeof els.codesDialog.showModal === 'function') {
      els.codesDialog.showModal();
    }
  }

  async function rotateRecoveryCodes() {
    setUploadLine('');
    try {
      const payload = await api('/api/recovery-codes', { method: 'POST' });
      showRecoveryCodes(payload.recoveryCodes || []);
    } catch (error) {
      setUploadLine(error.message);
    }
  }

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    await refreshSetup();

    try {
      const payload = await api('/api/me');
      applyAuthPayload(payload);
    } catch {
      renderAuth();
    }
  }

  els.ownerForm.addEventListener('submit', (event) => submitAuthForm(event, '/api/setup/owner'));
  els.loginForm.addEventListener('submit', (event) => submitAuthForm(event, '/api/login'));
  els.signupForm.addEventListener('submit', (event) => submitAuthForm(event, '/api/signup'));
  els.unlockForm.addEventListener('submit', unlockChat);
  els.logoutFromUnlock.addEventListener('click', logout);
  els.logoutButton.addEventListener('click', logout);
  els.lockButton.addEventListener('click', lockChat);
  els.inviteButton.addEventListener('click', createInvite);
  els.codesButton.addEventListener('click', rotateRecoveryCodes);
  els.loadOlderButton.addEventListener('click', async () => {
    const first = state.messages[0];
    if (first) {
      await loadMessages({ before: first.createdAt });
    }
  });

  els.composerForm.addEventListener('submit', sendText);
  els.photoButton.addEventListener('click', () => els.photoInput.click());
  els.photoInput.addEventListener('change', async () => {
    const file = els.photoInput.files && els.photoInput.files[0];
    els.photoInput.value = '';
    try {
      await handlePhotoFile(file);
    } catch (error) {
      setUploadLine(error.message);
    }
  });

  els.recordButton.addEventListener('click', async () => {
    try {
      if (state.recording) {
        stopRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      setUploadLine(error.message);
    }
  });

  els.messageInput.addEventListener('input', () => {
    resizeComposer();
    emitTyping(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => emitTyping(false), 1200);
  });

  els.copyInviteButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.inviteCodeOutput.value);
  });

  els.copyCodesButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.codesOutput.value);
  });

  els.viewerDialog.addEventListener('close', () => {
    els.viewerImage.removeAttribute('src');
  });

  init().catch((error) => {
    showAuthNotice(error.message);
    setView('auth');
  });
})();
