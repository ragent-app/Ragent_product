#!/usr/bin/env node
// AgentoC-as-Codex-MCP-server contract: stdio transport, JSON-RPC 2.0,
// one JSON object per line. Verifies initialize / tools/list / tools/call
// and the read-only metadata guarantee (session bodies never appear).
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const serverPath = join(repoRoot, 'scripts', 'agentoc-mcp-server.mjs');

function buildTempConfig() {
  const home = mkdtempSync(join(tmpdir(), 'agentoc-mcp-server-'));
  writeFileSync(join(home, 'chat-sessions.json'), JSON.stringify({
    0: {
      id: 'sess-1',
      name: 'Test session',
      group: 'Tests',
      description: 'A test session',
      tool: 'codex-json',
      created: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    1: {
      id: 'sess-2',
      name: 'Older session',
      tool: 'codex-json',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }));
  return home;
}

function startMcpServer(home) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, AGENTOC_CONFIG_DIR: home },
  });
  let buffer = '';
  const byId = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && message.id !== null) {
        byId.set(message.id, message);
      }
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (byId.has(id)) return resolve(byId.get(id));
      if (Date.now() - started > timeoutMs) return reject(new Error(`no response for id ${id}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  return { child, send, waitFor };
}

async function run() {
  const home = buildTempConfig();
  const mcp = startMcpServer(home);
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'phase1-test', version: '0' },
    } });
    const initialize = await mcp.waitFor(1);
    assert.equal(initialize.result?.serverInfo?.name, 'ragent', 'server should identify as ragent');
    assert.equal(initialize.result?.protocolVersion, '2024-11-05', 'protocol version should be echoed');

    // Notifications must never produce a response.
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await mcp.waitFor(2);
    const toolNames = list.result?.tools?.map((tool) => tool.name) || [];
    assert.deepEqual(toolNames, [
      'ragent_list_sessions',
      'ragent_get_session',
      'ragent_list_orchestrations',
      'ragent_get_orchestration',
    ], 'expected tool set');

    mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'ragent_list_sessions',
      arguments: { limit: 5 },
    } });
    mcp.send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: {
      name: 'agentoc_list_sessions', arguments: { limit: 5 },
    } });
    const legacyListed = await mcp.waitFor(30);
    const listed = await mcp.waitFor(3);
    assert.deepEqual(legacyListed.result, listed.result, 'cached legacy tool calls remain compatible');
    const listedText = listed.result?.content?.[0]?.text || '';
    assert.ok(listedText.includes('sess-1'), 'list should include newest session');
    assert.ok(listedText.includes('sess-2'), 'list should include both sessions');
    assert.ok(listedText.indexOf('sess-1') < listedText.indexOf('sess-2'), 'list should sort by updatedAt desc');
    assert.ok(!listedText.includes('message') && !listedText.includes('content'), 'list must never expose bodies');

    mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'ragent_get_session',
      arguments: { sessionId: 'sess-1' },
    } });
    const got = await mcp.waitFor(4);
    const gotText = got.result?.content?.[0]?.text || '';
    assert.ok(gotText.includes('Test session'), 'get should return session metadata');
    assert.ok(!gotText.includes('message'), 'get must never expose conversation bodies');

    mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
      name: 'ragent_get_session',
      arguments: { sessionId: 'missing' },
    } });
    const missing = await mcp.waitFor(5);
    assert.equal(missing.result?.isError, true, 'unknown session should surface as a tool error');

    mcp.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
      name: 'ragent_list_sessions',
      arguments: { limit: 1 },
    } });
    const limited = await mcp.waitFor(6);
    const limitedText = limited.result?.content?.[0]?.text || '';
    assert.ok(limitedText.includes('sess-1') && !limitedText.includes('sess-2'), 'limit should cap results');

    mcp.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
      name: 'ragent_list_orchestrations',
      arguments: { rootSessionId: 'sess-1' },
    } });
    const orchestrations = await mcp.waitFor(8);
    const orchestrationText = orchestrations.result?.content?.[0]?.text || '';
    assert.ok(orchestrationText.includes('executions'), 'orchestration list should return a durable projection');
    assert.equal(orchestrations.result?.isError, false, 'orchestration list should be read-only and succeed without rows');

    mcp.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
      name: 'ragent_get_orchestration',
      arguments: { executionId: 'missing-execution' },
    } });
    const missingOrchestration = await mcp.waitFor(9);
    assert.equal(missingOrchestration.result?.isError, true, 'unknown orchestration should surface as a tool error');

    mcp.send({ jsonrpc: '2.0', id: 7, method: 'unknown-method' });
    const unknown = await mcp.waitFor(7);
    assert.equal(unknown.error?.code, -32601, 'unknown methods should return JSON-RPC method-not-found');

    console.log('test-agentoc-mcp-server: ok');
  } finally {
    mcp.child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
