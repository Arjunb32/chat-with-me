const assert = require('assert/strict');
const { test } = require('node:test');

const { createPreSendState } = require('../public/presend-state');

test('photo pre-send state waits for explicit send and tracks upload failure', () => {
  const machine = createPreSendState();
  machine.set('photo', { name: 'pic.jpg' });
  assert.equal(machine.current.status, 'preview');

  machine.beginUpload();
  machine.progress(42);
  assert.equal(machine.current.progress, 42);

  machine.fail('network');
  assert.equal(machine.current.status, 'failed');
  assert.equal(machine.current.error, 'network');
});

test('voice pre-send state can be discarded before upload', () => {
  const machine = createPreSendState();
  machine.set('voice', { durationMs: 1200 });
  assert.equal(machine.current.kind, 'voice');
  assert.equal(machine.clear(), null);
  assert.equal(machine.current, null);
});
