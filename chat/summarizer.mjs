import { createInterface } from 'readline';
import { readLastTurnEvents } from './history.mjs';
import { normalizeFileChangeType } from './normalizer.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { aiCircuitBreaker, createBackoffRetrier } from './ai-circuit-breaker.mjs';
import { backgroundAiQueue } from './background-ai-queue.mjs';
import { createToolInvocation, resolveCommandSpawnSpec } from './process-runner.mjs';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from '../lib/windows-managed-spawn.mjs';
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';
import { prepareControlSideClaudeProvider } from './control-side-provider.mjs';
import { resolveRunnableSessionFolder } from './session-folder.mjs';
import {
  normalizeGeneratedSessionTitle,
  isSessionAutoRenamePending,
  normalizeSessionDescription,
  normalizeSessionGroup,
} from './session-naming.mjs';
import { appendUsageLedgerRecord, buildDetachedUsageLedgerRecord } from './usage-ledger.mjs';
import {
  OperationTimeoutError,
  beginOperation,
  classifyProviderError,
  recordOperationEvent,
} from './operation-ledger.mjs';
import { loadSessionLabelPromptContext } from './session-label-context.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import {
  isNeutralWorkflowStateLabel,
  parseMergedSuggestionResult,
} from './session-suggestion.mjs';

const CODEX_APP_SERVER_RUNTIME_FAMILY = 'codex-app-server-json';
const CODEX_ONE_SHOT_RUNTIME_FAMILY = 'codex-json';
const CLAUDE_BIDI_RUNTIME_FAMILY = 'claude-stream-json-bidi';
const CLAUDE_ONE_SHOT_RUNTIME_FAMILY = 'claude-stream-json';
const MAX_PROMPT_EVENT_LINES = 120;
const MAX_PROMPT_EVENT_CHARS = 24000;
const MAX_STRUCTURED_PROMPT_CHARS = 64000;
const MAX_STRUCTURED_OUTPUT_CHARS = 1_048_576;
const TASK_CARD_SUGGESTIONS_ENV = 'AGENTOC_TASK_CARD_SUGGESTIONS';
const WORKFLOW_STATE_SUGGESTIONS_ENV = 'AGENTOC_WORKFLOW_STATE_SUGGESTIONS';
// DS-05: when enabled, task-card and workflow-state suggestions after a
// completed turn coalesce into ONE model call (merged suggestion). Set to
// 'off' to restore the old per-kind separate triggers.
const MERGED_SUGGESTIONS_ENV = 'AGENTOC_SUGGESTION_MERGED';
const LABEL_SUGGESTIONS_ENV = 'AGENTOC_SESSION_LABEL_SUGGESTIONS';
const MERGED_SUGGESTION_OPERATION = 'merged_suggestion';
const SUMMARIZER_TIMEOUT_ENV = 'AGENTOC_SUMMARIZER_TIMEOUT_MS';
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 2 * 60_000;
const LABEL_SUGGESTION_DELAY_ENV = 'AGENTOC_SESSION_LABEL_SUGGESTION_DELAY_MS';
const DEFAULT_LABEL_SUGGESTION_DELAY_MS = 1000;

async function resolveStructuredPromptRuntimeFamily(toolId) {
  const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
  let runtimeFamily = '';
  try {
    const tool = normalizedToolId ? await getToolDefinitionAsync(normalizedToolId) : null;
    runtimeFamily = typeof tool?.runtimeFamily === 'string' ? tool.runtimeFamily.trim() : '';
  } catch {}
  if (!runtimeFamily && normalizedToolId === 'codex') {
    runtimeFamily = CODEX_APP_SERVER_RUNTIME_FAMILY;
  }
  if (runtimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY) {
    return CLAUDE_ONE_SHOT_RUNTIME_FAMILY;
  }
  return runtimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY
    ? CODEX_ONE_SHOT_RUNTIME_FAMILY
    : '';
}

function clipPromptText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function selectEventsForPrompt(events, maxEvents = MAX_PROMPT_EVENT_LINES) {
  const values = Array.isArray(events) ? events : [];
  if (!Number.isInteger(maxEvents) || maxEvents <= 0 || values.length <= maxEvents) {
    return values;
  }
  const first = values[0];
  return [
    first,
    ...values.slice(-(maxEvents - 1)),
  ];
}

function pushPromptLine(lines, line, { maxTotalChars = MAX_PROMPT_EVENT_CHARS } = {}) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return false;
  const currentLength = lines.reduce((total, part) => total + part.length + 1, 0);
  const nextLength = currentLength + text.length + 1;
  if (nextLength > maxTotalChars) {
    if (!lines.at(-1)?.includes('truncated by AgentoC')) {
      lines.push('[... additional events truncated by AgentoC ...]');
    }
    return false;
  }
  lines.push(text);
  return true;
}

export function formatEventsForPrompt(events, {
  userLimit = 400,
  assistantLimit = 600,
  toolUseLimit = 400,
  toolResultLimit = 600,
  reasoningLimit = 600,
  statusLimit = 200,
  maxEvents = MAX_PROMPT_EVENT_LINES,
  maxTotalChars = MAX_PROMPT_EVENT_CHARS,
} = {}) {
  const lines = [];
  const selectedEvents = selectEventsForPrompt(events, maxEvents);
  const omittedEvents = Array.isArray(events) && selectedEvents.length < events.length
    ? events.length - selectedEvents.length
    : 0;
  if (omittedEvents > 0) {
    lines.push(`[... ${omittedEvents} earlier events omitted by AgentoC ...]`);
  }
  for (const evt of selectedEvents) {
    let line = '';
    switch (evt.type) {
      case 'message':
        if (evt.role === 'user') {
          line = `USER: ${clipPromptText(evt.content || evt.bodyPreview || '', userLimit)}`;
        } else if (evt.role === 'assistant') {
          line = `ASSISTANT: ${clipPromptText(evt.content || evt.bodyPreview || '', assistantLimit)}`;
        }
        break;
      case 'file_change':
        line = `FILE ${normalizeFileChangeType(evt.changeType).toUpperCase()}: ${evt.filePath}`;
        break;
      case 'tool_use':
        line = `TOOL CALLED: ${evt.toolName}${evt.toolInput || evt.bodyPreview ? ` — ${clipPromptText(evt.toolInput || evt.bodyPreview, toolUseLimit)}` : ''}`;
        break;
      case 'tool_result':
        line = `TOOL RESULT: ${evt.toolName || 'tool'}${evt.output || evt.bodyPreview ? ` — ${clipPromptText(evt.output || evt.bodyPreview, toolResultLimit)}` : ''}`;
        break;
      case 'reasoning':
        if (evt.content || evt.bodyPreview) {
          line = `REASONING: ${clipPromptText(evt.content || evt.bodyPreview, reasoningLimit)}`;
        }
        break;
      case 'status':
        if (evt.content || evt.message) {
          line = `STATUS: ${clipPromptText(evt.content || evt.message, statusLimit)}`;
        }
        break;
    }
    if (line && !pushPromptLine(lines, line, { maxTotalChars })) break;
  }
  return lines.join('\n');
}

function formatTurnForPrompt(events) {
  return formatEventsForPrompt(events);
}

function formatHistoryForPrompt(events) {
  return formatEventsForPrompt(events, {
    userLimit: 1200,
    assistantLimit: 1800,
    toolUseLimit: 900,
    toolResultLimit: 1200,
    reasoningLimit: 1200,
    statusLimit: 500,
  });
}

function appendSummarizerUsage(sessionMeta, usageEvent, usageTracking = {}, state = 'completed') {
  if (!usageEvent || !usageTracking) return false;
  try {
    const record = buildDetachedUsageLedgerRecord({
      session: sessionMeta,
      usageEvent,
      tracking: {
        tool: sessionMeta.tool,
        model: sessionMeta.model,
        effort: sessionMeta.effort,
        ...usageTracking,
        state,
      },
    });
    if (!record) return false;
    return appendUsageLedgerRecord(record);
  } catch (error) {
    console.error(`[usage-ledger] Failed to append summarizer usage for ${sessionMeta?.id?.slice?.(0, 8) || 'unknown'}: ${error.message}`);
    return false;
  }
}

function buildUsageSummaryFromEvent(usageEvent) {
  if (!usageEvent || typeof usageEvent !== 'object') return null;
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'contextTokens']) {
    if (Number.isInteger(usageEvent[key])) usage[key] = usageEvent[key];
  }
  if (typeof usageEvent.costUsd === 'number') usage.costUsd = usageEvent.costUsd;
  if (typeof usageEvent.estimatedCostUsd === 'number') usage.estimatedCostUsd = usageEvent.estimatedCostUsd;
  return Object.keys(usage).length > 0 ? usage : null;
}

function readSummarizerTimeoutMs() {
  const raw = String(process.env[SUMMARIZER_TIMEOUT_ENV] ?? '').trim();
  if (!raw) return DEFAULT_SUMMARIZER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SUMMARIZER_TIMEOUT_MS;
}

function readSessionLabelSuggestionDelayMs() {
  const raw = String(process.env[LABEL_SUGGESTION_DELAY_ENV] ?? '').trim();
  if (!raw) return DEFAULT_LABEL_SUGGESTION_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_LABEL_SUGGESTION_DELAY_MS;
}

async function runToolJsonPrompt(sessionMeta, prompt, usageTracking = null) {
  const {
    id: sessionId,
    folder,
    tool,
    model,
    effort,
    thinking,
    providerProfile,
    claudeModelContract,
  } = sessionMeta;

  if (!tool) {
    throw new Error('Session label suggestion requires an explicit tool');
  }
  if (prompt.length > MAX_STRUCTURED_PROMPT_CHARS) {
    throw new Error(`Structured summarizer prompt too large (${prompt.length} chars)`);
  }

  const tracking = usageTracking || {};
  const op = beginOperation({
    operation: tracking.operation || 'background_prompt',
    sessionId,
    provider: tool,
    model,
    promptText: prompt,
    attempt: tracking.attempt || 1,
    ...(tracking.operationId ? { operationId: tracking.operationId } : {}),
  });

  const runtimeFamilyOverride = await resolveStructuredPromptRuntimeFamily(tool);
  const controlProvider = await prepareControlSideClaudeProvider({
    tool,
    runtimeFamily: runtimeFamilyOverride,
    model,
    providerProfile,
    claudeModelContract,
  });
  try {
    const { command, adapter, args, input, envOverrides, runtimeFamily } = await createToolInvocation(tool, prompt, {
      dangerouslySkipPermissions: true,
      model,
      effort,
      thinking,
      systemPrefix: '',
      ...(runtimeFamilyOverride ? { runtimeFamily: runtimeFamilyOverride } : {}),
      ...(controlProvider?.claudeHomeDir ? { claudeHomeDir: controlProvider.claudeHomeDir } : {}),
    });
  const resolvedFolder = resolveRunnableSessionFolder(folder);
  if (resolvedFolder.repaired) {
    console.log(
      `[summarizer] Repaired session cwd for ${sessionId.slice(0, 8)}: ${resolvedFolder.requestedCwd} -> ${resolvedFolder.cwd} (${resolvedFolder.reason})`,
    );
  }
    const subEnv = await applyManagedRuntimeEnv(
      tool,
      buildToolProcessEnv(envOverrides || {}),
      {
        runtimeFamily,
        ...(controlProvider?.claudeHomeDir ? {
          claudeHomeDir: controlProvider.claudeHomeDir,
          claudeHomeBridgeDir: controlProvider.claudeHomeBridgeDir,
        } : {}),
      },
    );
  delete subEnv.CLAUDECODE;
  delete subEnv.CLAUDE_CODE_ENTRYPOINT;
    const resolvedCmd = await resolveCommandSpawnSpec(command, args, {
      cwd: resolvedFolder.cwd,
      env: subEnv,
    });
  console.log(
    `[summarizer] Calling tool=${tool} runtime=${runtimeFamily || 'default'} cmd=${resolvedCmd.file} model=${model || 'default'} effort=${effort || 'default'} thinking=${!!thinking} for session ${sessionId.slice(0, 8)}`
  );

  recordOperationEvent({
    kind: 'started',
    operationId: op.operationId,
    operation: op.operation,
    sessionId: op.sessionId,
    provider: op.provider,
    model: op.model,
    attempt: op.attempt,
    ts: new Date().toISOString(),
    stage: 'call',
    promptLength: op.promptLength,
    promptHash: op.promptHash,
    promptPreview: op.promptPreview,
  });

    const proc = await spawnManagedProviderProcess(resolvedCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return await new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const timeoutMs = readSummarizerTimeoutMs();
    let timeoutTimer = null;
    let outputChars = 0;

    proc.stdin.end(typeof input === 'string' ? input : '');

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];
    let latestUsageEvent = null;

    rl.on('line', (line) => {
      if (settled) return;
      try {
        const events = adapter.parseLine(line);
        for (const evt of events || []) {
          if (evt.type === 'message' && evt.role === 'assistant') {
            const content = typeof evt.content === 'string' ? evt.content : '';
            outputChars += content.length;
            if (outputChars > MAX_STRUCTURED_OUTPUT_CHARS) {
              settled = true;
              clearTimeout(timeoutTimer);
              terminateProviderProcessTree(proc, 'SIGTERM');
              const killTimer = setTimeout(() => {
                terminateProviderProcessTree(proc, 'SIGKILL');
              }, 5000);
              killTimer.unref?.();
              const errorMessage = `${tool} structured prompt output exceeded ${MAX_STRUCTURED_OUTPUT_CHARS} characters`;
              recordOperationEvent({
                kind: 'failed',
                operationId: op.operationId,
                operation: op.operation,
                sessionId: op.sessionId,
                provider: op.provider,
                model: op.model,
                attempt: op.attempt,
                ts: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                errorCode: 'output_limit',
                errorMessage,
                stage: 'call',
              });
              aiCircuitBreaker.observeOutcome({
                provider: op.provider,
                operation: op.operation,
                errorCode: 'output_limit',
                errorMessage,
                ok: false,
              });
              reject(new Error(errorMessage));
              return;
            }
            textParts.push(content);
          } else if (evt.type === 'usage') {
            latestUsageEvent = evt;
          }
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        terminateProviderProcessTree(proc, 'SIGTERM');
        const killTimer = setTimeout(() => {
          terminateProviderProcessTree(proc, 'SIGKILL');
        }, 5000);
        killTimer.unref?.();
        const errorCode = 'provider_parse';
        const errorMessage = `${tool} structured prompt output could not be parsed: ${error?.message || String(error)}`;
        recordOperationEvent({
          kind: 'failed',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          errorCode,
          errorMessage: errorMessage.slice(0, 200),
          stage: 'call',
        });
        aiCircuitBreaker.observeOutcome({
          provider: op.provider,
          operation: op.operation,
          errorCode,
          errorMessage,
          ok: false,
        });
        reject(new Error(errorMessage));
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[summarizer] stderr: ${text.slice(0, 200)}`);
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        try {
          proc.kill('SIGKILL');
        } catch {}
        console.error(`[summarizer] ${tool} structured prompt timed out for ${sessionId.slice(0, 8)} after ${timeoutMs}ms`);
        recordOperationEvent({
          kind: 'timeout',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          errorCode: 'timeout',
          stage: 'call',
        });
        aiCircuitBreaker.observeOutcome({
          provider: op.provider,
          operation: op.operation,
          errorCode: 'timeout',
          errorMessage: `${tool} structured prompt timed out`,
          ok: false,
        });
        reject(new OperationTimeoutError(`${tool} structured prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      const errorCode = classifyProviderError(err, { context: 'spawn' });
      console.error(`[summarizer] ${tool} structured prompt error for ${sessionId.slice(0, 8)}: ${err.message}`);
      recordOperationEvent({
        kind: 'failed',
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
        ts: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        errorCode,
        errorMessage: String(err?.message || '').slice(0, 200),
        stage: 'call',
      });
      aiCircuitBreaker.observeOutcome({
        provider: op.provider,
        operation: op.operation,
        errorCode,
        errorMessage: String(err?.message || ''),
        ok: false,
      });
      reject(err);
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (latestUsageEvent && usageTracking) {
        appendSummarizerUsage(sessionMeta, latestUsageEvent, {
          ...usageTracking,
          ...(op.operationId ? { runId: op.operationId, operationId: op.operationId } : {}),
        }, code === 0 ? 'completed' : 'failed');
      }
      const raw = textParts.join('\n').trim();
      const usageSummary = buildUsageSummaryFromEvent(latestUsageEvent);
      const usageLink = {
        ...(op.operationId ? { usageRunId: op.operationId } : {}),
        ...(usageSummary ? { usage: usageSummary } : {}),
      };
      if (code !== 0 && !raw) {
        recordOperationEvent({
          kind: 'failed',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          errorCode: 'provider_exit',
          errorMessage: `${tool} exited with code ${code}`,
          stage: 'call',
          ...usageLink,
        });
        aiCircuitBreaker.observeOutcome({
          provider: op.provider,
          operation: op.operation,
          errorCode: 'provider_exit',
          errorMessage: `${tool} exited with code ${code}`,
          ok: false,
        });
        reject(new Error(`${tool} exited with code ${code}`));
        return;
      }
      recordOperationEvent({
        kind: 'succeeded',
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
        ts: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        result: 'ok',
        stage: 'call',
        ...usageLink,
      });
      aiCircuitBreaker.observeOutcome({
        provider: op.provider,
        operation: op.operation,
        ok: true,
      });
      resolve(raw);
    });
    });
  } finally {
    await controlProvider?.cleanup?.();
  }
}

function parseJsonObject(modelText) {
  try {
    return JSON.parse(modelText);
  } catch {
    const jsonMatch = modelText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function getDefaultWorkflowPriorityForState(workflowState) {
  switch (normalizeSessionWorkflowState(workflowState || '')) {
    case 'waiting_user':
      return 'high';
    case 'done':
      return 'low';
    case 'parked':
      return 'medium';
    default:
      return '';
  }
}

function formatTaskCardForPrompt(taskCard) {
  const normalized = normalizeSessionTaskCard(taskCard);
  if (!normalized) return '';
  return JSON.stringify(normalized, null, 2);
}

const labelSuggestionInFlight = new Map();

export function triggerSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  const sessionId = sessionMeta?.id;
  if (!isEnvToggleEnabled(process.env[LABEL_SUGGESTIONS_ENV], { defaultValue: false })) {
    return Promise.resolve({ ok: false, skipped: 'disabled' });
  }
  const inFlightKey = sessionId ? `session-label:${sessionId}` : '';
  const inFlight = inFlightKey ? labelSuggestionInFlight.get(inFlightKey) : null;
  if (inFlight) return inFlight;

  console.log(`[summarizer] triggerSessionLabelSuggestion called for session ${sessionId?.slice(0, 8)}`);
  const operation = beginOperation({
    operation: 'session_label_suggestion',
    sessionId,
    provider: sessionMeta?.tool || '',
    model: sessionMeta?.model || '',
  });
  const requestedDelayMs = Number.isFinite(options?.delayMs) && options.delayMs >= 0
    ? options.delayMs
    : readSessionLabelSuggestionDelayMs();
  const promise = backgroundAiQueue.enqueue(
    inFlightKey,
    () => runSessionLabelSuggestion(sessionMeta, onRename, {
      ...options,
      operationId: operation.operationId,
    }),
    {
      delayMs: requestedDelayMs,
      timeoutMs: readSummarizerTimeoutMs() + 10_000,
      operationId: operation.operationId,
      operation: operation.operation,
      sessionId: operation.sessionId,
      provider: operation.provider,
      model: operation.model,
      attempt: operation.attempt,
    },
  ).catch((err) => {
    console.error(`[summarizer] Session label suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      rename: { attempted: false, renamed: false },
    };
  });
  if (inFlightKey) {
    labelSuggestionInFlight.set(inFlightKey, promise);
    const cleanup = () => {
      if (labelSuggestionInFlight.get(inFlightKey) === promise) {
        labelSuggestionInFlight.delete(inFlightKey);
      }
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}

// Suggestion throttling (2026-08-06): task-card / workflow-state suggestions spawn
// heavy LLM subprocesses after every run completion. On a small host (2 cores,
// no spare CPU) that is enough to starve the chat server's event loop and trip
// the systemd watchdog. Throttle each suggestion kind to at most one call per
// session per interval; the direct turn-completion path still updates
// workflowState/taskCard from run results, so this only delays the proactive
// LLM re-classification.
const SUGGESTION_MIN_INTERVAL_MS = 5 * 60_000;
// Per-suggestion-kind timestamps, so task-card and workflow-state each get
// their own slot (a shared slot would let whichever fires first starve the
// other — workflow-state drives the amber-dot UX and must keep running).
const lastSuggestionAtBySession = new Map();

function isSuggestionEnabled(label) {
  if (label === 'task-card') {
    return isEnvToggleEnabled(process.env[TASK_CARD_SUGGESTIONS_ENV], { defaultValue: false });
  }
  if (label === 'workflow-state') {
    return isEnvToggleEnabled(process.env[WORKFLOW_STATE_SUGGESTIONS_ENV], { defaultValue: false });
  }
  if (label === 'merged') {
    return isEnvToggleEnabled(process.env[MERGED_SUGGESTIONS_ENV], { defaultValue: false });
  }
  return true;
}

// Exported for scheduler-side apply guards: each scheduler only writes the
// suggestion part whose component toggle is enabled.
export function isSuggestionKindEnabled(label) {
  return isSuggestionEnabled(label);
}

// Exported so schedulers can pick merged vs legacy trigger per call site.
export function isMergedSuggestionEnabled() {
  return isSuggestionEnabled('merged');
}

function isSuggestionThrottled(sessionId, label) {
  if (!sessionId) return false;
  if (!isSuggestionEnabled(label)) {
    console.log(`[${label}] Disabled by environment`);
    return true;
  }
  const key = `${label}:${sessionId}`;
  const now = Date.now();
  const last = lastSuggestionAtBySession.get(key) || 0;
  if (now - last < SUGGESTION_MIN_INTERVAL_MS) {
    console.log(`[${label}] Throttled for session ${sessionId.slice(0, 8)} (last suggestion ${Math.round((now - last) / 1000)}s ago)`);
    return true;
  }
  lastSuggestionAtBySession.set(key, now);
  return false;
}

// '' = proceed; 'disabled' | 'throttled' = skip reason.
function getSuggestionSkipReason(sessionId, label) {
  if (!sessionId) return '';
  if (!isSuggestionEnabled(label)) return 'disabled';
  if (isSuggestionThrottled(sessionId, label)) return 'throttled';
  return '';
}

// Pre-queue gate skip (throttle / env-disabled) gets a structured ledger
// event so the 24h summary can distinguish "never tried" from "failed".
function recordSuggestionGateSkip({ operation, sessionMeta, reason }) {
  const op = beginOperation({
    operation,
    sessionId: sessionMeta?.id || '',
    provider: sessionMeta?.tool || '',
    model: sessionMeta?.model || '',
  });
  recordOperationEvent({
    kind: 'skipped',
    operationId: op.operationId,
    operation: op.operation,
    sessionId: op.sessionId,
    provider: op.provider,
    model: op.model,
    attempt: op.attempt,
    ts: new Date().toISOString(),
    stage: 'gate',
    reason,
  });
}

// Merged per-session suggestion slot (DS-04): task-card and workflow-state
// must not alternate queue entries for the same session. Both triggers route
// through ONE `session-suggestion:<sessionId>` queue entry per window; kinds
// that arrive while an entry is queued/running join the same slot, so at most
// one background LLM unit is scheduled per session at a time and each kind is
// throttled independently (its own 5-minute slot) inside the merged unit.
const sessionSuggestionSlots = new Map(); // sessionId -> { kinds: Set, promise }

function suggestionOperationForKind(kind) {
  return kind === 'task-card' ? 'task_card_suggestion' : 'workflow_state_suggestion';
}

function suggestionResultKey(kind) {
  return kind === 'task-card' ? 'taskCard' : 'workflowState';
}

// Read-only throttle peek for the status projection (must not consume the
// throttle slot like isSuggestionThrottled does).
function peekSuggestionThrottled(sessionId, label) {
  if (!sessionId || !isSuggestionEnabled(label)) return false;
  const key = `${label}:${sessionId}`;
  const last = lastSuggestionAtBySession.get(key) || 0;
  return Date.now() - last < SUGGESTION_MIN_INTERVAL_MS;
}

async function runMergedSessionSuggestion(kinds, sessionMeta, callOptions = {}) {
  const results = {};
  const errors = [];
  const provider = sessionMeta?.tool || '';
  for (const kind of kinds) {
    const resultKey = suggestionResultKey(kind);
    try {
      if (kind === 'task-card') {
        results[resultKey] = await runSessionTaskCardSuggestion(sessionMeta, {
          ...callOptions,
        });
      } else if (kind === 'workflow-state') {
        results[resultKey] = await runSessionWorkflowStateSuggestion(sessionMeta, {
          ...callOptions,
        });
      }
    } catch (error) {
      // Provider failures are already recorded as call-stage failed events by
      // runToolJsonPrompt; keep running the remaining kinds and let the
      // circuit breaker see each failure.
      errors.push({ kind, error });
      results[resultKey] = { ok: false, error: error?.message || String(error) };
    }
  }
  for (const { kind, error } of errors) {
    const errorCode = classifyProviderError(error, { context: 'call' });
    aiCircuitBreaker.observeOutcome({
      provider,
      operation: suggestionOperationForKind(kind),
      errorCode,
      errorMessage: String(error?.message || ''),
      ok: false,
    });
  }
  if (errors.length > 0) {
    results.ok = false;
    results.skipped = 'provider_error';
    results.error = errors[0].error?.message || String(errors[0].error);
  } else {
    results.ok = true;
  }
  return results;
}

async function drainSessionSuggestionSlot(slot, sessionMeta) {
  const combined = {};
  const provider = sessionMeta?.tool || '';
  const model = sessionMeta?.model || '';
  for (;;) {
    if (slot.kinds.size === 0) break;
    const op = beginOperation({
      operation: 'session_suggestion',
      sessionId: sessionMeta?.id,
      provider,
      model,
    });
    // Limited exponential backoff (DS-04): a timeout re-runs the whole unit
    // with the same operationId up to maxAttempts, then gives up.
    const retrier = createBackoffRetrier();
    const entryResult = await backgroundAiQueue.enqueue(
      `session-suggestion:${sessionMeta?.id}`,
      () => retrier((attempt) => {
        // Snapshot at run time, not drain time: kinds that join while this
        // entry is still queued/running land in the SAME unit, so a
        // back-to-back task-card + workflow-state pair becomes one queued
        // suggestion instead of two competing entries. The first attempt's
        // snapshot is reused on retries so a timeout keeps its kinds.
        const kinds = attempt === 1 ? [...slot.kinds] : (slot.lastKinds || []);
        if (attempt === 1) slot.lastKinds = kinds;
        slot.kinds.clear();
        return runMergedSessionSuggestion(kinds, sessionMeta, { attempt, operationId: op.operationId });
      }, {
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
      }),
      {
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
      },
    );
    if (entryResult && typeof entryResult === 'object') {
      Object.assign(combined, entryResult);
    }
    // Queue refused the entry (dedupe/full/budget/deadline/breaker): stop
    // draining; kinds that arrive later start a fresh slot.
    if (!entryResult || entryResult.skipped) break;
  }
  return combined;
}

// Shared enqueue path for both suggestion kinds: one queue entry per session
// per window, per-kind results routed back to each caller.
function enqueueMergedSessionSuggestion(sessionMeta, kind, options = {}) {
  const sessionId = sessionMeta?.id;
  const provider = sessionMeta?.tool || '';
  const emptyResult = kind === 'task-card' ? { taskCard: null } : {};
  const skipReason = getSuggestionSkipReason(sessionId, kind);
  if (skipReason) {
    recordSuggestionGateSkip({ operation: suggestionOperationForKind(kind), sessionMeta, reason: skipReason });
    return Promise.resolve({ ok: false, throttled: true, ...emptyResult });
  }
  // Per-capability circuit breaker gate (DS-04): auth cooldown / unsupported /
  // code_error block new suggestions for this provider + kind.
  const gate = aiCircuitBreaker.shouldEnqueue(provider, suggestionOperationForKind(kind));
  if (!gate.allow) {
    const reason = gate.status === 'open' ? 'breaker_open' : gate.status;
    recordSuggestionGateSkip({ operation: suggestionOperationForKind(kind), sessionMeta, reason });
    return Promise.resolve({ ok: false, skipped: reason, retryAfterMs: gate.retryAfterMs ?? null, ...emptyResult });
  }
  let slot = sessionSuggestionSlots.get(sessionId);
  if (!slot) {
    slot = { kinds: new Set() };
    sessionSuggestionSlots.set(sessionId, slot);
  }
  // Add the kind BEFORE starting the drain: drainSessionSuggestionSlot checks
  // the slot's kinds synchronously, so a kind added after the drain starts
  // would see an empty slot and immediately settle with merged_skip.
  slot.kinds.add(kind);
  if (!slot.promise) {
    slot.promise = drainSessionSuggestionSlot(slot, sessionMeta).finally(() => {
      if (slot.kinds.size === 0) sessionSuggestionSlots.delete(sessionId);
    });
  }
  return slot.promise.then((results) => {
    const partial = results && typeof results === 'object' ? results[suggestionResultKey(kind)] : null;
    if (partial && typeof partial === 'object') return partial;
    return { ok: false, skipped: results?.skipped || 'merged_skip', ...emptyResult };
  });
}

export function triggerSessionWorkflowStateSuggestion(sessionMeta, options = {}) {
  const sessionId = sessionMeta?.id;
  console.log(`[workflow-state] triggerSessionWorkflowStateSuggestion called for session ${sessionId?.slice(0, 8)}`);
  return enqueueMergedSessionSuggestion(sessionMeta, 'workflow-state', options).catch((err) => {
    console.error(`[workflow-state] Session workflow suggestion error for ${sessionId?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
    };
  });
}

export function triggerSessionTaskCardSuggestion(sessionMeta, options = {}) {
  const sessionId = sessionMeta?.id;
  console.log(`[task-card] triggerSessionTaskCardSuggestion called for session ${sessionId?.slice(0, 8)}`);
  return enqueueMergedSessionSuggestion(sessionMeta, 'task-card', options).catch((err) => {
    console.error(`[task-card] Session task card suggestion error for ${sessionId?.slice(0, 8)}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
    };
  });
}

async function runSessionLabelSuggestion(sessionMeta, onRename, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    sourceName,
    autoRenamePending,
  } = sessionMeta;

  const shouldGenerateTitle = isSessionAutoRenamePending({ name, autoRenamePending });
  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const shouldGenerateGrouping = !currentGroup || !currentDescription;
  if (!shouldGenerateTitle && !shouldGenerateGrouping) {
    return {
      ok: true,
      skipped: 'session_labels_not_needed',
      rename: { attempted: false, renamed: false },
    };
  }

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: false });
  if (lastTurnEvents.length === 0) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
      rename: { attempted: false, renamed: false },
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[summarizer] Skipping session label suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
      rename: { attempted: false, renamed: false },
    };
  }

  const promptContext = await loadSessionLabelPromptContext({
    ...sessionMeta,
    group: currentGroup,
    description: currentDescription,
  }, turnText);

  const prompt = [
    'You are naming a developer session. Be concise and literal.',
    'Treat the display group as a flexible project-like container: usually the top-level project or recurring domain. The title should name the concrete subtask inside that group.',
    'Reuse an existing display group when the scope clearly matches. Create a new group only when the work clearly belongs to a different project or domain.',
    'The latest turn may be underspecified. Use earlier session context, scope-router hints, and existing session metadata to infer the right top-level project before naming.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    sourceName ? `Current source label: ${sourceName}` : '',
    promptContext.contextSummary ? `Earlier session context:\n${promptContext.contextSummary}` : '',
    promptContext.scopeRouter ? `Known scope router entries:\n${promptContext.scopeRouter}` : '',
    promptContext.existingSessions ? `Current non-archived sessions:\n${promptContext.existingSessions}` : '',
    shouldGenerateTitle ? 'The current name is only a temporary draft. Generate a better final title based on the latest full turn, using the user request as the main signal and the assistant reply to sharpen the task wording.' : '',
    shouldGenerateGrouping ? 'Also generate a stable one-level display group for session-list organization. This is not a filesystem path.' : '',
    shouldGenerateTitle ? 'The display group is shown separately in the UI. The title must focus on the specific task inside that group and should not repeat the group/domain words unless disambiguation truly requires it.' : '',
    shouldGenerateTitle ? 'Likewise, avoid repeating connector, provider, or source labels that are already captured elsewhere in session metadata unless they add real disambiguating context.' : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    shouldGenerateTitle ? '- "title": 2-5 words — a short descriptive session title (for example: "Fix auth bug", "Refactor naming flow").' : '',
    shouldGenerateGrouping ? '- "group": 1-3 words — a stable display group for similar work (for example: "Ragent", "Video tooling", "Hiring"). Not a path.' : '',
    shouldGenerateGrouping ? '- "description": One sentence — a compact hidden description of the work, useful for future regrouping.' : '',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'session_label_suggestion',
  });
  const labelResult = parseJsonObject(modelText);
  if (shouldGenerateTitle && !labelResult?.title) {
    console.error(`[summarizer] Unexpected title output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
      rename: { attempted: true, renamed: false, error: 'Unexpected model output' },
    };
  }

  const suggestedLabels = {};
  if (shouldGenerateGrouping) {
    const nextGroup = normalizeSessionGroup(labelResult?.group || '');
    const nextDescription = normalizeSessionDescription(labelResult?.description || '');
    if (nextGroup) {
      suggestedLabels.group = nextGroup;
    }
    if (nextDescription) {
      suggestedLabels.description = nextDescription;
    }
  }

  if (!shouldGenerateTitle) {
    return {
      ok: true,
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: false, renamed: false },
    };
  }

  if (!onRename) {
    return {
      ok: true,
      title: labelResult.title,
      ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
      rename: { attempted: true, renamed: false, error: 'No rename callback provided' },
    };
  }

  const finalGroup = normalizeSessionGroup(suggestedLabels.group || currentGroup || '');
  const newName = normalizeGeneratedSessionTitle(labelResult.title, finalGroup);
  if (!newName) {
    return {
      ok: false,
      error: 'Empty title generated',
      rename: { attempted: true, renamed: false, error: 'Empty title generated' },
    };
  }

  const renamed = await onRename(newName);
  return {
    ok: true,
    title: newName,
    ...(Object.keys(suggestedLabels).length > 0 ? { summary: suggestedLabels } : {}),
    rename: renamed
      ? { attempted: true, renamed: true, title: newName }
      : { attempted: true, renamed: false, error: options.skipReason || 'Auto-rename no longer needed' },
  };
}

async function runSessionWorkflowStateSuggestion(sessionMeta, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    workflowState,
    workflowPriority,
    runState,
    queuedCount,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: false });
  if (lastTurnEvents.length === 0) {
    console.log(`[workflow-state] Skipping workflow state suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[workflow-state] Skipping workflow state suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
    };
  }

  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const currentWorkflowState = normalizeSessionWorkflowState(workflowState || '');
  const currentWorkflowPriority = normalizeSessionWorkflowPriority(workflowPriority || '');

  const prompt = [
    'You are updating Ragent workflow state for a developer session.',
    'Low-visibility workflow states must be assigned very conservatively because they push the session lower in the sidebar.',
    'Use a two-step decision:',
    '1. First decide whether the latest turn supports a high-confidence durable low-visibility state at all.',
    '2. Only if confidence is high, choose the single best durable state after the latest assistant turn.',
    'Valid states:',
    '- "parked": not currently running and not blocked on immediate user input; paused, deferred, or left open for later.',
    '- "waiting_user": the assistant needs the user before meaningful progress can continue, such as approval, an answer, files, credentials, a choice, or manual validation.',
    '- "done": the current request is clearly closed and delivered; no user feedback, opinion, reaction, or response is still being solicited to wrap the current goal.',
    'Important rules:',
    '- Never output a running state. Live runtime already handles running separately.',
    '- If the assistant asked a direct question or requested approval/input needed to proceed, prefer "waiting_user".',
    '- Do NOT choose "waiting_user" for optional follow-up questions, broad invitations to continue, or open-ended conversation that can keep moving without the user.',
    '- If the assistant delivered the requested result or clearly closed the task, prefer "done".',
    '- Do NOT choose "done" when there is any unresolved open loop, required validation, pending acceptance, or obvious next step still needed to satisfy the current goal.',
    '- Do NOT choose "done" for open-ended wrap-ups that ask for subjective feedback, reactions, opinions, or review. If that input is not a hard blocker, leave the workflow state unset.',
    '- If the assistant delivered work but is still soliciting subjective feedback or a broad reaction, do NOT choose "waiting_user" unless progress truly cannot continue without the user. Otherwise leave the workflow state unset.',
    '- If the session is explicitly paused, deferred, or intentionally left for later, choose "parked".',
    '- On failures that require user intervention, prefer "waiting_user". On failures that simply stop progress without a clear ask, prefer "parked".',
    '- If confidence is not high, do not force a low-visibility state. Leave the workflow state unset so the session can stay active.',
    '- Also choose the user-attention priority for the next glance at the session list, but only when you are setting a workflow state.',
    '- Use "high" when the user should probably look soon, especially for blockers, approvals, decisions, or important next actions.',
    '- Use "medium" for meaningful open work that matters but is not urgent right now.',
    '- Use "low" for safely parked or completed work that does not deserve immediate attention.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    currentGroup ? `Current display group: ${currentGroup}` : '',
    currentDescription ? `Current session description: ${currentDescription}` : '',
    currentWorkflowState ? `Current workflow state: ${currentWorkflowState}` : '',
    currentWorkflowPriority ? `Current workflow priority: ${currentWorkflowPriority}` : '',
    typeof runState === 'string' && runState ? `Latest run state: ${runState}` : '',
    Number.isInteger(queuedCount) ? `Queued follow-ups after this turn: ${queuedCount}` : '',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "shouldSetWorkflowState": true or false.',
    '- "workflowState": "", "parked", "waiting_user", or "done".',
    '- "workflowPriority": "", "high", "medium", or "low".',
    '- "reason": one short sentence explaining the choice.',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'workflow_state_suggestion',
    ...(options.operationId ? { operationId: options.operationId } : {}),
  });
  const stateResult = parseJsonObject(modelText);
  const rawWorkflowState = typeof stateResult?.workflowState === 'string'
    ? stateResult.workflowState.trim()
    : '';
  const rawWorkflowPriority = typeof stateResult?.workflowPriority === 'string'
    ? stateResult.workflowPriority.trim()
    : '';
  const explicitSetDecision = stateResult?.shouldSetWorkflowState === true;
  const explicitClearDecision = stateResult?.shouldSetWorkflowState === false;
  const normalizedWorkflowState = normalizeSessionWorkflowState(rawWorkflowState);
  const shouldSetWorkflowState = explicitSetDecision || Boolean(normalizedWorkflowState);
  const shouldClearWorkflowState = !shouldSetWorkflowState && (
    explicitClearDecision || isNeutralWorkflowStateLabel(rawWorkflowState)
  );

  if (!shouldSetWorkflowState && !shouldClearWorkflowState) {
    console.error(`[workflow-state] Unexpected workflow output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  const nextWorkflowState = shouldSetWorkflowState ? normalizedWorkflowState : '';
  const nextWorkflowPriority = shouldSetWorkflowState
    ? (
      normalizeSessionWorkflowPriority(rawWorkflowPriority)
      || getDefaultWorkflowPriorityForState(nextWorkflowState)
    )
    : '';

  if (shouldSetWorkflowState && !nextWorkflowState) {
    console.error(`[workflow-state] Invalid workflow state output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Invalid workflow state output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    shouldClearWorkflowState,
    workflowState: nextWorkflowState,
    workflowPriority: nextWorkflowPriority,
    reason: typeof stateResult?.reason === 'string' ? stateResult.reason.trim() : '',
  };
}

async function runSessionTaskCardSuggestion(sessionMeta, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    sourceName,
    taskCard,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: false });
  if (lastTurnEvents.length === 0) {
    console.log(`[task-card] Skipping task card suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[task-card] Skipping task card suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
    };
  }

  const currentTaskCard = formatTaskCardForPrompt(taskCard);
  const prompt = [
    'You are updating backend-owned task memory for a Ragent session.',
    'This task card is hidden state, not user-facing prose.',
    'Update it after the latest turn using stable facts, not speculative filler.',
    'Keep it concise, cumulative, and easy for the main assistant to reuse next turn.',
    'Use "project" mode when the work is multi-step, recurring, or material-heavy; otherwise use "task".',
    'Use rawMaterials only for concrete artifacts such as files, folders, screenshots, links, exports, recordings, or example outputs that matter for the work.',
    'Use memory only for durable user preferences, accepted definitions, reusable context, or lasting collaboration knowledge.',
    'Use reusablePatterns only for short strategy-like lessons, heuristics, or repeatable workflows that the assistant should reuse in later turns or similar sessions.',
    'Do not put one-off facts, temporary TODOs, or ordinary user preferences into reusablePatterns.',
    'Use needsFromUser only for information, files, approvals, or decisions the assistant currently needs from the user.',
    'If something is not clearly supported, leave it empty instead of guessing.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    sourceName ? `Current source label: ${sourceName}` : '',
    currentTaskCard ? `Current task card:\n${currentTaskCard}` : 'Current task card: none',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a JSON object with exactly these fields:',
    '- "mode": "project" or "task".',
    '- "summary": one short cumulative summary sentence.',
    '- "goal": one short current goal sentence.',
    '- "background": array of short factual context bullets.',
    '- "rawMaterials": array of concrete material references.',
    '- "assumptions": array of active assumptions worth carrying.',
    '- "knownConclusions": array of established findings or decisions.',
    '- "reusablePatterns": array of short reusable strategies or heuristics learned from the work so far.',
    '- "nextSteps": array of likely next actions already implied by the work.',
    '- "memory": array of durable reusable user/context memory.',
    '- "needsFromUser": array of current missing user inputs or decisions.',
    '',
    'Respond with ONLY valid JSON. No markdown, no explanation.',
  ].filter((line) => line !== '').join('\n');

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: 'task_card_suggestion',
    ...(options.operationId ? { operationId: options.operationId } : {}),
  });
  const nextTaskCard = normalizeSessionTaskCard(parseJsonObject(modelText));
  if (!nextTaskCard) {
    console.error(`[task-card] Unexpected task card output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    taskCard: nextTaskCard,
  };
}

// Background AI status projection (DS-04): the user-visible per-session view
// the UI uses to distinguish 没启用 / 排队 / 成功 / 失败 / 暂时跳过, plus the
// breaker states (冷却中 / 不支持 / 代码错误). Merges the queue's per-session
// projection with the per-kind breaker gates and the env toggles. Pure
// in-memory, cheap enough for every session list item.
export function buildSessionBackgroundAiProjection(session) {
  const sessionId = typeof session?.id === 'string' ? session.id : '';
  const provider = typeof session?.tool === 'string' ? session.tool : '';
  const queueStatus = backgroundAiQueue.getSessionProjection(sessionId);
  const kinds = ['task-card', 'workflow-state'];
  const gateInfo = kinds.map((kind) => {
    const gate = provider ? aiCircuitBreaker.getGate(provider, suggestionOperationForKind(kind)) : null;
    return {
      kind,
      operation: suggestionOperationForKind(kind),
      enabled: isSuggestionEnabled(kind),
      throttled: peekSuggestionThrottled(sessionId, kind),
      breakerState: gate?.state || 'closed',
      retryAfterMs: gate?.retryAfterMs ?? null,
    };
  });
  const allDisabled = gateInfo.every((gate) => !gate.enabled);
  const breakerProblem = gateInfo.find((gate) => gate.breakerState !== 'closed' && gate.breakerState !== 'half_open');
  let status = 'idle';
  if (allDisabled) {
    status = 'disabled';
  } else if (queueStatus && (queueStatus.status === 'queued' || queueStatus.status === 'running')) {
    status = queueStatus.status;
  } else if (breakerProblem) {
    status = breakerProblem.breakerState === 'open' ? 'cooldown' : breakerProblem.breakerState;
  } else if (queueStatus && ['succeeded', 'failed', 'skipped'].includes(queueStatus.status)) {
    status = queueStatus.status;
  }
  return {
    status,
    provider,
    model: queueStatus?.model || session?.model || '',
    ...(queueStatus
      ? {
          operation: queueStatus.operation,
          errorCode: queueStatus.errorCode,
          errorMessage: queueStatus.errorMessage,
          skippedReason: queueStatus.skippedReason,
          retryAfterMs: queueStatus.retryAfterMs ?? breakerProblem?.retryAfterMs ?? null,
          enqueuedAt: queueStatus.enqueuedAt,
          startedAt: queueStatus.startedAt,
          finishedAt: queueStatus.finishedAt,
          attempt: queueStatus.attempt,
          queueDepth: queueStatus.queueDepth,
        }
      : {}),
    gates: gateInfo,
  };
}
// ---------------------------------------------------------------------------
// DS-05: merged session suggestion — one model call per completed turn that
// returns taskCard + workflowState + nextAction + confidence + reason.
// The two per-kind triggers above stay as the legacy compatibility path
// (used when AGENTOC_SUGGESTION_MERGED=off); the schedulers coalesce into
// triggerSessionMergedSuggestion below, which is gated by one shared
// per-session throttle slot and one queue dedupe key, so both schedulers
// firing in the same turn still cause at most one model call.
// ---------------------------------------------------------------------------

export function buildMergedSuggestionSessionMeta(session, run, options = {}) {
  return {
    id: session?.id,
    folder: session?.folder,
    name: session?.name || '',
    sourceName: session?.sourceName || '',
    group: session?.group || '',
    description: session?.description || '',
    workflowState: session?.workflowState || '',
    workflowPriority: session?.workflowPriority || '',
    taskCard: session?.taskCard,
    tool: run?.tool || session?.tool,
    model: run?.model || undefined,
    effort: run?.effort || undefined,
    thinking: false,
    runState: run?.state,
    runId: run?.id || run?.runId || null,
    queuedCount: options.queuedCount,
  };
}

function buildMergedSuggestionPrompt(context) {
  const {
    folder,
    name,
    sourceName,
    group,
    description,
    workflowState,
    workflowPriority,
    runState,
    queuedCount,
    taskCardText,
    turnText,
  } = context;

  return [
    'You are updating Ragent backend session memory after a completed turn.',
    'Low-visibility workflow states must be assigned very conservatively because they push the session lower in the sidebar.',
    'Use a two-step decision:',
    '1. First decide whether the latest turn supports a high-confidence durable low-visibility state at all.',
    '2. Only if confidence is high, choose the single best durable state after the latest assistant turn.',
    'Valid workflowState values:',
    '- "parked": not currently running and not blocked on immediate user input; paused, deferred, or left open for later.',
    '- "waiting_user": the assistant needs the user before meaningful progress can continue, such as approval, an answer, files, credentials, a choice, or manual validation.',
    '- "done": the current request is clearly closed and delivered; no user feedback, opinion, reaction, or response is still being solicited to wrap the current goal.',
    'Important workflow rules:',
    '- Never output a running state. Live runtime already handles running separately.',
    '- If the assistant asked a direct question or requested approval/input needed to proceed, prefer "waiting_user".',
    '- Do NOT choose "waiting_user" for optional follow-up questions, broad invitations to continue, or open-ended conversation that can keep moving without the user.',
    '- If the assistant delivered the requested result or clearly closed the task, prefer "done".',
    '- Do NOT choose "done" when there is any unresolved open loop, required validation, pending acceptance, or obvious next step still needed to satisfy the current goal.',
    '- Do NOT choose "done" for open-ended wrap-ups that ask for subjective feedback, reactions, opinions, or review. If that input is not a hard blocker, leave the workflow state unset.',
    '- If the assistant delivered work but is still soliciting subjective feedback or a broad reaction, do NOT choose "waiting_user" unless progress truly cannot continue without the user. Otherwise leave the workflow state unset.',
    '- If the session is explicitly paused, deferred, or intentionally left for later, choose "parked".',
    '- On failures that require user intervention, prefer "waiting_user". On failures that simply stop progress without a clear ask, prefer "parked".',
    '- If confidence is not high, do not force a low-visibility state. Leave the workflow state unset so the session can stay active.',
    '- Also choose the user-attention priority for the next glance at the session list, but only when you are setting a workflow state.',
    '- Use "high" when the user should probably look soon, especially for blockers, approvals, decisions, or important next actions.',
    '- Use "medium" for meaningful open work that matters but is not urgent right now.',
    '- Use "low" for safely parked or completed work that does not deserve immediate attention.',
    '',
    'The taskCard is backend-owned hidden session memory, not user-facing prose.',
    'Update it after the latest turn using stable facts, not speculative filler.',
    'Keep it concise, cumulative, and easy for the main assistant to reuse next turn.',
    'Use "project" mode when the work is multi-step, recurring, or material-heavy; otherwise use "task".',
    'Use rawMaterials only for concrete artifacts such as files, folders, screenshots, links, exports, recordings, or example outputs that matter for the work.',
    'Use memory only for durable user preferences, accepted definitions, reusable context, or lasting collaboration knowledge.',
    'Use reusablePatterns only for short strategy-like lessons, heuristics, or repeatable workflows that the assistant should reuse in later turns or similar sessions.',
    'Do not put one-off facts, temporary TODOs, or ordinary user preferences into reusablePatterns.',
    'Use needsFromUser only for information, files, approvals, or decisions the assistant currently needs from the user.',
    'If something is not clearly supported, leave it empty instead of guessing.',
    '',
    `Session folder: ${folder}`,
    `Current session name: ${name || '(unnamed)'}`,
    sourceName ? `Current source label: ${sourceName}` : '',
    group ? `Current display group: ${group}` : '',
    description ? `Current session description: ${description}` : '',
    workflowState ? `Current workflow state: ${workflowState}` : '',
    workflowPriority ? `Current workflow priority: ${workflowPriority}` : '',
    typeof runState === 'string' && runState ? `Latest run state: ${runState}` : '',
    Number.isInteger(queuedCount) ? `Queued follow-ups after this turn: ${queuedCount}` : '',
    taskCardText ? `Current task card:\n${taskCardText}` : 'Current task card: none',
    '',
    'Latest turn:',
    turnText,
    '',
    'Write a single JSON object with exactly these fields (all optional):',
    '- "taskCard": an object with mode ("project" or "task"), summary, goal, background, rawMaterials, assumptions, knownConclusions, reusablePatterns, nextSteps, memory, needsFromUser — or null to keep the current card unchanged.',
    '- "workflowState": "", "parked", "waiting_user", or "done".',
    '- "workflowPriority": "", "high", "medium", or "low" — only meaningful when workflowState is set.',
    '- "shouldSetWorkflowState": true when workflowState above should be applied, false to explicitly clear any existing low-visibility state.',
    '- "nextAction": one short sentence naming the single most useful next step for the user or assistant.',
    '- "confidence": a number between 0 and 1 expressing confidence in the workflowState choice.',
    '- "reason": one short visible sentence explaining the workflowState choice.',
    '',
    'Respond with ONLY a strict fenced JSON block: ```json ... ```. No other text.',
    'Do NOT include any thinking, chain-of-thought, internal reasoning, or hidden analysis fields — "reason" is the only rationale field and it is visible.',
  ].filter((line) => line !== '').join('\n');
}

async function runSessionMergedSuggestion(sessionMeta, options = {}) {
  const {
    id: sessionId,
    folder,
    name,
    group,
    description,
    sourceName,
    taskCard,
    workflowState,
    workflowPriority,
    runState,
    queuedCount,
  } = sessionMeta;

  const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: false });
  if (lastTurnEvents.length === 0) {
    console.log(`[merged-suggestion] Skipping suggestion for ${sessionId.slice(0, 8)}: no history events`);
    return {
      ok: false,
      skipped: 'no_history',
    };
  }

  const turnText = formatTurnForPrompt(lastTurnEvents);
  if (!turnText.trim()) {
    console.log(`[merged-suggestion] Skipping suggestion for ${sessionId.slice(0, 8)}: empty turn text`);
    return {
      ok: false,
      skipped: 'empty_turn',
    };
  }

  const currentGroup = normalizeSessionGroup(group || '');
  const currentDescription = normalizeSessionDescription(description || '');
  const currentWorkflowState = normalizeSessionWorkflowState(workflowState || '');
  const currentWorkflowPriority = normalizeSessionWorkflowPriority(workflowPriority || '');
  const currentTaskCard = formatTaskCardForPrompt(taskCard);

  const prompt = buildMergedSuggestionPrompt({
    folder,
    name,
    sourceName,
    group: currentGroup,
    description: currentDescription,
    workflowState: currentWorkflowState,
    workflowPriority: currentWorkflowPriority,
    runState,
    queuedCount,
    taskCardText: currentTaskCard,
    turnText,
  });

  const modelText = await runToolJsonPrompt(sessionMeta, prompt, {
    operation: MERGED_SUGGESTION_OPERATION,
    ...(options.operationId ? { operationId: options.operationId } : {}),
  });
  const parsed = parseMergedSuggestionResult(modelText);
  if (!parsed.ok) {
    console.error(
      `[merged-suggestion] Discarded invalid suggestion for ${sessionId.slice(0, 8)}: ${parsed.reason}`
      + (parsed.fields ? ` (${parsed.fields.join(', ')})` : ''),
    );
    return {
      ok: false,
      discarded: true,
      reason: parsed.reason,
      ...(parsed.fields ? { fields: parsed.fields } : {}),
    };
  }

  const suggestion = parsed.suggestion;
  const rawWorkflowState = typeof suggestion.workflowState === 'string'
    ? suggestion.workflowState
    : '';
  const rawWorkflowPriority = typeof suggestion.workflowPriority === 'string'
    ? suggestion.workflowPriority
    : '';
  const explicitSetDecision = suggestion.shouldSetWorkflowState === true;
  const explicitClearDecision = suggestion.shouldSetWorkflowState === false;
  const shouldSetWorkflowState = explicitSetDecision || Boolean(rawWorkflowState);
  const shouldClearWorkflowState = !shouldSetWorkflowState && (
    explicitClearDecision || isNeutralWorkflowStateLabel(rawWorkflowState)
  );

  if (!shouldSetWorkflowState && !shouldClearWorkflowState) {
    console.error(`[merged-suggestion] Unexpected workflow output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Unexpected model output: ${modelText.slice(0, 200)}`,
    };
  }

  const nextWorkflowState = shouldSetWorkflowState ? rawWorkflowState : '';
  const nextWorkflowPriority = shouldSetWorkflowState
    ? (normalizeSessionWorkflowPriority(rawWorkflowPriority) || getDefaultWorkflowPriorityForState(nextWorkflowState))
    : '';

  if (shouldSetWorkflowState && !nextWorkflowState) {
    console.error(`[merged-suggestion] Invalid workflow state output for ${sessionId.slice(0, 8)}: ${modelText.slice(0, 200)}`);
    return {
      ok: false,
      error: `Invalid workflow state output: ${modelText.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    ...(suggestion.taskCard ? { taskCard: suggestion.taskCard } : {}),
    shouldClearWorkflowState,
    ...(shouldSetWorkflowState
      ? {
          workflowState: nextWorkflowState,
          workflowPriority: nextWorkflowPriority,
        }
      : {}),
    ...(suggestion.nextAction ? { nextAction: suggestion.nextAction } : {}),
    ...(Number.isFinite(suggestion.confidence) ? { confidence: suggestion.confidence } : {}),
    ...(suggestion.reason ? { reason: suggestion.reason } : {}),
  };
}

// Single-flight map: when both schedulers fire in the same completed turn,
// the second caller must receive the SAME merged result promise (not a
// throttle skip) so each scheduler can apply its own part of the result.
// Keyed by session+run so a LATER turn's scheduler is never served a stale
// in-flight suggestion (it falls through to the throttle skip instead).
// Entries are removed as soon as the promise settles; gate-skips never touch
// this map, so it cannot grow unbounded.
const mergedSuggestionInFlight = new Map();

export function triggerSessionMergedSuggestion(sessionMeta, options = {}) {
  const sessionId = sessionMeta?.id;
  if (!isMergedSuggestionEnabled() || (!isSuggestionEnabled('task-card') && !isSuggestionEnabled('workflow-state'))) {
    recordSuggestionGateSkip({ operation: MERGED_SUGGESTION_OPERATION, sessionMeta, reason: 'disabled' });
    return Promise.resolve({ ok: false, throttled: true });
  }
  // Same turn, both schedulers: return the in-flight call. Callers must pass
  // equivalent sessionMeta; the first caller's context wins.
  const inFlightKey = sessionId ? `${sessionId}:${sessionMeta?.runId ?? ''}` : null;
  const inFlight = inFlightKey ? mergedSuggestionInFlight.get(inFlightKey) : null;
  if (inFlight) return inFlight;
  const skipReason = getSuggestionSkipReason(sessionId, 'merged');
  if (skipReason) {
    recordSuggestionGateSkip({ operation: MERGED_SUGGESTION_OPERATION, sessionMeta, reason: skipReason });
    return Promise.resolve({ ok: false, throttled: true });
  }
  console.log(`[merged-suggestion] triggerSessionMergedSuggestion called for session ${sessionId?.slice(0, 8)}`);
  const startedAt = Date.now();
  const op = beginOperation({
    operation: MERGED_SUGGESTION_OPERATION,
    sessionId,
    provider: sessionMeta?.tool || '',
    model: sessionMeta?.model || '',
  });
  const promise = backgroundAiQueue.enqueue(
    `suggestion:${sessionId}`,
    () => runSessionMergedSuggestion(sessionMeta, { ...options, operationId: op.operationId }),
    {
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
    },
  )
    .then((result) => {
      console.log(
        `[merged-suggestion] Suggestion finished for session ${sessionId?.slice(0, 8)} in ${Date.now() - startedAt}ms`
        + (result?.ok ? ' (applied)' : result?.discarded ? ` (discarded: ${result.reason})` : result?.skipped ? ` (${result.skipped})` : ''),
      );
      return result;
    })
    .catch((err) => {
      console.error(`[merged-suggestion] Session suggestion error for ${sessionMeta.id?.slice(0, 8)}: ${err.message}`);
      return {
        ok: false,
        error: err.message,
      };
    });
  if (inFlightKey) {
    mergedSuggestionInFlight.set(inFlightKey, promise);
    const cleanup = () => {
      if (mergedSuggestionInFlight.get(inFlightKey) === promise) {
        mergedSuggestionInFlight.delete(inFlightKey);
      }
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}
