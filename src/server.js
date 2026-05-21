require('dotenv').config({ quiet: true });

const http = require('http');
const path = require('path');
const cookie = require('cookie');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Server } = require('socket.io');

const JsonStore = require('./store');
const PostgresStore = require('./postgres-store');
const { createMediaStorage } = require('./media-storage');
const {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  SESSION_DAYS,
  cleanInviteCode,
  cleanRecoveryCode,
  hashPassword,
  normalizeDisplayName,
  randomToken,
  sha256,
  validatePassword,
  verifyPassword
} = require('./security');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = Number(process.env.PORT || 5177);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 12);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const store = process.env.STORE_DRIVER === 'postgres' ? new PostgresStore() : new JsonStore(ROOT_DIR);
const mediaStorage = createMediaStorage(ROOT_DIR);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 256 * 1024,
  serveClient: true
});

const onlineUsers = new Map();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    }
  })
);
app.use(compression());
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 80,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again later.' }
});

app.use('/api', apiLimiter);

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

function setDeviceCookie(res, token) {
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/'
  });
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

async function sessionFromToken(token) {
  if (!token) return null;
  return store.findSessionByTokenHash(sha256(token));
}

async function isDeviceVerified(req, userId) {
  const token = req.cookies[DEVICE_COOKIE];
  if (!token) return false;
  const device = await store.findVerifiedDevice({
    userId,
    tokenHash: sha256(token)
  });
  return Boolean(device);
}

async function createSessionAndCookies({ res, req, user }) {
  const sessionToken = randomToken(32);
  await store.createSession({
    userId: user.id,
    tokenHash: sha256(sessionToken),
    userAgent: req.get('user-agent'),
    ip: req.ip
  });
  setSessionCookie(res, sessionToken);

  const deviceToken = randomToken(32);
  await store.createVerifiedDevice({
    userId: user.id,
    tokenHash: sha256(deviceToken),
    label: 'Browser',
    userAgent: req.get('user-agent'),
    ip: req.ip
  });
  setDeviceCookie(res, deviceToken);
}

async function requireAuth(req, res, next) {
  try {
    const session = await sessionFromToken(req.cookies[SESSION_COOKIE]);
    if (!session) {
      return sendError(res, 401, 'Sign in required.');
    }

    req.user = session.user;
    req.session = session.session;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function buildMePayload(user, extras = {}) {
  const status = await store.getStatus();
  const people = await store.listPublicUsers();
  return {
    me: user,
    people,
    cryptoSalt: status.cryptoSalt,
    maxUploadMb: MAX_UPLOAD_MB,
    ...extras
  };
}

function isEncryptionEnvelope(value, maxCiphertextChars = 80_000) {
  return Boolean(
    value &&
      value.v === 1 &&
      value.alg === 'AES-GCM' &&
      typeof value.iv === 'string' &&
      value.iv.length >= 12 &&
      value.iv.length <= 64 &&
      typeof value.ciphertext === 'string' &&
      value.ciphertext.length > 0 &&
      value.ciphertext.length <= maxCiphertextChars
  );
}

function validateMessageInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid message.');
  }

  if (!['text', 'photo', 'voice'].includes(input.type)) {
    throw new Error('Unsupported message type.');
  }

  if (!isEncryptionEnvelope(input.payload)) {
    throw new Error('Invalid encrypted payload.');
  }

  if ((input.type === 'photo' || input.type === 'voice') && typeof input.attachmentId !== 'string') {
    throw new Error('Media message needs an attachment.');
  }

  const expiresInMs = Number(input.expiresInMs || 0);
  if (expiresInMs < 0 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Invalid expiration.');
  }

  return {
    type: input.type,
    payload: input.payload,
    attachmentId: input.attachmentId || null,
    expiresAt: expiresInMs ? new Date(Date.now() + expiresInMs).toISOString() : null
  };
}

function validateAttachmentEnvelope(rawBody) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length < 32 || rawBody.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Encrypted file must be between 32 bytes and ${MAX_UPLOAD_MB} MB.`);
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('Encrypted file envelope is invalid.');
  }

  if (!isEncryptionEnvelope(envelope, MAX_UPLOAD_BYTES * 2)) {
    throw new Error('Encrypted file envelope is invalid.');
  }
}

function onlineUserIdsExcept(userId) {
  return [...onlineUsers.keys()].filter((id) => id !== userId);
}

function addOnlineUser(userId, socketId) {
  const sockets = onlineUsers.get(userId) || new Set();
  sockets.add(socketId);
  onlineUsers.set(userId, sockets);
}

function removeOnlineUser(userId, socketId) {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    onlineUsers.delete(userId);
  }
}

function emitPresence() {
  io.to('private-chat').emit('presence:update', {
    onlineUserIds: [...onlineUsers.keys()]
  });
}

async function deleteAttachmentFiles(attachments) {
  for (const attachment of attachments) {
    await mediaStorage.remove(attachment.filename);
  }
}

async function purgeExpiredAndNotify() {
  const result = await store.purgeExpiredMessages();
  if (result.deletedAttachments.length) {
    await deleteAttachmentFiles(result.deletedAttachments);
  }

  if (result.changedMessages.length) {
    io.to('private-chat').emit('messages:expired', {
      messages: result.changedMessages
    });
  }
}

app.post(
  '/api/attachments',
  requireAuth,
  uploadLimiter,
  express.raw({ type: '*/*', limit: `${MAX_UPLOAD_MB}mb` }),
  async (req, res, next) => {
    try {
      const kind = String(req.get('x-attachment-kind') || '').toLowerCase();
      if (!['photo', 'voice'].includes(kind)) {
        return sendError(res, 400, 'Unsupported attachment type.');
      }

      validateAttachmentEnvelope(req.body);

      const id = `att_${randomToken(12)}`;
      const filename = mediaStorage.keyForAttachment(id);
      await mediaStorage.put(filename, req.body);

      const attachment = await store.addAttachment({
        id,
        ownerId: req.user.id,
        kind,
        byteLength: req.body.length,
        filename
      });

      return res.status(201).json({
        attachmentId: attachment.id,
        kind: attachment.kind,
        byteLength: attachment.byteLength
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.get('/api/attachments/:id/blob', requireAuth, async (req, res, next) => {
  try {
    const attachment = await store.getAttachment(req.params.id);
    if (!attachment || attachment.deletedAt) {
      return sendError(res, 404, 'Attachment not found.');
    }

    const body = await mediaStorage.get(attachment.filename);
    res.type('application/json');
    return res.send(body);
  } catch (error) {
    return next(error);
  }
});

app.use(express.json({ limit: '128kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/setup/status', async (_req, res, next) => {
  try {
    res.json({
      ...(await store.getStatus()),
      maxUploadMb: MAX_UPLOAD_MB
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/setup/owner', authLimiter, async (req, res, next) => {
  try {
    if (process.env.APP_SETUP_CODE && req.body.setupCode !== process.env.APP_SETUP_CODE) {
      return sendError(res, 403, 'Setup code is invalid.');
    }

    const displayName = normalizeDisplayName(req.body.displayName);
    validatePassword(req.body.password);
    const passwordHash = await hashPassword(req.body.password);
    const user = await store.createOwner({ displayName, passwordHash });
    const recoveryCodes = await store.rotateRecoveryCodes(user.id);

    await createSessionAndCookies({ res, req, user });
    res.status(201).json(await buildMePayload(user, { recoveryCodes }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/signup', authLimiter, async (req, res, next) => {
  try {
    const displayName = normalizeDisplayName(req.body.displayName);
    validatePassword(req.body.password);
    const inviteCode = cleanInviteCode(req.body.inviteCode);
    const passwordHash = await hashPassword(req.body.password);
    const user = await store.signupWithInvite({ displayName, passwordHash, inviteCode });
    const recoveryCodes = await store.rotateRecoveryCodes(user.id);

    await createSessionAndCookies({ res, req, user });
    res.status(201).json(await buildMePayload(user, { recoveryCodes }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const userRecord = await store.findUserByDisplayName(req.body.displayName);
    if (!userRecord) {
      return sendError(res, 401, 'Display name or password is incorrect.');
    }

    const passwordOk = await verifyPassword(req.body.password, userRecord.passwordHash);
    if (!passwordOk) {
      return sendError(res, 401, 'Display name or password is incorrect.');
    }

    const user = {
      id: userRecord.id,
      displayName: userRecord.displayName,
      role: userRecord.role,
      createdAt: userRecord.createdAt
    };
    const verifiedDevice = await isDeviceVerified(req, user.id);
    const hasRecoveryCodes = await store.hasActiveRecoveryCodes(user.id);

    if (!verifiedDevice && hasRecoveryCodes) {
      const recoveryOk = await store.verifyRecoveryCode({
        userId: user.id,
        recoveryCode: cleanRecoveryCode(req.body.recoveryCode)
      });

      if (!recoveryOk) {
        return sendError(res, 403, 'Recovery code is required for this new device.');
      }
    }

    await createSessionAndCookies({ res, req, user });
    res.json(await buildMePayload(user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireAuth, async (req, res, next) => {
  try {
    await store.deleteSession(sha256(req.cookies[SESSION_COOKIE]));
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    res.json(await buildMePayload(req.user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/invites', requireAuth, async (req, res, next) => {
  try {
    const result = await store.createInvite(req.user.id);
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      inviteCode: result.token,
      inviteUrl: `${origin}/?invite=${encodeURIComponent(result.token)}`,
      expiresAt: result.invite.expiresAt
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/recovery-codes', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const recoveryCodes = await store.rotateRecoveryCodes(req.user.id);
    res.status(201).json({ recoveryCodes });
  } catch (error) {
    next(error);
  }
});

app.get('/api/messages', requireAuth, async (req, res, next) => {
  try {
    await purgeExpiredAndNotify();
    const messages = await store.listMessages({
      limit: req.query.limit,
      before: req.query.before
    });

    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

io.use(async (socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const session = await sessionFromToken(cookies[SESSION_COOKIE]);
    if (!session) {
      return next(new Error('Sign in required.'));
    }

    socket.user = session.user;
    return next();
  } catch (error) {
    return next(error);
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  socket.join('private-chat');
  addOnlineUser(user.id, socket.id);
  emitPresence();

  try {
    const statuses = await store.markDeliveredForUser(user.id);
    if (statuses.length) {
      io.to('private-chat').emit('message:status', { messages: statuses });
    }
  } catch (error) {
    socket.emit('app:error', { error: error.message });
  }

  socket.on('message:send', async (input, ack) => {
    try {
      const messageInput = validateMessageInput(input);

      if (messageInput.attachmentId) {
        const attachment = await store.getAttachment(messageInput.attachmentId);
        if (!attachment || attachment.deletedAt || attachment.ownerId !== user.id || attachment.kind !== messageInput.type) {
          throw new Error('Attachment is invalid for this message.');
        }
      }

      const message = await store.addMessage({
        senderId: user.id,
        type: messageInput.type,
        payload: messageInput.payload,
        attachmentId: messageInput.attachmentId,
        expiresAt: messageInput.expiresAt,
        deliveredTo: onlineUserIdsExcept(user.id)
      });

      io.to('private-chat').emit('message:new', message);
      if (typeof ack === 'function') ack({ ok: true, message });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('message:read', async (input, ack) => {
    try {
      const messageIds = Array.isArray(input && input.messageIds)
        ? input.messageIds.filter((id) => typeof id === 'string').slice(0, 100)
        : [];
      const messages = await store.markRead({ userId: user.id, messageIds });

      if (messages.length) {
        io.to('private-chat').emit('message:status', { messages });
      }

      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('message:delete', async (input, ack) => {
    try {
      const messageId = input && input.messageId;
      if (typeof messageId !== 'string') {
        throw new Error('Message not found.');
      }

      const result = await store.deleteMessage({ messageId, userId: user.id });
      if (result.deletedAttachment) {
        await mediaStorage.remove(result.deletedAttachment.filename);
      }

      io.to('private-chat').emit('message:deleted', result.message);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('typing', (input) => {
    socket.broadcast.to('private-chat').emit('typing', {
      userId: user.id,
      displayName: user.displayName,
      isTyping: Boolean(input && input.isTyping)
    });
  });

  socket.on('disconnect', () => {
    removeOnlineUser(user.id, socket.id);
    emitPresence();
  });
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: IS_PRODUCTION ? '1h' : 0
  })
);

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  return next();
});

app.use((error, _req, res, _next) => {
  if (error.type === 'entity.too.large') {
    return sendError(res, 413, `Upload is too large. Limit is ${MAX_UPLOAD_MB} MB.`);
  }

  const message = error.message || 'Something went wrong.';
  const status = /invalid|required|must|unsupported|expired|not found/i.test(message) ? 400 : 500;
  return sendError(res, status, message);
});

async function main() {
  await store.init();
  await mediaStorage.init();
  await purgeExpiredAndNotify();

  const interval = setInterval(() => {
    purgeExpiredAndNotify().catch((error) => {
      console.error('Expired message cleanup failed:', error);
    });
  }, 60 * 1000);
  interval.unref();

  server.listen(PORT, () => {
    console.log(`Chat With Me is running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
