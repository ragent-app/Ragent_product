import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReadOnlyCodexMcp } from '../chat/codex-readonly-mcp.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-codex-mcp-'));
const workspace = join(root, 'workspace'), hidden = join(root, 'hidden'), fakeEmpty = join(root, 'fake-empty');
await mkdir(workspace); await mkdir(hidden); await mkdir(fakeEmpty);
let wrapped;
try {
  const fakeBuilder = ({ command, args }) => ({ command: '/usr/bin/bwrap', args: ['--', command, ...args], emptyDir: fakeEmpty });
  wrapped = await prepareReadOnlyCodexMcp({ cwd: workspace, workspace, hidePaths: [hidden], requireSandbox: () => true,
    sandboxBuilder: fakeBuilder, servers: { local: { command: 'node', args: ['server.js'], environment_id: 'local', env: { FIXTURE: 'yes' } },
      remote: { url: 'https://mcp.example.test', enabled: true } } });
  assert.deepEqual(wrapped.config.mcp_servers.local.args, ['--die-with-parent', '--', 'node', 'server.js']);
  assert.equal(Object.hasOwn(wrapped.config.mcp_servers.local, 'env'), false);
  assert.equal(Object.hasOwn(wrapped.config.mcp_servers, 'remote'), false);
  await wrapped.cleanup(); wrapped = null;
  await assert.rejects(prepareReadOnlyCodexMcp({ cwd: workspace, workspace, hidePaths: [workspace], servers: {} }), TypeError);
  await assert.rejects(prepareReadOnlyCodexMcp({ cwd: workspace, workspace, hidePaths: [hidden], requireSandbox: () => true,
    servers: { invalid: { command: 'node', url: 'https://mcp.example.test' } } }), TypeError);
  await assert.rejects(prepareReadOnlyCodexMcp({ cwd: workspace, workspace, hidePaths: [hidden], requireSandbox: () => true,
    servers: JSON.parse('{"__proto__":{"url":"https://mcp.example.test"}}') }), TypeError);

  if (process.platform === 'linux' && process.env.AGENTOC_TEST_CODEX_EXTERNAL_EXECUTOR === '1') {
    const protectedFile = join(workspace, 'protected.txt'), fixture = join(root, 'mcp.mjs');
    await writeFile(protectedFile, 'original');
    await writeFile(fixture, `import { writeFileSync } from 'node:fs'; try { writeFileSync(${JSON.stringify(protectedFile)}, 'changed'); console.log('writable'); } catch { console.log('blocked'); }`);
    wrapped = await prepareReadOnlyCodexMcp({ cwd: workspace, workspace, hidePaths: [hidden],
      servers: { local: { command: process.execPath, args: [fixture] } } });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(wrapped.config.mcp_servers.local.command, wrapped.config.mcp_servers.local.args, { cwd: workspace });
      let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), 'blocked');
    assert.equal(await readFile(protectedFile, 'utf8'), 'original');
    console.log('test-codex-readonly-mcp: real MCP write was blocked');
  } else console.log('test-codex-readonly-mcp: unit checks passed; Linux integration skipped');
} finally {
  await wrapped?.cleanup();
  await rm(root, { recursive: true, force: true });
}
