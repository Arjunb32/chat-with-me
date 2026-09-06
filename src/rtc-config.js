'use strict';

const { createHmac, createHash } = require('node:crypto');

async function getRtcConfiguration(userId, env = process.env, request = fetch) {
  const ttl = 7200; // Longer than the server-enforced one-hour call limit.
  let iceServers;
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Call relay is temporarily unavailable. Please try again.');
    const payload = await response.json();
    if (!Array.isArray(payload.iceServers)) throw new Error('Call relay returned an invalid configuration.');
    iceServers = payload.iceServers.map((entry) => ({
      urls: (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
        .filter((url) => typeof url === 'string' && /^(stun|stuns|turn|turns):/.test(url) && !/:53(?:\?|$)/.test(url)),
      ...(typeof entry.username === 'string' ? { username: entry.username } : {}),
      ...(typeof entry.credential === 'string' ? { credential: entry.credential } : {})
    })).filter((entry) => entry.urls.length);
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
