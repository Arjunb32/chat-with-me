'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getRtcConfiguration } = require('../src/rtc-config');

test('production cannot quietly fall back to STUN-only calling', async () => {
  await assert.rejects(getRtcConfiguration('alice', { NODE_ENV: 'production' }), /not configured/);
  const config = await getRtcConfiguration('alice', { NODE_ENV: 'development' });
  assert.equal(config.hasRelay, false);
});

test('shared-secret TURN configuration exposes temporary credentials, never the signing secret', async () => {
  const env = { NODE_ENV: 'production', TURN_URLS: 'turn:relay.example.test:3478,turns:relay.example.test:443?transport=tcp', TURN_SHARED_SECRET: 'test-only-signing-secret', RTC_RELAY_ONLY: 'true' };
  const config = await getRtcConfiguration('alice', env);
  assert.equal(config.hasRelay, true);
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.iceServers[0].urls.length, 2);
  assert.equal(JSON.stringify(config).includes(env.TURN_SHARED_SECRET), false);
  const expires = Number(config.iceServers[0].username.split(':')[0]);
  assert.ok(expires > Date.now() / 1000 + config.maxCallSeconds);
  assert.notEqual(config.iceServers[0].username, (await getRtcConfiguration('bob', env)).iceServers[0].username);
});

test('provider response is sanitized and does not expose the API key or blocked port 53', async () => {
  const env = { NODE_ENV: 'production', TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'test-token' };
  const config = await getRtcConfiguration('alice', env, async (url, options) => {
    assert.match(url, /test-key\/credentials\/generate-ice-servers$/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(options.body).ttl, 7200);
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:relay.test:53', 'turns:relay.test:443?transport=tcp'], username: 'temporary', credential: 'temporary-password', secret: 'do-not-return' }] }) };
  });
  assert.deepEqual(config.iceServers[0].urls, ['turns:relay.test:443?transport=tcp']);
  assert.equal(JSON.stringify(config).includes('test-token'), false);
  assert.equal(JSON.stringify(config).includes('do-not-return'), false);
});

test('failed or unusable relay responses fail closed', async () => {
  const env = { NODE_ENV: 'production', TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'token' };
  await assert.rejects(getRtcConfiguration('alice', env, async () => ({ ok: false })), /unavailable/);
  await assert.rejects(getRtcConfiguration('alice', env, async () => ({ ok: true, json: async () => ({ iceServers: [] }) })), /no usable/);
});
