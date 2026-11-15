#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ragent-codex-goal-prompt-'));
process.env.HOME = tempHome;
process.env.RAGENT_PUBLIC_BASE_URL = '';

await fs.mkdir(path.join(tempHome, '.config', 'ragent'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, '.config', 'ragent', 'tools.json'),
  `${JSON.stringify([
    {
      id: 'micro-agent',
      name: 'Micro Agent',
      command: 'codex',
      runtimeFamily: 'codex-app-server-json',
      promptMode: 'default',
      flattenPrompt: false,
      models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
    },
  ], null, 2)}\n`,
  'utf8',
);

const { buildPromptEnvelope } = await import('../chat/session-manager.mjs');

const envelope = await buildPromptEnvelope(
  'session-codex-goal-fallback',
  {
    systemPrompt: '',
    visitorId: '',
    claudeSessionId: null,
    codexThreadId: null,
    goal: {
      objective: 'Finish the migration',
      tokenBudget: 25000,
      enabled: true,
      chasing: true,
    },
  },
  'Continue the migration.',
  'micro-agent',
  'micro-agent',
  null,
  { runtimeFamily: 'codex-app-server-json' },
);

assert.match(envelope.prompt, /Active goal.*"Finish the migration"/);
assert.match(envelope.prompt, /Token budget: 25000/);
assert.equal(envelope.metadata.includedCarrierBySection.goalInstructions, 'prompt');

console.log('test-codex-goal-prompt-fallback: ok');
