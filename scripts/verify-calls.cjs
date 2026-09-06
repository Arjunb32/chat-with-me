// Optional browser verification: install Playwright or specify its module location.
const { chromium } = require(process.env.CALL_TEST_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

(async () => {
  const source = path.resolve(__dirname, '..');
  const scratch = process.env.CALL_TEST_WORKDIR || path.join(require('node:os').tmpdir(), 'chat-with-me-browser-tests');
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, 'browser-run-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  for (const directory of ['src', 'public']) await fs.cp(path.join(source, directory), path.join(fixture, directory), { recursive: true });
  await fs.symlink(path.join(source, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
  const child = spawn(process.execPath, [path.join(fixture, 'src/server.js')], { cwd: fixture, windowsHide: true,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', PUBLIC_ORIGIN: `http://localhost:${port}`, APP_SETUP_CODE: '', STORE_DRIVER: 'json', MEDIA_DRIVER: 'local', TURN_KEY_ID: '', TURN_KEY_API_TOKEN: '', TURN_URLS: '', TURN_SHARED_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const browsers = [];
  const contexts = [];
  try {
    await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start.')), 20000);
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('running at')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Test server exited: ${code}`)); });
  });
  const browserOptions = { executablePath: process.env.CALL_TEST_BROWSER || undefined, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] };
    browsers.push(await chromium.launch(browserOptions));
    browsers.push(await chromium.launch(browserOptions));
    const makeContext = async () => {
      const context = await browsers[contexts.length].newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1200, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        window.testPeers = [];
        window.testStreams = [];
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.testPeers.push(this); } };
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => {
          if (window.holdTestCapture) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const lateStream = canvas.captureStream(1);
            window.testStreams.push(lateStream);
            await new Promise((resolve) => { window.releaseTestCapture = resolve; });
            return lateStream;
          }
          const stream = await capture(...args);
          for (const track of stream.getTracks()) track.addEventListener('ended', () => console.log('TEST_TRACK_ENDED', track.kind, track.label));
          window.testStreams.push(stream);
          return stream;
        };
      });
      return context;
    };
    const first = await makeContext();
    const second = await makeContext();
    const origin = `http://localhost:${port}`;
    const password = randomBytes(24).toString('base64url');
    const ownerResponse = await first.request.post(`${origin}/api/setup/owner`, { data: { displayName: 'Call Test Alice', password } });
    assert.equal(ownerResponse.status(), 201, await ownerResponse.text());
    const invite = await (await first.request.post(`${origin}/api/invites`)).json();
    const memberResponse = await second.request.post(`${origin}/api/signup`, { data: { displayName: 'Call Test Bob', password, inviteCode: invite.inviteCode } });
    assert.equal(memberResponse.status(), 201, await memberResponse.text());
    const alice = await first.newPage();
    const bob = await second.newPage();
    const errors = [];
    for (const page of [alice, bob]) {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.text().startsWith('TEST_')) console.log(message.text()); });
      page.setDefaultTimeout(20000);
      await page.goto(origin);
      try {
        await page.locator('#chatView').waitFor({ state: 'visible' });
      } catch (error) {
        console.log('Browser errors:', errors);
        console.log(await page.evaluate(() => ({ title: document.title, notice: document.querySelector('#authNotice')?.textContent, callsLoaded: Boolean(window.ChatCalls) })));
        throw error;
      }
    }
    for (const kind of ['voice', 'video']) {
      await alice.locator(`#${kind}CallButton`).click();
      await bob.locator('#callDialog').waitFor({ state: 'visible' });
      await bob.locator('#callAcceptButton').click();
      for (const page of [alice, bob]) {
        try {
          await page.waitForFunction(() => document.querySelector('#callStatus').textContent === 'Connected');
        } catch (error) {
          for (const debugPage of [alice, bob]) console.log(await debugPage.evaluate(() => ({
            status: document.querySelector('#callStatus').textContent,
            notice: document.querySelector('#uploadLine').textContent,
            peers: testPeers.map((peer) => ({ connection: peer.connectionState, signaling: peer.signalingState, ice: peer.iceConnectionState }))
          })));
          throw error;
        }
        const trackKinds = await page.evaluate(() => testPeers.at(-1).getReceivers().map((receiver) => receiver.track.kind).sort());
        assert.deepEqual(trackKinds, kind === 'video' ? ['audio', 'video'] : ['audio']);
        await page.waitForFunction(async () => {
          const stats = await testPeers.at(-1).getStats();
          return [...stats.values()].some((report) => report.type === 'inbound-rtp' && report.bytesReceived > 1000);
        });
      }
      await alice.locator('#callMuteButton').click();
      assert.equal(await alice.evaluate(() => testStreams.at(-1).getAudioTracks()[0].enabled), false);
      await alice.locator('#callMuteButton').click();
      if (kind === 'video') {
        await alice.locator('#callCameraButton').click();
        assert.equal(await alice.evaluate(() => testStreams.at(-1).getVideoTracks()[0].enabled), false);
        await alice.locator('#callCameraButton').click();
      }
      await (kind === 'video' ? bob : alice).locator('#callEndButton').click();
      for (const page of [alice, bob]) {
        await page.locator('#callDialog').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), true);
      }
      console.log(`PASS ${kind}: received media, controls, remote hang-up and capture cleanup`);
    }
    await alice.locator('#voiceCallButton').click();
    await bob.locator('#callDeclineButton').click();
    await alice.locator('#callDialog').waitFor({ state: 'hidden' });
    console.log('PASS incoming decline');

    await alice.evaluate(() => { window.holdTestCapture = true; });
    await alice.locator('#videoCallButton').click();
    await alice.waitForFunction(() => typeof window.releaseTestCapture === 'function');
    await alice.locator('#callEndButton').click();
    await alice.evaluate(() => { window.holdTestCapture = false; window.releaseTestCapture(); });
    await alice.waitForFunction(() => testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')));
    console.log('PASS cancelled pending permission releases a controlled late media stream');

    await alice.locator('#voiceCallButton').click();
    await bob.locator('#callAcceptButton').click();
    await alice.waitForFunction(() => document.querySelector('#callStatus').textContent === 'Connected');
    await first.request.post(`${origin}/api/logout`);
    await bob.locator('#callDialog').waitFor({ state: 'hidden' });
    await alice.locator('#callDialog').waitFor({ state: 'hidden' });
    assert.equal(await alice.evaluate(() => testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), true);
    console.log('PASS server logout terminates an established call');
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught browser errors');
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await Promise.all(browsers.map((browser) => browser.close()));
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
