const MAX_EPOCH = Number.MAX_SAFE_INTEGER;

function isSafeEpoch(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_EPOCH;
}

function normalizeEpoch(value) {
  if (value === undefined || value === null) {
    return 1;
  }

  if (!isSafeEpoch(value)) {
    throw new Error('Invalid encrypted envelope epoch.');
  }

  return value;
}

function isEncryptionEnvelope(value, maxCiphertextChars = 80_000) {
  return Boolean(
    value &&
      value.v === 1 &&
      value.alg === 'AES-GCM' &&
      (value.epoch === undefined || isSafeEpoch(value.epoch)) &&
      typeof value.iv === 'string' &&
      value.iv.length >= 12 &&
      value.iv.length <= 64 &&
      typeof value.ciphertext === 'string' &&
      value.ciphertext.length > 0 &&
      value.ciphertext.length <= maxCiphertextChars
  );
}

function validateEncryptionEnvelope(value, maxCiphertextChars) {
  if (!isEncryptionEnvelope(value, maxCiphertextChars)) {
    throw new Error('Invalid encrypted payload.');
  }

  normalizeEpoch(value.epoch);
  return value;
}

function validateMessageInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid message.');
  }

  const mode = input.mode === 'private' ? 'private' : 'standard';
  let payload;
  if (mode === 'private') {
    payload = validateEncryptionEnvelope(input.payload);
  } else {
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new Error('Invalid plain payload.');
    }
    const kind = input.payload.kind || 'text';
    if (!['text', 'photo', 'voice'].includes(kind)) {
      throw new Error('Invalid plain payload.');
    }
    payload = {
      ...input.payload,
      kind
    };
    if (payload.text !== undefined) {
      payload.text = String(payload.text).slice(0, 4000);
    }
  }
  const attachmentId = input.attachmentId || null;
  if (attachmentId !== null && (typeof attachmentId !== 'string' || attachmentId.length > 120)) {
    throw new Error('Attachment is invalid for this message.');
  }

  const expiresInMs = Number(input.expiresInMs || 0);
  if (expiresInMs < 0 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Invalid expiration.');
  }

  return {
    mode,
    payload,
    attachmentId,
    expiresAt: expiresInMs ? new Date(Date.now() + expiresInMs).toISOString() : null
  };
}

function validateAttachmentEnvelope(rawBody, maxUploadBytes, maxUploadMb) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length < 32 || rawBody.length > maxUploadBytes) {
    throw new Error(`Encrypted file must be between 32 bytes and ${maxUploadMb} MB.`);
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('Encrypted file envelope is invalid.');
  }

  try {
    validateEncryptionEnvelope(envelope, maxUploadBytes * 2);
  } catch {
    throw new Error('Encrypted file envelope is invalid.');
  }

  return envelope;
}

module.exports = {
  isEncryptionEnvelope,
  isSafeEpoch,
  normalizeEpoch,
  validateAttachmentEnvelope,
  validateEncryptionEnvelope,
  validateMessageInput
};
