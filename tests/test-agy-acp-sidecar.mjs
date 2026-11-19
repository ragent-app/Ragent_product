#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const sidecarPath = join(repoRoot, 'chat', 'runner-sidecar.mjs');

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-agy-acp-sidecar-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const memoryDir = join(instanceRoot, 'memory');
const spoolDir = join(instanceRoot, 'data', 'chat-runs');
const providerHomesDir = join(instanceRoot, 'provider-homes');
const workRootDir = join(instanceRoot, 'workspace');
const harnessRoot = join(tempRoot, 'harnesses');
const agyHarnessBin = join(harnessRoot, 'agy', 'bin');
const hermesHarnessBin = join(harnessRoot, 'hermes', 'bin');
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(spoolDir, { recursive: true });
mkdirSync(providerHomesDir, { recursive: true });
mkdirSync(workRootDir, { recursive: true });
mkdirSync(agyHarnessBin, { recursive: true });
mkdirSync(hermesHarnessBin, { recursive: true });

const agyHomeDir = join(providerHomesDir, 'agy');
mkdirSync(join(agyHomeDir, '.gemini', 'config'), { recursive: true });
writeFileSync(join(agyHomeDir, '.ragent-provider-id'), 'agy-test-profile\n', 'utf8');
writeFileSync(
  join(agyHomeDir, '.gemini', 'config', 'mcp_config.json'),
  JSON.stringify({
    mcpServers: {
      authorized_ext: {
        command: process.execPath,
        args: ['-e', 'console.log("ok")'],
        env: { FOO: 'bar' },
      },
      unauthorized_ext: {
        command: process.execPath,
        args: ['-e', 'console.log("bad")'],
      },
      sse_ext: {
        type: 'sse',
        url: 'http://127.0.0.1:9999/sse',
      },
      ragent_spoof: {
        command: process.execPath,
        args: ['-e', 'console.log("spoof")'],
      },
    },
  }, null, 2),
  'utf8',
);

const fakeAgyScript = join(tempRoot, 'fake-agy.mjs');
writeFileSync(
  fakeAgyScript,
  `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.5.12\\n');
  process.exit(0);
}

const cwd = process.cwd();
const scenarioPath = join(cwd, '.fake-agy-scenario.json');
const tracePath = join(cwd, '.fake-agy-trace.json');
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {};

const agyHome = process.env.RAGENT_AGY_HOME_DIR || process.env.HOME || '';
const mcpConfigFile = agyHome ? join(agyHome, '.gemini', 'config', 'mcp_config.json') : '';
const trace = {
  args,
  cwd,
  env: {
    RAGENT_AGY_HOME_DIR: process.env.RAGENT_AGY_HOME_DIR || '',
    AGY_CLI_GEMINI_DIR: process.env.AGY_CLI_GEMINI_DIR || '',
    AGY_CLI_APP_DATA_DIR: process.env.AGY_CLI_APP_DATA_DIR || '',
    RAGENT_SESSION_CONTROL_TOKEN: process.env.RAGENT_SESSION_CONTROL_TOKEN ? '<present>' : '',
    RAGENT_APPROVED_ACTIONS_ENABLED: process.env.RAGENT_APPROVED_ACTIONS_ENABLED || '',
    RAGENT_BROWSER_MCP_ENABLED: process.env.RAGENT_BROWSER_MCP_ENABLED || '',
  },
  startupMcpConfig: mcpConfigFile && existsSync(mcpConfigFile) ? JSON.parse(readFileSync(mcpConfigFile, 'utf8')) : null,
  requests: [],
  permissionOutcomes: [],
  turns: [],
};

function saveTrace() {
  writeFileSync(tracePath, JSON.stringify(trace, null, 2), 'utf8');
}
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}
saveTrace();

const rl = createInterface({ input: process.stdin });

if (scenario.mode === 'stream-json') {
  let turnIndex = 0;
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    trace.turns.push(msg);
    saveTrace();
    turnIndex += 1;
    send({ event: 'init', conversation_id: 'agy-stream-conv-1', session_id: 'agy-stream-conv-1' });
    send({ event: 'message', role: 'assistant', content: \`turn-\${turnIndex}: \${msg.message?.content || msg.prompt || ''}\` });
    const emit = () => {
      send({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-stream-conv-1' }, conversation_id: 'agy-stream-conv-1' });
    };
    if (turnIndex === 1 && Number(scenario.turn1DelayMs) > 0) {
      setTimeout(emit, Number(scenario.turn1DelayMs));
    } else {
      emit();
    }
  });
  rl.on('close', () => {
    saveTrace();
    process.exit(0);
  });
} else {
  let sessionId = scenario.sessionId || 'agy-sess-1';
  let mcpServers = [];
  let promptRequestId = null;
  let pendingPermIndex = 0;
  const permissions = Array.isArray(scenario.permissions) ? scenario.permissions : [];

  function findActionsServerName() {
    const match = mcpServers.find((server) => Array.isArray(server?.args)
      && server.args.some((arg) => String(arg).includes('ragent-approved-actions-mcp.mjs')));
    return match?.name || 'ragent_actions';
  }

  function finishPrompt() {
    if (!promptRequestId) return;
    if (Array.isArray(scenario.emitUpdatesAfterPermissions)) {
      for (const upd of scenario.emitUpdatesAfterPermissions) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: upd },
        });
      }
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'usage_update', used: 120, size: 100000 },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP turn ok' } },
      },
    });
    send({
      jsonrpc: '2.0',
      id: promptRequestId,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      },
    });
    promptRequestId = null;
  }

  function sendNextPermissionOrFinish() {
    if (pendingPermIndex >= permissions.length) {
      if (scenario.waitForCancel) return;
      finishPrompt();
      return;
    }
    const spec = permissions[pendingPermIndex];
    pendingPermIndex += 1;
    const rawToolCall = JSON.parse(JSON.stringify(spec.toolCall));
    if (spec.useDynamicActionsTool) {
      rawToolCall.name = \`mcp__\${findActionsServerName()}__ragent_request_actions\`;
    }
    send({
      jsonrpc: '2.0',
      id: spec.id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: rawToolCall,
        options: spec.options,
      },
    });
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.method) {
      trace.requests.push(msg);
      saveTrace();
    } else if (msg.id && (Object.hasOwn(msg, 'result') || msg.error)) {
      trace.permissionOutcomes.push(msg);
      saveTrace();
      if (scenario.exitOnPermissionOutcome) return;
      sendNextPermissionOrFinish();
      return;
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            ...(scenario.supportsClose !== false ? { sessionCapabilities: { close: {} } } : {}),
          },
        },
      });
      return;
    }

    if (msg.method === 'session/new' || msg.method === 'session/load') {
      mcpServers = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      sessionId = msg.params?.sessionId || sessionId;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId,
          configOptions: scenario.initialConfigOptions || [
            { id: 'model', currentValue: 'default', options: [{ value: 'default' }, { value: 'gemini-4-neon' }] },
          ],
          modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }] },
        },
      });
      return;
    }

    if (msg.method === 'session/set_config_option') {
      const nextConfigs = [
        { id: 'model', currentValue: msg.params?.configId === 'model' ? msg.params.value : 'gemini-4-neon', options: [{ value: 'default' }, { value: 'gemini-4-neon' }] },
        { id: 'thought_level', currentValue: msg.params?.configId === 'thought_level' ? msg.params.value : 'low', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
        { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
      ];
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: nextConfigs } });
      return;
    }

    if (msg.method === 'session/prompt') {
      promptRequestId = msg.id;
      sendNextPermissionOrFinish();
      return;
    }

    if (msg.method === 'session/cancel') {
      if (promptRequestId) {
        send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'cancelled' } });
        promptRequestId = null;
      }
      return;
    }

    if (msg.method === 'session/close') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      setTimeout(() => process.exit(0), 25);
    }
  });
  rl.on('close', () => {
    saveTrace();
    setTimeout(() => process.exit(0), 25);
  });
}
`,
  'utf8',
);

for (const [binDir, cmdName] of [
  [agyHarnessBin, 'agy'],
  [hermesHarnessBin, 'hermes-acp'],
]) {
  const posixShim = join(binDir, cmdName);
  writeFileSync(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeAgyScript}" "$@"\n`, 'utf8');
  try {
    chmodSync(posixShim, 0o755);
  } catch {}
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, `${cmdName}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fakeAgyScript}" %*\r\n`,
      'utf8',
    );
  }
}

const originalEnv = { ...process.env };
const childEnv = {
  ...process.env,
  HOME: tempRoot,
  USERPROFILE: tempRoot,
  LOCALAPPDATA: join(tempRoot, 'local-appdata'),
  APPDATA: join(tempRoot, 'roaming-appdata'),
  RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
  RAGENT_INSTANCE_ROOT: instanceRoot,
  RAGENT_CONFIG_DIR: configDir,
  RAGENT_MEMORY_DIR: memoryDir,
  RAGENT_WORK_ROOT_DIR: workRootDir,
  RAGENT_RUN_SPOOL_DIR: spoolDir,
  RAGENT_PROVIDER_HOMES_DIR: providerHomesDir,
  RAGENT_HARNESS_ROOT: harnessRoot,
  RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
};
Object.assign(process.env, childEnv);

const runs = await import('../chat/runs.mjs');
const { createAcpEventParser } = await import('../chat/adapters/acp-stdio.mjs');
const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');
const { ownerWindowsOsPaths } = await import('../lib/windows-owner-os-paths.mjs');

function buildExecutionScope(cwd) {
  const realCwd = realpathSync(cwd);
  const windowsPaths = process.platform === 'win32' ? ownerWindowsOsPaths() : null;
  const executionScope = {
    cwd: { realPath: realCwd },
    riskContext: {
      schemaVersion: 1,
      platform: process.platform,
      trustedWorkspaceRoot: realCwd,
      protectedRoots: [join(realCwd, '.ssh')],
      ...(windowsPaths ? {
        programDataRoot: windowsPaths.programData,
        systemPathRoots: [
          windowsPaths.windows,
          windowsPaths.programData,
          windowsPaths.programFiles,
          windowsPaths.programFilesX86,
        ],
      } : {}),
    },
  };
  return {
    executionScope,
    executionScopeDigest: computeExecutionScopeDigest(executionScope),
  };
}

async function waitFor(predicate, label, timeoutMs = 15000, onTick = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (onTick) await onTick();
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function spawnSidecar(runId, extraEnv = {}) {
  const child = spawn(process.execPath, [sidecarPath, runId], {
    cwd: repoRoot,
    env: { ...childEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString('utf8')).slice(-8000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString('utf8')).slice(-8000); });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => resolveExit({ code, signal, logs: () => logs }));
  });
  return { child, exited, logs: () => logs };
}

try {
  // ---- Scenario 1: Gated agy-acp full flow (MCP, storage, configOptions, auto-allow, owner approval fallback, session/close) ----
  {
    const scenarioDir = join(workRootDir, 's1');
    const extraDir = join(workRootDir, 's1-extra');
    mkdirSync(scenarioDir, { recursive: true });
    mkdirSync(extraDir, { recursive: true });
    const helloFile = join(realpathSync(scenarioDir), 'hello.txt');
    writeFileSync(helloFile, 'hello\n', 'utf8');

    const runId = 'run_agy_acp_s1';
    const sessionId = 'sess_agy_acp_s1';
    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'agy-sess-s1',
      permissions: [
        {
          id: 'perm-1',
          toolCall: {
            toolCallId: 'tc-read-1',
            name: 'Read',
            kind: 'read',
            title: 'Read hello.txt',
            rawInput: { AbsolutePath: helloFile },
          },
          options: [
            { optionId: 'allow-once-1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once-1', name: 'Reject once', kind: 'reject_once' },
          ],
        },
        {
          id: 'perm-2',
          useDynamicActionsTool: true,
          toolCall: {
            toolCallId: 'tc-mcp-2',
            name: 'placeholder',
            kind: 'other',
            title: 'Request approved action',
            rawInput: { reason: 'test' },
          },
          options: [
            { optionId: 'allow-once-2', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once-2', name: 'Reject once', kind: 'reject_once' },
          ],
        },
        {
          id: 'perm-3',
          toolCall: {
            toolCallId: 'tc-cmd-3',
            name: 'run_command',
            kind: 'execute',
            title: 'Dangerous rm -rf .git',
            rawInput: { CommandLine: 'rm -rf .git', cwd: scenarioDir },
          },
          options: [
            { optionId: 'allow-once-3', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once-3', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      ],
    }));

    await runs.createRun({
      status: {
        id: runId,
        sessionId,
        requestId: 'req-s1',
        state: 'accepted',
        providerPreparation: { authorizedExternalMcpNames: ['authorized_ext'] },
      },
      manifest: {
        id: runId,
        sessionId,
        requestId: 'req-s1',
        tool: 'agy',
        folder: scenarioDir,
        ...buildExecutionScope(scenarioDir),
        prompt: 'Verify AgY ACP full lifecycle',
        options: {
          runtimeFamily: 'agy-acp',
          model: 'gemini-4-neon',
          effort: 'xhigh',
          riskMode: 'safe',
          permissionMode: 'safe',
          authorizedExternalMcpServers: ['authorized_ext'],
          additionalDirectories: [extraDir],
          browserMcpEnabled: true,
          sessionControlChannel: {
            token: 'sc-tok-s1',
            runId,
            sessionId,
            turnId: 'req-s1',
          },
          approvedActionChannel: {
            token: 'aa-tok-s1',
            endpoint: '/api/internal/approved-actions',
            turnId: 'req-s1',
          },
        },
      },
    });

    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: agyHomeDir });
    try {
      const dumpDiagnostics = async (prefix) => {
        const current = await runs.getRun(runId).catch(() => null);
        const traceDump = existsSync(join(scenarioDir, '.fake-agy-trace.json'))
          ? readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8')
          : '<no-trace>';
        const spoolDump = JSON.stringify(await runs.readRunSpoolRecords(runId).catch(() => []));
        return `${prefix} (exit=${sidecar.child.exitCode}) state=${current?.state} reason=${current?.failureReason} pending=${JSON.stringify(current?.appServerPendingApprovals || [])}\nlogs:\n${sidecar.logs()}\ntrace:\n${traceDump}\nspool:\n${spoolDump}`;
      };
      let pendingRun;
      try {
        pendingRun = await waitFor(async () => {
          const current = await runs.getRun(runId);
          const pending = current?.appServerPendingApprovals?.find((entry) => entry.approvalId === 'agy:perm-3');
          if (pending) return current;
          if (sidecar.child.exitCode !== null) {
            throw new Error(await dumpDiagnostics('S1 sidecar exited early'));
          }
          return null;
        }, 'S1 owner approval card agy:perm-3', 20000);
      } catch (err) {
        if (!String(err?.message || '').includes('S1 sidecar exited early')) {
          throw new Error(await dumpDiagnostics(err?.message || 'S1 timeout'));
        }
        throw err;
      }
      const card = pendingRun.appServerPendingApprovals.find((entry) => entry.approvalId === 'agy:perm-3');
      assert.equal(card.kind, 'command');
      assert.equal(card.state, 'pending');

      await runs.updateRun(runId, (current) => ({
        ...current,
        appServerApprovalResponseQueue: [
          {
            id: 'owner-resp-s1',
            approvalId: 'agy:perm-3',
            decision: 'allow_always',
            state: 'queued',
          },
        ],
      }));

      const exit = await Promise.race([
        sidecar.exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`S1 timeout logs:\n${sidecar.logs()}`)), 15000)),
      ]);
      assert.equal(exit.code, 0, `S1 exited ${exit.code}: ${exit.logs()}`);

      const finalRun = await runs.getRun(runId);
      assert.equal(finalRun.state, 'completed');
      assert.equal(finalRun.agyConversationId, 'agy-sess-s1');
      assert.equal(finalRun.providerResumeId, 'agy-sess-s1');
      assert.ok(finalRun.agyGeminiDir, 'agyGeminiDir must be persisted');
      assert.ok(finalRun.agySessionStorageDir, 'agySessionStorageDir must be persisted');

      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      assert.deepEqual(trace.args.slice(0, 3), ['acp', '--stdio', '--process-per-session']);
      assert.ok(trace.args.includes('--gemini-dir'));
      const appDataFlagIdx = trace.args.indexOf('--app-data-dir');
      assert.ok(appDataFlagIdx >= 0, '--app-data-dir flag must be forwarded');
      assert.equal(isAbsolute(trace.args[appDataFlagIdx + 1]), false, 'CLI --app-data-dir must be relative to --gemini-dir');

      const newReq = trace.requests.find((req) => req.method === 'session/new');
      assert.ok(newReq, 'session/new must be recorded');
      assert.deepEqual(newReq.params.additionalDirectories, [extraDir]);
      const mcpServers = newReq.params.mcpServers || [];
      assert.equal(mcpServers.some((s) => s.args?.some((a) => String(a).includes('ragent-organization-mcp.mjs'))), true, 'organization MCP injected');
      assert.equal(mcpServers.some((s) => s.args?.some((a) => String(a).includes('ragent-approved-actions-mcp.mjs'))), true, 'actions MCP injected');
      assert.equal(mcpServers.some((s) => s.args?.some((a) => String(a).includes('ragent-browser-mcp-server.mjs'))), true, 'browser MCP injected for agy-acp');
      assert.equal(mcpServers.some((s) => s.name === 'authorized_ext'), true, 'authorized external MCP included');
      assert.equal(mcpServers.some((s) => s.name === 'unauthorized_ext'), false, 'unauthorized external MCP excluded');
      assert.equal(mcpServers.some((s) => s.name === 'sse_ext'), false, 'SSE external MCP excluded');
      assert.equal(mcpServers.some((s) => s.name === 'ragent_spoof'), false, 'ragent_* spoof external MCP excluded');

      const configCalls = trace.requests.filter((req) => req.method === 'session/set_config_option');
      assert.deepEqual(
        configCalls.map((c) => [c.params.configId, c.params.value]),
        [['model', 'gemini-4-neon'], ['thought_level', 'xhigh']],
        'model switch must unlock dynamic thought_level switch',
      );
      assert.equal(trace.requests.some((req) => req.method === 'session/close'), true, 'session/close sent when supported');

      assert.deepEqual(
        trace.permissionOutcomes.map((o) => [o.id, o.result?.outcome]),
        [
          ['perm-1', { outcome: 'selected', optionId: 'allow-once-1' }],
          ['perm-2', { outcome: 'selected', optionId: 'allow-once-2' }],
          ['perm-3', { outcome: 'selected', optionId: 'allow-once-3' }],
        ],
      );

      const spoolRecords = await runs.readRunSpoolRecords(runId);
      const parser = createAcpEventParser({ provider: 'agy', runtimeFamily: 'agy-acp' });
      const projected = spoolRecords.flatMap((rec) => parser.parseLine(rec.line || JSON.stringify(rec.json || {})));
      const approvalRequests = projected.filter((ev) => ev.type === 'approval_request');
      assert.equal(approvalRequests.length, 1, 'auto-approved perm-1 and perm-2 must NOT surface owner approval cards');
      assert.equal(approvalRequests[0].approvalId, 'agy:perm-3');
      const approvalResponses = projected.filter((ev) => ev.type === 'approval_response');
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0].approvalId, 'agy:perm-3');
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 2a: agy-acp full-auto unattended denial + session/load resume ----
  {
    const scenarioDir = join(workRootDir, 's2a');
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'agy-resumed-99',
      permissions: [
        {
          id: 'perm-unattended',
          toolCall: {
            toolCallId: 'tc-deny-1',
            name: 'run_command',
            kind: 'execute',
            title: 'Destructive command',
            rawInput: { CommandLine: 'rm -rf .git', cwd: scenarioDir },
          },
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' },
          ],
        },
      ],
    }));
    const runId = 'run_agy_acp_s2a';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s2a', requestId: 'req-s2a', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s2a',
        requestId: 'req-s2a',
        tool: 'agy',
        folder: scenarioDir,
        ...buildExecutionScope(scenarioDir),
        prompt: 'Resume and auto-deny',
        options: {
          runtimeFamily: 'agy-acp',
          agyResume: true,
          agyConversationId: 'agy-resumed-99',
          riskMode: 'full-auto',
          permissionMode: 'safe',
        },
      },
    });
    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: agyHomeDir });
    try {
      const exit = await sidecar.exited;
      assert.equal(exit.code, 0, sidecar.logs());
      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      const loadReq = trace.requests.find((req) => req.method === 'session/load');
      assert.ok(loadReq, 'session/load must be sent when resuming agy-acp');
      assert.equal(loadReq.params.sessionId, 'agy-resumed-99');
      assert.deepEqual(trace.permissionOutcomes[0]?.result?.outcome, { outcome: 'selected', optionId: 'reject-once' });
      const finalRun = await runs.getRun(runId);
      assert.equal(finalRun.state, 'completed');
      const spool = await runs.readRunSpoolRecords(runId);
      const autoDeniedRec = spool.find((r) => r.json?.type === 'ragent.approval_response' && r.json?.autoDenied === true);
      assert.ok(autoDeniedRec, 'autoDenied spool record must be persisted in full-auto');
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 2b: non-gated hermes-acp fail-closed when no reject_once option offered ----
  {
    const scenarioDir = join(workRootDir, 's2b');
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'hermes-sess-1',
      permissions: [
        {
          id: 'perm-hermes-1',
          toolCall: {
            toolCallId: 'tc-h-1',
            name: 'run_command',
            kind: 'execute',
            title: 'Only allow offered',
            rawInput: { CommandLine: 'echo hi' },
          },
          options: [{ optionId: 'allow-once', kind: 'allow_once' }],
        },
      ],
    }));
    const runId = 'run_hermes_acp_s2b';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s2b', requestId: 'req-s2b', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s2b',
        requestId: 'req-s2b',
        tool: 'hermes',
        folder: scenarioDir,
        prompt: 'Hermes fail closed',
        options: { runtimeFamily: 'hermes-acp' },
      },
    });
    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: agyHomeDir });
    try {
      const exit = await sidecar.exited;
      assert.notEqual(exit.code, 0, 'hermes without reject_once option must fail closed');
      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      assert.deepEqual(trace.permissionOutcomes[0]?.result?.outcome, { outcome: 'cancelled' });
      const finalRun = await runs.getRun(runId);
      assert.equal(finalRun.state, 'failed');
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 3: Cancel while ACP permission request is pending ----
  {
    const scenarioDir = join(workRootDir, 's3');
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'agy-cancel-1',
      waitForCancel: true,
      permissions: [
        {
          id: 'perm-cancel-1',
          toolCall: {
            toolCallId: 'tc-cancel-1',
            name: 'run_command',
            kind: 'execute',
            title: 'Blocked awaiting cancel',
            rawInput: { CommandLine: 'rm -rf .git', cwd: scenarioDir },
          },
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' },
          ],
        },
      ],
    }));
    const runId = 'run_agy_acp_s3';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s3', requestId: 'req-s3', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s3',
        requestId: 'req-s3',
        tool: 'agy',
        folder: scenarioDir,
        ...buildExecutionScope(scenarioDir),
        prompt: 'Wait then cancel',
        options: {
          runtimeFamily: 'agy-acp',
          riskMode: 'safe',
          permissionMode: 'safe',
        },
      },
    });
    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: agyHomeDir });
    try {
      await waitFor(async () => {
        const current = await runs.getRun(runId);
        return current?.appServerPendingApprovals?.some((e) => e.approvalId === 'agy:perm-cancel-1');
      }, 'S3 pending approval before cancel');
      await runs.requestRunCancel(runId);
      const exit = await sidecar.exited;
      const finalRun = await runs.getRun(runId);
      assert.equal(finalRun.state, 'cancelled');
      const card = finalRun.appServerPendingApprovals?.find((e) => e.approvalId === 'agy:perm-cancel-1');
      assert.equal(card?.decision, 'cancelled');
      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      assert.deepEqual(trace.permissionOutcomes[0]?.result?.outcome, { outcome: 'cancelled' });
      assert.equal(trace.requests.some((r) => r.method === 'session/cancel'), true, 'session/cancel must be sent');
      void exit;
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 4: Native delegation spool evidence on agy-acp ----
  {
    const scenarioDir = join(workRootDir, 's4');
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'agy-del-1',
      emitUpdatesAfterPermissions: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-sub-1',
          name: 'invoke_subagent',
          kind: 'other',
          title: 'Spawn subagent',
          rawInput: { name: 'helper-1' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-sub-1',
          name: 'invoke_subagent',
          status: 'completed',
          rawOutput: { conversation_id: 'sub-conv-1', status: 'completed' },
        },
      ],
    }));
    const runId = 'run_agy_acp_s4';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s4', requestId: 'req-s4', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s4',
        requestId: 'req-s4',
        tool: 'agy',
        folder: scenarioDir,
        prompt: 'Trigger native delegation evidence',
        options: { runtimeFamily: 'agy-acp' },
      },
    });
    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: agyHomeDir });
    try {
      const exit = await sidecar.exited;
      assert.equal(exit.code, 0, sidecar.logs());
      const finalRun = await runs.getRun(runId);
      assert.ok(finalRun.providerNativeDelegation, 'providerNativeDelegation must be reconciled when agy emits invoke_subagent evidence');
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 5a & 5b: agy-stream-json overlay + keepStdinOpen multi-turn + crash cleanup ----
  {
    const scenarioDir = join(workRootDir, 's5a');
    mkdirSync(scenarioDir, { recursive: true });
    const streamAgyHome = join(tempRoot, 's5-agy-home');
    mkdirSync(join(streamAgyHome, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(streamAgyHome, '.ragent-provider-id'), 'agy-test-profile\n', 'utf8');
    const existingMcpPath = join(streamAgyHome, '.gemini', 'config', 'mcp_config.json');
    const originalMcpJson = `${JSON.stringify({ mcpServers: { user_kept: { command: 'node', args: ['-v'] } } }, null, 2)}\n`;
    writeFileSync(existingMcpPath, originalMcpJson, 'utf8');

    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      mode: 'stream-json',
      turn1DelayMs: 50,
    }));
    const runId = 'run_agy_stream_s5a';
    const sessionId = 'sess_s5a';
    await runs.createRun({
      status: { id: runId, sessionId, requestId: 'req-s5a', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId,
        requestId: 'req-s5a',
        tool: 'agy-stream-json',
        folder: scenarioDir,
        prompt: 'turn one',
        options: {
          runtimeFamily: 'agy-stream-json',
          agyHomeDir: streamAgyHome,
          multiTurn: true,
          keepStdinOpen: true,
          sessionControlChannel: {
            token: 'sc-tok-s5a',
            runId,
            sessionId,
            turnId: 'req-s5a',
          },
          approvedActionChannel: {
            token: 'aa-tok-s5a',
            endpoint: '/api/internal/approved-actions',
            turnId: 'req-s5a',
          },
        },
      },
    });
    // Pre-enqueue steer before turn 1 completes so turn 1 result triggers multi-turn turn 2 cleanly
    await runs.updateRun(runId, (current) => ({
      ...current,
      appServerSteerQueue: [
        { id: 'steer-s5a-1', text: 'turn two', state: 'queued' },
      ],
    }));

    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: streamAgyHome });
    try {
      const exit = await sidecar.exited;
      const finalRun = await runs.getRun(runId);
      assert.equal(exit.code, 0, `exit=${exit.code} state=${finalRun?.state} reason=${finalRun?.failureReason}\nlogs:\n${sidecar.logs()}`);
      assert.equal(finalRun.state, 'completed');
      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      assert.equal(trace.turns.length, 2, 'keepStdinOpen must keep process open for turn two');
      assert.equal(trace.turns[0].message?.content, 'turn one');
      assert.equal(trace.turns[1].message?.content, 'turn two');
      const overlayServerNames = Object.keys(trace.startupMcpConfig?.mcpServers || {});
      assert.equal(overlayServerNames.includes('user_kept'), true, 'existing non-ragent server must remain in stream-json overlay');
      assert.equal(overlayServerNames.some((n) => n.startsWith('ragent_')), true, 'ragent_* managed servers injected into stream-json overlay');
      assert.equal(readFileSync(existingMcpPath, 'utf8'), originalMcpJson, 'stream-json overlay cleanup must restore original mcp_config.json');

      const spool = await runs.readRunSpoolRecords(runId);
      const results = spool.filter((r) => r.json?.event === 'result');
      assert.equal(results.length, 2);
      assert.equal(results[0].json.ragent_intermediate, true);
      assert.notEqual(results[1].json.ragent_intermediate, true);
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  {
    const scenarioDir = join(workRootDir, 's5b');
    mkdirSync(scenarioDir, { recursive: true });
    const badAgyHome = join(tempRoot, 's5b-agy-home-missing-marker');
    mkdirSync(badAgyHome, { recursive: true });
    const runId = 'run_agy_acp_s5b';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s5b', requestId: 'req-s5b', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s5b',
        requestId: 'req-s5b',
        tool: 'agy',
        folder: scenarioDir,
        prompt: 'Should fail without marker',
        options: {
          runtimeFamily: 'agy-acp',
          agyHomeDir: badAgyHome,
        },
      },
    });
    const sidecar = await spawnSidecar(runId, { RAGENT_AGY_HOME_DIR: badAgyHome });
    try {
      const exit = await sidecar.exited;
      assert.notEqual(exit.code, 0, 'built-in agy run without .ragent-provider-id marker must fail closed');
      const finalRun = await runs.getRun(runId);
      assert.equal(finalRun.state, 'failed');
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  // ---- Scenario 6: Real run.providerPreparation shape (external by-session storage + agyHomeDir + authorizedExternalMcpNames without RAGENT_AGY_HOME_DIR) ----
  {
    const scenarioDir = join(workRootDir, 's6');
    mkdirSync(scenarioDir, { recursive: true });
    const preparedAgyHome = join(tempRoot, 's6-prepared-agy-home');
    const preparedGeminiDir = join(preparedAgyHome, '.gemini');
    const preparedAppDataDir = join(preparedGeminiDir, 'antigravity-cli');
    const externalSessionStorageDir = join(tempRoot, 'by-session', 'sess_s6_hash', 'antigravity-cli');
    mkdirSync(join(preparedGeminiDir, 'config'), { recursive: true });
    mkdirSync(externalSessionStorageDir, { recursive: true });
    writeFileSync(join(preparedAgyHome, '.ragent-provider-id'), 'agy-prepared-profile\n', 'utf8');
    writeFileSync(
      join(preparedGeminiDir, 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          authorized_ext: { command: process.execPath, args: ['-e', 'console.log("s6")'] },
          blocked_ext: { command: process.execPath, args: ['-e', 'console.log("no")'] },
        },
      }),
      'utf8',
    );
    try {
      symlinkSync(externalSessionStorageDir, preparedAppDataDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      mkdirSync(preparedAppDataDir, { recursive: true });
    }

    writeFileSync(join(scenarioDir, '.fake-agy-scenario.json'), JSON.stringify({
      sessionId: 'agy-s6-conv',
    }));

    const runId = 'run_agy_acp_s6';
    await runs.createRun({
      status: { id: runId, sessionId: 'sess_s6', requestId: 'req-s6', state: 'accepted' },
      manifest: {
        id: runId,
        sessionId: 'sess_s6',
        requestId: 'req-s6',
        tool: 'agy',
        folder: scenarioDir,
        prompt: 'Verify real providerPreparation storage and home wiring',
        options: { runtimeFamily: 'agy-acp' },
      },
    });
    await runs.updateRun(runId, (current) => ({
      ...current,
      providerPreparation: {
        agyHomeDir: preparedAgyHome,
        agyGeminiDir: preparedGeminiDir,
        agyAppDataDir: preparedAppDataDir,
        agySessionStorageDir: externalSessionStorageDir,
        authorizedExternalMcpNames: ['authorized_ext'],
      },
    }));

    // Deliberately omit RAGENT_AGY_HOME_DIR so effectiveAgyHomeDir must resolve from run.providerPreparation.agyHomeDir.
    const sidecar = await spawnSidecar(runId, {});
    try {
      const exit = await sidecar.exited;
      const finalRun = await runs.getRun(runId);
      assert.equal(exit.code, 0, `S6 exited ${exit.code} state=${finalRun?.state} reason=${finalRun?.failureReason}\nlogs:\n${sidecar.logs()}`);
      assert.equal(finalRun.state, 'completed');
      assert.equal(finalRun.agyHomeDir, preparedAgyHome);
      assert.equal(finalRun.agyGeminiDir, preparedGeminiDir);
      assert.equal(finalRun.agyAppDataRelDir, 'antigravity-cli');
      assert.equal(
        finalRun.agySessionStorageDir,
        externalSessionStorageDir,
        'durable agySessionStorageDir must preserve backing by-session storage path',
      );
      const trace = JSON.parse(readFileSync(join(scenarioDir, '.fake-agy-trace.json'), 'utf8'));
      const geminiIdx = trace.args.indexOf('--gemini-dir');
      assert.equal(trace.args[geminiIdx + 1], preparedGeminiDir);
      const appDataIdx = trace.args.indexOf('--app-data-dir');
      assert.equal(trace.args[appDataIdx + 1], 'antigravity-cli');
      const newReq = trace.requests.find((req) => req.method === 'session/new');
      assert.ok(newReq);
      assert.equal(newReq.params.mcpServers.some((s) => s.name === 'authorized_ext'), true);
      assert.equal(newReq.params.mcpServers.some((s) => s.name === 'blocked_ext'), false);
    } finally {
      if (sidecar.child.exitCode === null) sidecar.child.kill();
    }
  }

  console.log('test-agy-acp-sidecar: ok');
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await new Promise((r) => setTimeout(r, 150));
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  } catch (cleanupError) {
    console.warn(`[test-agy-acp-sidecar] deferred temp cleanup warning: ${cleanupError?.message || cleanupError}`);
  }
}
