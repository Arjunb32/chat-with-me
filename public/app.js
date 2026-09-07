(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state = {
    setup: null,
    me: null,
    people: [],
    onlineUserIds: [],
    cryptoRootKey: null,
    cryptoKeyCache: new Map(),
    keyFingerprint: '',
    mode: sessionStorage.getItem('chatMode') === 'private' ? 'private' : 'standard',
    contacts: [],
    activeContactId: null,
    sessionEpoch: 1,
    socket: null,
    messages: [],
    decryptedMessages: new Map(),
    attachmentCache: new Map(),
    recording: null,
    recordingPending: null,
    recordingTimer: null,
    preview: null,
    pendingUploads: new Map(),
    newlyRenderedIds: new Set(),
    typingTimer: null,
    peerTypingTimer: null,
    olderExhausted: false,
    theme: localStorage.getItem('chatTheme') === 'dark' ? 'dark' : 'light'
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
    modeToggle: document.querySelector('#modeToggle'),
    modeLabel: document.querySelector('#modeLabel'),
    contactsButton: document.querySelector('#contactsButton'),
    codesButton: document.querySelector('#codesButton'),
    keyButton: document.querySelector('#keyButton'),
    themeButton: document.querySelector('#themeButton'),
    accountButton: document.querySelector('#accountButton'),
    lockButton: document.querySelector('#lockButton'),
    logoutButton: document.querySelector('#logoutButton'),
    loadOlderButton: document.querySelector('#loadOlderButton'),
    messageList: document.querySelector('#messageList'),
    typingLine: document.querySelector('#typingLine'),
    uploadLine: document.querySelector('#uploadLine'),
    recordingPanel: document.querySelector('#recordingPanel'),
    recordingCanvas: document.querySelector('#recordingCanvas'),
    recordingTimer: document.querySelector('#recordingTimer'),
    previewPanel: document.querySelector('#previewPanel'),
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
    keyDialog: document.querySelector('#keyDialog'),
    keyFingerprintOutput: document.querySelector('#keyFingerprintOutput'),
    keyEpochText: document.querySelector('#keyEpochText'),
    accountDialog: document.querySelector('#accountDialog'),
    profilePanel: document.querySelector('#profilePanel'),
    sessionsList: document.querySelector('#sessionsList'),
    devicesList: document.querySelector('#devicesList'),
    auditSection: document.querySelector('#auditSection'),
    auditList: document.querySelector('#auditList'),
    viewerDialog: document.querySelector('#viewerDialog'),
    viewerImage: document.querySelector('#viewerImage'),
    contactsPanel: document.querySelector('#contactsPanel'),
    contactsCloseButton: document.querySelector('#contactsCloseButton'),
    contactsList: document.querySelector('#contactsList')
  };

  const calling = window.ChatCalls.create({
    api,
    getPeer: () => {
      const peer = state.people.find((person) => person.id === state.activeContactId) ||
        state.people.find((person) => person.id !== state.me?.id);
      return peer ? { ...peer, online: state.onlineUserIds.includes(peer.id) } : null;
    },
    canCall: () => Boolean(state.me && !els.chatView.hidden && (!isPrivateMode() || state.cryptoRootKey)),
    isRecording: () => Boolean(state.recording || state.recordingPending),
    notice: setUploadLine
  });

  function setView(viewName) {
    if (viewName !== 'chat') calling.stop();
    els.authView.hidden = viewName !== 'auth';
    els.unlockView.hidden = viewName !== 'unlock';
    els.chatView.hidden = viewName !== 'chat';
  }

  function showAuthNotice(message) {
    els.authNotice.textContent = message;
    els.authNotice.hidden = !message;
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem('chatTheme', state.theme);
    const dark = state.theme === 'dark';
    if (els.themeButton) {
      els.themeButton.textContent = dark ? 'Light' : 'Dark';
      els.themeButton.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    }
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = dark ? '#101418' : '#f35f4c';
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  function setUploadLine(message) {
    els.uploadLine.textContent = message || '';
    els.uploadLine.hidden = !message;
  }

  function isPrivateMode() {
    return state.mode === 'private';
  }

  function setMode(mode, options = {}) {
    state.mode = mode === 'private' ? 'private' : 'standard';
    sessionStorage.setItem('chatMode', state.mode);
    updateModeUi();
    if (options.enter !== false && state.me) {
      if (isPrivateMode() && !state.cryptoRootKey) {
        lockChat();
      } else {
        enterChat().catch((error) => setUploadLine(error.message));
      }
    }
  }

  function updateModeUi() {
    if (!els.modeToggle) return;
    const privateMode = isPrivateMode();
    els.modeToggle.classList.toggle('private', privateMode);
    els.modeToggle.setAttribute('aria-pressed', String(privateMode));
    els.modeToggle.setAttribute('aria-label', privateMode ? 'Switch to Standard Mode' : 'Switch to Private Mode');
    els.modeLabel.textContent = privateMode ? 'Private' : 'Standard';
    if (els.keyButton) els.keyButton.hidden = !privateMode;
    if (els.lockButton) els.lockButton.hidden = !privateMode;
    if (els.unlockName) {
      const label = document.querySelector('#unlockView .wordmark strong');
      if (label) label.textContent = 'Private Mode';
    }
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

  function concatBytes(...chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  function normalizeEpoch(value) {
    const epoch = Number(value || 1);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('Invalid session epoch.');
    }

    return epoch;
  }

  function setSessionEpoch(value) {
    const epoch = normalizeEpoch(value);
    state.sessionEpoch = Math.max(state.sessionEpoch || 1, epoch);
    updateKeyUi();
  }

  function formatFingerprint(bytes) {
    const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.match(/.{1,4}/g).join(' ');
  }

  async function fingerprintForRoot(rootBytes) {
    const context = encoder.encode('chat-with-me key fingerprint v1');
    const digest = await window.crypto.subtle.digest('SHA-256', concatBytes(context, rootBytes));
    return formatFingerprint(new Uint8Array(digest));
  }

  async function deriveChatSecret(phrase, saltBase64) {
    const imported = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(phrase),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const rootBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(saltBase64),
        iterations: 250000,
        hash: 'SHA-256'
      },
      imported,
      256
    );
    const rootBytes = new Uint8Array(rootBits);
    const rootKey = await window.crypto.subtle.importKey(
      'raw',
      rootBytes,
      'HKDF',
      false,
      ['deriveKey']
    );
    const fingerprint = await fingerprintForRoot(rootBytes);
    rootBytes.fill(0);

    return { fingerprint, rootKey };
  }

  async function getEpochKey(epochValue) {
    const epoch = normalizeEpoch(epochValue);
    if (state.cryptoKeyCache.has(epoch)) {
      return state.cryptoKeyCache.get(epoch);
    }

    if (!state.cryptoRootKey) {
      throw new Error('Unlock the chat first.');
    }

    const key = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: base64ToBytes(state.setup.cryptoSalt),
        info: encoder.encode(`chat-with-me session epoch ${epoch}`)
      },
      state.cryptoRootKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    state.cryptoKeyCache.set(epoch, key);
    return key;
  }

  async function encryptBytes(bytes) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const epoch = normalizeEpoch(state.sessionEpoch);
    const key = await getEpochKey(epoch);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      bytes
    );

    return {
      v: 1,
      alg: 'AES-GCM',
      epoch,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  async function decryptBytes(envelope) {
    const key = await getEpochKey(envelope && envelope.epoch ? envelope.epoch : 1);
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
      key,
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
      sessionEpoch: payload.sessionEpoch || (state.setup && state.setup.sessionEpoch) || 1,
      maxUploadMb: payload.maxUploadMb || (state.setup && state.setup.maxUploadMb)
    };
    setSessionEpoch(state.setup.sessionEpoch);
    els.unlockName.textContent = state.me.displayName;
    showAuthNotice('');
    updateModeUi();
    if (isPrivateMode()) {
      setView('unlock');
    } else {
      enterChat().catch((error) => setUploadLine(error.message));
    }
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
    calling.stop();
    cancelVoiceCapture();
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
    calling.bindSocket(null);
    cancelVoiceCapture();
    if (state.socket) {
      state.socket.disconnect();
    }

    for (const attachment of state.attachmentCache.values()) {
      URL.revokeObjectURL(attachment.url);
    }

    state.me = null;
    state.people = [];
    state.cryptoRootKey = null;
    state.cryptoKeyCache.clear();
    state.keyFingerprint = '';
    state.socket = null;
    state.messages = [];
    state.decryptedMessages.clear();
    state.attachmentCache.clear();
    state.onlineUserIds = [];
    state.olderExhausted = false;
    state.sessionEpoch = 1;
    updateKeyUi();
    setUploadLine('');
  }

  function lockChat() {
    calling.bindSocket(null);
    cancelVoiceCapture();
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    state.cryptoRootKey = null;
    state.cryptoKeyCache.clear();
    state.keyFingerprint = '';
    state.decryptedMessages.clear();
    updateKeyUi();
    setView('unlock');
  }

  async function unlockChat(event) {
    event.preventDefault();
    setFormBusy(els.unlockForm, true);

    try {
      const phrase = els.unlockForm.elements.phrase.value;
      const secret = await deriveChatSecret(phrase, state.setup.cryptoSalt);
      state.cryptoRootKey = secret.rootKey;
      state.cryptoKeyCache.clear();
      state.keyFingerprint = secret.fingerprint;
      els.unlockForm.reset();
      updateKeyUi();
      await enterChat();
    } catch (error) {
      showAuthNotice(error.message);
    } finally {
      setFormBusy(els.unlockForm, false);
    }
  }

  async function enterChat() {
    setView('chat');
    updateModeUi();
    connectSocket();
    await loadMessages({ stickToBottom: true });
    await loadContacts();
  }

  function connectSocket() {
    calling.bindSocket(null);
    if (state.socket) {
      state.socket.disconnect();
    }

    state.socket = io({
      transports: ['websocket', 'polling']
    });
    calling.bindSocket(state.socket);

    state.socket.on('connect', () => {
      renderPresence();
    });

    state.socket.on('connect_error', (error) => {
      setUploadLine(error.message || 'Realtime connection failed.');
    });

    state.socket.on('presence:update', (payload) => {
      state.onlineUserIds = payload.onlineUserIds || [];
      renderPresence();
      renderContacts();
    });

    state.socket.on('crypto:epoch', (payload) => {
      if (payload && payload.sessionEpoch) {
        setSessionEpoch(payload.sessionEpoch);
      }
    });

    state.socket.on('message:new', async (message) => {
      state.newlyRenderedIds.add(message.id);
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
    calling.refresh();
    const peer = state.activeContactId
      ? state.people.find((person) => person.id === state.activeContactId) || state.contacts.find((person) => person.id === state.activeContactId)
      : state.people.find((person) => person.id !== state.me.id);
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
      if ((message.mode || 'private') === 'private' && message.payload && message.payload.epoch) {
        setSessionEpoch(message.payload.epoch);
      }
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

    if (!state.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'messages-empty';
      empty.innerHTML = '<strong>No messages yet</strong><span></span>';
      empty.querySelector('span').textContent = isPrivateMode()
        ? 'Unlock private mode and send the first encrypted message.'
        : 'Send the first standard message.';
      els.messageList.append(empty);
    } else {
      for (const message of state.messages) {
        els.messageList.append(await buildMessageNode(message));
      }
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
    if ((message.mode || 'private') === 'private') {
      bubble.classList.add('private-message');
    }
    if (state.newlyRenderedIds.has(message.id)) {
      row.classList.add('message-new');
      state.newlyRenderedIds.delete(message.id);
    }
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

    const kind = messageKind(message, decrypted.data);
    if (kind === 'text') {
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = decrypted.data.text || '';
      bubble.append(text);
    } else if (kind === 'photo' || kind === 'voice') {
      bubble.append(await buildMediaNode(message, decrypted.data, kind));
    } else {
      bubble.classList.add('deleted');
      bubble.textContent = 'Unknown message';
      return row;
    }

    bubble.append(buildMessageMeta(message));
    return row;
  }

  function messageKind(message, data) {
    if (data && ['text', 'photo', 'voice'].includes(data.kind)) {
      return data.kind;
    }

    if (message && ['text', 'photo', 'voice'].includes(message.type)) {
      return message.type;
    }

    if (data && typeof data.text === 'string') {
      return 'text';
    }

    if (data && data.attachmentId) {
      return String(data.mime || '').startsWith('image/') ? 'photo' : 'voice';
    }

    return null;
  }

  async function getDecryptedMessage(message) {
    if ((message.mode || 'private') === 'standard') {
      return { ok: true, data: message.payload || {} };
    }

    if (!state.cryptoRootKey) {
      return { ok: false, data: null };
    }

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

  async function buildMediaNode(message, data, kind) {
    const frame = document.createElement('div');
    frame.className = 'media-frame';

    const placeholder = document.createElement('div');
    placeholder.className = 'media-placeholder';
    placeholder.textContent = kind === 'photo' ? 'Photo' : 'Voice message';
    frame.append(placeholder);

    try {
      const media = await loadAttachment(message, data, kind);
      frame.replaceChildren();

      if (kind === 'photo') {
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

  async function loadAttachment(message, data, kind) {
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

    const bytes = (message.mode || 'private') === 'private'
      ? await decryptBytes(await response.json())
      : new Uint8Array(await response.arrayBuffer());
    const blob = new Blob([bytes], {
      type: data.mime || (kind === 'photo' ? 'image/jpeg' : 'audio/webm')
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

    if ((message.mode || 'private') === 'private') {
      const lock = document.createElement('span');
      lock.className = 'lock-mark';
      lock.textContent = 'Lock';
      lock.setAttribute('aria-label', 'Private encrypted message');
      meta.append(lock);
    }

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
      const payload = isPrivateMode() ? await encryptJson({ kind: 'text', text }) : { kind: 'text', text };
      await emitMessage({
        mode: state.mode,
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
    if (isPrivateMode() && !state.cryptoRootKey) {
      throw new Error('Unlock the chat first.');
    }

    const maxBytes = Math.floor(((state.setup && state.setup.maxUploadMb) || 12) * 1024 * 1024 * 0.72);
    if (blob.size > maxBytes) {
      throw new Error('Media is too large.');
    }

    setUploadLine(isPrivateMode() ? `Encrypting ${kind}` : `Preparing ${kind}`);
    const bodyBytes = isPrivateMode()
      ? encoder.encode(JSON.stringify(await encryptBytes(new Uint8Array(await blob.arrayBuffer()))))
      : new Uint8Array(await blob.arrayBuffer());

    setUploadLine(`Uploading ${kind}`);
    const uploadPayload = await uploadAttachment(bodyBytes, {
      contentType: isPrivateMode() ? 'application/json' : (blob.type || 'application/octet-stream'),
      onProgress: updatePreviewProgress
    });

    const plainPayload = {
      ...meta,
      kind,
      attachmentId: uploadPayload.attachmentId
    };
    const payload = isPrivateMode() ? await encryptJson(plainPayload) : plainPayload;

    setUploadLine(`Sending ${kind}`);
    await emitMessage({
      mode: state.mode,
      payload,
      attachmentId: uploadPayload.attachmentId,
      expiresInMs: Number(els.expirySelect.value || 0),
      clientId: window.crypto.randomUUID()
    });

    setUploadLine('');
  }

  async function loadContacts() {
    const payload = await api('/api/contacts');
    state.contacts = payload.contacts || [];
    renderContacts();
  }

  function renderContacts() {
    if (!els.contactsList) return;
    els.contactsList.replaceChildren();
    const contacts = state.contacts.map((contact) => ({
      ...contact,
      online: state.onlineUserIds.includes(contact.id) || contact.online
    }));
    if (!contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'contacts-empty';
      empty.textContent = 'No contacts yet';
      els.contactsList.append(empty);
      return;
    }
    for (const contact of contacts) {
      const card = document.createElement('article');
      card.className = 'contact-card';
      const initials = (contact.displayName || contact.username || '?').slice(0, 2).toUpperCase();
      card.innerHTML = '<div class="contact-avatar" aria-hidden="true"></div><div class="contact-copy"><strong></strong><span></span></div>';
      const avatar = card.querySelector('.contact-avatar');
      avatar.textContent = initials;
      avatar.style.setProperty('--avatar-color', contact.avatarColor || '#147c72');
      card.querySelector('strong').textContent = contact.displayName || contact.username;
      card.querySelector('span').textContent = contact.online ? 'Online' : `Last seen ${formatShortDate(contact.lastSeenAt)}`;
      card.classList.toggle('online', Boolean(contact.online));
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Start Chat';
      button.setAttribute('aria-label', `Start chat with ${contact.displayName || contact.username}`);
      button.addEventListener('click', () => {
        state.activeContactId = contact.id;
        closeContacts();
        renderPresence();
        els.messageInput.focus();
      });
      card.append(button);
      els.contactsList.append(card);
    }
  }

  function openContacts() {
    loadContacts().catch((error) => setUploadLine(error.message));
    els.contactsPanel.hidden = false;
  }

  function closeContacts() {
    els.contactsPanel.hidden = true;
  }

  function renderProfilePanel() {
    if (!els.profilePanel || !state.me) return;
    const colors = ['#147c72', '#f35f4c', '#6d5dfc', '#b7791f'];
    const current = state.me.avatarColor || '#147c72';
    els.profilePanel.replaceChildren();

    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar contact-avatar';
    avatar.textContent = (state.me.displayName || '?').slice(0, 2).toUpperCase();
    avatar.style.setProperty('--avatar-color', current);

    const swatches = document.createElement('div');
    swatches.className = 'avatar-swatches';
    for (const color of colors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'avatar-swatch';
      button.style.setProperty('--swatch-color', color);
      button.setAttribute('aria-label', `Use avatar color ${color}`);
      button.setAttribute('aria-pressed', String(color === current));
      button.addEventListener('click', () => {
        updateProfileColor(color).catch((error) => setUploadLine(error.message));
      });
      swatches.append(button);
    }

    els.profilePanel.append(avatar, swatches);
  }

  async function updateProfileColor(avatarColor) {
    const payload = await api('/api/account/profile', {
      method: 'PATCH',
      body: { avatarColor }
    });
    state.me = payload.me;
    state.people = payload.people || state.people;
    renderProfilePanel();
    await loadContacts();
  }

  function uploadAttachment(body, { contentType, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/attachments');
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
      xhr.setRequestHeader('X-Chat-Mode', state.mode);
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && typeof onProgress === 'function') {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
        } else {
          reject(new Error(payload.error || 'Upload failed.'));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed.')));
      xhr.send(body);
    });
  }

  function updatePreviewProgress(value) {
    const bar = els.previewPanel.querySelector('.preview-progress span');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  async function handlePhotoFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      throw new Error('Choose an image file.');
    }

    const prepared = await compressImage(file);
    showPhotoPreview(file, prepared.blob);
  }

  function showPhotoPreview(file, blob) {
    const url = URL.createObjectURL(blob);
    showPreview('photo', {
      blob,
      meta: {
      name: file.name,
        mime: blob.type || 'image/jpeg',
        size: blob.size,
      originalSize: file.size
      },
      url,
      title: file.name,
      detail: formatBytes(blob.size)
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
    if (calling.isActive()) throw new Error('Finish your call before recording a voice message.');
    if (state.recording || state.recordingPending) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      throw new Error('Voice recording is not supported in this browser.');
    }

    const pending = {};
    state.recordingPending = pending;
    calling.refresh();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (state.recordingPending === pending) state.recordingPending = null;
      calling.refresh();
      throw error;
    }
    if (state.recordingPending !== pending) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.recordingPending = null;
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
      stopRecordingVisualizer(recording);
      els.recordButton.classList.remove('recording');
      els.recordButton.querySelector('span').textContent = 'Voice';
      stream.getTracks().forEach((track) => track.stop());
      calling.refresh();

      if (recording.cancelled || !recording.chunks.length) return;

      try {
        const durationMs = Date.now() - recording.startedAt;
        const blob = new Blob(recording.chunks, { type: recording.mimeType });
        showVoicePreview(blob, {
          mime: recording.mimeType,
          durationMs,
          size: blob.size
        });
      } catch (error) {
        setUploadLine(error.message);
      }
    });

    state.recording = recording;
    calling.refresh();
    recorder.start();
    startRecordingVisualizer(recording);
    els.recordButton.classList.add('recording');
    els.recordButton.querySelector('span').textContent = 'Stop';
  }

  function cancelVoiceCapture() {
    state.recordingPending = null;
    if (state.recording) {
      state.recording.cancelled = true;
      state.recording.stream.getTracks().forEach((track) => track.stop());
      stopRecording();
    }
  }

  window.addEventListener('pagehide', cancelVoiceCapture);

  function showVoicePreview(blob, meta) {
    const url = URL.createObjectURL(blob);
    showPreview('voice', {
      blob,
      meta,
      url,
      title: 'Voice message',
      detail: formatDuration(meta.durationMs)
    });
    drawStaticWaveform(blob, els.previewPanel.querySelector('canvas')).catch(() => {});
  }

  function showPreview(kind, preview) {
    clearPreview();
    state.preview = { kind, ...preview };
    const media = kind === 'photo'
      ? `<img src="${preview.url}" alt="Photo preview">`
      : '<canvas width="260" height="48" aria-label="Voice waveform"></canvas><audio controls preload="metadata"></audio>';
    els.previewPanel.innerHTML = `
      <div class="preview-media">${media}</div>
      <div class="preview-copy"><strong></strong><span></span><div class="preview-progress" hidden><span></span></div></div>
      <div class="preview-actions">
        <button type="button" data-preview-send aria-label="Send preview">Send</button>
        <button type="button" class="ghost" data-preview-discard aria-label="Discard preview">Discard</button>
      </div>`;
    els.previewPanel.querySelector('strong').textContent = preview.title;
    els.previewPanel.querySelector('span').textContent = preview.detail;
    const audio = els.previewPanel.querySelector('audio');
    if (audio) audio.src = preview.url;
    els.previewPanel.hidden = false;
  }

  function clearPreview() {
    if (state.preview && state.preview.url) URL.revokeObjectURL(state.preview.url);
    state.preview = null;
    els.previewPanel.hidden = true;
    els.previewPanel.replaceChildren();
  }

  async function sendPreview() {
    if (!state.preview) return;
    const preview = state.preview;
    const progress = els.previewPanel.querySelector('.preview-progress');
    if (progress) progress.hidden = false;
    try {
      await sendMedia(preview.kind, preview.blob, preview.meta);
      clearPreview();
    } catch (error) {
      setUploadLine(error.message);
      const actions = els.previewPanel.querySelector('.preview-actions');
      if (actions && !actions.querySelector('[data-preview-retry]')) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.dataset.previewRetry = 'true';
        retry.textContent = 'Retry';
        retry.setAttribute('aria-label', 'Retry upload');
        actions.prepend(retry);
      }
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function stopRecording() {
    if (state.recording && state.recording.recorder.state !== 'inactive') {
      state.recording.recorder.stop();
    }
  }

  function startRecordingVisualizer(recording) {
    els.recordingPanel.hidden = false;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    const source = audioContext.createMediaStreamSource(recording.stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ctx = els.recordingCanvas.getContext('2d');
    recording.audioContext = audioContext;
    recording.visualFrame = requestAnimationFrame(function draw() {
      analyser.getByteFrequencyData(data);
      drawBars(ctx, els.recordingCanvas, data);
      recording.visualFrame = requestAnimationFrame(draw);
    });
    state.recordingTimer = setInterval(() => {
      els.recordingTimer.textContent = formatDuration(Date.now() - recording.startedAt);
    }, 250);
  }

  function stopRecordingVisualizer(recording) {
    els.recordingPanel.hidden = true;
    if (recording.visualFrame) cancelAnimationFrame(recording.visualFrame);
    if (recording.audioContext) recording.audioContext.close().catch(() => {});
    clearInterval(state.recordingTimer);
    state.recordingTimer = null;
    els.recordingTimer.textContent = '00:00';
  }

  function drawBars(ctx, canvas, values) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#147c72';
    const step = Math.max(1, Math.floor(values.length / 32));
    const barWidth = canvas.width / 32 - 2;
    for (let index = 0; index < 32; index += 1) {
      const value = values[index * step] / 255;
      const height = Math.max(4, value * canvas.height);
      ctx.fillRect(index * (barWidth + 2), (canvas.height - height) / 2, barWidth, height);
    }
  }

  async function drawStaticWaveform(blob, canvas) {
    if (!canvas) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const audioContext = new AudioContext();
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const values = new Uint8Array(64);
    const block = Math.max(1, Math.floor(samples.length / values.length));
    for (let index = 0; index < values.length; index += 1) {
      let peak = 0;
      for (let offset = 0; offset < block; offset += 1) {
        peak = Math.max(peak, Math.abs(samples[index * block + offset] || 0));
      }
      values[index] = Math.min(255, Math.round(peak * 255));
    }
    drawBars(canvas.getContext('2d'), canvas, values);
    await audioContext.close();
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

  function updateKeyUi() {
    if (els.keyFingerprintOutput) {
      els.keyFingerprintOutput.textContent = state.keyFingerprint || 'Locked';
    }

    if (els.keyEpochText) {
      els.keyEpochText.textContent = `Epoch ${state.sessionEpoch || 1}`;
    }

    if (els.keyButton) {
      els.keyButton.disabled = !state.keyFingerprint;
    }
  }

  function openKeyDialog() {
    updateKeyUi();
    if (typeof els.keyDialog.showModal === 'function') {
      els.keyDialog.showModal();
    }
  }

  function shortUserAgent(value) {
    const text = String(value || 'Unknown browser').replace(/\s+/g, ' ').trim();
    return text.length > 96 ? `${text.slice(0, 93)}...` : text;
  }

  function buildSecurityItem(item, kind) {
    const row = document.createElement('li');
    row.className = 'security-item';

    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.label || (kind === 'session' ? 'Browser session' : 'Verified device');
    if (item.current) {
      const current = document.createElement('span');
      current.className = 'current-pill';
      current.textContent = 'Current';
      title.append(' ', current);
    }

    const meta = document.createElement('p');
    const seen = item.lastSeenAt ? `Last seen ${formatShortDate(item.lastSeenAt)}` : 'Not seen yet';
    meta.textContent = `${seen} - ${shortUserAgent(item.userAgent)}`;
    details.append(title, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost revoke-button';
    button.dataset.revokeKind = kind;
    button.dataset.revokeId = item.id;
    button.textContent = 'Revoke';

    row.append(details, button);
    return row;
  }

  function renderSecurityList(container, items, kind) {
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'security-empty';
      empty.textContent = 'Nothing active';
      container.append(empty);
      return;
    }

    for (const item of items) {
      container.append(buildSecurityItem(item, kind));
    }
  }

  function renderAuditLogs(logs) {
    els.auditList.replaceChildren();
    if (!logs.length) {
      const empty = document.createElement('li');
      empty.className = 'security-empty';
      empty.textContent = 'No audit events yet';
      els.auditList.append(empty);
      return;
    }

    for (const log of logs) {
      const row = document.createElement('li');
      row.className = 'audit-item';
      const title = document.createElement('strong');
      title.textContent = log.event;
      const meta = document.createElement('p');
      meta.textContent = formatShortDate(log.createdAt);
      row.append(title, meta);
      els.auditList.append(row);
    }
  }

  async function openAccountDialog() {
    setUploadLine('');
    try {
      const payload = await api('/api/account/security');
      renderProfilePanel();
      renderSecurityList(els.sessionsList, payload.sessions || [], 'session');
      renderSecurityList(els.devicesList, payload.devices || [], 'device');
      els.auditSection.hidden = !payload.canViewAudit;
      if (payload.canViewAudit) {
        renderAuditLogs(payload.auditLogs || []);
      }

      if (!els.accountDialog.open && typeof els.accountDialog.showModal === 'function') {
        els.accountDialog.showModal();
      }
    } catch (error) {
      setUploadLine(error.message);
    }
  }

  async function revokeSecurityItem(kind, id) {
    const path = kind === 'session' ? `/api/account/sessions/${encodeURIComponent(id)}` : `/api/account/devices/${encodeURIComponent(id)}`;
    const payload = await api(path, { method: 'DELETE' });

    if (payload.revokedCurrent && kind === 'session') {
      clearLocalSession();
      await refreshSetup();
      renderAuth();
      return;
    }

    await openAccountDialog();
  }

  async function init() {
    applyTheme(state.theme);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    updateModeUi();
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
  els.modeToggle.addEventListener('click', () => setMode(isPrivateMode() ? 'standard' : 'private'));
  els.contactsButton.addEventListener('click', openContacts);
  els.contactsCloseButton.addEventListener('click', closeContacts);
  els.inviteButton.addEventListener('click', createInvite);
  els.codesButton.addEventListener('click', rotateRecoveryCodes);
  els.keyButton.addEventListener('click', openKeyDialog);
  els.themeButton.addEventListener('click', toggleTheme);
  els.accountButton.addEventListener('click', openAccountDialog);
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

  els.previewPanel.addEventListener('click', (event) => {
    if (event.target.closest('[data-preview-send], [data-preview-retry]')) {
      sendPreview();
    } else if (event.target.closest('[data-preview-discard]')) {
      clearPreview();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.preview) clearPreview();
    if (!els.contactsPanel.hidden) closeContacts();
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

  els.accountDialog.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke-kind]');
    if (!button) return;

    button.disabled = true;
    try {
      await revokeSecurityItem(button.dataset.revokeKind, button.dataset.revokeId);
    } catch (error) {
      setUploadLine(error.message);
      button.disabled = false;
    }
  });

  els.viewerDialog.addEventListener('close', () => {
    els.viewerImage.removeAttribute('src');
  });

  init().catch((error) => {
    showAuthNotice(error.message);
    setView('auth');
  });
})();
