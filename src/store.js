const fs = require('fs/promises');
const path = require('path');
const {
  cleanInviteCode,
  futureDate,
  isExpired,
  normalizeDisplayName,
  randomSalt,
  randomToken,
  sha256,
  toPublicUser
} = require('./security');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.attachmentsDir = path.join(rootDir, 'storage', 'attachments');
    this.dbPath = path.join(this.dataDir, 'db.json');
    this.db = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.attachmentsDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.dbPath, 'utf8');
      this.db = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.db = this.createDefaultDb();
      await this.save();
    }

    this.normalizeDb();
    await this.save();
  }

  createDefaultDb() {
    return {
      version: 1,
      cryptoSalt: randomSalt(),
      settings: {
        maxUsers: 2
      },
      users: [],
      sessions: [],
      verifiedDevices: [],
      recoveryCodes: [],
      invites: [],
      messages: [],
      attachments: []
    };
  }

  normalizeDb() {
    this.db.version = this.db.version || 1;
    this.db.cryptoSalt = this.db.cryptoSalt || randomSalt();
    this.db.settings = this.db.settings || { maxUsers: 2 };
    this.db.settings.maxUsers = this.db.settings.maxUsers || 2;
    this.db.users = Array.isArray(this.db.users) ? this.db.users : [];
    this.db.sessions = Array.isArray(this.db.sessions) ? this.db.sessions : [];
    this.db.verifiedDevices = Array.isArray(this.db.verifiedDevices) ? this.db.verifiedDevices : [];
    this.db.recoveryCodes = Array.isArray(this.db.recoveryCodes) ? this.db.recoveryCodes : [];
    this.db.invites = Array.isArray(this.db.invites) ? this.db.invites : [];
    this.db.messages = Array.isArray(this.db.messages) ? this.db.messages : [];
    this.db.attachments = Array.isArray(this.db.attachments) ? this.db.attachments : [];
  }

  async save() {
    const tempPath = `${this.dbPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(this.db, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.dbPath);
  }

  async transact(mutator) {
    const run = async () => {
      const result = await mutator(this.db);
      await this.save();
      return result;
    };

    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  getStatus() {
    const userCount = this.db.users.length;
    const maxUsers = this.db.settings.maxUsers;

    return {
      cryptoSalt: this.db.cryptoSalt,
      userCount,
      maxUsers,
      needsOwner: userCount === 0,
      canUseInvite: userCount > 0 && userCount < maxUsers,
      setupCodeRequired: Boolean(process.env.APP_SETUP_CODE)
    };
  }

  listPublicUsers() {
    return this.db.users.map(toPublicUser);
  }

  getUserById(userId) {
    return this.db.users.find((user) => user.id === userId) || null;
  }

  findUserByDisplayName(displayName) {
    const normalized = normalizeDisplayName(displayName);
    const key = normalized.toLocaleLowerCase();
    return this.db.users.find((user) => user.displayNameKey === key) || null;
  }

  async createOwner({ displayName, passwordHash }) {
    const normalized = normalizeDisplayName(displayName);
    return this.transact((db) => {
      if (db.users.length > 0) {
        throw new Error('The first account already exists.');
      }

      const user = {
        id: `usr_${randomToken(12)}`,
        displayName: normalized,
        displayNameKey: normalized.toLocaleLowerCase(),
        passwordHash,
        role: 'owner',
        createdAt: new Date().toISOString()
      };

      db.users.push(user);
      return toPublicUser(user);
    });
  }

  async signupWithInvite({ displayName, passwordHash, inviteCode }) {
    const normalized = normalizeDisplayName(displayName);
    const cleanedInviteCode = cleanInviteCode(inviteCode);
    const inviteHash = sha256(cleanedInviteCode);

    return this.transact((db) => {
      if (db.users.length >= db.settings.maxUsers) {
        throw new Error('This private chat already has both accounts.');
      }

      if (db.users.some((user) => user.displayNameKey === normalized.toLocaleLowerCase())) {
        throw new Error('That display name is already used.');
      }

      const invite = db.invites.find((item) => item.tokenHash === inviteHash);
      if (!invite || invite.usedAt || isExpired(invite.expiresAt)) {
        throw new Error('Invite code is invalid or expired.');
      }

      const user = {
        id: `usr_${randomToken(12)}`,
        displayName: normalized,
        displayNameKey: normalized.toLocaleLowerCase(),
        passwordHash,
        role: 'member',
        createdAt: new Date().toISOString()
      };

      invite.usedAt = new Date().toISOString();
      invite.usedBy = user.id;
      db.users.push(user);
      return toPublicUser(user);
    });
  }

  async createInvite(ownerId) {
    return this.transact((db) => {
      const owner = db.users.find((user) => user.id === ownerId && user.role === 'owner');
      if (!owner) {
        throw new Error('Only the owner can create invites.');
      }

      if (db.users.length >= db.settings.maxUsers) {
        throw new Error('Both private accounts already exist.');
      }

      const token = randomToken(32);
      const invite = {
        id: `inv_${randomToken(10)}`,
        tokenHash: sha256(token),
        createdBy: ownerId,
        createdAt: new Date().toISOString(),
        expiresAt: futureDate(INVITE_TTL_MS),
        usedAt: null,
        usedBy: null
      };

      db.invites.push(invite);
      return {
        token,
        invite: {
          id: invite.id,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt
        }
      };
    });
  }

  async createSession({ userId, tokenHash, userAgent, ip }) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      db.sessions = db.sessions.filter((session) => !isExpired(session.expiresAt));
      const session = {
        id: `ses_${randomToken(12)}`,
        userId,
        tokenHash,
        userAgent: String(userAgent || '').slice(0, 300),
        ip: String(ip || '').slice(0, 80),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: futureDate(SESSION_TTL_MS)
      };

      db.sessions.push(session);
      return session;
    });
  }

  async createVerifiedDevice({ userId, tokenHash, label, userAgent, ip }) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const device = {
        id: `dev_${randomToken(12)}`,
        userId,
        tokenHash,
        label: String(label || 'Verified device').slice(0, 80),
        userAgent: String(userAgent || '').slice(0, 300),
        ip: String(ip || '').slice(0, 80),
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null
      };

      db.verifiedDevices.push(device);
      return { ...device };
    });
  }

  async findVerifiedDevice({ userId, tokenHash }) {
    return this.transact((db) => {
      const device = db.verifiedDevices.find((item) => {
        return item.userId === userId && item.tokenHash === tokenHash && !item.revokedAt;
      });

      if (!device) return null;
      device.lastSeenAt = new Date().toISOString();
      return { ...device };
    });
  }

  async hasActiveRecoveryCodes(userId) {
    return this.db.recoveryCodes.some((code) => code.userId === userId && !code.usedAt);
  }

  async rotateRecoveryCodes(userId) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const plainCodes = [];

      db.recoveryCodes = db.recoveryCodes.filter((code) => code.userId !== userId || code.usedAt);

      for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
        const code = `${randomToken(5)}-${randomToken(5)}`.toUpperCase();
        plainCodes.push(code);
        db.recoveryCodes.push({
          id: `rcv_${randomToken(10)}`,
          userId,
          codeHash: sha256(code),
          createdAt: now,
          usedAt: null
        });
      }

      return plainCodes;
    });
  }

  async verifyRecoveryCode({ userId, recoveryCode }) {
    const codeHash = sha256(String(recoveryCode || '').trim().toUpperCase());

    return this.transact((db) => {
      const code = db.recoveryCodes.find((item) => {
        return item.userId === userId && item.codeHash === codeHash && !item.usedAt;
      });

      if (!code) return false;
      code.usedAt = new Date().toISOString();
      return true;
    });
  }

  async findSessionByTokenHash(tokenHash) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      let changed = false;

      db.sessions = db.sessions.filter((session) => {
        const keep = !isExpired(session.expiresAt);
        if (!keep) changed = true;
        return keep;
      });

      const session = db.sessions.find((item) => item.tokenHash === tokenHash) || null;
      if (!session) return null;

      session.lastSeenAt = now;
      changed = true;
      const user = db.users.find((item) => item.id === session.userId) || null;
      if (!user) return null;

      return {
        session,
        user: toPublicUser(user)
      };
    });
  }

  async deleteSession(tokenHash) {
    return this.transact((db) => {
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((session) => session.tokenHash !== tokenHash);
      return before !== db.sessions.length;
    });
  }

  async addAttachment({ id, ownerId, kind, byteLength, filename }) {
    return this.transact((db) => {
      const attachment = {
        id,
        ownerId,
        kind,
        byteLength,
        filename,
        createdAt: new Date().toISOString(),
        deletedAt: null
      };

      db.attachments.push(attachment);
      return { ...attachment };
    });
  }

  getAttachment(attachmentId) {
    return this.db.attachments.find((attachment) => attachment.id === attachmentId) || null;
  }

  getAttachmentPath(attachment) {
    return path.join(this.attachmentsDir, attachment.filename);
  }

  async removeAttachmentFile(attachment) {
    if (!attachment) return;
    try {
      await fs.unlink(this.getAttachmentPath(attachment));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async addMessage({ senderId, type, payload, attachmentId, expiresAt, deliveredTo = [] }) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const deliveredBy = {
        [senderId]: now
      };

      for (const userId of deliveredTo) {
        deliveredBy[userId] = now;
      }

      const message = {
        id: `msg_${randomToken(12)}`,
        senderId,
        type,
        payload,
        attachmentId: attachmentId || null,
        createdAt: now,
        expiresAt: expiresAt || null,
        deletedAt: null,
        deliveredBy,
        readBy: {}
      };

      db.messages.push(message);
      return this.publicMessage(message);
    });
  }

  publicMessage(message) {
    return {
      id: message.id,
      senderId: message.senderId,
      type: message.type,
      payload: message.deletedAt ? null : message.payload,
      attachmentId: message.deletedAt ? null : message.attachmentId,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      deletedAt: message.deletedAt,
      deliveredBy: message.deliveredBy || {},
      readBy: message.readBy || {}
    };
  }

  async purgeExpiredMessages() {
    return this.transact((db) => {
      const now = Date.now();
      const changedMessages = [];
      const deletedAttachments = [];

      for (const message of db.messages) {
        if (message.deletedAt || !message.expiresAt || Date.parse(message.expiresAt) > now) {
          continue;
        }

        message.deletedAt = new Date().toISOString();
        message.payload = null;

        if (message.attachmentId) {
          const attachment = db.attachments.find((item) => item.id === message.attachmentId);
          if (attachment && !attachment.deletedAt) {
            attachment.deletedAt = message.deletedAt;
            deletedAttachments.push({ ...attachment });
          }
        }

        message.attachmentId = null;
        changedMessages.push(this.publicMessage(message));
      }

      return { changedMessages, deletedAttachments };
    });
  }

  async listMessages({ limit = 50, before }) {
    const cursorTime = before ? Date.parse(before) : null;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const filtered = this.db.messages
      .filter((message) => !cursorTime || Date.parse(message.createdAt) < cursorTime)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    return filtered.slice(-safeLimit).map((message) => this.publicMessage(message));
  }

  async markDeliveredForUser(userId) {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const statuses = [];

      for (const message of db.messages) {
        if (message.deletedAt || message.senderId === userId) continue;
        message.deliveredBy = message.deliveredBy || {};
        if (!message.deliveredBy[userId]) {
          message.deliveredBy[userId] = now;
          statuses.push(this.publicMessage(message));
        }
      }

      return statuses;
    });
  }

  async markRead({ userId, messageIds }) {
    const idSet = new Set(messageIds);

    return this.transact((db) => {
      const now = new Date().toISOString();
      const statuses = [];

      for (const message of db.messages) {
        if (!idSet.has(message.id) || message.deletedAt || message.senderId === userId) {
          continue;
        }

        message.deliveredBy = message.deliveredBy || {};
        message.readBy = message.readBy || {};
        message.deliveredBy[userId] = message.deliveredBy[userId] || now;

        if (!message.readBy[userId]) {
          message.readBy[userId] = now;
          statuses.push(this.publicMessage(message));
        }
      }

      return statuses;
    });
  }

  async deleteMessage({ messageId, userId }) {
    return this.transact((db) => {
      const message = db.messages.find((item) => item.id === messageId);
      if (!message) {
        throw new Error('Message not found.');
      }

      const actor = db.users.find((user) => user.id === userId);
      if (!actor || (actor.role !== 'owner' && message.senderId !== userId)) {
        throw new Error('You can only delete your own messages.');
      }

      if (message.deletedAt) {
        return { message: this.publicMessage(message), deletedAttachment: null };
      }

      const deletedAt = new Date().toISOString();
      let deletedAttachment = null;

      if (message.attachmentId) {
        const attachment = db.attachments.find((item) => item.id === message.attachmentId);
        if (attachment && !attachment.deletedAt) {
          attachment.deletedAt = deletedAt;
          deletedAttachment = { ...attachment };
        }
      }

      message.deletedAt = deletedAt;
      message.payload = null;
      message.attachmentId = null;

      return {
        message: this.publicMessage(message),
        deletedAttachment
      };
    });
  }
}

module.exports = Store;
