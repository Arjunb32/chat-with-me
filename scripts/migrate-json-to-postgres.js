require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const PostgresStore = require('../src/postgres-store');

const ROOT_DIR = path.join(__dirname, '..');

function s3KeyForAttachment(attachment) {
  if (process.env.MEDIA_DRIVER !== 's3') {
    return attachment.filename;
  }

  const prefix = (process.env.S3_PREFIX || 'attachments').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${attachment.id}.json`;
}

async function main() {
  const jsonPath = process.argv[2] || path.join(ROOT_DIR, 'data', 'db.json');
  const db = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const store = new PostgresStore();
  await store.init();
  const client = await store.pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO app_settings (key, value)
        VALUES ('main', $1::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `,
      [JSON.stringify({ cryptoSalt: db.cryptoSalt, maxUsers: (db.settings && db.settings.maxUsers) || 2 })]
    );

    for (const user of db.users || []) {
      await client.query(
        `
          INSERT INTO users (id, display_name, display_name_key, password_hash, role, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              display_name_key = EXCLUDED.display_name_key,
              password_hash = EXCLUDED.password_hash,
              role = EXCLUDED.role
        `,
        [user.id, user.displayName, user.displayNameKey, user.passwordHash, user.role, user.createdAt]
      );
    }

    for (const session of db.sessions || []) {
      await client.query(
        `
          INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          session.id,
          session.userId,
          session.tokenHash,
          session.userAgent,
          session.ip,
          session.createdAt,
          session.lastSeenAt,
          session.expiresAt
        ]
      );
    }

    for (const device of db.verifiedDevices || []) {
      await client.query(
        `
          INSERT INTO verified_devices (id, user_id, token_hash, label, user_agent, ip, created_at, last_seen_at, revoked_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          device.id,
          device.userId,
          device.tokenHash,
          device.label,
          device.userAgent,
          device.ip,
          device.createdAt,
          device.lastSeenAt,
          device.revokedAt
        ]
      );
    }

    for (const code of db.recoveryCodes || []) {
      await client.query(
        `
          INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `,
        [code.id, code.userId, code.codeHash, code.createdAt, code.usedAt]
      );
    }

    for (const invite of db.invites || []) {
      await client.query(
        `
          INSERT INTO invites (id, token_hash, created_by, created_at, expires_at, used_at, used_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          invite.id,
          invite.tokenHash,
          invite.createdBy,
          invite.createdAt,
          invite.expiresAt,
          invite.usedAt,
          invite.usedBy
        ]
      );
    }

    for (const attachment of db.attachments || []) {
      await client.query(
        `
          INSERT INTO attachments (id, owner_id, kind, byte_length, storage_key, created_at, deleted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE
          SET storage_key = EXCLUDED.storage_key,
              deleted_at = EXCLUDED.deleted_at
        `,
        [
          attachment.id,
          attachment.ownerId,
          attachment.kind,
          attachment.byteLength,
          s3KeyForAttachment(attachment),
          attachment.createdAt,
          attachment.deletedAt
        ]
      );
    }

    for (const message of db.messages || []) {
      await client.query(
        `
          INSERT INTO messages (
            id, sender_id, type, payload, attachment_id, created_at, expires_at, deleted_at, delivered_by, read_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
          ON CONFLICT (id) DO UPDATE
          SET payload = EXCLUDED.payload,
              attachment_id = EXCLUDED.attachment_id,
              deleted_at = EXCLUDED.deleted_at,
              delivered_by = EXCLUDED.delivered_by,
              read_by = EXCLUDED.read_by
        `,
        [
          message.id,
          message.senderId,
          message.type,
          message.payload ? JSON.stringify(message.payload) : null,
          message.attachmentId,
          message.createdAt,
          message.expiresAt,
          message.deletedAt,
          JSON.stringify(message.deliveredBy || {}),
          JSON.stringify(message.readBy || {})
        ]
      );
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, users: (db.users || []).length, messages: (db.messages || []).length }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await store.pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
