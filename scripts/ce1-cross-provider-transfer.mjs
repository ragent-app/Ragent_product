import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExecutionStateProjection } from '../chat/execution-state-projection.mjs';
import { assembleContextPlan } from '../chat/context-attention-assembler.mjs';
import { buildCrossProviderContinuityBundle, renderCrossProviderContinuityBundle } from '../chat/cross-provider-continuity.mjs';
import { reduceContinuityEvents } from '../chat/continuity-core.mjs';
import { compileRuntimeContext } from '../chat/runtime-context-compiler.mjs';
import { workStateUpdateEvent } from '../chat/normalizer.mjs';
import { buildSessionContinuationContextFromBody, prepareSessionContinuationBody } from '../chat/session-continuation.mjs';

const execFile = promisify(execFileCallback);
const FIXED_TIME = '2026-09-01T02:00:00.000Z';
const SESSION_ID = 'ce1-codex-session-a';
const EXPECTED_FACTS = [
  { id: 'goal', needles: ['implement a small state machine'] },
  { id: 'decision', needles: ['keep the state machine in a provider-neutral module'] },
  { id: 'decision-rationale', needles: ['a provider-owned state machine would not survive a provider switch'] },
  { id: 'failed-attempt', needles: ['reuse the native codex thread as the semantic handoff'] },
  { id: 'failed-reason', needles: ['native session ids are provider-scoped'] },
  { id: 'stale-fact', needles: ['refresh-needed', 'revalidate'] },
  { id: 'next-action', needles: ['add the next transition test'] },
];

function text(value, maxChars = 2400) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function addEvent(events, event) {
  events.push({ seq: events.length + 1, ...event });
  return events.at(-1);
}

function addWorkState(events, input) {
  const event = workStateUpdateEvent(input);
  if (!event) throw new Error(`invalid CE-1 fixture work state: ${JSON.stringify(input)}`);
  // The normalizer assigns process-global event ids. CE-1's offline fixture
  // must be reproducible across repeated benchmark calls, so the probe owns a
  // deterministic id for these synthetic work-state events.
  return addEvent(events, {
    ...event,
    id: `ce1_evt_${String(events.length + 1).padStart(4, '0')}`,
    timestamp: FIXED_TIME,
  });
}

function buildFixtureEvents() {
  const events = [];
  addEvent(events, {
    type: 'message',
    role: 'user',
    content: 'Implement a small state machine and leave the second transition for the next provider.',
    timestamp: FIXED_TIME,
  });
  addWorkState(events, {
    operation: 'upsert',
    source: 'user',
    facts: [{
      kind: 'decision',
      id: 'decision-provider-neutral-state',
      value: {
        statement: 'Keep the state machine in a provider-neutral module.',
        reason: 'A provider-owned state machine would not survive a provider switch.',
        alternativesConsidered: ['Put the state machine in the Codex session transcript', 'Store it only in the Claude session'],
        rejectedAlternatives: ['Put the state machine in the Codex session transcript'],
        evidence: ['Cross-provider continuity audit'],
        decisionOwner: 'owner',
        reversible: true,
        decidedAt: FIXED_TIME,
      },
    }],
  });
  addWorkState(events, {
    operation: 'upsert',
    source: 'agent',
    facts: [{
      kind: 'failed_attempt',
      id: 'attempt-native-handoff',
      value: {
        approach: 'Reuse the native Codex thread as the semantic handoff.',
        failure: 'The new provider cannot safely inherit the native session.',
        rootCause: 'Native session ids are provider-scoped.',
        result: 'Rejected for cross-provider transfer.',
        environment: 'CE-1 isolated workspace',
        version: '2026-09-01',
        retryCondition: 'Retry only when the target provider has a matching native binding; semantic transfer remains the default.',
      },
    }],
  });
  addEvent(events, {
    type: 'tool_result',
    toolName: 'node test/state-machine.mjs',
    output: 'FAIL: second transition test is not implemented yet',
    exitCode: 1,
    runId: 'run-codex-a',
    timestamp: FIXED_TIME,
  });
  addEvent(events, {
    type: 'file_change',
    filePath: 'src/state-machine.mjs',
    changeType: 'add',
    contentHash: 'sha256:state-machine-half',
    runId: 'run-codex-a',
    timestamp: FIXED_TIME,
  });
  addWorkState(events, {
    operation: 'upsert',
    source: 'agent',
    facts: [{
      kind: 'next_action',
      id: 'next-transition-test',
      value: { text: 'Add the next transition test and run the focused state-machine test.' },
    }],
  });
  addEvent(events, {
    type: 'provider_binding',
    bindingId: 'codex',
    provider: 'codex',
    runtimeFamily: 'codex-app-server-json',
    providerProfile: 'codex-local-chatgpt',
    model: 'codex-fixture',
    nativeSessionId: 'codex-native-session-a',
    coveredThroughSeq: 6,
    timestamp: FIXED_TIME,
  });
  return events;
}

function buildFixtureState(events) {
  return reduceContinuityEvents(SESSION_ID, events, {
    executionProjection: buildExecutionStateProjection({
      run: { id: 'run-codex-a', state: 'completed' },
      events,
      workspace: {
        root: '/isolated/ce1-workspace',
        snapshotRevision: 'workspace-after-codex-a',
        observedAt: FIXED_TIME,
        stale: true,
        staleReason: 'The workspace may have changed after Codex Session A ended.',
      },
      git: {
        root: '/isolated/ce1-workspace',
        branch: 'main',
        head: 'ce1-head-a',
        dirty: true,
        observedAt: FIXED_TIME,
      },
    }),
  });
}

function buildBundle(events, state) {
  return buildCrossProviderContinuityBundle({
    sessionId: SESSION_ID,
    projectId: 'project-ce1-continuity',
    sessionName: 'Codex Session A -> Claude Session B',
    checkpoint: state,
    events,
    constraints: [
      'Do not resume the Codex native session in Claude.',
      'Revalidate workspace facts before making the next edit.',
    ],
    targetProvider: 'claude',
    targetRuntimeFamily: 'claude-stream-json',
    targetProviderProfile: 'default',
    generatedAt: FIXED_TIME,
  });
}

function carrierText(compiled) {
  return [compiled?.prompt, compiled?.developerInstructions, compiled?.systemPrefix]
    .filter((value) => typeof value === 'string' && value)
    .join('\n\n');
}

function scoreCarrier(carrier, { stale = false } = {}) {
  const normalized = String(carrier || '').toLowerCase();
  const facts = EXPECTED_FACTS.map((fact) => ({
    id: fact.id,
    matched: fact.needles.every((needle) => normalized.includes(needle.toLowerCase())),
  }));
  const matched = new Set(facts.filter((fact) => fact.matched).map((fact) => fact.id));
  return {
    facts,
    factRecall: facts.length > 0 ? Number((facts.filter((fact) => fact.matched).length / facts.length).toFixed(4)) : 0,
    decisionRationaleRecall: matched.has('decision') && matched.has('decision-rationale'),
    failedAttemptRecall: matched.has('failed-attempt') && matched.has('failed-reason'),
    staleFactHandling: matched.has('stale-fact'),
    silentStaleCurrent: stale && !matched.has('stale-fact'),
    nextActionRecall: matched.has('next-action'),
    carrierChars: String(carrier || '').length,
    estimatedTokens: Math.ceil(String(carrier || '').length / 3),
  };
}

function buildExistingContextCarrier(events, state) {
  const continuation = buildSessionContinuationContextFromBody(
    prepareSessionContinuationBody(events),
    { fromTool: 'codex', toTool: 'claude' },
  );
  const context = {
    version: 1,
    runtimeFamily: 'claude-stream-json',
    provider: 'claude',
    promptMode: 'default',
    flattenPrompt: false,
    hasResume: false,
    userText: 'Continue the state machine work.',
    sections: {
      continuationContext: continuation,
      managerTurnContext: 'Use the current Ragent context and continue safely.',
      systemContext: 'Preserve the workspace and approval boundaries.',
      sourceRuntimePrompt: '',
      templateInstructions: '',
      perMessageInstruction: '',
      visitorGuardrail: '',
      planArtifact: '',
      goalInstructions: '',
    },
    contextBudget: { maxInputTokens: 9000 },
  };
  const plan = assembleContextPlan({
    canonicalContext: context,
    checkpoint: state,
    recentEvents: events,
    maxInputTokens: 9000,
    outputReserveTokens: 600,
    sourceRevision: state.revision,
    workspaceRevision: state.execution.workspace?.snapshotRevision || '',
  });
  return carrierText(compileRuntimeContext({
    context,
    contextPlan: plan,
    runtimeFamily: 'claude-stream-json',
    options: { useAttentionPlan: true, contextCompilerMode: 'compatibility' },
  }));
}

export async function runCe1OfflineBenchmark() {
  const events = buildFixtureEvents();
  const state = buildFixtureState(events);
  const bundle = buildBundle(events, state);
  const rawRecent = prepareSessionContinuationBody(events.slice(-4));
  const existing = buildExistingContextCarrier(events, state);
  const semantic = renderCrossProviderContinuityBundle(bundle);
  const variants = [
    { variant: 'A', description: 'raw recent transcript', carrier: rawRecent },
    { variant: 'B', description: 'existing Ragent context path', carrier: existing },
    { variant: 'C', description: 'CrossProviderContinuityBundle', carrier: semantic },
  ].map(({ variant, description, carrier }) => ({
    variant,
    description,
    bundleDigest: bundle.bundleDigest,
    metrics: scoreCarrier(carrier, { stale: true }),
  }));
  const secondBundle = buildBundle(events, state);
  return {
    schemaVersion: 1,
    mode: 'ce1-offline-contract',
    scenario: {
      sessionA: 'codex',
      sessionB: 'claude',
      nativeResumeUsed: false,
      semanticResumeUsed: true,
      rawTranscriptPassedToSessionB: false,
      currentWorkspacePassedToSessionB: true,
      contains: ['user requirement', 'architecture decision', 'failed attempt', 'workspace modification', 'pending next action'],
    },
    variants,
    acceptance: {
      bundleNativeSessionIdLeak: JSON.stringify(bundle).includes('codex-native-session-a'),
      bundleDigestDeterministic: secondBundle.bundleDigest === bundle.bundleDigest,
      staleWorkspaceIsExplicit: bundle.freshness.state === 'refresh-needed',
      provenanceOnDecision: Boolean(bundle.decisions[0]?.provenance?.evidenceRefs),
      provenanceOnFailedAttempt: Boolean(bundle.failedAttempts[0]?.provenance?.evidenceRefs),
    },
    limitations: [
      'Offline carrier scoring does not prove a live provider followed the handoff.',
      'Live provider account/quota and execution are required for CE-1 completion evidence.',
    ],
  };
}

function providerEnv() {
  const env = { ...process.env };
  delete env.RAGENT_APPROVED_ACTIONS_TOKEN;
  delete env.RAGENT_SESSION_CONTROL_TOKEN;
  delete env.RAGENT_PRIVILEGED_TOKEN;
  return env;
}

async function runProvider(command, args, cwd, timeout = 180_000) {
  try {
    const result = await execFile(command, args, {
      cwd,
      env: providerEnv(),
      timeout,
      maxBuffer: 12 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout || '',
      stderr: error?.stderr || '',
      error: text(error?.message, 400),
    };
  }
}

async function commandVersion(command) {
  const result = await runProvider(command, ['--version'], process.cwd(), 20_000);
  const firstLine = String(result.stdout || result.stderr || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  return text(firstLine, 200);
}

async function listWorkspaceFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        result.push({
          path: relative(root, path).replaceAll('\\', '/'),
          changeType: 'update',
          contentHash: digest(content),
        });
      }
    }
  }
  await visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function parseClaudeAnswer(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return text(parsed?.result || parsed?.content || parsed?.message, 40_000);
  } catch {
    return text(stdout, 40_000);
  }
}

function providerFailureSummary(result) {
  if (result.code === 0 && !result.error) return '';
  const lines = `${result.stdout || ''}\n${result.stderr || ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.is_error || parsed?.subtype === 'error' || parsed?.type === 'error') {
        const message = parsed.result || parsed.error || parsed.message;
        if (message) return text(message, 320);
      }
    } catch {}
  }
  return text(
    lines.find((line) => /\b(error|failed|permission|unavailable|malformed)\b/i.test(line))
      || result.error,
    320,
  );
}

function safeOutputSummary(result) {
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const failureSummary = providerFailureSummary(result);
  return {
    exitCode: result.code,
    outputChars: combined.length,
    outputDigest: digest(combined),
    errorClass: result.error ? text(result.error.split(':')[0], 120) : '',
    ...(failureSummary ? { failureSummary } : {}),
  };
}

export async function runCe1Live({ outputPath = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-ce1-live-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, 'tests'), { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# CE-1 isolated workspace\n', 'utf8');
  await writeFile(join(workspace, 'src', 'state-machine.mjs'), 'export function transition(state, event) {\n  return state;\n}\n', 'utf8');

  const codexPrompt = [
    'This is Codex Session A in an isolated temporary workspace.',
    'Implement only the first half of the small state-machine task.',
    'Create or update src/state-machine.mjs with a provider-neutral transition function.',
    'Before editing, run one deliberately failing local check: node -e "process.exit(1)".',
    'Do not implement the second transition test. Leave this exact next action for a future provider: add the next transition test and run the focused state-machine test.',
    'In your final response, state that the native Codex session is not a semantic handoff mechanism for another provider.',
    'Do not access the network and do not modify files outside the current workspace.',
  ].join('\n');
  const codex = await runProvider('codex', [
    'exec', '--json', '--ephemeral', '--approve-for-me',
    '--skip-git-repo-check', '-C', workspace, codexPrompt,
  ], workspace);
  const filesAfterCodex = await listWorkspaceFiles(workspace);
  const events = [];
  addEvent(events, { type: 'message', role: 'user', content: 'Implement a small state machine and leave the second transition for the next provider.', timestamp: new Date().toISOString() });
  addEvent(events, { type: 'tool_result', toolName: 'codex exec', output: `Codex Session A completed with exit code ${codex.code}.`, exitCode: codex.code, runId: 'run-codex-a', timestamp: new Date().toISOString() });
  addEvent(events, { type: 'tool_result', toolName: 'node -e process.exit(1)', output: 'Deliberate failed attempt recorded by Session A.', exitCode: 1, runId: 'run-codex-a', timestamp: new Date().toISOString() });
  for (const file of filesAfterCodex) addEvent(events, { type: 'file_change', ...file, runId: 'run-codex-a', timestamp: new Date().toISOString() });
  addWorkState(events, {
    operation: 'upsert',
    source: 'agent',
    facts: [{
      kind: 'decision',
      id: 'decision-provider-neutral-state',
      value: {
        statement: 'Keep the state machine in a provider-neutral module.',
        reason: 'A provider-owned state machine would not survive a provider switch.',
        alternativesConsidered: ['Put the state machine in the Codex session transcript'],
        rejectedAlternatives: ['Put the state machine in the Codex session transcript'],
        decisionOwner: 'owner',
        reversible: true,
      },
    }, {
      kind: 'failed_attempt',
      id: 'attempt-native-handoff',
      value: {
        approach: 'Reuse the native Codex thread as the semantic handoff.',
        failure: 'The new provider cannot safely inherit the native session.',
        rootCause: 'Native session ids are provider-scoped.',
        result: 'Rejected for cross-provider transfer.',
        environment: 'CE-1 isolated workspace',
        version: await commandVersion('codex'),
        retryCondition: 'Retry only when the target provider has a matching native binding; semantic transfer remains the default.',
      },
    }, {
      kind: 'next_action',
      id: 'next-transition-test',
      value: { text: 'Add the next transition test and run the focused state-machine test.' },
    }],
  });
  addEvent(events, {
    type: 'provider_binding',
    bindingId: 'codex',
    provider: 'codex',
    runtimeFamily: 'codex-app-server-json',
    providerProfile: 'codex-local-chatgpt',
    model: 'live-codex',
    nativeSessionId: 'redacted-codex-native-session-a',
    coveredThroughSeq: events.length,
    timestamp: new Date().toISOString(),
  });
  const snapshotRevision = digest(filesAfterCodex.map((file) => `${file.path}:${file.contentHash}`).join('\n'));
  const state = reduceContinuityEvents(SESSION_ID, events, {
    executionProjection: buildExecutionStateProjection({
      run: { id: 'run-codex-a', state: codex.code === 0 ? 'completed' : 'failed' },
      events,
      workspace: {
        root: workspace,
        snapshotRevision,
        observedAt: new Date().toISOString(),
        stale: false,
      },
      files: filesAfterCodex,
    }),
  });
  const bundle = buildCrossProviderContinuityBundle({
    sessionId: SESSION_ID,
    projectId: 'project-ce1-continuity',
    sessionName: 'Codex Session A -> Claude Session B',
    checkpoint: state,
    events,
    constraints: ['Do not resume the Codex native session in Claude.', 'Revalidate workspace facts before editing.'],
    targetProvider: 'claude',
    targetRuntimeFamily: 'claude-stream-json',
    generatedAt: new Date().toISOString(),
  });

  let claude = null;
  let claudeAnswer = '';
  let nextFileExists = false;
  if (codex.code === 0) {
    const prompt = [
      renderCrossProviderContinuityBundle(bundle),
      '',
      'You are a brand-new Claude Session B. Do not resume or refer to the Codex native session.',
      'Use only the semantic bundle above, the current workspace, and your normal system instructions.',
      'First answer these checks briefly: current task, completed point, decision and rationale, failed attempt and reason, facts to revalidate, workspace state, next action, and what not to repeat.',
      'Then execute the next action: add tests/next-transition.mjs with a focused assertion for the second transition, and do not modify unrelated files.',
      'After the edit, run the focused test if possible. Return a concise result.',
    ].join('\n\n');
    claude = await runProvider('claude', [
      '-p', '--output-format', 'json', '--no-session-persistence', '--safe-mode',
      '--permission-mode', 'acceptEdits', '--allowed-tools', 'Read,Write,Edit,Bash',
      '--add-dir', workspace, '--append-system-prompt',
      'This is a cross-provider continuity evaluation. Keep all writes inside the provided workspace.',
      prompt,
    ], workspace);
    claudeAnswer = parseClaudeAnswer(claude.stdout);
    try {
      await stat(join(workspace, 'tests', 'next-transition.mjs'));
      nextFileExists = true;
    } catch {}
  }

  const report = {
    schemaVersion: 1,
    mode: 'ce1-live-provider-transfer',
    scenario: {
      sessionA: 'codex',
      sessionB: 'claude',
      nativeResumeUsed: false,
      semanticResumeUsed: true,
      rawTranscriptPassedToSessionB: false,
      isolatedWorkspace: true,
      workspaceResult: nextFileExists ? 'next-step-file-created' : 'next-step-file-not-created',
    },
    providers: {
      codex: { version: await commandVersion('codex'), ...safeOutputSummary(codex), filesAfterSessionA: filesAfterCodex.map((file) => file.path) },
      claude: claude
        ? { version: await commandVersion('claude'), ...safeOutputSummary(claude), answerChars: claudeAnswer.length }
        : { state: 'not-run', reason: 'Codex Session A did not complete' },
    },
    bundle: {
      schemaVersion: bundle.schemaVersion,
      digest: bundle.bundleDigest,
      factCounts: {
        decisions: bundle.decisions.length,
        failedAttempts: bundle.failedAttempts.length,
        workspaceFiles: bundle.workspaceState.files.length,
        nextActions: bundle.nextActions.length,
      },
      nativeSessionIdLeak: JSON.stringify(bundle).includes('redacted-codex-native-session-a'),
    },
    acceptance: {
      codexSessionACompleted: codex.code === 0,
      freshClaudeSessionInvoked: Boolean(claude),
      nextStepExecuted: nextFileExists,
      answer: scoreCarrier(claudeAnswer),
    },
    note: 'Provider stdout/stderr is intentionally reduced to size and digest; raw output is not persisted.',
  };
  await rm(root, { recursive: true, force: true });
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const live = process.argv.includes('--live');
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = outputFlag >= 0 ? resolve(process.argv[outputFlag + 1]) : '';
  const report = live ? await runCe1Live({ outputPath }) : await runCe1OfflineBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
