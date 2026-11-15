#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), 'ragent-title-backfill-'));
const configDir = join(tempRoot, 'config');
await mkdir(configDir, { recursive: true });
process.env.RAGENT_CONFIG_DIR = configDir;

try {
  const sessionId = 'pending-title-session';
  await writeFile(join(configDir, 'chat-sessions.json'), JSON.stringify([{
    id: sessionId,
    folder: tempRoot,
    tool: 'codex',
    sourceId: 'chat',
    name: '请帮我修复 Ragent…',
    autoRenamePending: true,
    created: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
  }]), 'utf8');

  const { appendEvent } = await import('../chat/history.mjs');
  await appendEvent(sessionId, {
    type: 'message',
    role: 'user',
    content: '请帮我修复 Ragent 会话标题生成机制，现在的标题只是机械截断第一条消息',
  });

  const dryRun = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'backfill-session-titles.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, RAGENT_CONFIG_DIR: configDir, CHAT_PORT: '17690' },
    encoding: 'utf8',
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /"mode": "dry-run"/);
  let stored = JSON.parse(await readFile(join(configDir, 'chat-sessions.json'), 'utf8'));
  assert.equal(stored[0].name, '请帮我修复 Ragent…', 'dry-run must not mutate metadata');

  const apply = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'backfill-session-titles.mjs'), '--apply'], {
    cwd: repoRoot,
    env: { ...process.env, RAGENT_CONFIG_DIR: configDir, CHAT_PORT: '17690' },
    encoding: 'utf8',
  });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /"changed": 1/);
  stored = JSON.parse(await readFile(join(configDir, 'chat-sessions.json'), 'utf8'));
  assert.equal(stored[0].name, '修复 Ragent 会话标题生成机制');
  assert.equal(stored[0].autoRenamePending, true, 'backfill keeps the next foreground turn eligible for refinement');
  assert.equal(stored[0].titleSource, 'backfill-provisional');
  assert.ok(
    (await readdir(configDir)).some((name) => name.startsWith('chat-sessions.json.titles-') && name.endsWith('.bak')),
    'apply mode should create a recoverable metadata backup',
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-session-title-backfill: ok');
