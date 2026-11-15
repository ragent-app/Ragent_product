#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-tool-priority-'));
const fakeBin = join(tempHome, '.local', 'bin');
mkdirSync(fakeBin, { recursive: true });

for (const command of ['codex', 'claude', 'copilot', 'agy']) {
  const path = join(fakeBin, command);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

process.env.HOME = tempHome;
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`;

const toolsModule = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);
const { getAvailableTools, getToolDefinitionAsync, isToolValid } = toolsModule;

try {
  const tools = (await getAvailableTools()).filter((tool) => tool.available);
  assert.ok(tools.length >= 3, 'fake built-in tools should be discoverable');
  assert.equal(tools[0]?.id, 'codex', 'CodeX/codex should be listed first');
  assert.equal(tools[0]?.name, 'CodeX', 'codex should use the CodeX display label');
  assert.equal(tools[1]?.id, 'claude', 'Claude Code should follow CodeX');
  assert.equal(tools[0]?.providerCapabilities?.permissionModel, 'codex-approval-sandbox');
  assert.deepEqual(
    tools[0]?.providerCapabilities?.permissionModes?.map((mode) => mode.id),
    [
      'untrusted-read-only',
      'untrusted-workspace-write',
      'untrusted-danger-full-access',
      'on-request-read-only',
      'on-request-workspace-write',
      'on-request-danger-full-access',
      'on-failure-read-only',
      'on-failure-workspace-write',
      'on-failure-danger-full-access',
      'never-read-only',
      'never-workspace-write',
      'never-danger-full-access',
    ],
    'Codex tools should expose native approval/sandbox permission modes',
  );
  assert.equal(tools[1]?.providerCapabilities?.permissionModel, 'claude-code-tools');
  assert.deepEqual(
    tools[1]?.providerCapabilities?.permissionModes?.map((mode) => mode.id),
    ['acceptEdits', 'auto', 'dontAsk', 'default', 'plan', 'bypassPermissions'],
    'Claude Code tools should expose native Claude Code permission modes',
  );
  const claudeBidi = await getToolDefinitionAsync('claude-bidi');
  assert.equal(claudeBidi?.id, 'claude-bidi', 'an exact Claude bidi tool id must not resolve through the harness alias');
  assert.equal(claudeBidi?.runtimeFamily, 'claude-stream-json-bidi', 'Claude bidi must retain its stdin runtime');
  assert.equal(await isToolValid('claude-bidi'), true, 'the exact Claude bidi tool must remain valid');
  const agy = tools.find((tool) => tool.id === 'agy');
  assert.equal(agy?.name, 'Antigravity CLI');
  assert.equal(agy?.provider, 'antigravity');
  assert.equal(agy?.runtimeFamily, 'agy-stream-json');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-tool-priority: ok');
