#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-tool-priority-'));
const configDir = join(tempHome, 'config');
const harnessRoot = join(tempHome, 'harnesses');
const fakeBin = join(tempHome, '.local', 'bin');
mkdirSync(configDir, { recursive: true });
mkdirSync(fakeBin, { recursive: true });

for (const [id, command, relDir, versionOut] of [
  ['codex', 'codex', join('node_modules', '.bin'), '0.1.0'],
  ['claude', 'claude', join('node_modules', '.bin'), '1.0.0'],
  ['copilot', 'copilot', join('node_modules', '.bin'), '1.0.0'],
  ['agy', 'agy', 'bin', '1.5.12'],
]) {
  const harnessDir = join(harnessRoot, id, relDir);
  mkdirSync(harnessDir, { recursive: true });
  for (const dir of [fakeBin, harnessDir]) {
    const posixPath = join(dir, command);
    writeFileSync(posixPath, `#!/bin/sh\necho "${versionOut}"\n`);
    try {
      chmodSync(posixPath, 0o755);
    } catch {}
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${command}.cmd`), `@echo off\r\necho ${versionOut}\r\n`);
    }
  }
}

process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.LOCALAPPDATA = join(tempHome, 'local-appdata');
process.env.APPDATA = join(tempHome, 'roaming-appdata');
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH || ''}`;

const toolsModule = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);
const { getAvailableTools, getPublicAvailableToolsAsync, getToolDefinitionAsync, isToolValid } = toolsModule;

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
  assert.equal(agy?.provider, 'agy');
  assert.equal(agy?.runtimeFamily, 'agy-acp');
  const agyCompat = await getToolDefinitionAsync('agy-stream-json');
  assert.equal(agyCompat?.id, 'agy-stream-json');
  assert.equal(agyCompat?.runtimeFamily, 'agy-stream-json');
  assert.equal(agyCompat?.internalFallback, true);
  const publicTools = await getPublicAvailableToolsAsync();
  assert.equal(publicTools.some((tool) => tool.id === 'agy-stream-json'), false, 'internal agy fallback must stay hidden from public catalog');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-tool-priority: ok');
