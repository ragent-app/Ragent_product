#!/usr/bin/env node
// P0 (2026-07-31): focused unit test for the auto-compact threshold logic.
// Verifies the 70% default, the RAGENT_AUTO_COMPACT_WINDOW_PERCENT override,
// the absolute RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS override, and that the
// codex-app-server-json family always skips Ragent-side compaction.
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function withEnv(env, fn) {
  const backup = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    process.env = backup;
  }
}

async function loadFresh() {
  // Re-import per case so module-level env reads reflect the current env.
  const url = pathToFileURL(join(repoRoot, 'chat', 'session-auto-compaction.mjs')).href;
  const mod = await import(`${url}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return mod;
}

// 1. Default threshold is 70% of the context window.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: undefined,
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      const run = (contextInputTokens, contextWindowTokens, runtimeFamily = 'claude-stream-json-bidi') => ({
        contextInputTokens,
        contextWindowTokens,
        runtimeFamily,
      });
      // 200K window -> threshold 140K.
      assert.equal(shouldAutoCompactRun(run(139_000, 200_000)), false, '69.5% usage must NOT compact');
      assert.equal(shouldAutoCompactRun(run(140_001, 200_000)), true, '70.0005% usage must compact');
      assert.equal(shouldAutoCompactRun(run(100, 100)), true, '100% usage must compact');
      assert.equal(shouldAutoCompactRun(run(70, 100)), false, 'exactly 70% (== threshold) must NOT compact');
      assert.equal(shouldAutoCompactRun(run(71, 100)), true, '71% must compact');
    },
  );
}

// 2. RAGENT_AUTO_COMPACT_WINDOW_PERCENT overrides the percent.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: '50',
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      const run = (contextInputTokens, contextWindowTokens) => ({
        contextInputTokens,
        contextWindowTokens,
        runtimeFamily: 'claude-stream-json-bidi',
      });
      assert.equal(shouldAutoCompactRun(run(49_999, 100_000)), false, '49.999% under 50% override must NOT compact');
      assert.equal(shouldAutoCompactRun(run(50_001, 100_000)), true, '50.001% under 50% override must compact');
    },
  );
}

// 3. Invalid percent override falls back to the 70% default.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: 'not-a-number',
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      const run = (contextInputTokens, contextWindowTokens) => ({
        contextInputTokens,
        contextWindowTokens,
        runtimeFamily: 'claude-stream-json-bidi',
      });
      assert.equal(shouldAutoCompactRun(run(80, 100)), true, '80% with invalid override still uses 70% default -> compact');
      assert.equal(shouldAutoCompactRun(run(60, 100)), false, '60% with invalid override still uses 70% default -> no compact');
    },
  );
}

// 4. Absolute RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS wins over the percent.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: '5000',
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: '90',
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      const run = (contextInputTokens) => ({
        contextInputTokens,
        contextWindowTokens: 1_000_000,
        runtimeFamily: 'claude-stream-json-bidi',
      });
      assert.equal(shouldAutoCompactRun(run(4999)), false, 'below absolute threshold must NOT compact');
      assert.equal(shouldAutoCompactRun(run(5001)), true, 'above absolute threshold must compact');
    },
  );
}

// 5. codex-app-server-json always skips regardless of usage.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: undefined,
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      assert.equal(
        shouldAutoCompactRun({
          contextInputTokens: 999_999_999,
          contextWindowTokens: 1_000_000_000,
          runtimeFamily: 'codex-app-server-json',
        }),
        false,
        'codex-app-server-json must skip Ragent compaction (native compaction handles it)',
      );
    },
  );

  // Kill-switch re-enables it.
  const { shouldAutoCompactRun: should2 } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: undefined,
      RAGENT_CODEX_NATIVE_COMPACT: 'off',
    },
    () => {
      assert.equal(
        should2({
          contextInputTokens: 95,
          contextWindowTokens: 100,
          runtimeFamily: 'codex-app-server-json',
        }),
        true,
        'codex-app-server-json with native compact disabled must compact above 70%',
      );
    },
  );
}

// 6. Missing context tokens or window -> cannot decide -> no compaction.
{
  const { shouldAutoCompactRun } = await loadFresh();
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: undefined,
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      assert.equal(
        shouldAutoCompactRun({ contextInputTokens: 1000, runtimeFamily: 'claude-stream-json-bidi' }),
        false,
        'no window size -> cannot compute threshold -> no compaction',
      );
      assert.equal(
        shouldAutoCompactRun({ runtimeFamily: 'claude-stream-json-bidi' }),
        false,
        'no usage info -> no compaction',
      );
    },
  );
}

// 7. Progressive levels: TRIM_TOOLS at 50%, COMPACT at 70%, EMERGENCY at 85%.
// The boundaries are mutually exclusive — a fixture at exactly 85% must hit
// EMERGENCY (emergency clear), NOT COMPACT (LLM summary compaction). This
// guards the regression where tests/test-auto-compaction.mjs used an 85%
// fixture expecting a 'summary' contextMode.
{
  const { getProgressiveCompactionLevel, COMPACTION_LEVEL } = await loadFresh();
  const run = (contextInputTokens, contextWindowTokens) => ({
    contextInputTokens,
    contextWindowTokens,
  });
  withEnv(
    {
      RAGENT_CURRENT_CONTEXT_COMPACT_TOKENS: undefined,
      RAGENT_AUTO_COMPACT_WINDOW_PERCENT: undefined,
      RAGENT_PROGRESSIVE_TOOL_TRIM_PERCENT: undefined,
      RAGENT_EMERGENCY_CLEAR_PERCENT: undefined,
      RAGENT_CODEX_NATIVE_COMPACT: undefined,
    },
    () => {
      assert.equal(getProgressiveCompactionLevel(run(49, 100)), COMPACTION_LEVEL.NONE, '49% must be below every level');
      assert.equal(getProgressiveCompactionLevel(run(60, 100)), COMPACTION_LEVEL.TRIM_TOOLS, '60% must trim tools');
      assert.equal(getProgressiveCompactionLevel(run(70, 100)), COMPACTION_LEVEL.COMPACT, '70% must compact');
      assert.equal(getProgressiveCompactionLevel(run(84, 100)), COMPACTION_LEVEL.COMPACT, '84% must compact');
      assert.equal(getProgressiveCompactionLevel(run(85, 100)), COMPACTION_LEVEL.EMERGENCY, '85% must emergency-clear, not compact');
      assert.equal(getProgressiveCompactionLevel(run(100, 100)), COMPACTION_LEVEL.EMERGENCY, '100% must emergency-clear');
    },
  );
}

console.log('test-session-auto-compaction-threshold: ok');
