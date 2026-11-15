#!/usr/bin/env node
// Exercise the real AgY runtime launcher with a harmless fake provider
// process. This verifies process/HOME isolation and overlap between two
// conversations without contacting AgY or reading a credential.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAgyRuntimeEnv,
  buildAgyRuntimeLaunchSpec,
} from '../lib/agy-runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-conversation-parallel-'));
const logPath = join(root, 'events.log');
const fakeScript = `
import { appendFile } from 'node:fs/promises';
const started = Date.now();
const row = { phase: 'start', conversation: process.env.AGY_TEST_CONVERSATION, home: process.env.HOME, started };
await appendFile(process.env.AGY_TEST_LOG, JSON.stringify(row) + '\\n');
await new Promise((resolve) => setTimeout(resolve, 180));
await appendFile(process.env.AGY_TEST_LOG, JSON.stringify({ phase: 'end', conversation: process.env.AGY_TEST_CONVERSATION, home: process.env.HOME, ended: Date.now() }) + '\\n');
`;

async function runConversation(conversation, home) {
  const env = await buildAgyRuntimeEnv({
    ...process.env,
    AGY_TEST_CONVERSATION: conversation,
    AGY_TEST_LOG: logPath,
    RAGENT_AGY_PRIVATE_KEYRING: '1',
  }, { homeDir: home });
  const spec = buildAgyRuntimeLaunchSpec({
    command: process.execPath,
    args: ['--input-type=module', '-e', fakeScript],
    env,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`fake AgY runtime exited ${code}: ${stderr}`));
    });
  });
}

try {
  const homeA = join(root, 'conversation-a');
  const homeB = join(root, 'conversation-b');
  const startedAt = Date.now();
  await Promise.all([
    runConversation('conversation-a', homeA),
    runConversation('conversation-b', homeB),
  ]);
  const elapsed = Date.now() - startedAt;
  const rows = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map((row) => row.conversation)), new Set(['conversation-a', 'conversation-b']));
  assert.deepEqual(new Set(rows.map((row) => row.home)), new Set([homeA, homeB]));
  assert.ok(elapsed < 330, `conversations should overlap, elapsed=${elapsed}ms`);
  for (const conversation of ['conversation-a', 'conversation-b']) {
    const events = rows.filter((row) => row.conversation === conversation);
    assert.deepEqual(events.map((row) => row.phase), ['start', 'end']);
  }
  console.log('test-agy-conversation-parallelism: independent conversations overlap with isolated HOME values');
} finally {
  await rm(root, { recursive: true, force: true });
}
