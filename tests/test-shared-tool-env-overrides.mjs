#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-shared-tool-env-'));
const sharedToolDir = join(tempHome, '.ragent', 'shared-tools', 'calendar-helper');
const configDir = join(tempHome, '.config', 'ragent');
const overlaysDir = join(configDir, 'tool-overlays');

mkdirSync(sharedToolDir, { recursive: true });
mkdirSync(overlaysDir, { recursive: true });

const commandPath = join(sharedToolDir, 'run-calendar');
const cardPath = join(sharedToolDir, 'TOOL.md');
const overlayPath = join(overlaysDir, 'calendar-helper.yaml');

writeFileSync(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
chmodSync(commandPath, 0o755);
writeFileSync(
  cardPath,
  `---
runtimeFamily: codex-json
command: ./run-calendar
---
# Calendar Helper
`,
  'utf8',
);
writeFileSync(overlayPath, 'default_calendar: personal\n', 'utf8');

process.env.HOME = tempHome;

const { createToolInvocation } = await import(pathToFileURL(join(repoRoot, 'chat', 'process-runner.mjs')).href);

try {
  const invocation = await createToolInvocation('calendar-helper', 'Ping');

  assert.equal(invocation.command, commandPath);
  assert.equal(invocation.envOverrides?.RAGENT_TOOL_ID, 'calendar-helper');
  assert.equal(invocation.envOverrides?.RAGENT_TOOL_SOURCE, 'shared');
  assert.equal(invocation.envOverrides?.RAGENT_TOOL_NAME, 'Calendar Helper');
  assert.equal(invocation.envOverrides?.RAGENT_SHARED_TOOL_DIR, sharedToolDir);
  assert.equal(invocation.envOverrides?.RAGENT_SHARED_TOOL_CARD, cardPath);
  assert.equal(invocation.envOverrides?.RAGENT_TOOL_OVERLAY, overlayPath);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-shared-tool-env-overrides: ok');
