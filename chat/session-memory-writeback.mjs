/**
 * Post-turn memory writeback.
 *
 * After a turn completes, evaluates whether anything durable was learned
 * and writes it back to the appropriate memory layer.
 *
 * This runs as part of the turn-close autonomy window, fully async and
 * non-blocking to the user.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  buildAutoMemorySectionHeading,
  buildNewMemoryTargetFilePreamble,
  formatMemoryWritebackTargetsForPrompt,
  loadMemoryWritebackTargets,
  resolveMemoryWritebackTarget,
} from './memory-writeback-targets.mjs';
import { extractTaggedBlock, parseJsonObjectText } from './session-text-parsing.mjs';
import {
  MODEL_CONTEXT_DIR,
} from './prompt-paths.mjs';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { aiCircuitBreaker } from './ai-circuit-breaker.mjs';
import { createKeyedTaskQueue, ensureDir, writeTextAtomic } from './fs-utils.mjs';
import { backgroundAiQueue } from './background-ai-queue.mjs';
import {
  beginOperation,
  buildSafePromptMeta,
  classifyProviderError,
  recordOperationEvent,
} from './operation-ledger.mjs';

const WRITEBACK_SETTING_ENV = 'AGENTOC_MEMORY_WRITEBACK';
const MIN_CHARS_ENV = 'AGENTOC_MEMORY_WRITEBACK_MIN_CHARS';
const COOLDOWN_ENV = 'AGENTOC_MEMORY_WRITEBACK_COOLDOWN_MS';
const TIMEOUT_ENV = 'AGENTOC_MEMORY_WRITEBACK_TIMEOUT_MS';
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const SESSION_LEARNINGS_DIR = join(MODEL_CONTEXT_DIR, 'session-learnings');
const memoryWritebackQueue = createKeyedTaskQueue();
// Per-session cooldown so ordinary turns don't each trigger a classifier call.
const lastWritebackAtBySession = new Map();

function isWritebackEnabled() {
  // Memory extraction is useful, but it launches an additional provider
  // process after ordinary turns. Keep the interactive chat path isolated
  // unless an operator explicitly enables this best-effort feature.
  return isEnvToggleEnabled(process.env[WRITEBACK_SETTING_ENV], { defaultValue: false });
}

function readMemoryWritebackMinChars() {
  const parsed = Number.parseInt(String(process.env[MIN_CHARS_ENV] ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 100;
}

function readMemoryWritebackCooldownMs() {
  const parsed = Number.parseInt(String(process.env[COOLDOWN_ENV] ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readMemoryWritebackTimeoutMs() {
  const raw = String(process.env[TIMEOUT_ENV] ?? '').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function isWritebackCoolingDown(sessionId) {
  const cooldownMs = readMemoryWritebackCooldownMs();
  if (!sessionId || cooldownMs <= 0) return false;
  const last = lastWritebackAtBySession.get(sessionId) || 0;
  return Date.now() - last < cooldownMs;
}

function clipText(text, maxChars = 3000) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

export function buildMemoryWritebackPrompt({
  userMessage,
  assistantTurnText,
  sessionName,
  sessionGroup,
  targets = [],
}) {
  const availableTargets = Array.isArray(targets) ? targets : [];
  return [
    'You are Ragent\'s hidden post-turn memory reviewer.',
    'Evaluate whether the just-completed conversation turn produced any durable, reusable knowledge worth persisting.',
    '',
    'What counts as worth persisting:',
    '- Stable user preferences confirmed across interaction (not one-off requests)',
    '- Recurring workflow patterns the user relies on',
    '- Key decisions or conclusions the user accepted',
    '- Facts about the user\'s environment, tools, or constraints',
    '- Solutions to problems that are likely to recur',
    '',
    'What does NOT count:',
    '- Session-specific task details or in-progress work',
    '- Information that\'s already obvious from context',
    '- Speculative or unverified conclusions',
    '- Trivial exchanges (greetings, acknowledgments)',
    '',
    'Session context:',
    sessionName ? `Session: ${sessionName}` : '',
    sessionGroup ? `Group: ${sessionGroup}` : '',
    '',
    'User message:',
    clipText(userMessage, 2000) || '[none]',
    '',
    'Assistant response:',
    clipText(assistantTurnText, 3000) || '[none]',
    '',
    'Available memory targets:',
    formatMemoryWritebackTargetsForPrompt(availableTargets) || '[none]',
    '',
    'Return a JSON object inside a <hide> block with these keys:',
    '- "shouldWrite": boolean — true only if something genuinely durable was learned',
    '- "learnings": array of objects, each with:',
    '  - "category": string — one of "preference", "workflow", "decision", "environment", "solution"',
    '  - "content": string — the concise learning to persist',
    '  - "layer": string — "user" (personal/machine-specific) or "system" (universal cross-deployment)',
    '  - "targetId": string — choose the smallest correct target from the available memory targets above',
    '',
    'If shouldWrite is false, return an empty learnings array.',
    'Prefer a specific existing user memory file when there is a clear fit; use the auto fallback targets only when no specific target is clearly correct.',
    'Do not invent target ids that are not listed above.',
    'Write learnings in the user\'s language.',
    'Do not output any text outside the <hide> block.',
  ].filter((line) => line !== undefined).join('\n');
}

export function parseWritebackDecision(content) {
  const text = String(content || '').trim();
  const hidden = extractTaggedBlock(text, 'hide');
  const parsed = parseJsonObjectText(hidden || text);

  if (!parsed || parsed.shouldWrite !== true) {
    return { shouldWrite: false, learnings: [] };
  }

  const learnings = Array.isArray(parsed.learnings)
    ? parsed.learnings
        .filter((l) => l && typeof l.content === 'string' && l.content.trim())
        .map((l) => ({
          category: ['preference', 'workflow', 'decision', 'environment', 'solution'].includes(l.category)
            ? l.category
            : 'decision',
          content: l.content.trim().slice(0, 500),
          layer: l.layer === 'system' ? 'system' : 'user',
          targetId: typeof l.targetId === 'string' ? l.targetId.trim() : '',
        }))
    : [];

  return { shouldWrite: learnings.length > 0, learnings };
}

function buildUniqueLearningContents(learnings = []) {
  const seen = new Set();
  const contents = [];
  for (const learning of learnings) {
    const content = String(learning?.content || '').trim();
    if (!content) continue;
    if (seen.has(content)) continue;
    seen.add(content);
    contents.push(content);
  }
  return contents;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function mergeLearningsIntoMemoryTarget(target, learnings) {
  const contents = buildUniqueLearningContents(learnings);
  if (contents.length === 0) {
    return { filePath: target.path, added: 0 };
  }

  return memoryWritebackQueue(target.path, async () => {
    const existing = (await readTextIfExists(target.path)).replace(/\r\n/g, '\n');
    const nextLines = [];

    for (const content of contents) {
      const bullet = `- ${content}`;
      const exactLinePattern = new RegExp(`(^|\\n)${escapeRegExp(bullet)}(?=\\n|$)`);
      if (!exactLinePattern.test(existing) && !nextLines.includes(bullet)) {
        nextLines.push(bullet);
      }
    }

    if (nextLines.length === 0 && existing) {
      return { filePath: target.path, added: 0 };
    }

    const sectionHeading = buildAutoMemorySectionHeading(target);
    let next = '';

    if (!existing.trim()) {
      next = `${await buildNewMemoryTargetFilePreamble(target)}\n\n${nextLines.join('\n')}\n`;
    } else if (existing.includes(`\n${sectionHeading}\n`) || existing.startsWith(`${sectionHeading}\n`)) {
      next = `${existing.trimEnd()}\n${nextLines.join('\n')}\n`;
    } else {
      next = `${existing.trimEnd()}\n\n${sectionHeading}\n\n${nextLines.join('\n')}\n`;
    }

    await writeTextAtomic(target.path, next);
    return { filePath: target.path, added: nextLines.length };
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function appendToLearningsFile(learnings, sessionId, sessionName) {
  if (!learnings.length) return;

  await memoryWritebackQueue(join(SESSION_LEARNINGS_DIR, 'learnings.jsonl'), async () => {
    await ensureDir(SESSION_LEARNINGS_DIR);
    const filePath = join(SESSION_LEARNINGS_DIR, 'learnings.jsonl');
    const timestamp = new Date().toISOString();

    const lines = learnings.map((learning) => JSON.stringify({
      ...learning,
      sessionId: sessionId?.slice(0, 12) || '',
      sessionName: sessionName?.slice(0, 60) || '',
      timestamp,
    }));

    await writeFile(filePath, lines.join('\n') + '\n', { flag: 'a' });
  });
}

async function promoteLearningsToDurableMemory(learnings) {
  const targets = await loadMemoryWritebackTargets();
  const learningsByTarget = new Map();

  for (const learning of learnings) {
    const target = resolveMemoryWritebackTarget(targets, learning);
    if (!target?.path) continue;
    const bucket = learningsByTarget.get(target.path) || { target, learnings: [] };
    bucket.learnings.push(learning);
    learningsByTarget.set(target.path, bucket);
  }

  const results = await Promise.all(
    [...learningsByTarget.values()].map(({ target, learnings: targetLearnings }) => (
      mergeLearningsIntoMemoryTarget(target, targetLearnings)
    )),
  );
  const promotedFiles = results
    .filter((result) => result.added > 0)
    .map((result) => result.filePath);
  const promotedCount = results.reduce((sum, result) => sum + (Number.isFinite(result.added) ? result.added : 0), 0);

  return {
    promotedFiles,
    promotedCount,
  };
}

/**
 * Evaluate and persist any durable learnings from the completed turn.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {object} params.session - Session metadata
 * @param {object} params.run - Completed run
 * @param {string} params.userMessage - The user's message text
 * @param {string} params.assistantTurnText - The assistant's response text
 * @param {Function} params.runPrompt - Async fn for one-shot LLM call
 * @returns {Promise<object>} Writeback result
 */
// Pre-call gate skips get a structured operation-ledger event so the 24h
// summary distinguishes "never tried" from "failed".
function recordWritebackGateSkip({ sessionId, session, run, reason }) {
  const op = beginOperation({
    operation: 'memory_writeback_review',
    sessionId: sessionId || session?.id || '',
    provider: run?.tool || session?.tool || '',
    model: run?.model || session?.model || '',
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

export async function maybeRunMemoryWriteback({
  sessionId,
  session,
  run,
  userMessage,
  assistantTurnText,
  runPrompt,
}) {
  if (!isWritebackEnabled()) {
    recordWritebackGateSkip({ sessionId, session, run, reason: 'disabled' });
    return { attempted: false, written: false };
  }

  // Skip interrupted/cancelled/failed runs: their turns are not reliable
  // sources of durable learnings.
  if (run?.state && run.state !== 'completed') {
    recordWritebackGateSkip({ sessionId, session, run, reason: 'run_not_completed' });
    return { attempted: false, written: false, skipped: 'run_not_completed' };
  }

  // Skip trivial turns
  if (!userMessage || !assistantTurnText) {
    return { attempted: false, written: false };
  }
  if (assistantTurnText.length < readMemoryWritebackMinChars()) {
    recordWritebackGateSkip({ sessionId, session, run, reason: 'assistant_turn_too_short' });
    return { attempted: false, written: false, skipped: 'assistant_turn_too_short' };
  }
  if (isWritebackCoolingDown(sessionId)) {
    recordWritebackGateSkip({ sessionId, session, run, reason: 'cooldown' });
    return { attempted: false, written: false, skipped: 'cooldown' };
  }
  if (sessionId) {
    lastWritebackAtBySession.set(sessionId, Date.now());
  }

  const op = beginOperation({
    operation: 'memory_writeback_review',
    sessionId,
    provider: run?.tool || session?.tool || '',
    model: run?.model || session?.model || '',
  });
  const timeoutMs = readMemoryWritebackTimeoutMs();

  const result = await backgroundAiQueue.enqueue(
    `memory-writeback:${sessionId}`,
    async () => {
      const targets = await loadMemoryWritebackTargets();
      const prompt = buildMemoryWritebackPrompt({
        userMessage,
        assistantTurnText,
        sessionName: session?.name || '',
        sessionGroup: session?.group || '',
        targets,
      });

      const promptMeta = buildSafePromptMeta(prompt);
      const callStartedAt = Date.now();
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
        promptLength: promptMeta.promptLength,
        promptHash: promptMeta.promptHash,
        promptPreview: promptMeta.promptPreview,
      });

      let rawResponse = '';
      try {
        rawResponse = await runPrompt(prompt, { timeoutMs });
      } catch (error) {
        const errorCode = classifyProviderError(error, { context: 'call' });
        console.error(`[memory-writeback] Classifier failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
        recordOperationEvent({
          kind: 'failed',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - callStartedAt,
          errorCode,
          errorMessage: String(error?.message || '').slice(0, 200),
          stage: 'call',
        });
        aiCircuitBreaker.observeOutcome({
          provider: op.provider,
          operation: op.operation,
          errorCode,
          errorMessage: String(error?.message || ''),
          ok: false,
        });
        return { attempted: true, written: false };
      }

      const decision = parseWritebackDecision(rawResponse);
      if (!decision.shouldWrite || decision.learnings.length === 0) {
        recordOperationEvent({
          kind: 'succeeded',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - callStartedAt,
          result: 'no_learnings',
          stage: 'call',
        });
        aiCircuitBreaker.observeOutcome({ provider: op.provider, operation: op.operation, ok: true });
        return { attempted: true, written: false };
      }

      try {
        await appendToLearningsFile(decision.learnings, sessionId, session?.name);
        const { promotedFiles, promotedCount } = await promoteLearningsToDurableMemory(decision.learnings);
        console.log(
          `[memory-writeback] Wrote ${decision.learnings.length} learning(s) from session ${sessionId?.slice(0, 8)}`
        );
        recordOperationEvent({
          kind: 'succeeded',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - callStartedAt,
          result: 'written',
          stage: 'call',
        });
        aiCircuitBreaker.observeOutcome({ provider: op.provider, operation: op.operation, ok: true });
        return {
          attempted: true,
          written: true,
          count: decision.learnings.length,
          learnings: decision.learnings,
          promotedCount,
          promotedFiles,
        };
      } catch (error) {
        console.error(`[memory-writeback] Write failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
        recordOperationEvent({
          kind: 'failed',
          operationId: op.operationId,
          operation: op.operation,
          sessionId: op.sessionId,
          provider: op.provider,
          model: op.model,
          attempt: op.attempt,
          ts: new Date().toISOString(),
          durationMs: Date.now() - callStartedAt,
          errorCode: classifyProviderError(error, { context: 'file' }),
          errorMessage: String(error?.message || '').slice(0, 200),
          stage: 'call',
        });
        return { attempted: true, written: false };
      }
    },
    {
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
      ...(timeoutMs > 0 ? { timeoutMs: timeoutMs + 10_000 } : {}),
    },
  );

  if (result?.skipped) {
    return { attempted: false, written: false, skipped: result.skipped };
  }
  return result;
}
