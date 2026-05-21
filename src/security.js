const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
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
  normalizeDisplayName,
  randomSalt,
  randomToken,
  sha256,
  toPublicUser,
  validatePassword,
  verifyPassword
};
