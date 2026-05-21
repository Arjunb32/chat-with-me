const fs = require('fs/promises');
const path = require('path');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class LocalMediaStorage {
  constructor(rootDir) {
    this.attachmentsDir = path.join(rootDir, 'storage', 'attachments');
  }

  async init() {
    await fs.mkdir(this.attachmentsDir, { recursive: true });
  }

  keyForAttachment(id) {
    return `${id}.json`;
  }

  async put(key, body) {
    const target = path.join(this.attachmentsDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { flag: 'wx' });
  }

  async get(key) {
    return fs.readFile(path.join(this.attachmentsDir, key));
  }

  async remove(key) {
    try {
      await fs.unlink(path.join(this.attachmentsDir, key));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

class S3MediaStorage {
  constructor() {
    const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`${key} is required when MEDIA_DRIVER=s3.`);
      }
    }

    this.bucket = process.env.S3_BUCKET;
    this.prefix = (process.env.S3_PREFIX || 'attachments').replace(/^\/+|\/+$/g, '');
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'auto',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
      }
    });
  }

  async init() {}

  keyForAttachment(id) {
    return `${this.prefix}/${id}.json`;
  }

  async put(key, body) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ServerSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION || undefined
      })
    );
  }

  async get(key) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );

    return streamToBuffer(response.Body);
  }

  async remove(key) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }
}

function createMediaStorage(rootDir) {
  if (process.env.MEDIA_DRIVER === 's3') {
    return new S3MediaStorage();
  }

  return new LocalMediaStorage(rootDir);
}

module.exports = {
  createMediaStorage
};
