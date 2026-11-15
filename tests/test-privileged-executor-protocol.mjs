#!/usr/bin/env node
import assert from 'assert/strict';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';

import {
  DEFAULT_PRIVILEGED_EXECUTOR_SOCKET_PATH,
  PRIVILEGED_EXECUTOR_ACTION_EXEC,
  createPrivilegedExecutorRequestId,
  requestPrivilegedExecutor,
  resolvePrivilegedExecutorSocketPath,
} from '../lib/privileged-executor-protocol.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// --- helpers ---
function makeFakeServer(socketPath, handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {}); // suppress ECONNRESET when client aborts
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          try {
            const req = JSON.parse(buf.slice(0, buf.indexOf('\n')));
            handler(sock, req);
          } catch (err) {
            sock.end();
          }
        }
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

const tmpDir = await mkdtemp(join(tmpdir(), 'ragent-p3b-test-'));

// --- createPrivilegedExecutorRequestId ---
check('preq_ prefix', createPrivilegedExecutorRequestId().startsWith('preq_'));
const id1 = createPrivilegedExecutorRequestId();
check('preq_ length 25', id1.length === 25); // preq_ (5) + randomBytes(10) hex (20) = 25
check('preq_ id starts with preq_', id1.startsWith('preq_'));
check('preq_ ids unique', id1 !== createPrivilegedExecutorRequestId());

// --- resolvePrivilegedExecutorSocketPath ---
const savedEnv = process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET;
delete process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET;
check('default socket path', resolvePrivilegedExecutorSocketPath() === DEFAULT_PRIVILEGED_EXECUTOR_SOCKET_PATH);
process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET = '/custom/sock';
check('env override', resolvePrivilegedExecutorSocketPath() === '/custom/sock');
if (savedEnv !== undefined) process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET = savedEnv; else delete process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET;

// --- constants ---
check('exec action constant', PRIVILEGED_EXECUTOR_ACTION_EXEC === 'exec');

// =============================================================================
// requestPrivilegedExecutor — fake socket tests
// =============================================================================

// --- happy path: round-trip ---
{
  const sockPath = join(tmpDir, 'happy.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('happy req has id', typeof req.id === 'string' && req.id.startsWith('preq_'));
    check('happy req action exec', req.action === 'exec');
    check('happy req token present', req.token && req.token.opId === 'pop_test');
    sock.end(JSON.stringify({ ok: true, id: req.id, result: { opId: 'pop_test', exitCode: 0 } }) + '\n');
  });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: { opId: 'pop_test' } },
    { socketPath: sockPath },
  );
  check('happy resp ok', resp.ok === true);
  check('happy resp result exitCode 0', resp.result.exitCode === 0);
  check('happy resp id preserved', resp.id.startsWith('preq_'));
  server.close();
}

// --- explicit id (caller-supplied) ---
{
  const sockPath = join(tmpDir, 'explicit-id.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('explicit id matches', req.id === 'preq_my-custom-id');
    sock.end(JSON.stringify({ ok: true, id: req.id }) + '\n');
  });
  const resp = await requestPrivilegedExecutor(
    { id: 'preq_my-custom-id', action: 'exec', token: {} },
    { socketPath: sockPath },
  );
  check('explicit resp ok', resp.ok === true);
  server.close();
}

// --- error response (ok: false from executor) ---
{
  const sockPath = join(tmpDir, 'error-resp.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({ ok: false, id: req.id, error: 'token expired', code: 'PRIVILEGED_TOKEN_EXPIRED' }) + '\n');
  });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: {} },
    { socketPath: sockPath },
  );
  check('error resp ok false', resp.ok === false);
  check('error resp code', resp.code === 'PRIVILEGED_TOKEN_EXPIRED');
  server.close();
}

// --- auditLabel round-trip ---
{
  const sockPath = join(tmpDir, 'audit-label.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('auditLabel transmitted', req.auditLabel === 'install nginx v1.2.3');
    sock.end(JSON.stringify({ ok: true, id: req.id }) + '\n');
  });
  await requestPrivilegedExecutor(
    { action: 'exec', token: {}, auditLabel: 'install nginx v1.2.3' },
    { socketPath: sockPath },
  );
  server.close();
}

// --- timeout ---
{
  const sockPath = join(tmpDir, 'timeout.sock');
  const server = await makeFakeServer(sockPath, (_sock, _req) => {
    // never respond — trigger timeout
  });
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: sockPath, timeoutMs: 1_000 },
    );
    check('timeout should throw', false);
  } catch (err) {
    check('timeout error code', err.code === 'PRIVILEGED_EXECUTOR_TIMEOUT');
    check('timeout message', err.message.includes('timed out'));
  }
  server.close();
}

// --- response too large ---
{
  const sockPath = join(tmpDir, 'too-large.sock');
  const server = await makeFakeServer(sockPath, (sock, _req) => {
    // send > 6 MiB with no newline — triggers size cap
    const big = 'x'.repeat(7 * 1024 * 1024);
    sock.end(big); // no newline, buffer grows past MAX_RESPONSE_BYTES
  });
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: sockPath },
    );
    check('too-large should throw', false);
  } catch (err) {
    check('too-large error code', err.code === 'PRIVILEGED_EXECUTOR_RESPONSE_TOO_LARGE');
  }
  server.close();
}

// --- invalid JSON response ---
{
  const sockPath = join(tmpDir, 'invalid-json.sock');
  const server = await makeFakeServer(sockPath, (sock, _req) => {
    sock.end('this is not json\n');
  });
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: sockPath },
    );
    check('invalid json should throw', false);
  } catch (err) {
    check('invalid json error code', err.code === 'PRIVILEGED_EXECUTOR_INVALID_RESPONSE');
  }
  server.close();
}

// --- empty response (close without response) ---
{
  const sockPath = join(tmpDir, 'empty.sock');
  const server = await makeFakeServer(sockPath, (sock, _req) => {
    sock.end(); // close immediately, no data
  });
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: sockPath },
    );
    check('empty resp should throw', false);
  } catch (err) {
    check('empty resp error code', err.code === 'PRIVILEGED_EXECUTOR_EMPTY_RESPONSE');
  }
  server.close();
}

// --- connection refused (non-existent socket) ---
{
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: join(tmpDir, 'does-not-exist.sock') },
    );
    check('conn refused should throw', false);
  } catch (err) {
    check('conn refused is error', err instanceof Error);
  }
}

// --- response split across multiple data events ---
{
  const sockPath = join(tmpDir, 'chunked.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    const resp = JSON.stringify({ ok: true, id: req.id, result: { exitCode: 0 } }) + '\n';
    // split into 3 chunks
    sock.write(resp.slice(0, 10));
    setTimeout(() => sock.write(resp.slice(10, 25)), 10);
    setTimeout(() => sock.end(resp.slice(25)), 20);
  });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: {} },
    { socketPath: sockPath },
  );
  check('chunked resp ok', resp.ok === true);
  check('chunked resp exitCode 0', resp.result.exitCode === 0);
  server.close();
}

// --- multiple newlines (takes first line only) ---
{
  const sockPath = join(tmpDir, 'multi-newline.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({ ok: true, id: req.id }) + '\n' + 'garbage second line\n');
  });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: {} },
    { socketPath: sockPath },
  );
  check('multi newline resp ok', resp.ok === true);
  server.close();
}

// --- default timeout clamping ---
// Test that timeoutMs is clamped: values < 1000 -> 1000, values > 35*60*1000 -> 35*60*1000
// We verify via a fast timeout that the lower clamp works.
{
  const sockPath = join(tmpDir, 'clamp-low.sock');
  const server = await makeFakeServer(sockPath, (_sock, _req) => {
    // never respond
  });
  const start = Date.now();
  try {
    await requestPrivilegedExecutor(
      { action: 'exec', token: {} },
      { socketPath: sockPath, timeoutMs: 0 }, // would be 0, should clamp to 1000
    );
  } catch (_err) {
    const elapsed = Date.now() - start;
    check('clamped timeout >= 1000ms', elapsed >= 900); // allow small timing variance
  }
  server.close();
}

// --- max timeout clamp (35 min) ---
// Don't actually wait 35 min; just verify the clamp logic doesn't reject the value.
// The transport clamps to max 35*60*1000. We pass a huge value and verify the
// call doesn't throw immediately with an invalid argument error.
{
  const sockPath = join(tmpDir, 'clamp-high.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    sock.end(JSON.stringify({ ok: true, id: req.id }) + '\n');
  });
  const resp = await requestPrivilegedExecutor(
    { action: 'exec', token: {} },
    { socketPath: sockPath, timeoutMs: 999_999_999 }, // huge, clamped to 35 min
  );
  check('clamped high resp ok', resp.ok === true);
  server.close();
}

// --- empty payload default ---
{
  const sockPath = join(tmpDir, 'empty-payload.sock');
  const server = await makeFakeServer(sockPath, (sock, req) => {
    check('empty payload has preq id', req.id.startsWith('preq_'));
    sock.end(JSON.stringify({ ok: true, id: req.id }) + '\n');
  });
  const resp = await requestPrivilegedExecutor({}, { socketPath: sockPath });
  check('empty payload resp ok', resp.ok === true);
  server.close();
}

// --- cleanup ---
await rm(tmpDir, { recursive: true, force: true });

console.log(`privileged-executor-protocol: ${passed} checks passed`);
