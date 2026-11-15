import assert from 'assert/strict';
import { access, readFile, unlink } from 'fs/promises';
import { execFileSync } from 'child_process';
import http from 'http';
import { arch } from 'process';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import {
  createReplayStore,
  issueBrowserConnectionGrant,
  issueSignalJoinToken,
  verifyBrowserConnectionGrant,
  verifySignalJoinToken,
} from '../lib/browser-connection-grant.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';
import { attachContractSignature, buildConnectionBootstrapContract, buildContractSigningPayload } from '../lib/connection-bootstrap-contract.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`test-browser-connectivity-poc skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const builtBinaryPath = process.env.RAGENT_PHASE0_P2P_BINARY ? '' : join(tmpdir(), `ragent-p2p-host-phase0-${process.pid}`);
if (builtBinaryPath) execFileSync('go', ['build', '-o', builtBinaryPath, './cmd/ragent-p2p-host'], { cwd: new URL('../p2p/', import.meta.url), stdio: 'ignore' });
const binaryPath = process.env.RAGENT_PHASE0_P2P_BINARY || builtBinaryPath || resolveP2PHostBinary();
await access(binaryPath);
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const resources = [];
const { privateKey: issuerPrivateKey, publicKey: issuerPublicKey } = generateKeyPairSync('ed25519');
const { privateKey: instancePrivateKey, publicKey: instancePublicKey } = generateKeyPairSync('ed25519');
const issuer = 'https://browser-test-issuer.invalid';
const keyId = 'browser-fixture-1';
const instanceId = 'ins_browser_poc';
const accountId = 'acct_browser_poc';
const signalSecret = 'browser-poc-signal-secret';
const roomId = createP2PRoomId(signalSecret);
const connectionId = 'conn_browser_poc';
const clientId = 'browser_poc_client';
const deviceId = 'device_browser_poc';
let observedRequest;

try {
  const target = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      observedRequest = { headers: request.headers };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, via: 'RemoteApiGateway' }));
      return;
    }
    response.writeHead(404); response.end();
  });
  resources.push(() => close(target));
  const targetAddress = await listen(target);

  const signalReplay = createReplayStore();
  const signaling = createP2PSignalingServer({
    host: '127.0.0.1',
    port: 0,
    authorizeJoin: ({ token, roomId: requestedRoomId, instanceId: requestedInstanceId, clientId: requestedClientId, connectionId: requestedConnectionId }) => {
      return verifySignalJoinToken(token, {
        trustedKeys: new Map([[keyId, issuerPublicKey]]),
        replayStore: signalReplay,
        expectedIssuer: issuer,
        expectedRoomId: requestedRoomId,
        expectedInstanceId: instanceId,
        expectedClientId: clientId,
        expectedConnectionId: connectionId,
      }).valid
        && requestedInstanceId === instanceId
        && requestedClientId === clientId
        && requestedConnectionId === connectionId;
    },
  });
  resources.push(() => signaling.close());
  const signalingAddress = await signaling.listen();
  const signalingUrl = `http://127.0.0.1:${signalingAddress.port}`;

  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret: signalSecret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    browserAuth: {
      publicKeyPem: issuerPublicKey.export({ type: 'spki', format: 'pem' }),
      keyId,
      issuer,
      instanceId,
    },
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;
  if (typeof host.child.__ragentWindowsJobList === 'function') {
    const jobPids = await host.child.__ragentWindowsJobList();
    assert.ok(jobPids?.pids?.map(Number).includes(Number(host.child.pid)), 'native P2P PE must be inside its Windows Job Object');
    console.log(`test-browser-connectivity-poc: Windows Job membership includes host pid ${host.child.pid}`);
  }

  const pocHtml = await readFile(new URL('../web-connectivity-poc/index.html', import.meta.url));
  const pocClient = await readFile(new URL('../web-connectivity-poc/client.js', import.meta.url));
  const p2pClient = await readFile(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url));
  const web = http.createServer((request, response) => {
    if (request.url === '/web-connectivity-poc/index.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(pocHtml); return; }
    if (request.url === '/web-connectivity-poc/client.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(pocClient); return; }
    if (request.url === '/static/p2p/ragent-p2p-client.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(p2pClient); return; }
    response.writeHead(404); response.end();
  });
  resources.push(() => close(web));
  const webAddress = await listen(web);

  const grantEndpointServer = http.createServer(async (request, response) => {
    if (request.url !== '/grant') { response.writeHead(404); response.end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }); response.end(); return; }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.accountId !== accountId || body.instanceId !== instanceId) {
      response.writeHead(403, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ error: 'account does not own instance' }));
      return;
    }
    const grant = issueBrowserConnectionGrant({
      privateKey: issuerPrivateKey,
      issuer,
      instanceId,
      accountId,
      clientId,
      connectionId,
      ephemeralPublicKey: body.ephemeralPublicKey,
      nowMs: Date.now(),
      ttlMs: 60_000,
      kid: keyId,
    });
    const instanceGrantCheck = verifyBrowserConnectionGrant(grant.token, {
      trustedKeys: new Map([[keyId, issuerPublicKey]]),
      expectedIssuer: issuer,
      expectedInstanceId: instanceId,
      expectedClientId: clientId,
      expectedConnectionId: connectionId,
      expectedAudience: `instance:${instanceId}`,
    });
    if (!instanceGrantCheck.valid) {
      response.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ error: `instance rejected browser grant: ${instanceGrantCheck.reason}` }));
      return;
    }
    const signal = issueSignalJoinToken({ privateKey: issuerPrivateKey, issuer, roomId, instanceId, clientId, connectionId, kid: keyId });
    const unsignedBootstrap = buildConnectionBootstrapContract({
      instanceId,
      deviceId,
      enrollmentKind: 'account-join',
      p2p: { signalingEndpoint: signalingUrl, roomId },
      turn: {
        provider: 'test-direct-harness',
        endpoint: 'stun:stun.l.google.com:19302',
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const bootstrap = attachContractSignature(unsignedBootstrap, {
      keyId: 'instance-browser-poc-1',
      signedAt: new Date().toISOString(),
      value: cryptoSign(null, Buffer.from(buildContractSigningPayload(unsignedBootstrap), 'utf8'), instancePrivateKey).toString('base64url'),
    });
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify({
      grant: grant.token,
      grantJtiPrefix: grant.payload.jti.slice(0, 12),
      signalJoinToken: signal.token,
      signalSecret,
      signalingUrl,
      roomId,
      instanceId,
      clientId,
      connectionId,
      deviceId,
      bootstrap,
      bootstrapPublicKey: {
        algorithm: 'ed25519',
        keyId: 'instance-browser-poc-1',
        publicKeyPem: instancePublicKey.export({ type: 'spki', format: 'pem' }),
      },
      turnOnly: false,
      testOnlyDirectHarness: true,
    }));
  });
  resources.push(() => close(grantEndpointServer));
  const grantAddress = await listen(grantEndpointServer);

  const wrongOwner = await fetch(`http://127.0.0.1:${grantAddress.port}/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'acct_other', instanceId, clientId, connectionId, ephemeralPublicKey: {} }),
  });
  assert.equal(wrongOwner.status, 403, 'test issuer rejects an account requesting another account\'s instance');

  // Windows may allocate a browser-blocked port (for example 6000) for the
  // ephemeral local fixture server. Allow the exact fixture port only.
  const browser = await chromium.launch({
    headless: true,
    args: [`--explicitly-allowed-ports=${webAddress.port}`],
  });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => pageErrors.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`));
  await page.addInitScript(({ grantUrl, instance, account, client, connection }) => {
    window.RAGENT_BROWSER_CONNECTIVITY_CONFIG = {
      grantEndpoint: grantUrl,
      instanceId: instance,
      accountId: account,
      clientId: client,
      connectionId: connection,
    };
  }, {
    grantUrl: `http://127.0.0.1:${grantAddress.port}/grant`,
    instance: instanceId,
    account: accountId,
    client: clientId,
    connection: connectionId,
  });
  await page.goto(`http://127.0.0.1:${webAddress.port}/web-connectivity-poc/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.RAGENTA_BROWSER_CONNECTIVITY_POC), { timeout: 5000 }).catch(() => {
    throw new Error(`browser PoC module did not load: ${pageErrors.join('; ')}`);
  });
  const result = await page.evaluate(async () => {
    await window.RAGENTA_BROWSER_CONNECTIVITY_POC.connect();
    await window.RAGENTA_BROWSER_CONNECTIVITY_POC.health();
    return {
      response: document.getElementById('response').textContent,
      turn: document.getElementById('turn').textContent,
      bootstrap: document.getElementById('bootstrap').textContent,
      auth: document.getElementById('auth').textContent,
      state: document.getElementById('connection').textContent,
      evidence: window.RAGENTA_BROWSER_CONNECTIVITY_POC.client.turnEvidence || null,
    };
  });
  assert.equal(result.state, 'Connected');
  assert.equal(result.auth, 'Authenticated browser principal');
  assert.equal(result.bootstrap, 'v2 verified');
  assert.match(result.response, /^200 /);
  assert.equal(result.evidence, null, 'local direct harness must not claim TURN evidence');
  assert.match(result.turn, /Direct harness/);
  assert.equal(observedRequest.headers['x-ragent-browser-principal'], 'browser');
  assert.equal(observedRequest.headers['x-ragent-browser-permissions'], 'remote.read.health');
  const tamperResult = await page.evaluate(async () => {
    const issued = await window.RAGENTA_BROWSER_CONNECTIVITY_POC.issueGrant();
    const tampered = structuredClone(issued.bootstrap);
    tampered.connectionMode = 'p2p-only';
    try {
      await window.RAGENTA_BROWSER_CONNECTIVITY_POC.verifyConnectionBootstrapV2(tampered, issued.bootstrapPublicKey);
      return 'accepted';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(tamperResult, /connection mode is not turn-first/);
  console.log('test-browser-connectivity-poc: Chromium protocol chain passed (local direct harness; TURN evidence BLOCKED)');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
  if (builtBinaryPath) await unlink(builtBinaryPath).catch(() => {});
}
