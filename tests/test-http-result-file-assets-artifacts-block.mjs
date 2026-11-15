#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const expectedOutputs = [
  { name: 'March report.xlsx', content: 'artifacts-block-result-1' },
  { name: 'notes summary.pdf', content: 'artifacts-block-result-2' },
];

function randomPort() {
  return 40000 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text, buffer });
      });
    });
    req.on('error', reject);
    if (body) {
      if (body instanceof Buffer) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-http-result-file-assets-artifacts-block-'));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  const exportDir = join(home, 'exports');
  const managedWorkRoot = mkdtempSync(join(homedir(), '.ragent-managed-work-root-test-'));
  const escapeRoot = mkdtempSync(join(homedir(), '.ragent-artifact-escape-test-'));
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(exportDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );

  const outputPaths = [
    join(exportDir, expectedOutputs[0].name),
    join(managedWorkRoot, expectedOutputs[1].name),
  ];
  const escapeTargetPath = join(escapeRoot, 'outside leak.pdf');
  const escapeSymlinkPath = join(managedWorkRoot, 'outside leak.pdf');
  writeFileSync(escapeTargetPath, 'should-not-publish', 'utf8');
  symlinkSync(escapeTargetPath, escapeSymlinkPath);
  const assistantMessage = `The exports are ready.\n\nArtifacts:\n- ${outputPaths[0]}\n- \`${outputPaths[1]}\`\n- ${escapeSymlinkPath}`;
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { dirname } = require('path');
const outputs = ${JSON.stringify(expectedOutputs)};
const outputPaths = ${JSON.stringify(outputPaths)};
const assistantMessage = ${JSON.stringify(assistantMessage)};
outputPaths.forEach((outputPath, index) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, outputs[index].content, 'utf8');
});
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-result-file-assets-artifacts-block' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: assistantMessage
  }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, managedWorkRoot, escapeRoot, outputPaths, escapeSymlinkPath };
}

async function startServer({ home, configDir, managedWorkRoot, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_AUTH_SESSION_SECRET: "test-secret-ragent-http-assets",
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: "1",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_MEMORY_DIR: join(home, '.ragent', 'memory'),
      RAGENT_WORK_ROOT_DIR: managedWorkRoot,
      SECURE_COOKIES: '0',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_ASSET_STORAGE_REGION: '',
      RAGENT_ASSET_STORAGE_ACCESS_KEY_ID: '',
      RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on("data", () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home, configDir, managedWorkRoot, escapeRoot, outputPaths, escapeSymlinkPath } = setupTempHome();
  const port = randomPort();
  let chatServer = await startServer({ home, configDir, managedWorkRoot, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Artifacts block result assets',
      systemPrompt: 'Return generated files when needed.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-result-file-asset-artifacts-block',
      text: 'Generate the exports and return them.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');

    const run = await waitForRunTerminal(port, messageRes.json.run.id);
    assert.equal(run.state, 'completed', 'run should complete');

    const resultMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      const generated = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'result_file_assets'
        && event.resultRunId === run.id
      ));
      const original = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && typeof event.content === 'string'
        && event.content.startsWith('The exports are ready.')
      ));
      return generated && original ? { generated, original } : false;
    }, 'artifacts-block result-file message');

    const generated = resultMessage.generated;
    assert.equal(generated.content, '', 'generated result message should carry no ready-to-download copy (product decision 2026-08-04)');
    assert.equal(generated.images?.length, expectedOutputs.length, 'generated result message should attach each accepted file and reject symlink escapes');
    assert.deepEqual(generated.images.map((image) => image.originalName), expectedOutputs.map((output) => output.name), 'generated attachments should preserve the declared file names');
    assert.deepEqual(generated.images.map((image) => image.mimeType), ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'], 'generated attachments should preserve the declared mime types');
    assert.deepEqual(generated.images.map((image) => image.sizeBytes), expectedOutputs.map((output) => Buffer.byteLength(output.content, 'utf8')), 'generated attachments should preserve file sizes');

    assert.match(resultMessage.original.content, /Artifacts:\s*\n-\s+.+exports\/March report\.xlsx/, 'raw assistant history should preserve the original artifact block path');
    assert.match(
      resultMessage.original.content,
      new RegExp(`\`${outputPaths[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``),
      'raw assistant history should preserve the original managed-work-root artifact block code span',
    );
    assert.match(
      resultMessage.original.content,
      new RegExp(escapeSymlinkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'raw assistant history should preserve rejected artifact candidates for auditability',
    );

    const visibleEventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      const assistant = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && typeof event.content === 'string'
        && event.content.startsWith('The exports are ready.')
      ));
      const delivery = events.find((event) => (
        event.type === 'attachment_delivery'
        && Array.isArray(event.attachments)
        && event.attachments.length === expectedOutputs.length
      ));
      return assistant && delivery ? { assistant, delivery } : false;
    }, 'visible artifacts-block message');

    assert.equal(
      visibleEventsRes.assistant.content,
      'The exports are ready.',
      'visible assistant content should strip the artifact block instead of leaking host-local paths',
    );
    assert.doesNotMatch(visibleEventsRes.assistant.content, new RegExp(outputPaths[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'visible assistant content should not leak the first host-local path');
    assert.doesNotMatch(visibleEventsRes.assistant.content, new RegExp(outputPaths[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'visible assistant content should not leak the second host-local path');
    assert.deepEqual(
      visibleEventsRes.delivery.attachments.map((attachment) => attachment.originalName),
      expectedOutputs.map((output) => output.name),
      'visible display events should expose the artifact block files as downloadable attachment rows',
    );
    assert.ok(
      visibleEventsRes.delivery.attachments.every((attachment) => attachment.renderAs === 'file' && !('savedPath' in attachment)),
      'visible artifact downloads should render as file cards without leaking host-local saved paths',
    );

    const assetId = generated.images[0].assetId;
    const assetRes = await request(port, 'GET', `/api/assets/${assetId}`);
    assert.equal(assetRes.status, 200, 'published result asset metadata should load');
    assert.equal(assetRes.json.asset.originalName, expectedOutputs[0].name, 'published asset should keep the declared filename');

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 200, 'published artifacts-block asset should stream locally');
    assert.equal(await downloadRes.text(), expectedOutputs[0].content, 'downloaded artifacts-block asset should match file contents');

    const managedAssetId = generated.images[1].assetId;
    const managedAssetRes = await request(port, 'GET', `/api/assets/${managedAssetId}`);
    assert.equal(managedAssetRes.status, 200, 'managed-work-root artifact metadata should load');
    assert.equal(managedAssetRes.json.asset.originalName, expectedOutputs[1].name, 'managed-work-root artifact should keep the declared filename');

    const managedDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${managedAssetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(managedDownloadRes.status, 200, 'managed-work-root artifact should stream locally');
    assert.equal(await managedDownloadRes.text(), expectedOutputs[1].content, 'downloaded managed-work-root artifact should match file contents');

    await stopServer(chatServer);
    chatServer = await startServer({ home, configDir, managedWorkRoot, port });

    const restartedAllRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
    assert.equal(restartedAllRes.status, 200, 'session history should load after restart');
    const restartedResultMessages = (restartedAllRes.json?.events || []).filter((event) => (
      event.type === 'message'
      && event.role === 'assistant'
      && event.source === 'result_file_assets'
      && event.resultRunId === run.id
    ));
    assert.equal(restartedResultMessages.length, 1, 'artifact publication should stay idempotent across restart');

    const restartedVisibleRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`);
    assert.equal(restartedVisibleRes.status, 200, 'visible session events should load after restart');
    const restartedDelivery = (restartedVisibleRes.json?.events || []).find((event) => (
      event.type === 'attachment_delivery'
      && Array.isArray(event.attachments)
      && event.attachments.length === expectedOutputs.length
    ));
    assert.ok(restartedDelivery, 'artifact download rows should still be visible after restart');
    assert.deepEqual(
      restartedDelivery.attachments.map((attachment) => attachment.originalName),
      expectedOutputs.map((output) => output.name),
      'restarted visible download rows should preserve artifact file names',
    );

    const restartedManagedDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${managedAssetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(restartedManagedDownloadRes.status, 200, 'managed-work-root artifact should still download after restart');
    assert.equal(await restartedManagedDownloadRes.text(), expectedOutputs[1].content, 'restarted managed-work-root download should match file contents');
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
    rmSync(managedWorkRoot, { recursive: true, force: true });
    rmSync(escapeRoot, { recursive: true, force: true });
  }

  console.log('test-http-result-file-assets-artifacts-block: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}
