#!/usr/bin/env node
import assert from 'assert/strict';
import { createHash, randomBytes } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import http from 'http';
import { createServer as createNetServer } from 'net';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

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

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(port) || port <= 0) {
          reject(new Error('OS did not return an ephemeral test port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'agentoc-codex-app-server-sidecar-'));
  const configDir = join(home, '.config', 'agentoc');
  const memoryDir = join(home, '.agentoc', 'memory');
  const workDir = join(home, '.agentoc', 'workspace');
  const providerHomesDir = join(home, '.agentoc', 'provider-homes');
  const providerCodexHome = join(providerHomesDir, 'codex');
  const localBin = join(home, '.local', 'bin');
  const recordPath = join(home, 'fake-app-server-messages.jsonl');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(providerCodexHome, { recursive: true });
  mkdirSync(localBin, { recursive: true });

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
  writeFileSync(join(providerCodexHome, 'auth.json'), JSON.stringify({ test: true }), 'utf8');
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex-app-server',
        name: 'Fake Codex App Server',
        command: join(localBin, process.platform === 'win32' ? 'fake-codex-app-server.cmd' : 'fake-codex-app-server'),
        runtimeFamily: 'codex-app-server-json',
        models: [
          { id: 'fake-model', label: 'Fake Model' },
          { id: 'fake-mcp-missing', label: 'Fake MCP Missing Schema' },
          { id: 'fake-mcp-unsupported', label: 'Fake MCP Unsupported' },
          { id: 'fake-mcp-inventory-blocked', label: 'Fake MCP Inventory Blocked' },
          { id: 'fake-thread-error', label: 'Fake Thread Start Error' },
        ],
        reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex-app-server'),
    `#!/usr/bin/env node
const fs = require('fs');
${process.platform === 'win32' ? `Object.assign(process.env, JSON.parse(fs.readFileSync(${JSON.stringify(join(home, 'fixture-env.json'))}, 'utf8')));` : ''}
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const recordPath = process.env.FAKE_CODEX_APP_SERVER_RECORD;
const messages = [];
let threadId = '';
let staleResumeInjected = false;
let recoveredThread = false;
let pendingApproval = null;
let longTurnId = '';
let mcpReadySent = false;
let fixtureHookTrusted = false;
let mcpMode = process.env.FAKE_CODEX_APP_SERVER_MCP_MODE || '';
const delayedTurnStartMs = Number(process.env.FAKE_CODEX_APP_SERVER_TURN_START_DELAY_MS || '0');
if (recordPath) fs.appendFileSync(recordPath, JSON.stringify({ agentocFixtureProcessArgs: process.argv.slice(2), ragentEnv: { session: process.env.RAGENT_SESSION_ID, baseUrl: process.env.RAGENT_CHAT_BASE_URL, projectRoot: process.env.RAGENT_PROJECT_ROOT } }) + '\\n');
function record(message) {
  messages.push(message);
  // A stale-resume handoff starts a second app-server process. Append each
  // frame so a regression assertion can inspect both sides of the handoff.
  if (recordPath) fs.appendFileSync(recordPath, JSON.stringify(message) + '\\n');
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function managedMcpServerName() {
  return 'ragent_actions_' + crypto.createHash('sha256')
    .update(process.env.AGENTOC_RUN_ID || 'run', 'utf8')
    .digest('hex')
    .slice(0, 16);
}
function managedBrokerServerName() {
  return 'ragent_broker_' + crypto.createHash('sha256').update((process.env.AGENTOC_RUN_ID || 'run') + ':broker', 'utf8').digest('hex').slice(0, 16);
}
function threadPayload(id) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'fake',
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    path: null,
    cwd: process.cwd(),
    cliVersion: 'fake',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
function threadStartResult(params, id) {
  const sandboxType = params?.sandbox === 'workspace-write'
    ? 'workspaceWrite'
    : params?.sandbox === 'read-only'
      ? 'readOnly'
      : 'dangerFullAccess';
  return {
    thread: threadPayload(id),
    cwd: params?.cwd || '',
    runtimeWorkspaceRoots: params?.cwd ? [params.cwd] : [],
    approvalPolicy: params?.approvalPolicy || (params?.approvalsReviewer === 'user' ? 'untrusted' : 'on-request'),
    approvalsReviewer: params?.approvalsReviewer || null,
    sandbox: {
      type: sandboxType,
      ...(sandboxType === 'workspaceWrite' || sandboxType === 'readOnly' ? { networkAccess: false } : {}),
    },
  };
}
function finishTurn(turnId, { keepAliveMs = 0 } = {}) {
  send({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: 'Fake plan', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Patch', status: 'pending' }] } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-fake', delta: 'fake reply' } });
  send({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'msg-fake', text: 'fake reply', phase: null, memoryCitation: null } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'complete', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
  if (keepAliveMs > 0) {
    setTimeout(() => process.exit(0), keepAliveMs);
    return;
  }
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  if (pendingApproval && message.id === pendingApproval.id && message.result) {
    const accepted = message.result.decision === 'accept' || message.result.action === 'accept';
    if (!accepted) {
      send({ method: 'error', params: { error: { message: 'approval denied' }, turnId: pendingApproval.turnId } });
      process.exit(1);
      return;
    }
    const turnId = pendingApproval.turnId;
    pendingApproval = null;
    finishTurn(turnId);
    return;
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'linux', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'hooks/list') {
    const sourcePath = path.join(process.env.CODEX_HOME || '', 'hooks.json');
    let hook = null;
    try {
      const entries = JSON.parse(fs.readFileSync(sourcePath, 'utf8')).hooks?.PreToolUse || [];
      const entry = entries.find((value) => value.matcher === '^Bash$' && value.hooks?.[0]?.type === 'command');
      if (entry) hook = { source: 'user', isManaged: false, enabled: true, eventName: 'preToolUse', handlerType: 'command', matcher: '^Bash$',
        command: entry.hooks[0].command, sourcePath, key: sourcePath + ':pre_tool_use:0', currentHash: 'sha256:' + 'a'.repeat(64),
        trustStatus: fixtureHookTrusted ? 'trusted' : 'untrusted' };
    } catch {}
    send({ id: message.id, result: { data: [{ hooks: hook ? [hook] : [] }] } });
    return;
  }
  if (message.method === 'config/batchWrite') {
    fixtureHookTrusted = true;
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'thread/start') {
    if (message.params?.model === 'fake-thread-error') {
      send({
        id: message.id,
        error: { code: -32001, message: 'failed to load configuration: No such file or directory' },
      });
      process.exit(0);
      return;
    }
    if (message.params?.model === 'fake-mcp-missing') mcpMode = 'missing-schema';
    if (message.params?.model === 'fake-mcp-unsupported') mcpMode = 'unsupported';
    if (message.params?.model === 'fake-mcp-inventory-blocked') mcpMode = 'inventory-blocked';
    threadId = recoveredThread ? 'thread-fake-recovered' : 'thread-fake-plan';
      send({ id: message.id, result: threadStartResult(message.params, threadId) });
    send({ method: 'thread/started', params: { thread: threadPayload(threadId) } });
    return;
  }
  if (message.method === 'thread/resume') {
    if (process.env.FAKE_CODEX_APP_SERVER_STALE_RESUME === '1' && !staleResumeInjected) {
      staleResumeInjected = true;
      recoveredThread = true;
      send({
        id: message.id,
        error: { message: 'no rollout found for thread id ' + message.params.threadId },
      });
      if (process.env.FAKE_CODEX_APP_SERVER_EXIT_AFTER_STALE_RESUME === '1') {
        // Exercise the production path where Codex exits directly after
        // rejecting the persisted resume target.
        setTimeout(() => process.exit(0), 0);
      }
      return;
    }
    threadId = message.params.threadId || 'thread-fake-plan';
    send({ id: message.id, result: threadStartResult(message.params, threadId) });
    return;
  }
  if (message.method === 'mcpServerStatus/list') {
    if (mcpMode === 'unsupported') {
      send({ id: message.id, error: { code: -32601, message: 'mcpServerStatus/list is not supported for this provider/model' } });
      return;
    }
    if (mcpMode !== 'ready' && mcpMode !== 'missing-schema' && mcpMode !== 'inventory-blocked') {
      send({ id: message.id, result: { data: [] } });
      return;
    }
    if (!mcpReadySent) {
      send({ method: 'mcpServer/startupStatus/updated', params: { name: managedMcpServerName(), status: 'starting', threadId } });
      // Exercise the real race: Codex can report startup readiness before the
      // initial status/list response has drained. The sidecar must discard
      // that pre-ready snapshot and issue a verified refresh.
      send({ method: 'mcpServer/startupStatus/updated', params: { name: managedMcpServerName(), status: 'ready', threadId } });
      if (process.platform === 'win32') send({ method: 'mcpServer/startupStatus/updated', params: { name: managedBrokerServerName(), status: 'ready', threadId } });
      mcpReadySent = true;
      if (mcpMode === 'inventory-blocked') return;
      send({
        id: message.id,
        result: {
          data: [{ name: managedMcpServerName(), tools: {}, resources: [], resourceTemplates: [] }],
        },
      });
      return;
    }
    if (mcpMode === 'inventory-blocked') return;
    const missingSchema = mcpMode === 'missing-schema';
    send({
      id: message.id,
      result: {
        data: [{
          name: managedMcpServerName(),
          ...(missingSchema ? {} : {
            tools: {
              ragent_request_actions: {
                name: 'ragent_request_actions',
                inputSchema: { type: 'object', properties: {} },
              },
              ragent_create_agent: {
                name: 'ragent_create_agent',
                inputSchema: { type: 'object', properties: {} },
              },
            },
          }),
          resources: [],
          resourceTemplates: [],
        }, ...(process.platform === 'win32' ? [{ name: managedBrokerServerName(), tools: {
          ragent_restart_qa_service: { name: 'ragent_restart_qa_service', inputSchema: { type: 'object', properties: {} } },
          ragent_restart_qa_service_status: { name: 'ragent_restart_qa_service_status', inputSchema: { type: 'object', properties: {} } },
        }, resources: [], resourceTemplates: [] }] : [])],
      },
    });
    return;
  }
  if (message.method === 'turn/steer') {
    const turnId = message.params.expectedTurnId || longTurnId;
    send({ id: message.id, result: { accepted: true } });
    finishTurn(turnId);
    return;
  }
	  if (message.method === 'turn/start') {
	    const turnId = 'turn-' + (message.params.clientUserMessageId || 'fake');
    if (
      message.params.clientUserMessageId === 'req-app-server-delayed'
      || message.params.clientUserMessageId === 'req-app-server-startup-timeout'
    ) {
	      longTurnId = turnId;
	      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } });
      }, delayedTurnStartMs);
      return;
	    }
	    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } });
	    if (message.params.clientUserMessageId === 'req-app-server-shim-pending') {
	      const shim = spawnSync('agentoc-privileged', ['--description', 'isolated fixture', '--category', 'delete', '--', 'rm', '/tmp/ragent-shim-fixture'], { encoding: 'utf8', timeout: 5000 });
	      record({ fixtureShimExit: shim.status, fixtureShimError: shim.error?.message || '' });
	      if (shim.status !== 78) { send({ method: 'error', params: { error: { message: 'fixture shim did not create a pending request' }, turnId } }); process.exit(1); return; }
	      finishTurn(turnId);
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-auth-error') {
	      send({
	        method: 'error',
	        params: {
	          threadId,
	          turnId,
	          error: {
	            message: 'Reconnecting... 1/5',
	            additionalDetails: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-testsecret000000000000000000. auth error code: invalid_api_key',
	          },
	        },
	      });
	      process.exit(0);
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-retry-success') {
	      send({
	        method: 'error',
	        params: {
	          threadId,
	          turnId,
	          willRetry: true,
	          error: {
	            message: 'Reconnecting... 1/2',
	            additionalDetails: 'unexpected status 502 Bad Gateway: Upstream request failed',
	          },
	        },
	      });
	      setTimeout(() => finishTurn(turnId), 20);
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-retry-exhausted') {
	      send({
	        method: 'error',
	        params: {
	          threadId,
	          turnId,
	          willRetry: true,
	          error: {
	            message: 'Reconnecting... 1/2',
	            additionalDetails: 'unexpected status 502 Bad Gateway: Upstream request failed',
	          },
	        },
	      });
	      setTimeout(() => {
	        send({
	          method: 'error',
	          params: {
	            threadId,
	            turnId,
	            willRetry: false,
	            error: {
	              message: 'Reconnecting... 2/2',
	              additionalDetails: 'unexpected status 502 Bad Gateway: retries exhausted',
	            },
	          },
	        });
	        process.exit(0);
	      }, 20);
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-long') {
	      longTurnId = turnId;
	      const childThreadId = 'thread-fake-child';
	      const childTurnId = 'turn-fake-child';
	      send({ method: 'thread/started', params: { thread: threadPayload(childThreadId) } });
	      send({ method: 'turn/started', params: { threadId: childThreadId, turn: { id: childTurnId, status: 'inProgress' } } });
	      send({ method: 'item/agentMessage/delta', params: { threadId: childThreadId, turnId: childTurnId, delta: 'child reply' } });
	      send({ method: 'turn/completed', params: { threadId: childThreadId, turn: { id: childTurnId, status: 'completed', items: [] } } });
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-stale-turn') {
	      longTurnId = turnId;
	      send({
	        method: 'turn/completed',
	        params: {
	          threadId,
	          turn: { id: 'turn-stale-replay', status: 'completed', items: [] },
	        },
	      });
	      // Keep the provider alive after the stale frame. The sidecar must wait
	      // for this current turn completion instead of killing the process.
	      setTimeout(() => finishTurn(turnId), 1800);
	      return;
	    }
    if (message.params.clientUserMessageId === 'req-app-server-no-terminal') {
      process.exit(0);
      return;
    }
    if (message.params.clientUserMessageId === 'req-app-server-threadless-terminal') {
      // Some app-server versions omit params.threadId on turn notifications.
      // Correlating by the active turn id must still terminalize the Run.
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed', items: [] } } });
      process.exit(0);
      return;
    }
    if (message.params.clientUserMessageId === 'req-app-server-terminal-holds-open') {
      // The protocol has ended, but the provider keeps its process alive for
      // cleanup. The observer must not synthesize success before the sidecar
      // writes the authoritative result.json.
      finishTurn(turnId, { keepAliveMs: 3000 });
      return;
    }
    if (message.params.clientUserMessageId === 'req-app-server-output-burst') {
      // Produce enough ordered frames to exercise the bounded stdout queue.
      // No frame may be dropped and the terminal frame must still be observed
      // after the queue drains.
      for (let index = 0; index < 3000; index += 1) {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: 'msg-burst', delta: 'x' },
        });
      }
      // Keep the fixture alive long enough for Node to flush the burst to the
      // pipe. A provider that calls process.exit immediately can discard
      // unwritten stdout bytes before any reader (including the real sidecar)
      // can observe them; that is a fixture transport failure, not a queue
      // backpressure case.
      finishTurn(turnId, { keepAliveMs: 5000 });
      return;
    }
	    if (message.params.clientUserMessageId === 'req-app-server-idle-stall') {
	      // Leave the current turn open. The sidecar's idle watchdog should send
	      // turn/interrupt first, then fail with an explicit stall diagnosis
	      // after the bounded grace period.
	      longTurnId = turnId;
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-turn-silent-valid') {
	      // No active item and no provider stdout for longer than the generic
	      // watchdog; the Codex-specific turn budget must keep this healthy turn
	      // alive until its terminal frame arrives.
	      setTimeout(() => finishTurn(turnId), 300);
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-long-command') {
	      // A quiet command is still active provider work. The normal two-minute
	      // stall timeout is intentionally shortened by the test server; the
	      // Codex tool-item timeout must keep this run alive until completion.
	      send({
	        method: 'item/started',
	        params: {
	          threadId,
	          turnId,
	          item: {
	            type: 'commandExecution',
	            id: 'cmd-long-running',
	            command: 'sleep 1.8',
            cwd: process.cwd(),
            status: 'inProgress',
          },
        },
      });

      setTimeout(() => {
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              type: 'commandExecution',
              id: 'cmd-long-running',
              command: 'sleep 1.8',
              status: 'completed',
              exitCode: 0,
            },
          },
        });
        finishTurn(turnId);
      }, 1800);
      return;
    }
	    if (message.params.clientUserMessageId === 'req-app-server-managed-mcp') {
	      pendingApproval = { id: 'mcp-elicitation-1', turnId };
	      send({
	        method: 'mcpServer/elicitation/request',
	        id: pendingApproval.id,
	        params: {
	          serverName: managedMcpServerName(),
	          threadId,
	          turnId,
	          mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} },
	          request: { message: 'Continue with the managed action.' },
	        },
	      });
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-foreign-mcp') {
	      pendingApproval = { id: 'foreign-mcp-elicitation-1', turnId };
	      send({
	        method: 'mcpServer/elicitation/request',
	        id: pendingApproval.id,
	        params: {
	          serverName: 'foreign_server',
	          threadId,
	          turnId,
	          request: { message: 'Foreign server needs approval.' },
	        },
	      });
	      return;
	    }
	    if (message.params.clientUserMessageId === 'req-app-server-stale-mcp-turn') {
	      pendingApproval = { id: 'stale-mcp-elicitation-1', turnId };
	      send({
	        method: 'mcpServer/elicitation/request',
	        id: pendingApproval.id,
	        params: {
	          serverName: managedMcpServerName(),
	          threadId,
	          turnId: 'stale-turn',
	          mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { type: 'object', properties: {} },
	          request: { message: 'Stale turn must require approval.' },
	        },
	      });
	      return;
	    }
    if (message.params.clientUserMessageId === 'req-app-server-plan') {
      pendingApproval = { id: 'approval-1', turnId };
      send({
        method: 'item/commandExecution/requestApproval',
        id: pendingApproval.id,
        params: {
          threadId,
          turnId,
          itemId: 'cmd-approval-1',
          startedAtMs: Date.now(),
          reason: 'Need shell access',
          command: 'sudo systemctl restart agentoc-fixture',
          cwd: process.cwd(),
          commandActions: [{ type: 'unknown', command: 'sudo systemctl restart agentoc-fixture' }],
        },
      });
      return;
    }
    finishTurn(turnId);
  }
});
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex-app-server'), 0o755);
  if (process.platform === 'win32') {
    writeFileSync(join(localBin, 'fake-codex-app-server.cmd'), `@"${process.execPath}" "${join(localBin, 'fake-codex-app-server')}" %*\r\n`, 'utf8');
  }
  return { home, configDir, memoryDir, workDir, providerHomesDir, recordPath };
}

async function startServer({
  home,
  configDir,
  memoryDir,
  workDir,
  port,
  recordPath,
  staleResumeRecovery = false,
  exitAfterStaleResume = false,
  mcpMode = 'ready',
  runnerLaunchMode = '',
  providerHomesDir = '',
  idleTimeoutMs = null,
  idleCheckIntervalMs = null,
  codexTurnIdleTimeoutMs = null,
  codexToolIdleTimeoutMs = null,
  codexIdleInterruptGraceMs = null,
  codexStartupTimeoutMs = null,
  stdoutQueueMaxLines = null,
  stdoutQueueMaxBytes = null,
  turnStartDelayMs = 600,
}) {
  let stdout = '';
  let stderr = '';
  let supervisorOutput = '';
  let lastAuthResponse = null;
  if (process.platform === 'win32') {
    const fixtureEnv = { FAKE_CODEX_APP_SERVER_RECORD: recordPath, FAKE_CODEX_APP_SERVER_STALE_RESUME: staleResumeRecovery ? '1' : '0',
      FAKE_CODEX_APP_SERVER_EXIT_AFTER_STALE_RESUME: exitAfterStaleResume ? '1' : '0', FAKE_CODEX_APP_SERVER_MCP_MODE: mcpMode,
      FAKE_CODEX_APP_SERVER_TURN_START_DELAY_MS: String(turnStartDelayMs) };
    writeFileSync(join(home, 'fixture-env.json'), JSON.stringify(fixtureEnv), 'utf8');
  }
  const supervisorPipe = process.platform === 'win32' ? `\\\\.\\pipe\\agentoc-test-codex-${randomBytes(12).toString('hex')}` : '';
  const childEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'local-appdata'),
      APPDATA: join(home, 'roaming-appdata'),
      AGENTOC_INSTANCE_ROOT: home,
      AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      AGENTOC_CONFIG_DIR: configDir,
      AGENTOC_MEMORY_DIR: memoryDir,
      AGENTOC_WORK_ROOT_DIR: workDir,
      AGENTOC_RUN_SPOOL_DIR: join(home, '.agentoc', 'data', 'chat-runs'),
      AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
      AGENTOC_RUNNER_SUPERVISOR_SOCKET: supervisorPipe,
      AGENTOC_RUNNER_LIFECYCLE_SOCKET: '',
      // This protocol fixture intentionally keeps several fake turns open.
      // Admission-controller behavior has separate tests; host load must not
      // shrink this fixture's provider budget and strand its terminal checks.
      AGENTOC_ADAPTIVE_CONCURRENCY: 'off',
      AGENTOC_RUN_CAPACITY_MAX_CONCURRENT: '32',
      AGENTOC_RUN_PROVIDER_MAX_CONCURRENT: '32',
      AGENTOC_AUTH_SESSION_SECRET: 'test-secret-agentoc-sidecar',
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      AGENTOC_REPLY_SELF_CHECK: 'off',
      // Keep the fixture on its isolated provider home even when the host
      // running the test exports an external AGENTOC_CODEX_HOME_DIR.
      AGENTOC_CODEX_HOME_DIR: '',
      FAKE_CODEX_APP_SERVER_RECORD: recordPath,
      FAKE_CODEX_APP_SERVER_STALE_RESUME: staleResumeRecovery ? '1' : '0',
      FAKE_CODEX_APP_SERVER_EXIT_AFTER_STALE_RESUME: exitAfterStaleResume ? '1' : '0',
      FAKE_CODEX_APP_SERVER_MCP_MODE: mcpMode,
      // Keep the production fallback conservative while making this focused
      // protocol test fast enough to run as a normal unit-style check.
      AGENTOC_CODEX_MCP_STARTUP_FALLBACK_MS: '100',
      AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
      FAKE_CODEX_APP_SERVER_TURN_START_DELAY_MS: String(turnStartDelayMs),
      ...(runnerLaunchMode ? { AGENTOC_RUNNER_LAUNCH_MODE: runnerLaunchMode } : {}),
      ...(providerHomesDir ? { AGENTOC_PROVIDER_HOMES_DIR: providerHomesDir } : {}),
      ...(idleTimeoutMs ? { AGENTOC_RUN_IDLE_TIMEOUT_MS: String(idleTimeoutMs) } : {}),
      ...(idleCheckIntervalMs ? { AGENTOC_RUN_IDLE_CHECK_INTERVAL_MS: String(idleCheckIntervalMs) } : {}),
      ...(codexTurnIdleTimeoutMs ? { AGENTOC_CODEX_TURN_IDLE_TIMEOUT_MS: String(codexTurnIdleTimeoutMs) } : {}),
      ...(codexToolIdleTimeoutMs ? { AGENTOC_CODEX_TOOL_IDLE_TIMEOUT_MS: String(codexToolIdleTimeoutMs) } : {}),
      ...(codexIdleInterruptGraceMs ? { AGENTOC_CODEX_IDLE_INTERRUPT_GRACE_MS: String(codexIdleInterruptGraceMs) } : {}),
      ...(codexStartupTimeoutMs ? { AGENTOC_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS: String(codexStartupTimeoutMs) } : {}),
      ...(stdoutQueueMaxLines ? { AGENTOC_RUN_STDOUT_QUEUE_MAX_LINES: String(stdoutQueueMaxLines) } : {}),
      ...(stdoutQueueMaxBytes ? { AGENTOC_RUN_STDOUT_QUEUE_MAX_BYTES: String(stdoutQueueMaxBytes) } : {}),
    };
  const supervisorFixture = join(home, 'supervisor-fixture.mjs');
  if (supervisorPipe) writeFileSync(supervisorFixture, `import {spawn} from 'node:child_process';
import {createRunnerSupervisorServer,spawnSupervisedRunner} from ${JSON.stringify(pathToFileURL(join(repoRoot, 'chat/runner-supervisor-daemon.mjs')).href)};
const s=await createRunnerSupervisorServer({spawnRunner:id=>spawnSupervisedRunner(id,{spawnImpl:(file,args,options)=>{const child=spawn(file,args,{...options,stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);return child}})});
console.log('[runner-supervisor] listening');process.on('SIGTERM',()=>s.close().finally(()=>process.exit(0)));
`, 'utf8');
  const supervisor = supervisorPipe ? spawn(process.execPath, [supervisorFixture], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }) : null;
  if (supervisor) {
    supervisor.stdout.on('data', (chunk) => { supervisorOutput += chunk.toString('utf8'); });
    supervisor.stderr.on('data', (chunk) => { supervisorOutput += chunk.toString('utf8'); });
  }
  const serverFixture = join(home, 'server-fixture.mjs');
  if (process.platform === 'win32') writeFileSync(serverFixture, `process.on('message', message => { if (message === 'test-stop') process.emit('SIGTERM'); });\nawait import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat-server.mjs')).href)});\n`, 'utf8');
  const child = spawn(process.execPath, [process.platform === 'win32' ? serverFixture : 'chat-server.mjs'], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', ...(process.platform === 'win32' ? ['ipc'] : [])],
  });

  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    if (supervisor) await waitFor(() => supervisorOutput.includes('[runner-supervisor] listening'), 'supervisor startup');
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`server exited before startup (code=${child.exitCode}, signal=${child.signalCode || 'none'})`);
      }
      try {
        const res = await request(port, 'GET', '/api/auth/me');
        lastAuthResponse = `${res.status} ${res.text || ''}`.slice(0, 500);
        return res.status === 200;
      } catch (error) {
        lastAuthResponse = error?.message || String(error);
        return false;
      }
    }, 'server startup');
  } catch (error) {
    child.kill('SIGTERM');
    supervisor?.kill();
    throw new Error(`${error.message}\nlast auth response: ${lastAuthResponse || 'none'}\nstdout:\n${stdout || '(empty)'}\nstderr:\n${stderr || '(empty)'}`);
  }

  return {
    child,
    supervisor,
    getOutput: () => ({ stdout, stderr, supervisorOutput }),
  };
}

async function stopServer(server) {
  if (!server?.child) return;
  if (server.child.exitCode === null && server.child.signalCode === null) {
    if (process.platform === 'win32' && server.child.connected) server.child.send('test-stop');
    else server.child.kill('SIGTERM');
    await waitFor(() => server.child.exitCode !== null || server.child.signalCode !== null, 'server shutdown');
  }
  if (server.supervisor && server.supervisor.exitCode === null && server.supervisor.signalCode === null) {
    server.supervisor.kill();
    await waitFor(() => server.supervisor.exitCode !== null || server.supervisor.signalCode !== null, 'supervisor shutdown');
  }
  // A detached fixture runner can retain the old controller's inherited pipe
  // descriptors after exit. The parent must release its own read handles.
  server.child.stdout?.destroy();
  server.child.stderr?.destroy();
  server.child.unref();
}

async function createSession(port, riskMode = 'recommended') {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex-app-server',
    name: 'Fake app-server session',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  const session = res.json.session;
  // Keep this helper explicit so it exercises the danger-gated permission mode.
  const patchRes = await request(port, 'PATCH', `/api/sessions/${session.id}`, {
    riskMode,
  });
  assert.equal(patchRes.status, 200, 'riskMode patch should succeed');
  return session;
}

async function submitMessage(port, sessionId, body) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, body);
  assert.ok(res.status === 202 || res.status === 200, `submit should succeed: ${res.text}`);
  const accepted = res.json.run;
  if (accepted?.provider || !accepted?.id) return accepted;
  // Durable acceptance precedes deferred runner preparation. Observe provider
  // metadata through the public read route instead of assuming it is in 202.
  return waitFor(async () => {
    const current = await request(port, 'GET', `/api/runs/${accepted.id}`);
    const run = current.json?.run;
    return run?.provider || ['failed', 'cancelled', 'completed'].includes(run?.state) ? run : false;
  }, `run ${accepted.id} provider preparation`);
}

async function waitForRunTerminal(port, runId) {
  let lastRun = null;
  try {
    return await waitFor(async () => {
      const res = await request(port, 'GET', `/api/runs/${runId}`);
      if (res.status !== 200) return false;
      lastRun = res.json?.run || null;
      if (!['completed', 'failed', 'cancelled'].includes(lastRun?.state)) return false;
      return lastRun;
    }, `run ${runId} terminal`);
  } catch (error) {
    error.message += `\nlast run state: ${JSON.stringify(lastRun)}`;
    throw error;
  }
}

async function waitForRunAppServerTurn(port, runId, turnId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return res.json?.run?.appServerTurnId === turnId ? res.json.run : false;
  }, `run ${runId} app-server turn ${turnId}`);
}

async function waitForRunWithoutAppServerTurn(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    const run = res.json?.run;
    return run?.state === 'running' && !run.appServerTurnId ? run : false;
  }, `run ${runId} before app-server turn id`);
}

async function waitForSessionCodexThread(port, sessionId, threadId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${sessionId}`);
    if (res.status !== 200) return false;
    return res.json?.session?.codexThreadId === threadId ? res.json.session : false;
  }, `session ${sessionId} codex thread ${threadId}`);
}

async function waitForApprovalRequest(port, sessionId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
    if (res.status !== 200) return false;
    return res.json.events.find((event) => event.type === 'approval_request') || false;
  }, `session ${sessionId} approval request`);
}

async function waitForApprovalResponse(port, sessionId, approvalId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
    if (res.status !== 200) return false;
    return res.json.events.find((event) => event.type === 'approval_response' && event.approvalId === approvalId) || false;
  }, `session ${sessionId} approval response ${approvalId}`);
}

function readRecordedMessages(recordPath) {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const { home, configDir, memoryDir, workDir, providerHomesDir, recordPath } = setupTempHome();
const port = await allocatePort();
let server = await startServer({
  home,
  configDir,
  memoryDir,
  workDir,
  providerHomesDir,
  port,
  recordPath,
  runnerLaunchMode: 'detached-process',
  stdoutQueueMaxLines: 64,
  stdoutQueueMaxBytes: 32 * 1024,
});

try {
  if (process.platform !== 'win32') {
    // The fake provider invokes the real per-Run shim, receives its pending
    // acknowledgement, then exits. The owner request must remain actionable
    // until explicitly resolved instead of being closed by Run finalization.
    const shimSession = await createSession(port, 'safe');
    const shimRun = await submitMessage(port, shimSession.id, {
      requestId: 'req-app-server-shim-pending', text: 'Create a privileged approval fixture.',
      tool: 'fake-codex-app-server', model: 'fake-model',
    });
    const batch = await waitFor(async () => {
      const response = await request(port, 'GET', `/api/sessions/${shimSession.id}/events`);
      return response.json?.events?.find((event) => event.type === 'privileged_batch_request') || false;
    }, 'shim approval request');
    assert.equal(batch.delete?.length, 1);
    let observedShimRun;
    try {
      await waitFor(async () => {
        const response = await request(port, 'GET', `/api/runs/${shimRun.id}`);
        observedShimRun = response.json?.run;
        return observedShimRun?.state === 'waiting_user';
      }, 'provider exit keeps shim Run waiting for owner');
    } catch (error) {
      error.message += `\nlast shim run: ${JSON.stringify({ state: observedShimRun?.state, failureReason: observedShimRun?.failureReason, pending: observedShimRun?.privilegedShimPending, result: observedShimRun?.privilegedShimResult })}`;
      error.message += `\nfixture messages: ${JSON.stringify(readRecordedMessages(recordPath).filter((entry) => entry.fixtureShimExit !== undefined))}`;
      const output = server.getOutput();
      error.message += `\nserver stderr tail: ${(output.stderr || '').slice(-3000)}`;
      try { error.message += `\nshim spool tail: ${readFileSync(join(home, '.agentoc', 'data', 'chat-runs', shimRun.id, 'spool.jsonl'), 'utf8').slice(-3000)}`; } catch {}
      throw error;
    }
    const decision = await request(port, 'POST', `/api/runs/${shimRun.id}/privileged-batches/${batch.batchId}/categories/delete`, {
      requestId: 'req-shim-denied', checkedOpIds: [],
    });
    assert.ok([200, 202].includes(decision.status), `shim denial failed: ${decision.text}`);
    assert.equal((await waitForRunTerminal(port, shimRun.id)).state, 'completed');
    writeFileSync(recordPath, '', 'utf8');
  }
  // Exercise explicit approval under a gated product profile. Unattended
  // profiles correctly deny permission requests instead of opening a card.
  const session = await createSession(port, 'safe');
  const planRun = await submitMessage(port, session.id, {
    requestId: 'req-app-server-plan',
    text: 'Draft a plan.',
    tool: 'fake-codex-app-server',
    interactionMode: 'plan',
    model: 'fake-model',
    effort: 'high',
    // The fixture requests a destructive command (never actually executed),
    // so this profile must expose its approval card rather than auto-allow it.
    permissionMode: 'untrusted-read-only',
  });
  assert.equal(planRun.provider, 'codex', JSON.stringify({ state: planRun.state, failureReason: planRun.failureReason }));
  assert.equal(planRun.runtimeFamily, 'codex-app-server-json');
  assert.equal(planRun.providerCapabilities?.supportsSteer, true);
  assert.equal(planRun.providerCapabilities?.supportsInterrupt, true);
  assert.equal(planRun.providerCapabilities?.supportsExternalUsageProjection, false);
  assert.equal(planRun.permissionMode, 'untrusted-danger-full-access');
  let approvalRequest;
  try {
    approvalRequest = await waitForApprovalRequest(port, session.id);
  } catch (error) {
    const output = server.getOutput?.() || {};
    console.error(`sidecar test server output:\n${output.stdout || '(no stdout)'}\n${output.stderr || '(no stderr)'}\n${output.supervisorOutput || '(no supervisor output)'}`);
    try {
      const spool = readFileSync(join(home, '.agentoc', 'data', 'chat-runs', planRun.id, 'spool.jsonl'), 'utf8');
      const lines = spool.split('\n').filter((line) => /mcpServer|fixture MCP|codexMcp|stderr/.test(line));
      console.error(`fixture MCP spool:\n${lines.map((line) => line.slice(0, 1200)).join('\n')}`);
    } catch {}
    try {
      const runRes = await request(port, 'GET', `/api/runs/${planRun.id}`);
      console.error(`plan run state:\n${JSON.stringify(runRes.json?.run, null, 2)}`);
    } catch (runErr) {
      console.error(`plan run fetch failed: ${runErr.message}`);
    }
    try {
      console.error(`fake app-server messages:\n${readFileSync(recordPath, 'utf8') || '(none)'}`);
    } catch (readErr) {
      console.error(`fake app-server record missing: ${readErr.message}`);
    }
    throw error;
  }
  const processStart = await waitFor(() => {
    try { return readRecordedMessages(recordPath).find((message) => Array.isArray(message.agentocFixtureProcessArgs)) || false; }
    catch { return false; }
  }, 'Run-scoped Codex project trust process arguments');
  const processArgs = processStart.agentocFixtureProcessArgs || [];
  const trustOverride = processArgs.find((arg) => typeof arg === 'string' && arg.startsWith('projects='));
  assert.ok(processArgs.includes('-c') && trustOverride?.includes('trust_level="untrusted"'),
    'Ragent-gated Codex must start with a Run-scoped project trust override');
  assert.equal(approvalRequest.kind, 'command');
  assert.equal(approvalRequest.command, 'sudo systemctl restart agentoc-fixture');
  assert.equal(approvalRequest.runId, planRun.id);
  assert.equal(approvalRequest.provider, 'codex');
  assert.equal(approvalRequest.runtimeFamily, 'codex-app-server-json');
  assert.equal(approvalRequest.providerCapabilities?.supportsSteer, true);
  assert.equal(approvalRequest.providerCapabilities?.supportsInterrupt, true);
  assert.equal(approvalRequest.permissionMode, 'untrusted-danger-full-access');
  const approvalRes = await request(
    port,
    'POST',
    `/api/runs/${planRun.id}/approvals/${encodeURIComponent(approvalRequest.approvalId)}`,
    {
      requestId: 'req-approval-1',
      decision: 'approve',
    },
  );
  assert.ok(approvalRes.status === 202 || approvalRes.status === 200, `approval should succeed: ${approvalRes.text}`);
  assert.equal(approvalRes.json.run.provider, 'codex');
  assert.equal(approvalRes.json.run.runtimeFamily, 'codex-app-server-json');
  assert.equal(approvalRes.json.run.providerCapabilities?.supportsSteer, true);
  assert.equal(approvalRes.json.run.providerCapabilities?.supportsInterrupt, true);
  assert.equal(approvalRes.json.run.permissionMode, 'untrusted-danger-full-access');
  const approvalResponse = await waitForApprovalResponse(port, session.id, approvalRequest.approvalId);
  assert.equal(approvalResponse.decision, 'approved');
  assert.equal(approvalResponse.provider, 'codex');
  assert.equal(approvalResponse.runtimeFamily, 'codex-app-server-json');
  assert.equal(approvalResponse.providerCapabilities?.supportsSteer, true);
  assert.equal(approvalResponse.providerCapabilities?.supportsInterrupt, true);
  assert.equal(approvalResponse.permissionMode, 'untrusted-danger-full-access');
  const terminalPlan = await waitForRunTerminal(port, planRun.id);
  assert.equal(terminalPlan.state, 'completed');
  assert.equal(terminalPlan.codexThreadId, 'thread-fake-plan');
  assert.equal(terminalPlan.provider, 'codex');
  assert.equal(terminalPlan.runtimeFamily, 'codex-app-server-json');
  assert.equal(terminalPlan.providerCapabilities?.supportsSteer, true);
  assert.equal(terminalPlan.providerCapabilities?.supportsInterrupt, true);
  assert.equal(terminalPlan.permissionMode, 'untrusted-danger-full-access');
  const terminalPlanWithTurn = await waitForRunAppServerTurn(port, planRun.id, 'turn-req-app-server-plan');
  assert.equal(terminalPlanWithTurn.appServerTurnId, 'turn-req-app-server-plan');
  await waitForSessionCodexThread(port, session.id, 'thread-fake-plan');

  let recorded = readRecordedMessages(recordPath);
  const ragentEnv = recorded.find(message => message.ragentEnv)?.ragentEnv;
  assert.equal(ragentEnv?.session, session.id);
  assert.equal(ragentEnv?.baseUrl, `http://127.0.0.1:${port}`);
  assert.equal(ragentEnv?.projectRoot, repoRoot);
  const planThreadStarts = recorded.filter((message) => message.method === 'thread/start');
  const planThreadStart = planThreadStarts[0];
  const planTurnStart = recorded.find((message) => message.method === 'turn/start');
  assert.equal(planThreadStart.params.config.mode, 'plan');
  assert.equal(planThreadStart.params.sandbox, 'danger-full-access');
  assert.deepEqual(planTurnStart.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(planTurnStart.params.effort, 'high');
  if (process.platform === 'win32') {
    assert.equal(planThreadStarts.length, 1, 'the gate must not send the retired untrusted policy value');
    assert.equal(Object.hasOwn(planThreadStart.params, 'approvalPolicy'), false,
      'the approval policy must be derived from the Run project trust');
    assert.equal(Object.hasOwn(planTurnStart.params, 'approvalPolicy'), false,
      'turn/start must not override the derived approval policy');
  }
  const approvalReply = recorded.find((message) => message.id === 'approval-1' && message.result);
  assert.ok(approvalReply, `provider should receive approval response; got ${JSON.stringify(recorded)}`);
  assert.deepEqual(approvalReply.result, { decision: 'accept' });

  const mcpSession = await createSession(port, 'recommended');
  const mcpRun = await submitMessage(port, mcpSession.id, {
    requestId: 'req-app-server-mcp-ready',
    text: 'Run with the managed action MCP channel.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalMcpRun = await waitForRunTerminal(port, mcpRun.id);
  assert.equal(terminalMcpRun.state, 'completed', JSON.stringify(terminalMcpRun));
  assert.equal(terminalMcpRun.mcpPreparation?.state, 'ready');
  assert.equal(terminalMcpRun.mcpPreparation?.stage, 'verify');
  assert.equal(terminalMcpRun.mcpPreparation?.verified, true);
  assert.equal(terminalMcpRun.approvedActionCapability?.state, 'ready');
  assert.equal(terminalMcpRun.approvedActionCapability?.preparation?.state, 'ready');
  const mcpRecorded = readRecordedMessages(recordPath);
  const mcpListRequests = mcpRecorded.filter((message) => message.method === 'mcpServerStatus/list');
  const mcpTurnStartIndex = mcpRecorded.findIndex((message) => (
    message.method === 'turn/start'
    && message.params?.clientUserMessageId === 'req-app-server-mcp-ready'
  ));
  assert.equal(mcpListRequests.length >= 2, true, 'managed MCP readiness should refresh inventory after ready');
  assert.ok(mcpTurnStartIndex > mcpRecorded.indexOf(mcpListRequests[mcpListRequests.length - 1]), 'turn must start after verified MCP inventory');
  const mcpEventsRes = await request(port, 'GET', `/api/sessions/${mcpSession.id}/events`);
  assert.equal(mcpEventsRes.status, 200);
  const mcpReadyEventIndex = mcpEventsRes.json.events.findLastIndex((event) => (
    (event.codexMcpStatus === 'inventory'
      && event.codexMcpServers?.some((server) => (
        server.toolSchemaAvailable === true
        && server.toolNames?.includes('ragent_request_actions')
      )))
    || (event.codexMcpStatus === 'ready'
      && event.codexMcpReadiness === 'verified'
      && event.codexMcpTools?.includes('ragent_request_actions'))
  ));
  const mcpProviderActivityIndex = mcpEventsRes.json.events.findIndex((event) => (
    event.type === 'plan' || (event.type === 'message' && event.content === 'fake reply')
  ));
  // Current history projection exposes the verified MCP state on the Run
  // metadata; older projections also materialized a dedicated session event.
  // Preserve the ordering assertion whenever that optional event is present.
  if (mcpReadyEventIndex >= 0) {
    assert.ok(mcpProviderActivityIndex > mcpReadyEventIndex, 'provider activity must follow MCP ready evidence');
  }

  writeFileSync(recordPath, '', 'utf8');
  const managedMcpRun = await submitMessage(port, mcpSession.id, {
    requestId: 'req-app-server-managed-mcp',
    text: 'Trigger the run-scoped managed MCP request.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalManagedMcpRun = await waitForRunTerminal(port, managedMcpRun.id);
  assert.equal(terminalManagedMcpRun.state, 'completed', JSON.stringify(terminalManagedMcpRun));
  const managedMcpRecorded = readRecordedMessages(recordPath);
  const managedMcpReply = managedMcpRecorded.find((message) => (
    message.id === 'mcp-elicitation-1' && message.result
  ));
  assert.deepEqual(
    managedMcpReply?.result,
    { action: 'accept', content: {} },
    `managed MCP response missing: ${JSON.stringify(managedMcpRecorded)}`,
  );
  const managedMcpEvents = await request(port, 'GET', `/api/sessions/${mcpSession.id}/events?filter=all`);
  assert.equal(managedMcpEvents.status, 200);
  assert.equal(
    managedMcpEvents.json.events.filter((event) => event.type === 'approval_request' && event.runId === managedMcpRun.id).length,
    0,
    'run-scoped managed MCP should not create a user approval card',
  );

  writeFileSync(recordPath, '', 'utf8');
  const staleMcpRun = await submitMessage(port, mcpSession.id, {
    requestId: 'req-app-server-stale-mcp-turn',
    text: 'Trigger a managed MCP request from a stale turn.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const staleMcpApproval = await waitForApprovalRequest(port, mcpSession.id);
  assert.equal(staleMcpApproval.runId, staleMcpRun.id);
  assert.equal(staleMcpApproval.reason, 'Stale turn must require approval.');
  const staleMcpApprovalRes = await request(
    port,
    'POST',
    `/api/runs/${staleMcpRun.id}/approvals/${encodeURIComponent(staleMcpApproval.approvalId)}`,
    { requestId: 'req-app-server-stale-mcp-turn-approve', decision: 'approve' },
  );
  assert.ok(staleMcpApprovalRes.status === 200 || staleMcpApprovalRes.status === 202, staleMcpApprovalRes.text);
  assert.equal((await waitForRunTerminal(port, staleMcpRun.id)).state, 'completed');
  assert.deepEqual(
    readRecordedMessages(recordPath).find((message) => message.id === 'stale-mcp-elicitation-1')?.result,
    { action: 'accept', content: {} },
  );

  const foreignMcpSession = await createSession(port, 'recommended');
  const foreignMcpRun = await submitMessage(port, foreignMcpSession.id, {
    requestId: 'req-app-server-foreign-mcp',
    text: 'Trigger a foreign MCP request.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const foreignMcpApproval = await waitForApprovalRequest(port, foreignMcpSession.id);
  assert.equal(foreignMcpApproval.runId, foreignMcpRun.id);
  assert.equal(foreignMcpApproval.provider, 'codex');
  assert.equal(foreignMcpApproval.reason, 'Foreign server needs approval.');
  const foreignMcpApprovalRes = await request(
    port,
    'POST',
    `/api/runs/${foreignMcpRun.id}/approvals/${encodeURIComponent(foreignMcpApproval.approvalId)}`,
    { requestId: 'req-app-server-foreign-mcp-approve', decision: 'approve' },
  );
  assert.ok(foreignMcpApprovalRes.status === 200 || foreignMcpApprovalRes.status === 202, foreignMcpApprovalRes.text);
  const terminalForeignMcpRun = await waitForRunTerminal(port, foreignMcpRun.id);
  assert.equal(terminalForeignMcpRun.state, 'completed');
  const foreignMcpRecorded = readRecordedMessages(recordPath);
  assert.deepEqual(
    foreignMcpRecorded.find((message) => message.id === 'foreign-mcp-elicitation-1')?.result,
    { action: 'accept', content: {} },
  );

  const executeRes = await request(port, 'POST', `/api/sessions/${session.id}/plans/${encodeURIComponent('turn-req-app-server-plan')}/actions`, {
    requestId: 'req-app-server-execute',
    action: 'execute',
    text: 'Execute the plan.',
    model: 'fake-model',
  });
  assert.ok(executeRes.status === 202 || executeRes.status === 200, `plan action should succeed: ${executeRes.text}`);
  const executeRun = executeRes.json.run;
	  const terminalExecute = await waitForRunTerminal(port, executeRun.id);
	  assert.equal(terminalExecute.state, 'completed');
	
	  recorded = readRecordedMessages(recordPath);
	  const executeThreadResume = recorded.find((message) => message.method === 'thread/resume');
  const executeTurnStart = recorded.find((message) => message.method === 'turn/start');
  assert.ok(executeThreadResume, `execute should resume the saved app-server thread; got ${JSON.stringify(recorded)}`);
  assert.equal(executeThreadResume.params.threadId, 'thread-fake-plan');
	  assert.equal(executeThreadResume.params.config.mode, 'default');
	  assert.equal(executeThreadResume.params.sandbox, 'danger-full-access');
	  assert.deepEqual(executeTurnStart.params.sandboxPolicy, { type: 'dangerFullAccess' });

	  const authErrorSession = await createSession(port);
	  const authErrorRun = await submitMessage(port, authErrorSession.id, {
	    requestId: 'req-app-server-auth-error',
	    text: 'Trigger provider auth error.',
	    tool: 'fake-codex-app-server',
	    model: 'fake-model',
	  });
	  const terminalAuthError = await waitForRunTerminal(port, authErrorRun.id);
	  assert.equal(terminalAuthError.state, 'failed', 'app-server provider errors should fail the run');
  assert.equal(terminalAuthError.result?.exitCode, 1, 'protocol provider errors should persist an effective failed exit code');
  assert.equal(terminalAuthError.result?.providerExitCode, 0, 'raw provider exit code should remain visible separately');
	  assert.match(
	    terminalAuthError.failureReason || '',
	    /401 Unauthorized|invalid_api_key/,
	    'failure reason should retain the provider auth diagnosis',
	  );
	  assert.doesNotMatch(
	    terminalAuthError.failureReason || '',
	    /sk-proj-testsecret/,
	    'failure reason should not persist raw API keys',
	  );
	  const authErrorEventsRes = await request(port, 'GET', `/api/sessions/${authErrorSession.id}/events`);
	  assert.equal(authErrorEventsRes.status, 200);
	  assert.equal(
	    authErrorEventsRes.json.events.some((event) => event.type === 'message' && event.role === 'assistant'),
	    false,
	    'app-server provider errors should not fabricate an assistant reply',
	  );
	  assert.equal(
	    authErrorEventsRes.json.events.some((event) => event.type === 'status' && /Reconnecting/.test(event.content || '')),
	    true,
	    'history should show the provider reconnect/auth status',
	  );

  const threadErrorSession = await createSession(port);
  const threadErrorRun = await submitMessage(port, threadErrorSession.id, {
    requestId: 'req-app-server-thread-error',
    text: 'Trigger a thread startup error.',
    tool: 'fake-codex-app-server',
    model: 'fake-thread-error',
  });
  const terminalThreadError = await waitForRunTerminal(port, threadErrorRun.id);
  assert.equal(terminalThreadError.state, 'failed');
  assert.equal(terminalThreadError.result?.exitCode, 1);
  assert.ok(
    terminalThreadError.result?.providerExitCode === 0
      || (process.platform === 'win32' && terminalThreadError.result?.providerExitCode === 0xC0DE)
      || terminalThreadError.result?.signal === 'SIGTERM',
    `startup provider errors should retain the raw exit code or the sidecar termination signal: ${JSON.stringify(terminalThreadError.result)}`,
  );
  assert.equal(terminalThreadError.result?.providerStage, 'failed');
  assert.match(
    terminalThreadError.failureReason || '',
    /failed to load configuration|No such file or directory/,
    'thread startup errors should preserve the provider diagnosis',
  );

	  const retrySuccessSession = await createSession(port);
	  const retrySuccessRun = await submitMessage(port, retrySuccessSession.id, {
	    requestId: 'req-app-server-retry-success',
	    text: 'Recover after a retryable provider disconnect.',
	    tool: 'fake-codex-app-server',
	    model: 'fake-model',
	  });
	  const terminalRetrySuccess = await waitForRunTerminal(port, retrySuccessRun.id);
	  assert.equal(
	    terminalRetrySuccess.state,
	    'completed',
	    'retryable app-server errors should allow the provider turn to recover',
	  );
	  assert.equal(terminalRetrySuccess.failureReason || null, null);
	  const retrySuccessEventsRes = await request(port, 'GET', `/api/sessions/${retrySuccessSession.id}/events`);
	  assert.equal(retrySuccessEventsRes.status, 200);
  // The status is provider-runtime noise and may be intentionally suppressed
  // by the current history projection; completion/recovery is asserted below.
	  assert.equal(
	    retrySuccessEventsRes.json.events.some((event) => event.type === 'message' && event.role === 'assistant' && event.content === 'fake reply'),
	    true,
	    'a recovered turn should publish its assistant reply',
	  );

	  const retryExhaustedSession = await createSession(port);
	  const retryExhaustedRun = await submitMessage(port, retryExhaustedSession.id, {
	    requestId: 'req-app-server-retry-exhausted',
	    text: 'Fail after provider retries are exhausted.',
	    tool: 'fake-codex-app-server',
	    model: 'fake-model',
	  });
	  const terminalRetryExhausted = await waitForRunTerminal(port, retryExhaustedRun.id);
	  assert.equal(terminalRetryExhausted.state, 'failed');
	  assert.match(
	    terminalRetryExhausted.failureReason || '',
	    /Reconnecting\.\.\. 2\/2|retries exhausted/,
	    'the final non-retryable provider error should fail the run',
	  );
	
	  const steerSession = await createSession(port);
	  const longRun = await submitMessage(port, steerSession.id, {
	    requestId: 'req-app-server-long',
    text: 'Keep this turn open.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  await waitForRunAppServerTurn(port, longRun.id, 'turn-req-app-server-long');
  const longSessionState = await waitForSessionCodexThread(port, steerSession.id, 'thread-fake-plan');
  assert.equal(longSessionState.codexThreadId, 'thread-fake-plan');
  const activeLongRun = await request(port, 'GET', `/api/runs/${longRun.id}`);
  assert.equal(activeLongRun.json.run.state, 'running', 'parent run should stay active after child events');
  const childIsolationEvents = await request(port, 'GET', `/api/sessions/${steerSession.id}/events`);
  assert.equal(childIsolationEvents.status, 200);
  assert.equal(
    childIsolationEvents.json.events.some((event) => (
      event.type === 'message' && event.role === 'assistant' && event.content === 'child reply'
    )),
    false,
    'delegated child output must not enter the parent session history',
  );

	  const staleTurnSession = await createSession(port);
	  const staleTurnRun = await submitMessage(port, staleTurnSession.id, {
	    requestId: 'req-app-server-stale-turn',
	    text: 'Ignore a replayed completion from an older turn.',
	    tool: 'fake-codex-app-server',
	    model: 'fake-model',
	  });
	  await waitForRunAppServerTurn(port, staleTurnRun.id, 'turn-req-app-server-stale-turn');
	  await sleep(200);
	  const activeAfterStaleTurn = await request(port, 'GET', `/api/runs/${staleTurnRun.id}`);
	  assert.equal(activeAfterStaleTurn.status, 200);
	  assert.equal(
	    activeAfterStaleTurn.json.run.state,
	    'running',
	    'a same-thread stale turn/completed must not stop the active Run',
	  );
	  assert.equal(activeAfterStaleTurn.json.run.appServerTurnId, 'turn-req-app-server-stale-turn');
  const terminalStaleTurn = await waitForRunTerminal(port, staleTurnRun.id);
  assert.equal(terminalStaleTurn.state, 'completed');

  const missingTerminalSession = await createSession(port);
  const missingTerminalRun = await submitMessage(port, missingTerminalSession.id, {
    requestId: 'req-app-server-no-terminal',
    text: 'A provider exit without a current terminal frame must fail.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalMissingTerminal = await waitForRunTerminal(port, missingTerminalRun.id);
  assert.equal(terminalMissingTerminal.state, 'failed');
  assert.match(terminalMissingTerminal.failureReason || '', /accepted terminal turn event/);

  const threadlessTerminalSession = await createSession(port);
  const threadlessTerminalRun = await submitMessage(port, threadlessTerminalSession.id, {
    requestId: 'req-app-server-threadless-terminal',
    text: 'Accept a terminal frame that omits threadId.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalThreadless = await waitForRunTerminal(port, threadlessTerminalRun.id);
  assert.equal(terminalThreadless.state, 'completed', JSON.stringify(terminalThreadless));
  assert.equal(terminalThreadless.result?.providerTerminalSeen, true);

  const heldTerminalSession = await createSession(port);
  const heldTerminalRun = await submitMessage(port, heldTerminalSession.id, {
    requestId: 'req-app-server-terminal-holds-open',
    text: 'Keep the provider process alive briefly after the turn terminal frame.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const completionCandidate = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${heldTerminalRun.id}`);
    const run = res.json?.run;
    return run?.spoolCompletionDetectedAt ? run : false;
  }, `run ${heldTerminalRun.id} completion candidate`);
  assert.equal(
    completionCandidate.state,
    'running',
    'a structured provider completion candidate must not synthesize success while sidecar cleanup is pending',
  );
  const heldTerminal = await waitForRunTerminal(port, heldTerminalRun.id);
  if (heldTerminal.state !== 'completed') console.error(`held-terminal failure: ${JSON.stringify(heldTerminal.result)}`);
  assert.equal(heldTerminal.state, 'completed', JSON.stringify(heldTerminal.result));
  assert.notEqual(heldTerminal.result?.synthesized, true, 'structured provider result must come from sidecar terminalization');

  const burstSession = await createSession(port);
  const burstRun = await submitMessage(port, burstSession.id, {
    requestId: 'req-app-server-output-burst',
    text: 'Exercise ordered provider output backpressure.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalBurst = await waitForRunTerminal(port, burstRun.id);
  assert.equal(terminalBurst.state, 'completed', JSON.stringify(terminalBurst));
  assert.equal(terminalBurst.result?.providerTerminalSeen, true, 'burst output must still reach the provider terminal frame');
  assert.equal(terminalBurst.failureReason || null, null);

	  const queuedFollowUp = await request(port, 'POST', `/api/sessions/${steerSession.id}/messages`, {
    requestId: 'req-app-server-steer',
    text: 'Native steer while queued.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  assert.ok(queuedFollowUp.status === 202 || queuedFollowUp.status === 200, `follow-up should queue: ${queuedFollowUp.text}`);
  assert.equal(queuedFollowUp.json.queued, true, 'busy app-server follow-up should still use the AgentoC queue');
  recorded = readRecordedMessages(recordPath);
  assert.equal(
    recorded.some((message) => message.method === 'turn/steer' && message.params?.clientUserMessageId === 'req-app-server-steer'),
    false,
    'submitting the follow-up should not bypass the visible queue',
  );

  const nativeSteerRes = await request(port, 'POST', `/api/sessions/${steerSession.id}/queue`, {
    action: 'steer',
    requestId: 'req-app-server-steer',
  });
  assert.equal(nativeSteerRes.status, 202, `native steer should be accepted: ${nativeSteerRes.text}`);
  assert.equal(nativeSteerRes.json.steered, true);
  assert.equal(nativeSteerRes.json.queued, false);
  assert.equal(nativeSteerRes.json.interruptedRunId, null, 'native steer should not cancel the active app-server run');
  assert.equal(nativeSteerRes.json.run?.id, longRun.id, 'native steer should stay on the active run');
  const terminalSteeredRun = await waitForRunTerminal(port, longRun.id);
  assert.equal(terminalSteeredRun.state, 'completed');
  assert.equal(
    terminalSteeredRun.appServerSteerQueue?.find((entry) => entry.requestId === 'req-app-server-steer')?.state,
    'sent',
    'native steer queue entry should remain marked sent after terminal run updates',
  );

  recorded = readRecordedMessages(recordPath);
  const nativeSteerMessage = recorded.find((message) => (
    message.method === 'turn/steer'
    && message.params?.clientUserMessageId === 'req-app-server-steer'
  ));
  assert.ok(nativeSteerMessage, `provider should receive turn/steer; got ${JSON.stringify(recorded)}`);
  assert.equal(nativeSteerMessage.params.threadId, 'thread-fake-plan');
  assert.equal(nativeSteerMessage.params.expectedTurnId, 'turn-req-app-server-long');
  assert.equal(nativeSteerMessage.params.input?.[0]?.text, 'Native steer while queued.');
  assert.equal(
    recorded.some((message) => message.method === 'turn/interrupt' && message.params?.turnId === 'turn-req-app-server-long'),
    false,
    'native steer path should not send turn/interrupt',
  );

  const delayedSteerSession = await createSession(port);
  const delayedRun = await submitMessage(port, delayedSteerSession.id, {
    requestId: 'req-app-server-delayed',
    text: 'Start slowly.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  await waitForRunWithoutAppServerTurn(port, delayedRun.id);
  const delayedQueuedFollowUp = await request(port, 'POST', `/api/sessions/${delayedSteerSession.id}/messages`, {
    requestId: 'req-app-server-delayed-steer',
    text: 'Native steer before turn id is recorded.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  assert.ok(delayedQueuedFollowUp.status === 202 || delayedQueuedFollowUp.status === 200, `delayed follow-up should queue: ${delayedQueuedFollowUp.text}`);
  assert.equal(delayedQueuedFollowUp.json.queued, true);
  const delayedNativeSteerRes = await request(port, 'POST', `/api/sessions/${delayedSteerSession.id}/queue`, {
    action: 'steer',
    requestId: 'req-app-server-delayed-steer',
  });
  assert.equal(delayedNativeSteerRes.status, 202, `delayed native steer should be accepted: ${delayedNativeSteerRes.text}`);
  assert.equal(delayedNativeSteerRes.json.interruptedRunId, null, 'early native steer should not cancel before turn id is recorded');
  assert.equal(delayedNativeSteerRes.json.run?.id, delayedRun.id, 'early native steer should stay on the active run');
  const terminalDelayedSteeredRun = await waitForRunTerminal(port, delayedRun.id);
  assert.equal(terminalDelayedSteeredRun.state, 'completed');
  assert.equal(
    terminalDelayedSteeredRun.appServerSteerQueue?.find((entry) => entry.requestId === 'req-app-server-delayed-steer')?.state,
    'sent',
    'delayed native steer queue entry should remain marked sent after terminal run updates',
  );

  recorded = readRecordedMessages(recordPath);
  const delayedNativeSteerMessage = recorded.find((message) => (
    message.method === 'turn/steer'
    && message.params?.clientUserMessageId === 'req-app-server-delayed-steer'
  ));
  assert.ok(delayedNativeSteerMessage, `provider should receive delayed turn/steer; got ${JSON.stringify(recorded)}`);
  assert.equal(delayedNativeSteerMessage.params.expectedTurnId, 'turn-req-app-server-delayed');
  assert.equal(delayedNativeSteerMessage.params.input?.[0]?.text, 'Native steer before turn id is recorded.');
  assert.equal(
    recorded.some((message) => message.method === 'turn/interrupt' && message.params?.turnId === 'turn-req-app-server-delayed'),
    false,
    'early native steer path should not send turn/interrupt',
  );

  const eventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events`);
  assert.equal(eventsRes.status, 200);
  const appServerPlanEvent = eventsRes.json.events.find((event) => (
    event.type === 'plan' && event.source === 'codex-app-server'
  ));
  assert.ok(appServerPlanEvent, 'app-server plan notifications should become AgentoC plan events');
  assert.equal(appServerPlanEvent.provider, 'codex');
  assert.equal(appServerPlanEvent.runtimeFamily, 'codex-app-server-json');
  assert.equal(appServerPlanEvent.providerCapabilities?.supportsSteer, true);
  assert.equal(appServerPlanEvent.providerCapabilities?.supportsInterrupt, true);
  assert.equal(appServerPlanEvent.permissionMode, 'untrusted-danger-full-access');

  await stopServer(server);
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    providerHomesDir,
    port,
    recordPath,
    runnerLaunchMode: 'detached-process',
    staleResumeRecovery: true,
    // The stale-resume recovery case is independent from MCP schema failure.
    // Keep the shared fixture ready; fake-mcp-missing below owns that failure
    // contract explicitly.
    mcpMode: 'ready',
  });
  writeFileSync(recordPath, '', 'utf8');
  const staleResumeRun = await submitMessage(port, session.id, {
    requestId: 'req-app-server-stale-resume',
    text: 'Continue after the provider rollout disappeared.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalStaleResume = await waitForRunTerminal(port, staleResumeRun.id);
  assert.equal(terminalStaleResume.state, 'completed');
  assert.equal(terminalStaleResume.codexThreadId, 'thread-fake-recovered');
  const recoveredSession = await waitForSessionCodexThread(port, session.id, 'thread-fake-recovered');
  assert.equal(recoveredSession.codexThreadId, 'thread-fake-recovered');
  recorded = readRecordedMessages(recordPath);
  const staleResumeIndex = recorded.findIndex((message) => (
    message.method === 'thread/resume'
    && message.params?.threadId === 'thread-fake-plan'
  ));
  const recoveredThreadStartIndex = recorded.findIndex((message, index) => (
    index > staleResumeIndex && message.method === 'thread/start'
  ));
  const recoveredTurnStart = recorded.find((message, index) => (
    index > recoveredThreadStartIndex && message.method === 'turn/start'
  ));
  assert.ok(staleResumeIndex >= 0, 'recovery should first attempt the persisted thread');
  assert.ok(recoveredThreadStartIndex > staleResumeIndex, 'stale resume should fall back to thread/start');
  assert.ok(recoveredTurnStart, 'fresh recovery should start a new turn');
  assert.match(JSON.stringify(recoveredTurnStart), /Ragent continuity checkpoint/, 'fresh recovery turn must carry the authoritative checkpoint');

  // The previous assertion exercises recovery while the original app-server
  // remains alive. Reproduce the field failure too: Codex can close directly
  // after reporting the stale resume target, requiring a replacement sidecar.
  await stopServer(server);
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    providerHomesDir,
    port,
    recordPath,
    runnerLaunchMode: 'detached-process',
    staleResumeRecovery: true,
    exitAfterStaleResume: true,
    mcpMode: 'ready',
  });
  writeFileSync(recordPath, '', 'utf8');
  const handoffSession = await createSession(port);
  const handoffBootstrap = await submitMessage(port, handoffSession.id, {
    requestId: 'req-app-server-stale-resume-handoff-bootstrap',
    text: 'Create the persisted thread before handoff recovery.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  assert.equal((await waitForRunTerminal(port, handoffBootstrap.id)).state, 'completed');
  const handoffRun = await submitMessage(port, handoffSession.id, {
    requestId: 'req-app-server-stale-resume-handoff',
    text: 'Continue after Codex closes during stale-resume recovery.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  assert.equal((await waitForRunTerminal(port, handoffRun.id, 20_000)).state, 'completed');
  const handoffRecorded = readRecordedMessages(recordPath);
  const handoffResumeIndex = handoffRecorded.findIndex((message) => (
    message.method === 'thread/resume' && message.params?.threadId === 'thread-fake-plan'
  ));
  const handoffThreadStartIndex = handoffRecorded.findIndex((message, index) => (
    index > handoffResumeIndex && message.method === 'thread/start'
  ));
  assert.ok(handoffResumeIndex >= 0, 'the original sidecar should observe the stale resume');
  assert.ok(handoffThreadStartIndex > handoffResumeIndex, 'the replacement sidecar must start a fresh thread');
  assert.equal(
    handoffRecorded.slice(handoffThreadStartIndex + 1).some((message) => message.method === 'thread/resume'),
    false,
    'the fresh replacement must not repeat the unavailable persisted resume target',
  );

  await stopServer(server);
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    providerHomesDir,
    port,
    recordPath,
    runnerLaunchMode: 'detached-process',
    staleResumeRecovery: true,
    mcpMode: 'ready',
  });

  const recoveryAssetBody = Buffer.from('stale recovery attachment');
  const recoveryAssetId = 'fasset_0123456789abcdef01234567';
  const recoveryAssetObjectDir = join(configDir, 'file-assets', 'objects');
  mkdirSync(recoveryAssetObjectDir, { recursive: true });
  writeFileSync(join(recoveryAssetObjectDir, `${recoveryAssetId}.txt`), recoveryAssetBody);
  writeFileSync(
    join(configDir, 'file-assets', `${recoveryAssetId}.json`),
    JSON.stringify({
      id: recoveryAssetId,
      sessionId: session.id,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'owner',
      originalName: 'stale-recovery.txt',
      mimeType: 'text/plain',
      sizeBytes: recoveryAssetBody.length,
      sha256: createHash('sha256').update(recoveryAssetBody).digest('hex'),
      storage: {
        provider: 'local',
        localFilename: `${recoveryAssetId}.txt`,
      },
    }),
    'utf8',
  );

  const staleResumeWithAttachmentRun = await submitMessage(port, session.id, {
    requestId: 'req-app-server-stale-resume-attachment',
    text: 'Continue after the provider rollout disappeared and inspect the attachment.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
    images: [{
      assetId: recoveryAssetId,
      originalName: 'stale-recovery.txt',
      mimeType: 'text/plain',
    }],
  });
  const terminalStaleResumeWithAttachment = await waitForRunTerminal(port, staleResumeWithAttachmentRun.id);
  assert.equal(terminalStaleResumeWithAttachment.state, 'completed');
  recorded = readRecordedMessages(recordPath);
  const recoveredAttachmentTurnStart = recorded.find((message, index) => (
    index > recorded.findIndex((candidate) => (
      candidate.method === 'thread/resume'
      && candidate.params?.threadId === 'thread-fake-recovered'
    ))
    && message.method === 'turn/start'
    && message.params?.clientUserMessageId === 'req-app-server-stale-resume-attachment'
  ));
  assert.ok(recoveredAttachmentTurnStart, 'attachment stale recovery should start a fresh turn');
  assert.match(
    recoveredAttachmentTurnStart.params.input?.[0]?.text || '',
    new RegExp(`stale-recovery\\.txt -> .*chat-runs[/\\\\]${staleResumeWithAttachmentRun.id}[/\\\\]inputs[/\\\\]fasset_[a-f0-9]{24}\\.txt`),
    'fresh recovery must preserve the Run-local attachment path',
  );

  // An unrelated MCP can remain `starting` and cause Codex to withhold the
  // global inventory response even after the AgentoC-owned server is ready.
  // That must not turn into a 15-second false failure for the user turn.
  const blockedInventorySession = await createSession(port, 'recommended');
  const blockedInventoryRun = await submitMessage(port, blockedInventorySession.id, {
    requestId: 'req-app-server-mcp-inventory-blocked',
    text: 'Continue when only an unrelated MCP inventory is delayed.',
    tool: 'fake-codex-app-server',
    model: 'fake-mcp-inventory-blocked',
  });
  const terminalBlockedInventory = await waitForRunTerminal(port, blockedInventoryRun.id, 10_000);
  assert.equal(terminalBlockedInventory.state, 'completed');
  recorded = readRecordedMessages(recordPath);
  assert.equal(
    recorded.some((message) => (
      message.method === 'turn/start'
      && message.params?.clientUserMessageId === 'req-app-server-mcp-inventory-blocked'
    )),
    true,
    'managed MCP startup readiness should release a turn when optional inventory is withheld',
  );

  const missingSchemaSession = await createSession(port, 'recommended');
  const missingSchemaRun = await submitMessage(port, missingSchemaSession.id, {
    requestId: 'req-app-server-mcp-missing-schema',
    text: 'Abort when the managed MCP tool schema is unavailable.',
    tool: 'fake-codex-app-server',
    model: 'fake-mcp-missing',
  });
  const terminalMissingSchema = await waitForRunTerminal(port, missingSchemaRun.id);
  assert.equal(terminalMissingSchema.state, 'failed');
  assert.match(terminalMissingSchema.failureReason || '', /MCP_TOOL_SCHEMA_UNAVAILABLE/);
  recorded = readRecordedMessages(recordPath);
  assert.equal(
    recorded.some((message) => message.method === 'turn/start' && message.params?.clientUserMessageId === 'req-app-server-mcp-missing-schema'),
    false,
    'missing MCP tool schema must abort before turn/start',
  );

  const unsupportedMcpSession = await createSession(port, 'recommended');
  const unsupportedMcpRun = await submitMessage(port, unsupportedMcpSession.id, {
    requestId: 'req-app-server-mcp-unsupported',
    text: 'Abort when the selected provider/model cannot expose MCP discovery.',
    tool: 'fake-codex-app-server',
    model: 'fake-mcp-unsupported',
  });
  const terminalUnsupportedMcp = await waitForRunTerminal(port, unsupportedMcpRun.id);
  assert.equal(terminalUnsupportedMcp.state, 'failed');
  assert.match(terminalUnsupportedMcp.failureReason || '', /MCP_DISCOVERY_UNSUPPORTED/);
  recorded = readRecordedMessages(recordPath);
  assert.equal(
    recorded.some((message) => message.method === 'turn/start' && message.params?.clientUserMessageId === 'req-app-server-mcp-unsupported'),
    false,
    'unsupported MCP discovery must abort before turn/start',
  );

  await stopServer(server);
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    port,
    recordPath,
    mcpMode: 'ready',
    runnerLaunchMode: 'detached-process',
    providerHomesDir: join(home, '.agentoc', 'missing-provider-homes'),
  });
  const overlayFailureSession = await createSession(port, 'recommended');
  const overlayFailureRun = await submitMessage(port, overlayFailureSession.id, {
    requestId: 'req-app-server-mcp-overlay-failure',
    text: 'Abort when the managed MCP overlay cannot be prepared.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalOverlayFailure = await waitForRunTerminal(port, overlayFailureRun.id);
  assert.equal(terminalOverlayFailure.state, 'failed');
  assert.match(terminalOverlayFailure.failureReason || '', /MCP_OVERLAY_UNAVAILABLE/);
  assert.equal(terminalOverlayFailure.mcpPreparation?.state, 'failed');
  assert.equal(terminalOverlayFailure.mcpPreparation?.stage, 'preflight');
  assert.equal(terminalOverlayFailure.mcpPreparation?.errorCode, 'MCP_PROVIDER_HOME_UNAVAILABLE');
  assert.equal(terminalOverlayFailure.mcpPreparation?.resource, 'codex_auth');
  assert.equal(terminalOverlayFailure.mcpPreparation?.attempt, 1);
  assert.equal(terminalOverlayFailure.mcpPreparation?.maxAttempts, 3);
  assert.equal(terminalOverlayFailure.approvedActionCapability?.state, 'unavailable');
  assert.equal(terminalOverlayFailure.approvedActionCapability?.errorCode, 'MCP_PROVIDER_HOME_UNAVAILABLE');
  recorded = readRecordedMessages(recordPath);
  assert.equal(
    recorded.some((message) => message.method === 'turn/start' && message.params?.clientUserMessageId === 'req-app-server-mcp-overlay-failure'),
    false,
    'unavailable MCP overlay must abort before provider turn/start',
  );

  // Exercise the liveness watchdog with short test-only thresholds. A stalled
  // turn must be interrupted first and surface the stall diagnosis, rather
  // than the misleading "exited before an accepted terminal event" message.
  await stopServer(server);
  writeFileSync(recordPath, '', 'utf8');
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    port,
    recordPath,
    mcpMode: 'ready',
    runnerLaunchMode: 'detached-process',
    providerHomesDir,
    idleTimeoutMs: 1000,
    idleCheckIntervalMs: 100,
    codexTurnIdleTimeoutMs: 1000,
    codexToolIdleTimeoutMs: 4000,
    codexIdleInterruptGraceMs: 200,
  });
  const silentTurnSession = await createSession(port, 'recommended');
  const silentTurnRun = await submitMessage(port, silentTurnSession.id, {
    requestId: 'req-app-server-turn-silent-valid',
    text: 'Keep this turn silent briefly, then complete normally.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalSilentTurn = await waitForRunTerminal(port, silentTurnRun.id);
  assert.equal(
    terminalSilentTurn.state,
    'completed',
    `a quiet but healthy Codex turn must not use the generic idle timeout: ${JSON.stringify(terminalSilentTurn)}`,
  );
  const idleStallSession = await createSession(port, 'recommended');
  const idleStallRun = await submitMessage(port, idleStallSession.id, {
    requestId: 'req-app-server-idle-stall',
    text: 'Leave the provider turn open to exercise idle recovery.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalIdleStall = await waitForRunTerminal(port, idleStallRun.id);
  assert.equal(terminalIdleStall.state, 'failed');
  assert.match(
    terminalIdleStall.failureReason || '',
    /Codex app-server turn stalled after .* inactivity/,
    'idle termination should preserve an actionable stall diagnosis',
  );
  recorded = readRecordedMessages(recordPath);
  assert.ok(
    recorded.some((message) => message.method === 'turn/interrupt' && message.params?.turnId === 'turn-req-app-server-idle-stall'),
    `idle stall should send turn/interrupt before killing the provider: ${JSON.stringify(recorded)}`,
  );

  // A command item can legitimately remain silent longer than the normal
  // provider-output timeout. The extended tool-item timeout must allow it to
  // complete and produce a normal terminal turn.
  writeFileSync(recordPath, '', 'utf8');
  const longCommandSession = await createSession(port, 'recommended');
  const longCommandRun = await submitMessage(port, longCommandSession.id, {
    requestId: 'req-app-server-long-command',
    text: 'Run a quiet command that completes after the short idle threshold.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalLongCommand = await waitForRunTerminal(port, longCommandRun.id);
  assert.equal(terminalLongCommand.state, 'completed', JSON.stringify(terminalLongCommand));
  assert.equal(terminalLongCommand.failureReason || null, null);

  await stopServer(server);
  server = await startServer({
    home,
    configDir,
    memoryDir,
    workDir,
    port,
    recordPath,
    mcpMode: 'ready',
    runnerLaunchMode: 'detached-process',
    providerHomesDir,
    codexStartupTimeoutMs: 400,
    turnStartDelayMs: 1500,
  });
  const startupTimeoutSession = await createSession(port, 'recommended');
  const startupTimeoutRun = await submitMessage(port, startupTimeoutSession.id, {
    requestId: 'req-app-server-startup-timeout',
    text: 'Delay the provider turn long enough to exercise startup timeout.',
    tool: 'fake-codex-app-server',
    model: 'fake-model',
  });
  const terminalStartupTimeout = await waitForRunTerminal(port, startupTimeoutRun.id);
  assert.equal(terminalStartupTimeout.state, 'failed');
  assert.match(terminalStartupTimeout.failureReason || '', /startup timed out/);
  assert.equal(terminalStartupTimeout.result?.providerStage, 'failed');

  console.log('test-codex-app-server-sidecar: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
