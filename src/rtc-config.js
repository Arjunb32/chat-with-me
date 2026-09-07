'use strict';

const { createHmac, createHash } = require('node:crypto');

function sanitizeIceServers(entries) {
  if (!Array.isArray(entries)) throw new Error('Call relay returned an invalid configuration.');
  return entries.slice(0, 16).filter((entry) => entry && typeof entry === 'object').map((entry) => ({
    urls: (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).slice(0, 16)
      .filter((url) => typeof url === 'string' && url.length <= 2048 && /^(stun|stuns|turn|turns):[^\s]+$/.test(url) && !/:53(?:\?|$)/.test(url)),
    ...(typeof entry.username === 'string' && entry.username.length <= 1024 ? { username: entry.username } : {}),
    ...(typeof entry.credential === 'string' && entry.credential.length <= 1024 ? { credential: entry.credential } : {})
  })).filter((entry) => entry.urls.length);
}

async function getRtcConfiguration(userId, env = process.env, request = fetch) {
  const ttl = 7200; // Longer than the server-enforced one-hour call limit.
  let iceServers;
  if (env.METERED_TURN_APP_NAME || env.METERED_TURN_API_KEY) {
    const appName = String(env.METERED_TURN_APP_NAME || '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appName) || !env.METERED_TURN_API_KEY) {
      throw new Error('The site owner needs to finish configuring the call relay.');
    }
    const endpoint = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
    endpoint.searchParams.set('apiKey', env.METERED_TURN_API_KEY);
    let payload;
    try {
      const response = await request(endpoint.href, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('Provider request failed.');
      payload = await response.json();
    } catch {
      // Provider URLs contain the master key: never forward request errors to clients/logs.
      throw new Error('Call relay is temporarily unavailable or its free allowance is exhausted.');
    }
    iceServers = sanitizeIceServers(payload);
  } else if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Call relay is temporarily unavailable. Please try again.');
    const payload = await response.json();
    iceServers = sanitizeIceServers(payload.iceServers);
  } else if (env.TURN_URLS && env.TURN_SHARED_SECRET) {
    const urls = env.TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean);
    if (!urls.length || urls.some((url) => !/^turns?:[^\s]+$/.test(url))) throw new Error('Call relay URLs are invalid.');
    const identity = createHash('sha256').update(userId).digest('hex').slice(0, 16);
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${identity}`;
    iceServers = [{ urls, username, credential: createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64') }];
  } else if (env.NODE_ENV === 'production') {
    throw new Error('Calling is not configured yet. The site owner needs to connect a call relay.');
  } else {
    iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
  const hasRelay = iceServers.some((entry) => entry.urls.some((url) => /^turns?:/.test(url)) && entry.username && entry.credential);
  if (env.NODE_ENV === 'production' && !hasRelay) throw new Error('Call relay returned no usable relay servers.');
  return { iceServers, iceTransportPolicy: env.RTC_RELAY_ONLY === 'true' ? 'relay' : 'all', hasRelay, maxCallSeconds: 3600 };
}

module.exports = { getRtcConfiguration };
