import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startReadOnlyCodexExecutor } from '../chat/codex-readonly-executor.mjs';

await assert.rejects(startReadOnlyCodexExecutor({ command: '/bin/true', cwd: '/workspace', workspace: '/workspace', hidePaths: ['/workspace'] }), TypeError);
await assert.rejects(startReadOnlyCodexExecutor({ command: 'relative', cwd: '/workspace', workspace: '/workspace', hidePaths: ['/secret'] }), TypeError);

if (process.platform !== 'linux' || process.env.AGENTOC_TEST_CODEX_EXTERNAL_EXECUTOR !== '1') {
  console.log('test-codex-readonly-executor: unit checks passed; Linux integration skipped');
} else {
  const command = process.env.AGENTOC_TEST_CODEX_BINARY;
  if (!command?.startsWith('/')) throw new Error('An absolute AGENTOC_TEST_CODEX_BINARY is required');
  const root = await mkdtemp(join(tmpdir(), 'ragent-codex-executor-'));
  const workspace = join(root, 'workspace'), hidden = join(root, 'hidden');
  await mkdir(workspace); await mkdir(hidden);
  let executor;
  try {
    executor = await startReadOnlyCodexExecutor({ command, cwd: workspace, workspace, hidePaths: [hidden] });
    assert.match(executor.execServerUrl, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(executor.authBearerToken, /^[a-f0-9]{64}$/);
    const connect = token => new Promise((resolve, reject) => {
      const req = request(executor.execServerUrl.replace(/^ws:/, 'http:'), { headers: {
        authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'),
      } });
      req.once('response', res => { res.resume(); resolve(res.statusCode); });
      req.once('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.once('error', reject); req.end();
    });
    assert.equal(await connect('incorrect-fixture-token'), 401);
    assert.equal(await connect(executor.authBearerToken), 101);
    await executor.stop();
    await executor.stop();
    console.log('test-codex-readonly-executor: sandboxed authenticated executor started and stopped');
  } finally {
    await executor?.stop();
    await rm(root, { recursive: true, force: true });
  }
}
