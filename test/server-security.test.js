const assert = require('assert/strict');
const { test } = require('node:test');

test('production CSP keeps scripts local and upgrades insecure requests', () => {
  const oldEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
    CSP_REPORT_URI: process.env.CSP_REPORT_URI
  };

  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://chat.example.test';
  process.env.CSP_REPORT_URI = '/api/csp-report';

  try {
    delete require.cache[require.resolve('../src/server')];
    const { buildCspDirectives } = require('../src/server');
    const directives = buildCspDirectives();

    assert.deepEqual(directives.defaultSrc, ["'none'"]);
    assert.deepEqual(directives.scriptSrc, ["'self'"]);
    assert.deepEqual(directives.scriptSrcAttr, ["'none'"]);
    assert.equal(directives.connectSrc.includes('https://chat.example.test'), true);
    assert.equal(directives.connectSrc.includes('wss://chat.example.test'), true);
    assert.equal(Object.hasOwn(directives, 'upgradeInsecureRequests'), true);
    assert.deepEqual(directives.reportUri, ['/api/csp-report']);
  } finally {
    delete require.cache[require.resolve('../src/server')];
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
