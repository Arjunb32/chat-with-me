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
const {
  isEncryptionEnvelope,
  validateAttachmentEnvelope,
  validateMessageInput
} = require('./envelope');
const { createMediaStorage } = require('./media-storage');
const {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  SESSION_DAYS,
  cleanInviteCode,
  cleanRecoveryCode,
  hashPassword,
  normalizeAvatarColor,
  normalizeDisplayName,
  passwordNeedsRehash,
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

function exactWebSocketOrigin(origin) {
  try {
    const url = new URL(origin);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function buildCspDirectives() {
  const connectSrc = ["'self'"];
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const websocketOrigin = publicOrigin && exactWebSocketOrigin(publicOrigin);

  if (publicOrigin) {
    connectSrc.push(publicOrigin);
  }

  if (websocketOrigin) {
    connectSrc.push(websocketOrigin);
  }

  if (!IS_PRODUCTION) {
    connectSrc.push('ws://localhost:*', 'ws://127.0.0.1:*');
  }

  const directives = {
    defaultSrc: ["'none'"],
    baseUri: ["'self'"],
    connectSrc,
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'none'"],
    imgSrc: ["'self'", 'blob:'],
    manifestSrc: ["'self'"],
    mediaSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    prefetchSrc: ["'none'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'"],
    workerSrc: ["'self'"]
  };

  if (IS_PRODUCTION) {
    directives.upgradeInsecureRequests = [];
  }

  if (process.env.CSP_REPORT_URI) {
    directives.reportUri = [process.env.CSP_REPORT_URI];
  }

  return directives;
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildCspDirectives(),
      reportOnly: process.env.CSP_REPORT_ONLY === 'true'
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

function clearDeviceCookie(res) {
  res.clearCookie(DEVICE_COOKIE, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/'
  });
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => {
        return value === null || ['string', 'number', 'boolean'].includes(typeof value);
      })
      .slice(0, 12)
  );
}

async function audit(req, event, { actorId = null, metadata = {} } = {}) {
  try {
    await store.addAuditLog({
      actorId,
      event,
      metadata: safeMetadata(metadata),
      ipHash: req && req.ip ? sha256(req.ip) : null,
      userAgentHash: req ? sha256(req.get('user-agent') || '') : null
    });
  } catch (error) {
    console.error('Audit log write failed:', error);
  }
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
  const session = await store.createSession({
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

  const sessionEpoch = await store.advanceCryptoEpoch();
  io.to('private-chat').emit('crypto:epoch', { sessionEpoch });
  await audit(req, 'session.created', {
    actorId: user.id,
    metadata: {
      sessionId: session.id,
      sessionEpoch
    }
  });

  return { session, sessionEpoch };
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

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return sendError(res, 403, 'Only the owner can do that.');
  }

  return next();
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

async function buildContacts(userId) {
  const contacts = await store.listContacts({ excludeUserId: userId });
  return contacts.map((contact) => ({
    ...contact,
    online: onlineUsers.has(contact.id)
  }));
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
      const mode = req.get('x-chat-mode') === 'standard' ? 'standard' : 'private';
      if (mode === 'private') {
        validateAttachmentEnvelope(req.body, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB);
      } else if (!Buffer.isBuffer(req.body) || req.body.length < 1 || req.body.length > MAX_UPLOAD_BYTES) {
        throw new Error(`File must be between 1 byte and ${MAX_UPLOAD_MB} MB.`);
      }

      const id = `att_${randomToken(12)}`;
      const filename = mediaStorage.keyForAttachment(id);
      await mediaStorage.put(filename, req.body);

      const attachment = await store.addAttachment({
        id,
        ownerId: req.user.id,
        kind: mode === 'private' ? 'encrypted' : 'photo',
        byteLength: req.body.length,
        filename
      });

      return res.status(201).json({
        attachmentId: attachment.id,
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
    res.type(attachment.kind === 'encrypted' ? 'application/json' : 'application/octet-stream');
    return res.send(body);
  } catch (error) {
    return next(error);
  }
});

app.post(
  '/api/csp-report',
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  async (req, res) => {
    await audit(req, 'security.csp_violation', {
      metadata: {
        blockedUri: req.body && (req.body['csp-report'] || req.body).blockedURI,
        violatedDirective: req.body && (req.body['csp-report'] || req.body).violatedDirective
      }
    });
    res.status(204).end();
  }
);

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
    await audit(req, 'setup.owner_created', { actorId: user.id });
    await audit(req, 'recovery_codes.rotated', { actorId: user.id });
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
    await audit(req, 'auth.signup_success', { actorId: user.id });
    await audit(req, 'recovery_codes.rotated', { actorId: user.id });
    res.status(201).json(await buildMePayload(user, { recoveryCodes }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const userRecord = await store.findUserByDisplayName(req.body.displayName);
    if (!userRecord) {
      await audit(req, 'auth.login_failed', { metadata: { reason: 'unknown_user' } });
      return sendError(res, 401, 'Display name or password is incorrect.');
    }

    const passwordOk = await verifyPassword(req.body.password, userRecord.passwordHash);
    if (!passwordOk) {
      await audit(req, 'auth.login_failed', {
        actorId: userRecord.id,
        metadata: { reason: 'bad_password' }
      });
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
        await audit(req, 'auth.login_failed', {
          actorId: user.id,
          metadata: { reason: 'recovery_required' }
        });
        return sendError(res, 403, 'Recovery code is required for this new device.');
      }
    }

    if (passwordNeedsRehash(userRecord.passwordHash)) {
      await store.updatePasswordHash({
        userId: user.id,
        passwordHash: await hashPassword(req.body.password)
      });
    }

    await createSessionAndCookies({ res, req, user });
    await audit(req, 'auth.login_success', { actorId: user.id });
    res.json(await buildMePayload(user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireAuth, async (req, res, next) => {
  try {
    await store.deleteSession(sha256(req.cookies[SESSION_COOKIE]));
    await audit(req, 'auth.logout', { actorId: req.user.id });
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

app.get('/api/account/security', requireAuth, async (req, res, next) => {
  try {
    const currentDeviceToken = req.cookies[DEVICE_COOKIE];
    const currentDeviceTokenHash = currentDeviceToken ? sha256(currentDeviceToken) : null;
    const [sessions, devices, auditLogs] = await Promise.all([
      store.listUserSessions({ userId: req.user.id, currentSessionId: req.session.id }),
      store.listVerifiedDevices({ userId: req.user.id, currentDeviceTokenHash }),
      req.user.role === 'owner' ? store.listAuditLogs({ limit: 80 }) : Promise.resolve([])
    ]);

    res.json({
      sessions,
      devices,
      auditLogs,
      canViewAudit: req.user.role === 'owner'
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/account/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await store.updateProfile({
      userId: req.user.id,
      avatarColor: normalizeAvatarColor(req.body.avatarColor)
    });
    await audit(req, 'profile.updated', { actorId: req.user.id, metadata: { field: 'avatarColor' } });
    res.json(await buildMePayload(user));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/account/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    const revoked = await store.deleteSessionById({
      userId: req.user.id,
      sessionId: req.params.id
    });
    const revokedCurrent = req.params.id === req.session.id;

    if (revoked) {
      await audit(req, 'session.revoked', {
        actorId: req.user.id,
        metadata: { sessionId: req.params.id, current: revokedCurrent }
      });
    }

    if (revokedCurrent) {
      clearSessionCookie(res);
    }

    res.json({ ok: true, revoked, revokedCurrent });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/account/devices/:id', requireAuth, async (req, res, next) => {
  try {
    const currentDeviceToken = req.cookies[DEVICE_COOKIE];
    const currentDeviceTokenHash = currentDeviceToken ? sha256(currentDeviceToken) : null;
    const devices = await store.listVerifiedDevices({ userId: req.user.id, currentDeviceTokenHash });
    const target = devices.find((device) => device.id === req.params.id);
    const revoked = await store.revokeVerifiedDevice({
      userId: req.user.id,
      deviceId: req.params.id
    });

    if (revoked) {
      await audit(req, 'device.revoked', {
        actorId: req.user.id,
        metadata: { deviceId: req.params.id, current: Boolean(target && target.current) }
      });
    }

    if (target && target.current) {
      clearDeviceCookie(res);
    }

    res.json({ ok: true, revoked: Boolean(revoked), revokedCurrent: Boolean(target && target.current) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/audit-logs', requireAuth, requireOwner, async (req, res, next) => {
  try {
    res.json({ auditLogs: await store.listAuditLogs({ limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/invites', requireAuth, async (req, res, next) => {
  try {
    const result = await store.createInvite(req.user.id);
    const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    await audit(req, 'invite.created', { actorId: req.user.id, metadata: { inviteId: result.invite.id } });
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
    await audit(req, 'recovery_codes.rotated', { actorId: req.user.id });
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

app.get('/api/contacts', requireAuth, async (req, res, next) => {
  try {
    res.json({ contacts: await buildContacts(req.user.id) });
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
    const status = await store.getStatus();
    socket.emit('crypto:epoch', { sessionEpoch: status.sessionEpoch });
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
        if (!attachment || attachment.deletedAt || attachment.ownerId !== user.id) {
          throw new Error('Attachment is invalid for this message.');
        }
      }

      const message = await store.addMessage({
        senderId: user.id,
        mode: messageInput.mode,
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

      await audit({ ip: socket.handshake.address, get: (name) => socket.handshake.headers[name.toLowerCase()] }, 'message.deleted', {
        actorId: user.id,
        metadata: { messageId }
      });
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  app,
  buildCspDirectives,
  isEncryptionEnvelope,
  server,
  validateAttachmentEnvelope,
  validateMessageInput
};
