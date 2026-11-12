#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  BROWSER_CAPABILITY_VERSION,
  hashBrowserCapabilityToken,
  createRunBrowserCapability,
  validateBrowserCapabilityChannel,
} from '../chat/browser-capability.mjs';
import {
  createRun,
  getRunManifest,
  runBrowserArtifactDir,
  runBrowserCapabilityPath,
  runDir,
  readRunBrowserToken,
  sessionBrowserProfileDir,
} from '../chat/runs.mjs';
import { removePath } from '../chat/fs-utils.mjs';
import { collectBrowserArtifactFilesFromRun } from '../chat/session-result-files.mjs';
import { handleBrowserInternalRoutes } from '../chat/router-browser-internal-routes.mjs';

const repoRoot = join(import.meta.dirname, '..');
const browserMcpPath = join(repoRoot, 'scripts', 'agentoc-browser-mcp-server.mjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readResponses(child) {
  const lineReader = createInterface({ input: child.stdout });
  const pending = new Map();
  lineReader.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      waiter(response);
    } catch {
      // Ignore provider-side diagnostics that are not JSON-RPC responses.
    }
  });
  return (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timed out waiting for browser MCP response ${id}`));
    }, 10_000);
    timer.unref?.();
  });
}

async function testCapabilityAndArtifactPublishing() {
  const capability = createRunBrowserCapability({
    runId: 'run-capability',
    sessionId: 'session-capability',
    turnId: 'turn-capability',
    now: Date.parse('2026-08-27T00:00:00.000Z'),
  });
  assert.equal(capability.version, BROWSER_CAPABILITY_VERSION);
  assert.ok(capability.token);
  assert.equal(capability.tokenHash, hashBrowserCapabilityToken(capability.token));
  const channel = {
    enabled: true,
    ...capability,
  };
  assert.equal(validateBrowserCapabilityChannel(channel, {
    runId: capability.runId,
    sessionId: capability.sessionId,
    turnId: capability.turnId,
  }).valid, true);
  assert.equal(validateBrowserCapabilityChannel({ ...channel, enabled: false }).valid, false);
  assert.equal(validateBrowserCapabilityChannel({ ...channel, version: 'browser-capability/v0' }).valid, false);
  assert.equal(sessionBrowserProfileDir('session-a'), sessionBrowserProfileDir('session-a'));
  assert.notEqual(sessionBrowserProfileDir('session-a'), sessionBrowserProfileDir('session-b'));

  const runId = `run_browser_test_${randomBytes(8).toString('hex')}`;
  const ordinaryRunId = `run_ordinary_test_${randomBytes(8).toString('hex')}`;
  try {
    await createRun({
      status: {
        id: ordinaryRunId,
        sessionId: 'session-browser-test',
        requestId: 'turn-ordinary-test',
        state: 'running',
      },
      manifest: {
        sessionId: 'session-browser-test',
        requestId: 'turn-ordinary-test',
        folder: repoRoot,
        prompt: 'ordinary capability fixture',
      },
    });
    const ordinaryManifest = await getRunManifest(ordinaryRunId);
    assert.equal(ordinaryManifest.options?.browserChannel, undefined);
    await assert.rejects(stat(runBrowserCapabilityPath(ordinaryRunId)), { code: 'ENOENT' });

    const run = await createRun({
      status: {
        id: runId,
        sessionId: 'session-browser-test',
        requestId: 'turn-browser-test',
        state: 'running',
      },
      manifest: {
        sessionId: 'session-browser-test',
        requestId: 'turn-browser-test',
        folder: repoRoot,
        prompt: 'browser capability fixture',
        options: { browserMcpEnabled: true },
      },
    });
    const manifest = await getRunManifest(runId);
    const channel = manifest.options.browserChannel;
    assert.equal(channel.version, BROWSER_CAPABILITY_VERSION);
    assert.equal(Object.hasOwn(channel, 'token'), false);
    const token = await readRunBrowserToken(runId);
    assert.ok(token);
    assert.equal(channel.tokenHash, hashBrowserCapabilityToken(token));
    assert.equal((await stat(runBrowserCapabilityPath(runId))).mode & 0o777, 0o600);

    const artifactDir = runBrowserArtifactDir(runId);
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await writeFile(join(artifactDir, 'browser-report.csv'), 'name,value\nA,1\n');
    const files = [...(await collectBrowserArtifactFilesFromRun(run, manifest)).values()];
    assert.deepEqual(files.map((file) => file.originalName), ['browser-report.csv']);
    assert.equal(files[0].mimeType, 'text/csv');
  } finally {
    await removePath(runDir(runId));
    await removePath(runDir(ordinaryRunId));
  }
}

async function testBrowserMcp() {
  const pageServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Browser fixture</title></head><body><input id="name"><button id="submit">Submit</button></body></html>');
  });
  const approvals = [];
  const approvalServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      approvals.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'approved', approvalId: JSON.parse(body).approvalId }));
    });
  });
  const pagePort = await listen(pageServer);
  const approvalPort = await listen(approvalServer);
  const tempRoot = join(repoRoot, 'artifacts', `browser-test-${randomBytes(6).toString('hex')}`);
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [browserMcpPath], {
    env: {
      ...process.env,
      AGENTOC_BROWSER_MCP_ENABLED: '1',
      AGENTOC_BROWSER_TOKEN: 'browser-fixture-token',
      AGENTOC_BROWSER_CONFIRMATION_ENDPOINT: `http://127.0.0.1:${approvalPort}/confirmations`,
      AGENTOC_BROWSER_SESSION_ID: 'session-browser-fixture',
      AGENTOC_BROWSER_RUN_ID: 'run-browser-fixture',
      AGENTOC_BROWSER_TURN_ID: 'turn-browser-fixture',
      AGENTOC_BROWSER_PROFILE_DIR: join(tempRoot, 'profile'),
      AGENTOC_BROWSER_ARTIFACT_DIR: join(tempRoot, 'artifacts'),
      AGENTOC_BROWSER_HEADLESS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const request = readResponses(child);
  try {
    const initialized = await request(1, 'initialize');
    assert.equal(initialized.result.serverInfo.name, 'ragent-browser');
    const listed = await request(2, 'tools/list');
    assert.ok(listed.result.tools.some((tool) => tool.name === 'ragent_browser_click'));

    const navigated = await request(3, 'tools/call', {
      name: 'ragent_browser_navigate',
      arguments: { url: `http://127.0.0.1:${pagePort}/fixture` },
    });
    assert.equal(navigated.result.isError, false);
    const snapshot = await request(4, 'tools/call', {
      name: 'ragent_browser_snapshot', arguments: {},
    });
    assert.match(snapshot.result.content[0].text, /Browser fixture/);
    const legacySnapshot = await request(40, 'tools/call', { name: 'agentoc_browser_snapshot', arguments: {} });
    assert.match(legacySnapshot.result.content[0].text, /Browser fixture/);
    const filled = await request(5, 'tools/call', {
      name: 'ragent_browser_fill',
      arguments: { selector: '#name', value: 'secret-value' },
    });
    assert.equal(filled.result.isError, false);
    const filledAgain = await request(6, 'tools/call', {
      name: 'ragent_browser_fill',
      arguments: { selector: '#name', value: 'different-secret' },
    });
    assert.equal(filledAgain.result.isError, false);
    const clicked = await request(7, 'tools/call', {
      name: 'ragent_browser_click',
      arguments: { selector: '#submit' },
    });
    assert.equal(clicked.result.isError, false);
    const screenshot = await request(8, 'tools/call', {
      name: 'ragent_browser_screenshot', arguments: {},
    });
    assert.equal(screenshot.result.isError, false);
    const screenshotInfo = JSON.parse(screenshot.result.content[0].text);
    assert.equal(screenshotInfo.kind, 'screenshot');
    assert.ok((await stat(screenshotInfo.path)).size > 0);
    assert.equal(approvals.length, 3);
    assert.equal(approvals[0].operation, 'browser.fill');
    assert.equal(approvals[1].operation, 'browser.fill');
    assert.equal(approvals[2].operation, 'browser.click');
    assert.notEqual(approvals[0].approvalId, approvals[1].approvalId, 'different fill values need distinct approvals');
    assert.doesNotMatch(JSON.stringify(approvals), /secret-value|different-secret/);
  } finally {
    child.stdin.end();
    await once(child, 'exit');
    await close(pageServer);
    await close(approvalServer);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function testBrowserRoutes() {
  const token = 'route-fixture-token';
  const base = {
    id: 'run-route-fixture',
    sessionId: 'session-route-fixture',
    state: 'running',
    finalizedAt: null,
  };
  const manifest = {
    sessionId: base.sessionId,
    options: {
      browserChannel: {
        enabled: true,
        version: BROWSER_CAPABILITY_VERSION,
        endpoint: '/api/internal/browser/confirmations',
        tokenHash: hashBrowserCapabilityToken(token),
        runId: base.id,
        sessionId: base.sessionId,
        turnId: 'turn-route-fixture',
        tokenFile: 'browser.cap',
        profileDir: 'browser/profile',
        artifactDir: 'browser/artifacts',
        artifactChannel: 'run-artifacts/v1',
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  };
  const headers = {
    'x-agentoc-browser-token': token,
    'x-agentoc-browser-session-id': base.sessionId,
    'x-agentoc-browser-run-id': base.id,
    'x-agentoc-browser-turn-id': 'turn-route-fixture',
  };
  const confirmations = [];
  const responses = [];
  const writeJson = (res, status, payload) => responses.push({ status, payload });
  const deps = {
    req: { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers },
    res: {},
    pathname: '/api/internal/browser/confirmations',
    writeJson,
    getRun: async () => base,
    getRunManifest: async () => manifest,
    readRuntimeApprovalEvents: async () => [],
    getSessionEventsAfter: async () => {
      throw new Error('browser confirmation status must not scan the full Session history');
    },
    requestSessionConfirmation: async (sessionId, payload) => {
      confirmations.push({ sessionId, payload });
      return { duplicate: false };
    },
  };
  const body = JSON.stringify({
    approvalId: 'browser_route_1234',
    sessionId: base.sessionId,
    runId: base.id,
    turnId: 'turn-route-fixture',
    operation: 'browser.click',
    requestKey: 'route-1',
    reason: 'fixture',
  });
  const request = new EventEmitter();
  Object.assign(request, deps.req, { body });
  deps.req = request;
  process.nextTick(() => {
    request.emit('data', Buffer.from(body));
    request.emit('end');
  });
  await handleBrowserInternalRoutes(deps);
  assert.equal(responses.at(-1).status, 201);
  assert.equal(confirmations[0].payload.runId, base.id);

  const statusResponses = [];
  await handleBrowserInternalRoutes({
    ...deps,
    req: { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers },
    res: {},
    pathname: '/api/internal/browser/confirmations/browser_route_1234',
    writeJson: (res, status, payload) => statusResponses.push({ status, payload }),
    readRuntimeApprovalEvents: async () => [{
      type: 'approval_request', source: 'agentoc-confirmation', approvalId: 'browser_route_1234', runId: base.id,
    }, {
      type: 'approval_response', source: 'agentoc-confirmation', approvalId: 'browser_route_1234', runId: base.id, decision: 'approve', status: 'approved',
    }],
  });
  assert.equal(statusResponses.at(-1).payload.state, 'approved', JSON.stringify(statusResponses));

  const expired = {
    ...manifest,
    options: { browserChannel: { ...manifest.options.browserChannel, expiresAt: new Date(Date.now() - 1_000).toISOString() } },
  };
  const closedResponses = [];
  await handleBrowserInternalRoutes({
    ...deps,
    req: { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers },
    pathname: '/api/internal/browser/confirmations/browser_route_1234',
    writeJson: (res, status, payload) => closedResponses.push({ status, payload }),
    getRunManifest: async () => expired,
  });
  assert.equal(closedResponses.at(-1).status, 409);

  const terminalResponses = [];
  await handleBrowserInternalRoutes({
    ...deps,
    req: { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers },
    pathname: '/api/internal/browser/confirmations/browser_route_1234',
    writeJson: (res, status, payload) => terminalResponses.push({ status, payload }),
    getRun: async () => ({ ...base, state: 'completed', finalizedAt: new Date().toISOString() }),
  });
  assert.equal(terminalResponses.at(-1).status, 409);
}

await testCapabilityAndArtifactPublishing();
await testBrowserMcp();
await testBrowserRoutes();
console.log('managed browser channel tests passed');
