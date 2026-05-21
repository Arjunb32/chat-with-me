require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

function requirePassphrase() {
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase || passphrase.length < 20) {
    throw new Error('BACKUP_PASSPHRASE must be set to at least 20 characters.');
  }

  return passphrase;
}

function decryptBackup(envelope, passphrase) {
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) {
    throw new Error('Usage: node scripts/restore.js <backup-file>');
  }

  const envelope = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  const backup = JSON.parse(decryptBackup(envelope, requirePassphrase()).toString('utf8'));

  if (backup.database.driver === 'json') {
    await fs.mkdir(path.join(ROOT_DIR, 'data'), { recursive: true });
    await fs.writeFile(path.join(ROOT_DIR, 'data', 'db.json'), Buffer.from(backup.database.body, 'base64'));
  } else {
    const dumpPath = path.join(ROOT_DIR, 'backups', 'restore.pgcustom');
    await fs.mkdir(path.dirname(dumpPath), { recursive: true });
    await fs.writeFile(dumpPath, Buffer.from(backup.database.body, 'base64'));
    console.log(`PostgreSQL dump written to ${dumpPath}`);
    console.log('Restore with: pg_restore --clean --if-exists --no-owner --no-acl --dbname "$env:DATABASE_URL" backups/restore.pgcustom');
  }

  if (Array.isArray(backup.localEncryptedAttachments) && backup.localEncryptedAttachments.length) {
    const attachmentsDir = path.join(ROOT_DIR, 'storage', 'attachments');
    await fs.mkdir(attachmentsDir, { recursive: true });
    for (const attachment of backup.localEncryptedAttachments) {
      await fs.writeFile(path.join(attachmentsDir, attachment.key), Buffer.from(attachment.body, 'base64'));
    }
  }

  console.log(JSON.stringify({ ok: true, restored: backup.createdAt }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
