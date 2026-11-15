#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The caller provides a fresh isolated RAGENT_INSTANCE_ROOT on G: before any
// config-dependent import. Never use an installed instance for this test.
const root = process.env.RAGENT_INSTANCE_ROOT;
assert.ok(root && root.startsWith('G:\\Ragent\\tmp\\chat-session-actions-20261028\\'));
const workspace = join(root, 'work');
await mkdir(workspace, { recursive: true });
const { createSession, getSession, renameSession } = await import('../chat/session-manager.mjs');
  const created = await createSession(workspace, 'codex', '', {});
  assert.equal(created.name, 'new session');
  assert.equal(created.autoRenamePending, true);
  assert.equal(created.titleSource, 'placeholder');
  const manual = await renameSession(created.id, 'New session');
  assert.equal(manual.autoRenamePending, false);
  assert.equal(manual.titleSource, 'user');
  assert.equal((await getSession(created.id)).name, 'New session');
  console.log('test-session-title-create: PASS');
