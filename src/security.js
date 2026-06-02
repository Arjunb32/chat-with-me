const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let argon2Package = null;
try {
  argon2Package = require('argon2');
} catch {
  argon2Package = null;
}

const SESSION_COOKIE = 'cwm_session';
const DEVICE_COOKIE = 'cwm_device';
const SESSION_DAYS = 7;

function randomToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function randomSalt(byteLength = 16) {
  return crypto.randomBytes(byteLength).toString('base64');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function argon2Options() {
  return {
    memoryCost: Number(process.env.ARGON2_MEMORY_COST || 65536),
    timeCost: Number(process.env.ARGON2_TIME_COST || 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM || 1)
  };
}

function phcBase64(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=+$/g, '');
}

function fromPhcBase64(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(`${value}${padding}`, 'base64');
}

function hashWithNodeArgon2(password) {
  if (typeof crypto.argon2 !== 'function') {
    throw new Error('Argon2id requires Node crypto.argon2 support or the argon2 package.');
  }

  const options = argon2Options();
  const salt = crypto.randomBytes(16);

  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password),
        nonce: salt,
        parallelism: options.parallelism,
        tagLength: 32,
        memory: options.memoryCost,
        passes: options.timeCost
      },
      (error, tag) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(
          `$argon2id$v=19$m=${options.memoryCost},t=${options.timeCost},p=${options.parallelism}$${phcBase64(salt)}$${phcBase64(tag)}`
        );
      }
    );
  });
}

async function verifyWithNodeArgon2(password, hash) {
  if (typeof crypto.argon2 !== 'function') {
    return false;
  }

  const parts = String(hash).split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') {
    return false;
  }

  const params = Object.fromEntries(parts[3].split(',').map((item) => item.split('=')));
  const memory = Number(params.m);
  const passes = Number(params.t);
  const parallelism = Number(params.p);
  const salt = fromPhcBase64(parts[4]);
  const expected = fromPhcBase64(parts[5]);

  if (!memory || !passes || !parallelism || !salt.length || !expected.length) {
    return false;
  }

  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password),
        nonce: salt,
        parallelism,
        tagLength: expected.length,
        memory,
        passes
      },
      (error, tag) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(tag.length === expected.length && crypto.timingSafeEqual(tag, expected));
      }
    );
  });
}

async function hashPassword(password) {
  if (argon2Package) {
    const options = argon2Options();
    return argon2Package.hash(password, {
      type: argon2Package.argon2id,
      memoryCost: options.memoryCost,
      timeCost: options.timeCost,
      parallelism: options.parallelism
    });
  }

  return hashWithNodeArgon2(password);
}

async function verifyPassword(password, hash) {
  if (typeof hash === 'string' && hash.startsWith('$argon2')) {
    if (argon2Package) {
      try {
        return await argon2Package.verify(hash, password);
      } catch {
        return verifyWithNodeArgon2(password, hash);
      }
    }

    return verifyWithNodeArgon2(password, hash);
  }

  return bcrypt.compare(password, hash);
}

function passwordNeedsRehash(hash) {
  return typeof hash !== 'string' || !hash.startsWith('$argon2');
}

function normalizeDisplayName(displayName) {
  if (typeof displayName !== 'string') {
    throw new Error('Display name is required.');
  }

  const normalized = displayName.trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 32) {
    throw new Error('Display name must be 2 to 32 characters.');
  }

  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error('Display name cannot include control characters.');
  }

  return normalized;
}

function normalizeAvatarColor(avatarColor) {
  if (typeof avatarColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(avatarColor.trim())) {
    throw new Error('Avatar color must be a 6-digit hex color.');
  }

  return avatarColor.trim().toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
    throw new Error('Password must be 10 to 256 characters.');
  }
}

function cleanInviteCode(inviteCode) {
  if (typeof inviteCode !== 'string' || inviteCode.trim().length < 24) {
    throw new Error('Invite code is required.');
  }

  return inviteCode.trim();
}

function cleanRecoveryCode(recoveryCode) {
  if (typeof recoveryCode !== 'string') {
    return '';
  }

  return recoveryCode.trim().toUpperCase();
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    avatarColor: user.avatarColor || '#147c72',
    role: user.role,
    createdAt: user.createdAt
  };
}

function futureDate(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function isExpired(isoDate) {
  return Boolean(isoDate && Date.parse(isoDate) <= Date.now());
}

module.exports = {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  SESSION_DAYS,
  cleanRecoveryCode,
  cleanInviteCode,
  futureDate,
  hashPassword,
  isExpired,
  normalizeAvatarColor,
  normalizeDisplayName,
  passwordNeedsRehash,
  randomSalt,
  randomToken,
  sha256,
  toPublicUser,
  validatePassword,
  verifyPassword
};
