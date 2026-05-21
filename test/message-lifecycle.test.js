const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const Store = require('../src/store');

function envelope(epoch = 2) {
  return {
    v: 1,
    alg: 'AES-GCM',
    epoch,
    iv: 'abcdefghijklmnop',
    ciphertext: 'encrypted'
  };
}

async function withStore(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwm-store-'));
  const store = new Store(root);
  await store.init();

  try {
    await callback(store);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('stores sealed messages and runs delivery/read/delete lifecycle', async () => {
  await withStore(async (store) => {
    const owner = await store.createOwner({ displayName: 'Owner', passwordHash: 'hash' });
    const invite = await store.createInvite(owner.id);
    const member = await store.signupWithInvite({
      displayName: 'Member',
      passwordHash: 'hash',
      inviteCode: invite.token
    });

    const message = await store.addMessage({
      senderId: owner.id,
      payload: envelope(),
      deliveredTo: [member.id]
    });

    assert.equal(Object.hasOwn(message, 'type'), false);
    assert.equal(message.payload.epoch, 2);
    assert.ok(message.deliveredBy[member.id]);
    assert.equal(store.db.messages[0].type, 'sealed');

    const readStatuses = await store.markRead({ userId: member.id, messageIds: [message.id] });
    assert.equal(readStatuses.length, 1);
    assert.ok(readStatuses[0].readBy[member.id]);

    const deleted = await store.deleteMessage({ messageId: message.id, userId: owner.id });
    assert.equal(deleted.message.deletedAt !== null, true);
    assert.equal(deleted.message.payload, null);
  });
});

test('legacy messages keep encrypted payload compatibility without public type leakage', async () => {
  await withStore(async (store) => {
    const owner = await store.createOwner({ displayName: 'Owner', passwordHash: 'hash' });
    store.db.messages.push({
      id: 'msg_legacy_text',
      senderId: owner.id,
      type: 'text',
      payload: envelope(1),
      attachmentId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      deletedAt: null,
      deliveredBy: {},
      readBy: {}
    });

    const [message] = await store.listMessages({ limit: 10 });
    assert.equal(message.id, 'msg_legacy_text');
    assert.equal(Object.hasOwn(message, 'type'), false);
    assert.deepEqual(message.payload, envelope(1));
  });
});

test('purges expired sealed messages and linked attachments', async () => {
  await withStore(async (store) => {
    const owner = await store.createOwner({ displayName: 'Owner', passwordHash: 'hash' });
    const attachment = await store.addAttachment({
      id: 'att_test',
      ownerId: owner.id,
      byteLength: 128,
      filename: 'att_test.json'
    });

    assert.equal(attachment.kind, 'encrypted');

    const message = await store.addMessage({
      senderId: owner.id,
      payload: envelope(3),
      attachmentId: attachment.id,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });

    const result = await store.purgeExpiredMessages();
    assert.equal(result.changedMessages.length, 1);
    assert.equal(result.changedMessages[0].id, message.id);
    assert.equal(result.changedMessages[0].payload, null);
    assert.equal(result.deletedAttachments.length, 1);
    assert.equal(result.deletedAttachments[0].id, attachment.id);
  });
});
