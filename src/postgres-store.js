const { Pool } = require('pg');
const {
  cleanInviteCode,
  futureDate,
  isExpired,
  normalizeAvatarColor,
  normalizeDisplayName,
  randomSalt,
  randomToken,
  sha256,
  toPublicUser
} = require('./security');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;

function maybeSsl() {
  const mode = String(process.env.PGSSLMODE || '').toLowerCase();
  if (process.env.PGSSL === 'true' || mode === 'require') {
    return { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' };
  }

  return undefined;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    displayNameKey: row.display_name_key,
    avatarColor: row.avatar_color || '#147c72',
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: iso(row.created_at)
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    expiresAt: iso(row.expires_at)
  };
}

function rowToAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    byteLength: Number(row.byte_length || 0),
    filename: row.storage_key,
    createdAt: iso(row.created_at),
    deletedAt: iso(row.deleted_at)
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    mode: row.mode || 'private',
    type: row.type,
    payload: row.payload,
    attachmentId: row.attachment_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    deletedAt: iso(row.deleted_at),
    deliveredBy: row.delivered_by || {},
    readBy: row.read_by || {}
  };
}

class PostgresStore {
  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when STORE_DRIVER=postgres.');
    }

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: maybeSsl()
    });
  }

  async init() {
    await this.migrate();
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        display_name_key TEXT NOT NULL UNIQUE,
        avatar_color TEXT NOT NULL DEFAULT '#147c72',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verified_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        user_agent TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        used_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        used_by TEXT REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('encrypted', 'photo', 'voice')),
        byte_length BIGINT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'private' CHECK (mode IN ('standard', 'private')),
        type TEXT NOT NULL CHECK (type IN ('sealed', 'text', 'photo', 'voice')),
        payload JSONB,
        attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        delivered_by JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_by JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        event TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_hash TEXT,
        user_agent_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_deleted_at ON attachments(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    `);

    await this.pool.query(`
      ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
      ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('encrypted', 'photo', 'voice'));
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
      ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('sealed', 'text', 'photo', 'voice'));
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_mode_check;
      ALTER TABLE messages ADD CONSTRAINT messages_mode_check CHECK (mode IN ('standard', 'private'));
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT NOT NULL DEFAULT '#147c72';
    `);

    await this.pool.query(
      `
        INSERT INTO app_settings (key, value)
        VALUES ('main', $1::jsonb)
        ON CONFLICT (key) DO NOTHING
      `,
      [JSON.stringify({ cryptoSalt: randomSalt(), maxUsers: 2, cryptoEpoch: 1 })]
    );

    await this.pool.query(`
      UPDATE app_settings
      SET value = jsonb_set(value, '{cryptoEpoch}', COALESCE(value -> 'cryptoEpoch', '1'::jsonb), true)
      WHERE key = 'main'
    `);
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(54042077)');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSettings(client = this.pool) {
    const { rows } = await client.query("SELECT value FROM app_settings WHERE key = 'main'");
    return {
      cryptoEpoch: 1,
      maxUsers: 2,
      ...rows[0].value
    };
  }

  async getStatus() {
    const settings = await this.getSettings();
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS count FROM users');
    const userCount = rows[0].count;
    const maxUsers = Number(settings.maxUsers || 2);

    return {
      cryptoSalt: settings.cryptoSalt,
      sessionEpoch: Number(settings.cryptoEpoch || 1),
      userCount,
      maxUsers,
      needsOwner: userCount === 0,
      canUseInvite: userCount > 0 && userCount < maxUsers,
      setupCodeRequired: Boolean(process.env.APP_SETUP_CODE)
    };
  }

  async listPublicUsers() {
    const { rows } = await this.pool.query('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map((row) => toPublicUser(rowToUser(row)));
  }

  async listContacts({ excludeUserId } = {}) {
    const { rows } = await this.pool.query(
      `
        SELECT
          users.id,
          users.display_name,
          users.display_name_key,
          users.avatar_color,
          users.created_at,
          MAX(sessions.last_seen_at) AS last_seen_at
        FROM users
        LEFT JOIN sessions ON sessions.user_id = users.id AND sessions.expires_at > now()
        WHERE users.id <> $1
        GROUP BY users.id
        ORDER BY users.display_name ASC
      `,
      [excludeUserId]
    );
    return rows.map((row) => ({
      id: row.id,
      username: row.display_name_key || row.display_name,
      displayName: row.display_name,
      avatarColor: row.avatar_color || '#147c72',
      lastSeenAt: iso(row.last_seen_at || row.created_at)
    }));
  }

  async advanceCryptoEpoch() {
    return this.withTransaction(async (client) => {
      const settings = await this.getSettings(client);
      const nextEpoch = Number(settings.cryptoEpoch || 1) + 1;
      await client.query(
        `
          UPDATE app_settings
          SET value = jsonb_set(value, '{cryptoEpoch}', $1::jsonb, true)
          WHERE key = 'main'
        `,
        [JSON.stringify(nextEpoch)]
      );
      return nextEpoch;
    });
  }

  publicAuditLog(row) {
    return {
      id: row.id,
      actorId: row.actor_id || null,
      event: row.event,
      metadata: row.metadata || {},
      ipHash: row.ip_hash || null,
      userAgentHash: row.user_agent_hash || null,
      createdAt: iso(row.created_at)
    };
  }

  async addAuditLog({ actorId = null, event, metadata = {}, ipHash = null, userAgentHash = null }) {
    const { rows } = await this.pool.query(
      `
        INSERT INTO audit_logs (id, actor_id, event, metadata, ip_hash, user_agent_hash)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        RETURNING *
      `,
      [
        `aud_${randomToken(12)}`,
        actorId,
        String(event || 'unknown').slice(0, 120),
        JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
        ipHash,
        userAgentHash
      ]
    );

    return this.publicAuditLog(rows[0]);
  }

  async listAuditLogs({ limit = 80 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 80, 200));
    const { rows } = await this.pool.query(
      `
        SELECT *
        FROM audit_logs
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows.map((row) => this.publicAuditLog(row));
  }

  async getUserById(userId) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return rowToUser(rows[0]);
  }

  async findUserByDisplayName(displayName) {
    const normalized = normalizeDisplayName(displayName);
    const { rows } = await this.pool.query('SELECT * FROM users WHERE display_name_key = $1', [
      normalized.toLocaleLowerCase()
    ]);
    return rowToUser(rows[0]);
  }

  async createOwner({ displayName, passwordHash }) {
    const normalized = normalizeDisplayName(displayName);
    return this.withTransaction(async (client) => {
      const count = await client.query('SELECT COUNT(*)::int AS count FROM users');
      if (count.rows[0].count > 0) {
        throw new Error('The first account already exists.');
      }

      const user = {
        id: `usr_${randomToken(12)}`,
        displayName: normalized,
        displayNameKey: normalized.toLocaleLowerCase(),
        avatarColor: '#147c72',
        passwordHash,
        role: 'owner'
      };

      const { rows } = await client.query(
        `
          INSERT INTO users (id, display_name, display_name_key, avatar_color, password_hash, role)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [user.id, user.displayName, user.displayNameKey, user.avatarColor, user.passwordHash, user.role]
      );

      return toPublicUser(rowToUser(rows[0]));
    });
  }

  async signupWithInvite({ displayName, passwordHash, inviteCode }) {
    const normalized = normalizeDisplayName(displayName);
    const cleanedInviteCode = cleanInviteCode(inviteCode);
    const inviteHash = sha256(cleanedInviteCode);

    return this.withTransaction(async (client) => {
      const settings = await this.getSettings(client);
      const count = await client.query('SELECT COUNT(*)::int AS count FROM users');
      if (count.rows[0].count >= Number(settings.maxUsers || 2)) {
        throw new Error('This private chat already has both accounts.');
      }

      const existing = await client.query('SELECT id FROM users WHERE display_name_key = $1', [
        normalized.toLocaleLowerCase()
      ]);
      if (existing.rows.length) {
        throw new Error('That display name is already used.');
      }

      const inviteResult = await client.query(
        'SELECT * FROM invites WHERE token_hash = $1 AND used_at IS NULL',
        [inviteHash]
      );
      const invite = inviteResult.rows[0];
      if (!invite || isExpired(iso(invite.expires_at))) {
        throw new Error('Invite code is invalid or expired.');
      }

      const user = {
        id: `usr_${randomToken(12)}`,
        displayName: normalized,
        displayNameKey: normalized.toLocaleLowerCase(),
        avatarColor: '#f35f4c',
        passwordHash,
        role: 'member'
      };

      const { rows } = await client.query(
        `
          INSERT INTO users (id, display_name, display_name_key, avatar_color, password_hash, role)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [user.id, user.displayName, user.displayNameKey, user.avatarColor, user.passwordHash, user.role]
      );

      await client.query('UPDATE invites SET used_at = now(), used_by = $1 WHERE id = $2', [
        user.id,
        invite.id
      ]);

      return toPublicUser(rowToUser(rows[0]));
    });
  }

  async createInvite(ownerId) {
    return this.withTransaction(async (client) => {
      const owner = await client.query("SELECT id FROM users WHERE id = $1 AND role = 'owner'", [ownerId]);
      if (!owner.rows.length) {
        throw new Error('Only the owner can create invites.');
      }

      const settings = await this.getSettings(client);
      const count = await client.query('SELECT COUNT(*)::int AS count FROM users');
      if (count.rows[0].count >= Number(settings.maxUsers || 2)) {
        throw new Error('Both private accounts already exist.');
      }

      const token = randomToken(32);
      const invite = {
        id: `inv_${randomToken(10)}`,
        tokenHash: sha256(token),
        expiresAt: futureDate(INVITE_TTL_MS)
      };

      const { rows } = await client.query(
        `
          INSERT INTO invites (id, token_hash, created_by, expires_at)
          VALUES ($1, $2, $3, $4)
          RETURNING id, created_at, expires_at
        `,
        [invite.id, invite.tokenHash, ownerId, invite.expiresAt]
      );

      return {
        token,
        invite: {
          id: rows[0].id,
          createdAt: iso(rows[0].created_at),
          expiresAt: iso(rows[0].expires_at)
        }
      };
    });
  }

  async createSession({ userId, tokenHash, userAgent, ip }) {
    const expiresAt = futureDate(SESSION_TTL_MS);
    const { rows } = await this.pool.query(
      `
        INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        `ses_${randomToken(12)}`,
        userId,
        tokenHash,
        String(userAgent || '').slice(0, 300),
        String(ip || '').slice(0, 80),
        expiresAt
      ]
    );

    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    return rowToSession(rows[0]);
  }

  publicSession(session, currentSessionId) {
    return {
      id: session.id,
      userAgent: session.userAgent || '',
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      current: session.id === currentSessionId
    };
  }

  async listUserSessions({ userId, currentSessionId }) {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    const { rows } = await this.pool.query(
      `
        SELECT *
        FROM sessions
        WHERE user_id = $1
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      [userId]
    );
    return rows.map((row) => this.publicSession(rowToSession(row), currentSessionId));
  }

  async deleteSessionById({ userId, sessionId }) {
    const result = await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, sessionId]);
    return result.rowCount > 0;
  }

  async createVerifiedDevice({ userId, tokenHash, label, userAgent, ip }) {
    const { rows } = await this.pool.query(
      `
        INSERT INTO verified_devices (id, user_id, token_hash, label, user_agent, ip)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        `dev_${randomToken(12)}`,
        userId,
        tokenHash,
        String(label || 'Verified device').slice(0, 80),
        String(userAgent || '').slice(0, 300),
        String(ip || '').slice(0, 80)
      ]
    );

    return rows[0];
  }

  async findVerifiedDevice({ userId, tokenHash }) {
    const { rows } = await this.pool.query(
      `
        UPDATE verified_devices
        SET last_seen_at = now()
        WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL
        RETURNING *
      `,
      [userId, tokenHash]
    );

    return rows[0] || null;
  }

  publicDevice(device, currentDeviceTokenHash) {
    return {
      id: device.id,
      label: device.label || 'Verified device',
      userAgent: device.userAgent || '',
      createdAt: iso(device.created_at || device.createdAt),
      lastSeenAt: iso(device.last_seen_at || device.lastSeenAt),
      revokedAt: iso(device.revoked_at || device.revokedAt),
      current: Boolean(currentDeviceTokenHash && (device.token_hash || device.tokenHash) === currentDeviceTokenHash)
    };
  }

  async listVerifiedDevices({ userId, currentDeviceTokenHash }) {
    const { rows } = await this.pool.query(
      `
        SELECT *
        FROM verified_devices
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      [userId]
    );
    return rows.map((row) => this.publicDevice(row, currentDeviceTokenHash));
  }

  async revokeVerifiedDevice({ userId, deviceId }) {
    const { rows } = await this.pool.query(
      `
        UPDATE verified_devices
        SET revoked_at = now()
        WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING *
      `,
      [userId, deviceId]
    );

    return rows[0] ? this.publicDevice(rows[0]) : null;
  }

  async updatePasswordHash({ userId, passwordHash }) {
    const result = await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    return result.rowCount > 0;
  }

  async updateProfile({ userId, avatarColor }) {
    const normalizedColor = normalizeAvatarColor(avatarColor);
    const { rows } = await this.pool.query(
      'UPDATE users SET avatar_color = $1 WHERE id = $2 RETURNING *',
      [normalizedColor, userId]
    );

    if (!rows[0]) {
      throw new Error('User not found.');
    }

    return toPublicUser(rowToUser(rows[0]));
  }

  async hasActiveRecoveryCodes(userId) {
    const { rows } = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [userId]
    );
    return rows[0].count > 0;
  }

  async rotateRecoveryCodes(userId) {
    return this.withTransaction(async (client) => {
      await client.query('DELETE FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
      const plainCodes = [];

      for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
        const code = `${randomToken(5)}-${randomToken(5)}`.toUpperCase();
        plainCodes.push(code);
        await client.query(
          `
            INSERT INTO recovery_codes (id, user_id, code_hash)
            VALUES ($1, $2, $3)
          `,
          [`rcv_${randomToken(10)}`, userId, sha256(code)]
        );
      }

      return plainCodes;
    });
  }

  async verifyRecoveryCode({ userId, recoveryCode }) {
    const codeHash = sha256(String(recoveryCode || '').trim().toUpperCase());
    const { rows } = await this.pool.query(
      `
        UPDATE recovery_codes
        SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING id
      `,
      [userId, codeHash]
    );

    return rows.length > 0;
  }

  async findSessionByTokenHash(tokenHash) {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    const { rows } = await this.pool.query(
      `
        SELECT
          sessions.*,
          users.id AS user_row_id,
          users.display_name,
          users.display_name_key,
          users.password_hash,
          users.role,
          users.created_at AS user_created_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1
      `,
      [tokenHash]
    );

    const row = rows[0];
    if (!row) return null;

    await this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);

    return {
      session: rowToSession(row),
      user: toPublicUser(
        rowToUser({
          id: row.user_row_id,
          display_name: row.display_name,
          display_name_key: row.display_name_key,
          password_hash: row.password_hash,
          role: row.role,
          created_at: row.user_created_at
        })
      )
    };
  }

  async deleteSession(tokenHash) {
    const result = await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return result.rowCount > 0;
  }

  async addAttachment({ id, ownerId, kind = 'encrypted', byteLength, filename }) {
    const { rows } = await this.pool.query(
      `
        INSERT INTO attachments (id, owner_id, kind, byte_length, storage_key)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [id, ownerId, String(kind || 'encrypted').slice(0, 40), byteLength, filename]
    );

    return rowToAttachment(rows[0]);
  }

  async getAttachment(attachmentId) {
    const { rows } = await this.pool.query('SELECT * FROM attachments WHERE id = $1', [attachmentId]);
    return rowToAttachment(rows[0]);
  }

  publicMessage(message) {
    return {
      id: message.id,
      senderId: message.senderId,
      mode: message.mode || 'private',
      payload: message.deletedAt ? null : message.payload,
      attachmentId: message.deletedAt ? null : message.attachmentId,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      deletedAt: message.deletedAt,
      deliveredBy: message.deliveredBy || {},
      readBy: message.readBy || {}
    };
  }

  async addMessage({ senderId, mode = 'private', payload, attachmentId, expiresAt, deliveredTo = [] }) {
    const deliveredBy = {
      [senderId]: new Date().toISOString()
    };

    for (const userId of deliveredTo) {
      deliveredBy[userId] = deliveredBy[senderId];
    }

    const { rows } = await this.pool.query(
      `
        INSERT INTO messages (id, sender_id, mode, type, payload, attachment_id, expires_at, delivered_by, read_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, '{}'::jsonb)
        RETURNING *
      `,
      [
        `msg_${randomToken(12)}`,
        senderId,
        mode === 'private' ? 'private' : 'standard',
        'sealed',
        JSON.stringify(payload),
        attachmentId || null,
        expiresAt || null,
        JSON.stringify(deliveredBy)
      ]
    );

    return this.publicMessage(rowToMessage(rows[0]));
  }

  async purgeExpiredMessages() {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          SELECT *
          FROM messages
          WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
          ORDER BY created_at ASC
        `
      );

      const changedMessages = [];
      const deletedAttachments = [];

      for (const row of rows) {
        const message = rowToMessage(row);
        let deletedAttachment = null;

        if (message.attachmentId) {
          const attachmentResult = await client.query(
            `
              UPDATE attachments
              SET deleted_at = now()
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING *
            `,
            [message.attachmentId]
          );
          deletedAttachment = rowToAttachment(attachmentResult.rows[0]);
          if (deletedAttachment) deletedAttachments.push(deletedAttachment);
        }

        const updateResult = await client.query(
          `
            UPDATE messages
            SET deleted_at = now(), payload = NULL, attachment_id = NULL
            WHERE id = $1
            RETURNING *
          `,
          [message.id]
        );
        changedMessages.push(this.publicMessage(rowToMessage(updateResult.rows[0])));
      }

      return { changedMessages, deletedAttachments };
    });
  }

  async listMessages({ limit = 50, before }) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const params = [safeLimit];
    let where = '';

    if (before) {
      params.push(before);
      where = 'WHERE created_at < $2';
    }

    const { rows } = await this.pool.query(
      `
        SELECT *
        FROM messages
        ${where}
        ORDER BY created_at DESC
        LIMIT $1
      `,
      params
    );

    return rows.reverse().map((row) => this.publicMessage(rowToMessage(row)));
  }

  async markDeliveredForUser(userId) {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM messages WHERE deleted_at IS NULL AND sender_id <> $1 AND NOT (delivered_by ? $1)",
        [userId]
      );
      const statuses = [];

      for (const row of rows) {
        const message = rowToMessage(row);
        message.deliveredBy[userId] = new Date().toISOString();
        const updated = await client.query(
          'UPDATE messages SET delivered_by = $1::jsonb WHERE id = $2 RETURNING *',
          [JSON.stringify(message.deliveredBy), message.id]
        );
        statuses.push(this.publicMessage(rowToMessage(updated.rows[0])));
      }

      return statuses;
    });
  }

  async markRead({ userId, messageIds }) {
    if (!messageIds.length) return [];

    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          SELECT *
          FROM messages
          WHERE id = ANY($1::text[]) AND deleted_at IS NULL AND sender_id <> $2
        `,
        [messageIds, userId]
      );
      const statuses = [];

      for (const row of rows) {
        const message = rowToMessage(row);
        if (message.readBy[userId]) continue;

        const now = new Date().toISOString();
        message.deliveredBy[userId] = message.deliveredBy[userId] || now;
        message.readBy[userId] = now;
        const updated = await client.query(
          'UPDATE messages SET delivered_by = $1::jsonb, read_by = $2::jsonb WHERE id = $3 RETURNING *',
          [JSON.stringify(message.deliveredBy), JSON.stringify(message.readBy), message.id]
        );
        statuses.push(this.publicMessage(rowToMessage(updated.rows[0])));
      }

      return statuses;
    });
  }

  async deleteMessage({ messageId, userId }) {
    return this.withTransaction(async (client) => {
      const messageResult = await client.query('SELECT * FROM messages WHERE id = $1', [messageId]);
      const message = rowToMessage(messageResult.rows[0]);
      if (!message) {
        throw new Error('Message not found.');
      }

      const actor = await client.query('SELECT role FROM users WHERE id = $1', [userId]);
      if (!actor.rows[0] || (actor.rows[0].role !== 'owner' && message.senderId !== userId)) {
        throw new Error('You can only delete your own messages.');
      }

      if (message.deletedAt) {
        return { message: this.publicMessage(message), deletedAttachment: null };
      }

      let deletedAttachment = null;
      if (message.attachmentId) {
        const attachmentResult = await client.query(
          `
            UPDATE attachments
            SET deleted_at = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING *
          `,
          [message.attachmentId]
        );
        deletedAttachment = rowToAttachment(attachmentResult.rows[0]);
      }

      const updateResult = await client.query(
        `
          UPDATE messages
          SET deleted_at = now(), payload = NULL, attachment_id = NULL
          WHERE id = $1
          RETURNING *
        `,
        [message.id]
      );

      return {
        message: this.publicMessage(rowToMessage(updateResult.rows[0])),
        deletedAttachment
      };
    });
  }
}

module.exports = PostgresStore;
