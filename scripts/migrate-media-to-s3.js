require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const { createMediaStorage } = require('../src/media-storage');

const ROOT_DIR = path.join(__dirname, '..');

async function main() {
  if (process.env.MEDIA_DRIVER !== 's3') {
    throw new Error('Set MEDIA_DRIVER=s3 and S3_* variables before running this migration.');
  }

  const dbPath = path.join(ROOT_DIR, 'data', 'db.json');
  const db = JSON.parse(await fs.readFile(dbPath, 'utf8'));
  const mediaStorage = createMediaStorage(ROOT_DIR);
  await mediaStorage.init();

  let uploaded = 0;
  for (const attachment of db.attachments || []) {
    if (attachment.deletedAt) continue;
    const localPath = path.join(ROOT_DIR, 'storage', 'attachments', attachment.filename);
    const key = mediaStorage.keyForAttachment(attachment.id);
    const body = await fs.readFile(localPath);
    await mediaStorage.put(key, body);
    uploaded += 1;
  }

  console.log(JSON.stringify({ ok: true, uploaded }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
