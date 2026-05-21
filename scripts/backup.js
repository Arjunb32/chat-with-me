require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const ROOT_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT_DIR, process.env.BACKUP_DIR || 'backups');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function requirePassphrase() {
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase || passphrase.length < 20) {
    throw new Error('BACKUP_PASSPHRASE must be set to at least 20 characters.');
  }

  return passphrase;
}

function encryptPayload(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(
    JSON.stringify({
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64')
    })
  );
}

function runPgDump() {
  return new Promise((resolve, reject) => {
    if (!process.env.DATABASE_URL) {
      reject(new Error('DATABASE_URL is required for PostgreSQL backups.'));
      return;
    }

    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', process.env.DATABASE_URL], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `pg_dump exited with ${code}.`));
        return;
      }

      resolve(Buffer.concat(stdout));
    });
  });
}

async function readLocalAttachments() {
  const attachmentsDir = path.join(ROOT_DIR, 'storage', 'attachments');
  if (!(await exists(attachmentsDir))) return [];

  const entries = await fs.readdir(attachmentsDir);
  const attachments = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(attachmentsDir, entry);
    const body = await fs.readFile(filePath);
    attachments.push({
      key: entry,
      body: body.toString('base64')
    });
  }

  return attachments;
}

async function buildBackupPackage() {
  const storeDriver = process.env.STORE_DRIVER || 'json';
  const mediaDriver = process.env.MEDIA_DRIVER || 'local';
  let database;

  if (storeDriver === 'postgres') {
    database = {
      driver: 'postgres',
      format: 'pg_dump_custom',
      body: (await runPgDump()).toString('base64')
    };
  } else {
    const dbPath = path.join(ROOT_DIR, 'data', 'db.json');
    database = {
      driver: 'json',
      format: 'json',
      body: (await fs.readFile(dbPath)).toString('base64')
    };
  }

  return Buffer.from(
    JSON.stringify({
      app: 'chat-with-me',
      createdAt: new Date().toISOString(),
      storeDriver,
      mediaDriver,
      database,
      localEncryptedAttachments: mediaDriver === 'local' ? await readLocalAttachments() : []
    })
  );
}

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
}

async function uploadBackup(fileName, body) {
  if (!process.env.BACKUP_S3_BUCKET) return null;

  const key = `${(process.env.BACKUP_S3_PREFIX || 'database-backups').replace(/^\/+|\/+$/g, '')}/${fileName}`;
  await makeS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.BACKUP_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION || undefined
    })
  );

  return key;
}

async function main() {
  const passphrase = requirePassphrase();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const backupPackage = await buildBackupPackage();
  const encrypted = encryptPayload(backupPackage, passphrase);
  const fileName = `chat-with-me-${stamp()}.cwmbackup`;
  const filePath = path.join(BACKUP_DIR, fileName);

  await fs.writeFile(filePath, encrypted, { flag: 'wx' });
  const uploadedKey = await uploadBackup(fileName, encrypted);

  console.log(JSON.stringify({ ok: true, filePath, uploadedKey }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
