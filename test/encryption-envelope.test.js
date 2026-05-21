const assert = require('assert/strict');
const { test } = require('node:test');

const {
  isEncryptionEnvelope,
  validateAttachmentEnvelope,
  validateMessageInput
} = require('../src/envelope');

function envelope(extra = {}) {
  return {
    v: 1,
    alg: 'AES-GCM',
    epoch: 7,
    iv: 'abcdefghijklmnop',
    ciphertext: 'encrypted',
    ...extra
  };
}

test('accepts encrypted envelopes with numeric session epochs', () => {
  assert.equal(isEncryptionEnvelope(envelope()), true);
  assert.equal(isEncryptionEnvelope(envelope({ epoch: '2026-05-21' })), false);
});

test('validates sealed message input without exposing message type', () => {
  const input = validateMessageInput({
    type: 'photo',
    payload: envelope(),
    attachmentId: 'att_test',
    expiresInMs: 1000
  });

  assert.equal(input.attachmentId, 'att_test');
  assert.equal(input.payload.epoch, 7);
  assert.equal(Object.hasOwn(input, 'type'), false);
  assert.match(input.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('rejects attachment envelopes with date-string epochs', () => {
  const body = Buffer.from(JSON.stringify(envelope({ epoch: '2026-05-21' })));
  assert.throws(() => validateAttachmentEnvelope(body, 1024, 1), /Encrypted file envelope is invalid/);
});
