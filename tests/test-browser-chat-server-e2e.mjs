#!/usr/bin/env node
// Production-shaped Browser -> Pion -> real chat-server evidence. This test is
// intentionally direct-harness only unless a real TURN configuration is supplied
// by a separate validation environment; it must never turn a direct result into
// TURN evidence.
import assert from 'assert/strict';
import { spawn, execFileSync } from 'child_process';
import { createHmac, generateKeyPairSync } from 'crypto';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import http from 'http';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { chromium } from '@playwright/test';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import {
  verifyConnectionBootstrapContract,
} from '../lib/connection-bootstrap-contract.mjs';
import {
  createReplayStore,
  issueBrowserConnectionGrant,
  issueSignalJoinToken,
  verifyBrowserConnectionGrant,
  verifySignalJoinToken,
} from '../lib/browser-connection-grant.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const supportedArch = ['arm64', 'x64'].includes(process.arch);
if (!supportedArch) {
  console.log(`test-browser-chat-server-e2e skipped on ${process.arch}; no supported sidecar`);
  process.exit(0);
}

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function jsonRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

const tempHome = await mkdtemp(join(tmpdir(), 'ragent-browser-chat-e2e-'));
const configDir = join(tempHome, 'config');
const localBin = join(tempHome, 'bin');
const { privateKey: authorityPrivateKey, publicKey: authorityPublicKey } = generateKeyPairSync('ed25519');
const authorityIssuer = 'https://browser-e2e-account-authority.invalid';
const authorityKeyId = 'browser-e2e-authority-1';
const instanceId = 'instance-browser-chat-e2e';
const accountId = 'account-browser-chat-e2e';
const deviceId = 'device-browser-chat-e2e';
const instanceSecret = 'browser-chat-e2e-instance-secret';
const signalSecret = createHmac('sha256', instanceSecret)
  .update(`ragent-p2p-device-secret-v1:${deviceId}`)
  .digest('hex');
const roomId = createP2PRoomId(signalSecret);
const binaryPath = process.env.RAGENT_PHASE0_P2P_BINARY || join(tmpdir(), `ragent-p2p-host-browser-e2e-${process.pid}`);
const builtBinary = !process.env.RAGENT_PHASE0_P2P_BINARY;
const resources = [];
const policyEvents = [];
const gatewayEvents = [];
const sidecarLogs = [];
let chatChild;
let host;
let turnBroker;
let hostIceServers = [];

try {
  const { mkdir, writeFile } = await import('fs/promises');
  const { privateKey: instancePrivateKey, publicKey: instancePublicKey } = generateKeyPairSync('ed25519');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'instance-identity.json'), JSON.stringify({
    version: 1,
    algorithm: 'ed25519',
    instanceId,
    publicKey: instancePublicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: instancePrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  process.env.RAGENT_INSTANCE_KEY_FILE = join(configDir, 'instance-identity.json');
  await Promise.all([
    mkdir(localBin, { recursive: true }),
    writeFile(join(configDir, 'auth.json'), JSON.stringify({ token: '0'.repeat(64) })),
    writeFile(join(configDir, 'auth-sessions.json'), '{}'),
    writeFile(join(configDir, 'tools.json'), '[]'),
    writeFile(join(configDir, 'trusted-devices.json'), JSON.stringify({
      version: 1,
      instanceId,
      instanceSecret,
      invitations: [],
      devices: [{
        id: deviceId,
        status: 'bound',
        enrollmentKind: 'account-join',
        accountId,
        deviceName: 'Browser connectivity test device',
        platform: 'test',
        devicePublicKey: 'test-device-public-key',
        createdAt: new Date().toISOString(),
        boundAt: new Date().toISOString(),
        revokedAt: '',
      }],
      challenges: [],
      authTokens: [],
      accountJoinIntents: [],
    })),
  ]);
  process.env.RAGENT_CONFIG_DIR = configDir;
  if (builtBinary) execFileSync('go', ['build', '-o', binaryPath, './cmd/ragent-p2p-host'], { cwd: join(repoRoot, 'p2p'), stdio: 'ignore' });
  await access(binaryPath);

  const chatPort = 40000 + Math.floor(Math.random() * 2000);
  const chatBase = `http://127.0.0.1:${chatPort}`;
  process.env.RAGENT_P2P_SIGNALING_URL = chatBase;

  // This server exercises the production broker client/service boundary with
  // a Cloudflare-shaped, short-lived fixture. It is deliberately not a TURN
  // server and can never produce real relay evidence.
  turnBroker = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/turn/credentials') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.headers.authorization !== 'Bearer browser-chat-e2e-broker') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'turn_broker_unauthorized' }));
      return;
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      protocolVersion: 1,
      provider: 'cloudflare-realtime',
      transport: 'turn',
      endpoint: 'turn:127.0.0.1:3478?transport=udp',
      iceServers: [{
        urls: 'turn:127.0.0.1:3478?transport=udp',
        username: `${Math.floor(Date.now() / 1000) + 60}:browser-chat-e2e`,
        password: 'short-lived-test-credential',
      }],
      expiresAt,
      appTrafficOnly: true,
      credentialScope: 'device-access',
      source: 'turn-broker',
      connectionId: body.connectionId,
    }));
  });
  const turnBrokerAddress = await listen(turnBroker);
  resources.push(() => close(turnBroker));
  process.env.RAGENT_TURN_BROKER_URL = `http://127.0.0.1:${turnBrokerAddress.port}`;
  process.env.RAGENT_TURN_BROKER_TOKEN = 'browser-chat-e2e-broker';
  process.env.RAGENT_TURN_BROKER_AUTH_MODE = 'static';

  const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
  const { buildDeviceConnectionBootstrapContract } = await import('../chat/connection-bootstrap-service.mjs');
  const { evaluateTurnConnectionAuthorization } = await import('../lib/turn-authorization.mjs');
  // Bootstrap contracts are signed by the durable instance identity. Keep the
  // test verifier on the same key as the production bootstrap service.
  const instancePublicKeyPem = (await loadOrCreateInstanceIdentity()).publicKey;
  const buildProductionBootstrap = () => buildDeviceConnectionBootstrapContract({
    deviceId,
    turnAuthorizationProvider: async (input) => evaluateTurnConnectionAuthorization({
      ...input,
      accountPlan: 'plus',
      deviceKind: 'computer',
      activeDeviceIds: [],
      activeInstanceIds: [],
      activePhones: 0,
      activeComputers: 0,
      accountMatches: true,
    }),
  });

  chatChild = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      PATH: `${localBin}${delimiter}${process.env.PATH}`,
      CHAT_PORT: String(chatPort),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_MEMORY_DIR: join(tempHome, 'memory'),
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_AUTH_SESSION_SECRET: 'browser-chat-e2e-session-secret',
      RAGENT_REPLY_SELF_CHECK: 'off',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_TURN_BROKER_URL: '',
      RAGENT_TURN_BROKER_TOKEN: '',
      RAGENT_TURN_BROKER_AUTH_MODE: 'static',
      // This test owns the host in the parent process so it can collect
      // policy/gateway evidence; do not let the child auto-recover the same
      // room and replace that host's signaling membership.
      RAGENT_P2P_HOST_RECOVERY: 'off',
      RAGENT_BROWSER_SIGNAL_ISSUER: authorityIssuer,
      RAGENT_BROWSER_SIGNAL_TRUSTED_KEYS_JSON: JSON.stringify({
        [authorityKeyId]: authorityPublicKey.export({ type: 'spki', format: 'pem' }),
      }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let chatStderr = '';
  chatChild.stderr.on('data', (chunk) => { chatStderr += chunk.toString(); });
  resources.push(async () => {
    if (chatChild?.exitCode === null) chatChild.kill('SIGTERM');
    await waitFor(() => chatChild?.exitCode !== null, 'chat-server shutdown').catch(() => {});
  });
  await waitFor(async () => {
    if (chatChild.exitCode !== null) throw new Error(`chat-server exited: ${chatStderr.slice(-1200)}`);
    try { return (await fetch(`${chatBase}/healthz`)).status === 200; } catch { return false; }
  }, 'real chat-server healthz');

  const grantServer = http.createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/grant') { response.writeHead(404); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (body.accountId !== accountId || body.instanceId !== instanceId) {
      response.writeHead(403, headers);
      response.end(JSON.stringify({ error: 'account does not own instance' }));
      return;
    }
    const clientId = String(body.clientId || 'browser-e2e-client');
    const connectionId = String(body.connectionId || `conn_${Date.now()}`);
    const grant = issueBrowserConnectionGrant({
      privateKey: authorityPrivateKey,
      issuer: authorityIssuer,
      instanceId,
      accountId,
      clientId,
      connectionId,
      ephemeralPublicKey: body.ephemeralPublicKey,
      ttlMs: 60_000,
      kid: authorityKeyId,
    });
    const instanceGrantCheck = verifyBrowserConnectionGrant(grant.token, {
      trustedKeys: new Map([[authorityKeyId, authorityPublicKey]]),
      expectedIssuer: authorityIssuer,
      expectedInstanceId: instanceId,
      expectedClientId: clientId,
      expectedConnectionId: connectionId,
      expectedAudience: `instance:${instanceId}`,
    });
    if (!instanceGrantCheck.valid) {
      response.writeHead(500, headers);
      response.end(JSON.stringify({ error: `instance rejected browser grant: ${instanceGrantCheck.reason}` }));
      return;
    }
    const signal = issueSignalJoinToken({ privateKey: authorityPrivateKey, issuer: authorityIssuer, roomId, instanceId, clientId, connectionId, kid: authorityKeyId });
    const bootstrap = await buildProductionBootstrap();
    assert.equal(bootstrap.contractVersion, 2);
    assert.equal(bootstrap.connectionMode, 'turn-first');
    assert.equal(bootstrap.signature?.algorithm, 'ed25519');
    assert.equal(verifyConnectionBootstrapContract(bootstrap, instancePublicKeyPem).valid, true);
    response.writeHead(200, headers);
    response.end(JSON.stringify({
      grant: grant.token,
      grantJtiPrefix: grant.payload.jti.slice(0, 12),
      signalJoinToken: signal.token,
      signalSecret,
      roomId,
      instanceId,
      deviceId,
      clientId,
      connectionId,
      bootstrap,
      bootstrapPublicKey: {
        algorithm: 'ed25519',
        keyId: bootstrap.signature.keyId,
        publicKeyPem: instancePublicKeyPem,
      },
      testOnlyDirectIceServers: [],
      testOnlyDirectHarness: true,
    }));
  });
  resources.push(() => close(grantServer));
  const grantAddress = await listen(grantServer);

  const startHost = async () => {
    const hostBootstrap = await buildProductionBootstrap();
    assert.equal(hostBootstrap.contractVersion, 2);
    hostIceServers = [];
    host = await runP2PHostAgent({
      signalingUrl: chatBase,
      roomId,
      secret: signalSecret,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      binaryPath,
      localBaseUrl: chatBase,
      iceServers: hostIceServers,
      browserAuth: {
        publicKeyPem: authorityPublicKey.export({ type: 'spki', format: 'pem' }),
        keyId: authorityKeyId,
        issuer: authorityIssuer,
        instanceId,
      },
      onPolicyDecision: (event) => policyEvents.push(event),
      onGatewayResponse: (event) => gatewayEvents.push(event),
      onSidecarLog: (line) => sidecarLogs.push(line),
    });
    await host.ready;
  };
  const stopHost = async () => {
    if (!host) return;
    host.stop();
    await host.done;
    host = null;
  };
  resources.push(stopHost);
  await startHost();

  const pocHtml = await readFile(join(repoRoot, 'web-connectivity-poc/index.html'));
  const pocClient = await readFile(join(repoRoot, 'web-connectivity-poc/client.js'));
  const p2pClient = await readFile(join(repoRoot, 'static/p2p/ragent-p2p-client.js'));
  const pageServer = http.createServer((request, response) => {
    if (request.url === '/web-connectivity-poc/index.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(pocHtml); return; }
    if (request.url === '/web-connectivity-poc/client.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(pocClient); return; }
    if (request.url === '/static/p2p/ragent-p2p-client.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(p2pClient); return; }
    response.writeHead(404); response.end();
  });
  resources.push(() => close(pageServer));
  const pageAddress = await listen(pageServer);
  const browser = await chromium.launch({ headless: true });
  resources.push(() => browser.close());

  const configurePage = async (page) => {
    await page.addInitScript(({ grantUrl }) => {
      window.RAGENT_BROWSER_CONNECTIVITY_CONFIG = {
        grantEndpoint: grantUrl,
        instanceId: 'instance-browser-chat-e2e',
        accountId: 'account-browser-chat-e2e',
        clientId: `browser_${crypto.randomUUID().replaceAll('-', '')}`,
      };
    }, { grantUrl: `http://127.0.0.1:${grantAddress.port}/grant` });
    await page.goto(`http://127.0.0.1:${pageAddress.port}/web-connectivity-poc/index.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.RAGENTA_BROWSER_CONNECTIVITY_POC));
  };

  const positivePage = await browser.newPage();
  await configurePage(positivePage);
  const positive = await positivePage.evaluate(async () => {
    await window.RAGENTA_BROWSER_CONNECTIVITY_POC.connect();
    await window.RAGENTA_BROWSER_CONNECTIVITY_POC.health();
    return {
      state: document.getElementById('connection').textContent,
      bootstrap: document.getElementById('bootstrap').textContent,
      auth: document.getElementById('auth').textContent,
      response: document.getElementById('response').textContent,
      turn: document.getElementById('turn').textContent,
    };
  });
  assert.equal(positive.state, 'Connected');
  assert.equal(positive.bootstrap, 'v2 verified');
  assert.equal(positive.auth, 'Authenticated browser principal');
  assert.match(positive.response, /^200 /);
  assert.match(positive.turn, /Direct harness/);
  assert.ok(policyEvents.some((event) => event.decision === 'authenticated' && event.principalType === 'browser' && event.permission === 'remote.read.health' && event.path === '/healthz'));
  assert.ok(gatewayEvents.some((event) => event.path === '/healthz' && event.status === 200));

  const tamper = await positivePage.evaluate(async () => {
    const issued = await window.RAGENTA_BROWSER_CONNECTIVITY_POC.issueGrant();
    const altered = structuredClone(issued.bootstrap);
    altered.connectionMode = 'p2p-only';
    try {
      await window.RAGENTA_BROWSER_CONNECTIVITY_POC.verifyConnectionBootstrapV2(altered, issued.bootstrapPublicKey);
      return 'accepted';
    } catch (error) { return error.message; }
  });
  assert.match(tamper, /connection mode is not turn-first/);
  await positivePage.close();
  await stopHost();
  await startHost();

  const preAuthPage = await browser.newPage();
  await configurePage(preAuthPage);
  const preAuthState = await preAuthPage.evaluate(async () => {
    const unauthenticated = await window.RAGENTA_BROWSER_CONNECTIVITY_POC.connectWithoutBrowserAuth();
    const closed = new Promise((resolve) => unauthenticated.channel.addEventListener('close', () => resolve(true), { once: true }));
    unauthenticated.channel.send(JSON.stringify({ id: 'preauth-health', type: 'http_request', method: 'GET', path: '/healthz', headers: {}, bodyBase64: '' }));
    await closed;
    return unauthenticated.authState;
  });
  assert.equal(preAuthState, 'AUTHENTICATING');
  assert.equal(policyEvents.filter((event) => event.path === '/healthz').length, 1, 'pre-auth request must not reach the gateway policy');
  assert.equal(gatewayEvents.filter((event) => event.path === '/healthz').length, 1, 'pre-auth request must not reach the upstream gateway');
  await preAuthPage.close();
  await stopHost();
  await startHost();

  const wrongKeyPage = await browser.newPage();
  await configurePage(wrongKeyPage);
  const wrongKey = await wrongKeyPage.evaluate(async () => {
    try {
      await window.RAGENTA_BROWSER_CONNECTIVITY_POC.connectWithWrongKey();
      return 'accepted';
    } catch (error) { return error.message; }
  });
  assert.match(wrongKey, /browser authentication rejected|browser authentication timed out/);
  assert.ok(sidecarLogs.some((line) => line.includes('browser_auth event=auth_rejected reason=browser proof rejected')));
  assert.equal(policyEvents.filter((event) => event.path === '/healthz').length, 1, 'wrong-key auth must not reach the gateway policy');
  await wrongKeyPage.close();

  console.log('test-browser-chat-server-e2e: real Chromium + real chat-server + real gateway path passed; TURN evidence BLOCKED (direct harness)');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
  if (builtBinary) await rm(binaryPath, { force: true }).catch(() => {});
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
}
