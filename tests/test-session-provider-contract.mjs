#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const home = mkdtempSync(join(tmpdir(), 'agentoc-session-provider-contract-'));
const configDir = join(home, '.config', 'agentoc');
const memoryDir = join(home, '.agentoc', 'memory');
const workDir = join(home, '.agentoc', 'workspace');
const binDir = join(home, '.local', 'bin');
const fakeCodexPath = join(binDir, 'fake-codex');
const fakeClaudePath = join(binDir, 'fake-claude');

mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '700');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'provider-contract-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'provider contract session reply' },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delay);
setTimeout(() => process.exit(0), delay + 50);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  fakeClaudePath,
  `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || '700');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-provider-contract-session' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'claude provider contract session reply' }] },
  }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'claude-provider-contract-session',
    usage: { input_tokens: 2, output_tokens: 3 },
  }));
}, delay);
setTimeout(() => process.exit(0), delay + 50);
`,
  'utf8',
);
chmodSync(fakeClaudePath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: fakeCodexPath,
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
      {
        id: 'fake-claude',
        name: 'Fake Claude',
        command: fakeClaudePath,
        runtimeFamily: 'claude-stream-json',
        models: [{ id: 'fake-claude-model', label: 'Fake Claude model' }],
        reasoning: {
          kind: 'toggle',
          label: 'Thinking',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_MEMORY_DIR = memoryDir;
process.env.AGENTOC_WORK_ROOT_DIR = workDir;
process.env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.FAKE_CODEX_DELAY_MS = '700';
process.env.FAKE_CLAUDE_DELAY_MS = '700';

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const runs = await import(
  pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href
);

const {
  createSession,
  getSession,
  killAll,
  listSessions,
  submitHttpMessage,
} = sessionManager;
const { getRunManifest } = runs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 5000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

async function safeRm(target, attempts = 6, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs * (i + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
}

try {
  const session = await createSession(home, 'fake-codex', 'Provider contract session test', {
    group: 'Tests',
    description: 'Verifies provider contract fields on live session activity.',
    interactionMode: 'plan',
  });

  const outcome = await submitHttpMessage(session.id, 'Check provider contract fields.', [], {
    requestId: 'req-provider-contract',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  assert.equal(outcome.run?.provider, 'codex');
  assert.equal(outcome.run?.runtimeFamily, 'codex-json');
  assert.equal(outcome.run?.providerCapabilities?.permissionModel, 'codex-approval-sandbox');
  assert.equal(outcome.run?.permissionMode, 'never-read-only');
  const manifest = await getRunManifest(outcome.run.id);
  assert.equal(manifest.contextRenderer.runtimeFamily, 'codex-json');
  assert.equal(manifest.contextRenderer.resumeUsed, false);
  assert.equal(manifest.contextRenderer.contextResumeMode, 'remote_continuation');
  assert.ok(manifest.contextRenderer.includedSections.includes('systemContext'));
  assert.equal(manifest.contextRendererVersion, manifest.contextRenderer.rendererVersion);
  assert.equal(manifest.contextResumeMode, 'remote_continuation');
  assert.ok(manifest.includedContextSections.includes('systemContext'));
  assert.equal(manifest.contextRenderer.includedCarrierBySection.systemContext, 'developerInstructions');
  assert.equal(typeof manifest.contextCharCounts.prompt, 'number');
  assert.match(manifest.developerInstructions || '', /Ragent system context:/);

  const detail = await waitFor(
    async () => {
      const current = await getSession(session.id);
      return current?.activity?.run?.state === 'running' ? current : null;
    },
    'session detail should expose running activity',
  );
  assert.equal(detail.activity.run.provider, 'codex');
  assert.equal(detail.activity.run.runtimeFamily, 'codex-json');
  assert.equal(detail.activity.run.providerCapabilities.supportsExternalUsageProjection, true);
  assert.equal(detail.activity.run.providerCapabilities.permissionModel, 'codex-approval-sandbox');
  assert.equal(detail.activity.run.permissionMode, 'never-read-only');

  const listEntry = (await listSessions()).find((entry) => entry.id === session.id);
  assert.equal(listEntry?.activity?.run?.provider, 'codex');
  assert.equal(listEntry?.activity?.run?.runtimeFamily, 'codex-json');
  assert.equal(listEntry?.activity?.run?.providerCapabilities?.supportsFileStats, true);
  assert.equal(listEntry?.activity?.run?.permissionMode, 'never-read-only');

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'session should finish running',
  );

  const claudeSession = await createSession(home, 'fake-claude', 'Claude provider contract session test', {
    group: 'Tests',
    description: 'Verifies Claude provider contract fields on live session activity.',
    riskMode: 'full-auto',
  });

  const claudeOutcome = await submitHttpMessage(claudeSession.id, 'Check Claude provider contract fields.', [], {
    requestId: 'req-claude-provider-contract',
    tool: 'fake-claude',
    model: 'fake-claude-model',
  });

  assert.equal(claudeOutcome.run?.provider, 'claude');
  assert.equal(claudeOutcome.run?.runtimeFamily, 'claude-stream-json');
  assert.equal(claudeOutcome.run?.providerCapabilities?.permissionModel, 'claude-code-tools');
  assert.equal(claudeOutcome.run?.permissionMode, 'bypassPermissions');
  const claudeManifest = await getRunManifest(claudeOutcome.run.id);
  assert.equal(claudeManifest.contextRenderer.runtimeFamily, 'claude-stream-json');
  assert.equal(claudeManifest.contextRenderer.contextResumeMode, 'remote_continuation');
  assert.equal(claudeManifest.contextRenderer.rendererStrategy, 'claude-sectioned-prompt');
  assert.equal(claudeManifest.contextResumeMode, 'remote_continuation');
  assert.equal(typeof claudeManifest.contextCharCounts.prompt, 'number');
  assert.equal(Object.prototype.hasOwnProperty.call(claudeManifest, 'developerInstructions'), false);

  const claudeDetail = await waitFor(
    async () => {
      const current = await getSession(claudeSession.id);
      return current?.activity?.run?.state === 'running' ? current : null;
    },
    'Claude session detail should expose running activity',
  );
  assert.equal(claudeDetail.activity.run.provider, 'claude');
  assert.equal(claudeDetail.activity.run.runtimeFamily, 'claude-stream-json');
  assert.equal(claudeDetail.activity.run.providerCapabilities.supportsStructuredPlanFallback, true);
  assert.equal(claudeDetail.activity.run.providerCapabilities.supportsExternalUsageProjection, false);
  assert.equal(claudeDetail.activity.run.permissionMode, 'bypassPermissions');

  const claudeListEntry = (await listSessions()).find((entry) => entry.id === claudeSession.id);
  assert.equal(claudeListEntry?.activity?.run?.provider, 'claude');
  assert.equal(claudeListEntry?.activity?.run?.runtimeFamily, 'claude-stream-json');
  assert.equal(claudeListEntry?.activity?.run?.providerCapabilities?.permissionModel, 'claude-code-tools');
  assert.equal(claudeListEntry?.activity?.run?.permissionMode, 'bypassPermissions');

  await waitFor(
    async () => (await getSession(claudeSession.id))?.activity?.run?.state === 'idle',
    'Claude session should finish running',
  );
} finally {
  killAll();
  await safeRm(home);
}

console.log('test-session-provider-contract: ok');
