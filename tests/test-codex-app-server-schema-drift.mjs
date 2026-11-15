#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { resolveInternalHarnessCommandPath } from '../lib/harness-paths.mjs';
import { buildPlatformSpawnSpec } from '../lib/executable-resolution.mjs';

function collectMethodEnums(value, methods = new Set()) {
  if (!value || typeof value !== 'object') return methods;
  const method = value.properties?.method;
  if (Array.isArray(method?.enum)) {
    for (const entry of method.enum) methods.add(entry);
  }
  for (const child of Object.values(value)) {
    collectMethodEnums(child, methods);
  }
  return methods;
}

function readMethods(schemaPath) {
  return collectMethodEnums(JSON.parse(readFileSync(schemaPath, 'utf8')));
}

function assertHasMethods(methods, expected, label) {
  for (const method of expected) {
    assert.ok(methods.has(method), `${label} should include ${method}`);
  }
}

const command = await resolveInternalHarnessCommandPath('codex');
if (!command) {
  console.log('test-codex-app-server-schema-drift: skipped (internal codex not installed)');
  process.exit(0);
}
function invoke(args, options) {
  const spec = buildPlatformSpawnSpec(command, args);
  return spawnSync(spec.file, spec.args, { ...options, shell: spec.shell,
    ...(spec.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: spec.windowsVerbatimArguments }) });
}
const hasCodex = invoke(['--version'], {
  encoding: 'utf8',
  timeout: 5000,
});
if (hasCodex.error?.code === 'ENOENT' || hasCodex.status === 127) {
  console.log('test-codex-app-server-schema-drift: skipped (internal codex unavailable)');
  process.exit(0);
}

const outDir = mkdtempSync(join(tmpdir(), 'ragent-codex-schema-'));
try {
  const generated = invoke(['app-server', 'generate-json-schema', '--experimental', '--out', outDir], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    generated.status,
    0,
    `codex app-server schema generation should succeed\nstdout:\n${generated.stdout}\nstderr:\n${generated.stderr}`,
  );

  const clientRequestMethods = readMethods(join(outDir, 'ClientRequest.json'));
  const serverNotificationMethods = readMethods(join(outDir, 'ServerNotification.json'));
  const serverRequestMethods = readMethods(join(outDir, 'ServerRequest.json'));

  assertHasMethods(clientRequestMethods, [
    'initialize',
    'thread/start',
    'thread/resume',
    'thread/fork',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'mcpServerStatus/list',
  ], 'ClientRequest schema');

  assertHasMethods(serverNotificationMethods, [
    'thread/started',
    'thread/status/changed',
    'thread/settings/updated',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/completed',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/textDelta',
    'item/reasoning/summaryTextDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/patchUpdated',
  ], 'ServerNotification schema');

  assertHasMethods(serverRequestMethods, [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ], 'ServerRequest schema');

  console.log('test-codex-app-server-schema-drift: ok');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
