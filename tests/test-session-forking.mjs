#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-session-fork-'));
process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = home;
process.env.AGENTOC_CONFIG_DIR = join(home, '.config', 'agentoc');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

const workspace = join(home, 'workspace');
const configDir = join(home, '.config', 'agentoc');
const localBin = join(home, '.local', 'bin');
mkdirSync(workspace, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(localBin, { recursive: true });
delete process.env.AGENTOC_USER_SHELL_ENV_B64;
process.env.PATH = `${localBin}${delimiter}${process.env.PATH || ''}`;
writeFileSync(
  join(localBin, 'codex-fake-fork'),
  `#!/usr/bin/env node
const readline = require('readline');
let initialized = false;
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialized = true;
    send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'linux', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'thread/fork') {
    if (!initialized) {
      send({ id: message.id, error: { message: 'not initialized' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: 'codex-child-thread-native', forkedFromId: message.params.threadId } } });
    process.exit(0);
  }
});
`,
  'utf8',
);
chmodSync(join(localBin, 'codex-fake-fork'), 0o755);
if (process.platform === 'win32') {
  writeFileSync(join(localBin, 'codex-fake-fork.cmd'), `@"${process.execPath}" "${join(localBin, 'codex-fake-fork')}" %*\r\n`, 'utf8');
}
// The runtime resolves `codex` through PREFERRED_RUNTIME_COMMAND_PATHS (lib/user-shell-env.mjs),
// which wins over PATH, so a PATH-shim cannot intercept the fork. Register a custom tool whose
// command is an absolute path instead (absolute commands skip the preferred-path lookup).
writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify([{
    id: 'codex-fake-fork',
    name: 'Fake Codex Fork',
    command: join(localBin, process.platform === 'win32' ? 'codex-fake-fork.cmd' : 'codex-fake-fork'),
    runtimeFamily: 'codex-app-server-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  }], null, 2),
  'utf8',
);

const {
  createSession,
  forkSession,
  getHistory,
  getSession,
  killAll,
  submitHttpMessage,
} = await import('../chat/session-manager.mjs');
const {
  appendEvents,
  getForkContext,
  getContextHead,
  setForkContext,
  setContextHead,
} = await import('../chat/history.mjs');
const {
  getRunManifest,
} = await import('../chat/runs.mjs');
const { createProject } = await import('../chat/projects.mjs');

try {
  // Two projects may intentionally share a root. Forking must preserve the
  // explicit project binding instead of re-resolving the folder to the first
  // project created for that root.
  await createProject({ name: 'Canonical workspace project', rootPath: workspace });
  const selectedProject = await createProject({ name: 'Selected workspace project', rootPath: workspace });
  const parent = await createSession(workspace, 'codex-fake-fork', 'Invoice discussion', {
    projectId: selectedProject.id,
    group: 'Painting',
    description: 'Original discussion to branch from',
    sourceId: 'email',
    sourceName: 'Email',
    templateId: 'app-owner-console',
    templateName: 'Owner Console',
    systemPrompt: 'Stay focused on the user topic.',
    externalTriggerId: 'email-thread:parent-thread',
    completionTargets: [{
      id: 'email_target_parent',
      type: 'email',
      requestId: 'req_parent_completion',
      to: 'owner@example.com',
      subject: 'Re: source session',
      inReplyTo: '<parent@example.com>',
      references: '<parent@example.com>',
    }],
  });

  await appendEvents(parent.id, [
    {
      type: 'message',
      role: 'user',
      content: 'Let us keep the original conversation intact.',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 1,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'Sure. We can split follow-up threads later.',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 2,
    },
    {
      type: 'tool_use',
      id: 'tool_parent_1',
      toolName: 'shell',
      toolInput: 'echo hello',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 3,
    },
    {
      type: 'tool_result',
      toolName: 'shell',
      output: 'hello',
      exitCode: 0,
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 4,
    },
    {
      type: 'status',
      content: 'interrupted before follow-up',
      requestId: 'req_parent',
      runId: 'run_parent',
      timestamp: 5,
    },
  ]);

  await setContextHead(parent.id, {
    mode: 'summary',
    summary: 'The original conversation is summarized here.',
    activeFromSeq: 2,
    compactedThroughSeq: 2,
    inputTokens: 321,
    updatedAt: '2026-03-10T00:00:00.000Z',
    source: 'manual',
  });

  const sessionsPath = join(home, '.config', 'agentoc', 'chat-sessions.json');
  const storedSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const parentRecord = storedSessions.find((entry) => entry.id === parent.id);
  assert.ok(parentRecord, 'parent session record should exist');
  parentRecord.codexThreadId = 'codex-parent-thread';
  parentRecord.claudeSessionId = 'claude-parent-thread';
  parentRecord.activeRun = {
    id: 'interrupted-parent-run',
    tool: 'codex',
    model: 'fake-model',
    thinking: false,
  };
  writeFileSync(sessionsPath, JSON.stringify(storedSessions, null, 2), 'utf8');

  const child = await forkSession(parent.id);
  assert.ok(child, 'fork should create a child session');
  assert.notEqual(child.id, parent.id, 'fork should create a new session id');
  assert.equal(child.name, 'fork - Invoice discussion', 'fork should keep the fixed name prefix');
  assert.equal(child.group, parent.group, 'fork should copy the session group');
  assert.equal(child.description, parent.description, 'fork should copy the session description');
  assert.equal(child.folder, parent.folder, 'fork should keep the same folder');
  assert.equal(child.projectId, parent.projectId, 'fork should keep the explicit project binding');
  assert.equal(child.tool, parent.tool, 'fork should keep the same tool');
  assert.equal(child.templateId, parent.templateId, 'fork should keep the same template scope');
  assert.equal(child.systemPrompt, parent.systemPrompt, 'fork should keep the same prompt');
  assert.equal(child.forkedFromSessionId, parent.id, 'fork should record the parent id');
  assert.equal(child.rootSessionId, parent.id, 'first fork should use parent as root');
  assert.equal(child.sessionHierarchy?.parentSessionId, null, 'fork should not become a hierarchy child');
  assert.equal(child.sessionHierarchy?.level, parent.sessionLevel, 'fork should inherit the source hierarchy level');
  assert.equal(child.sessionHierarchy?.category, parent.sessionCategory, 'fork should inherit the source hierarchy category');
  assert.equal(child.isRootSession, true, 'fork of a root session should remain a root session');
  assert.equal(child.forkedFromSeq, 5, 'fork should record the copied sequence boundary');
  assert.equal(typeof child.forkedAt, 'string', 'fork should record forkedAt');
  assert.equal(child.activeRunId, undefined, 'fork should not keep activeRunId');
  assert.equal(child.activeRun, undefined, 'fork should not keep interrupted run state');
  assert.equal(child.codexThreadId, 'codex-child-thread-native', 'fork should use Codex native thread/fork when available');
  assert.equal(child.claudeSessionId, undefined, 'fork should clear Claude resume ids');
  assert.equal(child.externalTriggerId, undefined, 'fork should clear external trigger ids');
  assert.equal(child.completionTargets, undefined, 'fork should not inherit completion targets');
  assert.equal(child.activity?.run?.state, 'idle', 'forked child should start idle');
  assert.equal(child.latestSeq, 5, 'forked child should keep the copied history length');

  const parentLoaded = await getSession(parent.id);
  assert.equal(parentLoaded?.codexThreadId, 'codex-parent-thread', 'fork should not mutate the parent resume id');
  assert.equal(parentLoaded?.claudeSessionId, 'claude-parent-thread', 'fork should not mutate the parent Claude id');
  assert.equal(parentLoaded?.externalTriggerId, 'email-thread:parent-thread', 'fork should not mutate the parent external trigger id');
  assert.equal(parentLoaded?.completionTargets?.length, 1, 'fork should not mutate the parent completion targets');
  assert.equal(parentLoaded?.activeRun, undefined, 'session loads should prune legacy interrupted run metadata');

  const parentHistory = await getHistory(parent.id);
  const childHistory = await getHistory(child.id);
  assert.equal(childHistory.length, parentHistory.length, 'fork should copy the full normalized history');
  assert.deepEqual(
    childHistory.map((event) => event.type),
    parentHistory.map((event) => event.type),
    'fork should preserve event ordering',
  );
  assert.equal(
    childHistory.some((event) => Object.prototype.hasOwnProperty.call(event, 'runId')),
    false,
    'forked history should strip parent run ids',
  );
  assert.equal(
    childHistory.some((event) => Object.prototype.hasOwnProperty.call(event, 'requestId')),
    false,
    'forked history should strip parent request ids',
  );
  assert.equal(childHistory[0].content, parentHistory[0].content, 'fork should preserve message content');
  assert.equal(childHistory[2].toolInput, 'echo hello', 'fork should preserve tool input bodies');
  assert.equal(childHistory[3].output, 'hello', 'fork should preserve tool result bodies');

  const parentContext = await getContextHead(parent.id);
  const childContext = await getContextHead(child.id);
  assert.deepEqual(childContext, parentContext, 'fork should copy the current context head');

  const parentForkContext = await getForkContext(parent.id);
  const childForkContext = await getForkContext(child.id);
  assert.equal(parentForkContext?.preparedThroughSeq, 5, 'fork should prepare a reusable parent context snapshot');
  assert.deepEqual(
    { ...childForkContext, updatedAt: undefined },
    { ...parentForkContext, updatedAt: undefined },
    'fork should copy the prepared fork context to the child',
  );
  assert.equal(typeof childForkContext?.updatedAt, 'string', 'forked prepared context should keep its own timestamp');

  const promptParent = await createSession(workspace, 'codex-fake-fork', 'Prompt cache parent', {
    group: 'Painting',
    description: 'Prepared context prompt reuse',
    riskMode: 'recommended',
  });
  await appendEvents(promptParent.id, [
    {
      type: 'message',
      role: 'user',
      content: 'Warm this up once for all future branches.',
      timestamp: 10,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'Warm template ready.',
      timestamp: 11,
    },
  ]);
  const promptChild = await forkSession(promptParent.id);
  assert.ok(promptChild, 'second fork should succeed for prompt-cache validation');

  await setForkContext(promptChild.id, {
    mode: 'history',
    summary: '',
    continuationBody: '[Assistant]\nSENTINEL FORK CONTEXT',
    activeFromSeq: 0,
    preparedThroughSeq: promptChild.latestSeq,
    updatedAt: '2026-03-11T00:00:00.000Z',
    source: 'test',
  });

  const promptOutcome = await submitHttpMessage(promptChild.id, 'Branch into a new sub-feature.', [], {
    requestId: 'req_prompt_cache',
    queueIfBusy: false,
    skipDispatch: true,
  });
  const manifest = await getRunManifest(promptOutcome.run.id);
  assert.match(manifest?.prompt || '', /SENTINEL FORK CONTEXT/, 'first child turn should reuse the prepared fork context');

  console.log('test-session-forking: ok');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}
