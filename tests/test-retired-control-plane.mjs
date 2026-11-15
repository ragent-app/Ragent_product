#!/usr/bin/env node
// Release guard for the retired developer maintenance control plane.
//
// This is deliberately a source-tree test rather than an HTTP smoke test:
// the required property is that the old route, modules, units, helpers, and
// environment names cannot be reintroduced accidentally. The package tests
// cover the one-time upgrade migration separately.

import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE_DIRS = ['chat', 'lib', 'scripts', 'packaging/deb', 'native', 'static', 'templates', 'android/feature/workbench/src/main'];
const SOURCE_FILES = ['chat-server.mjs', 'cli.js'];
const TEXT_EXTENSIONS = new Set(['.c', '.css', '.env', '.html', '.js', '.json', '.kt', '.mjs', '.service', '.sh', '.xml']);

const RETIRED_PATHS = [
  'chat/maintenance-audit-projection.mjs',
  'chat/maintenance-session-channel.mjs',
  'chat/maintenance.mjs',
  'lib/maintenance-audit-projection-store.mjs',
  'lib/maintenance-command.mjs',
  'lib/maintenance-control-client.mjs',
  'lib/maintenance-control-service.mjs',
  'lib/maintenance-lifecycle.mjs',
  'lib/maintenance-protocol.mjs',
  'lib/maintenance-request-protocol.mjs',
  'lib/maintenance-status.mjs',
  'scripts/maintenance-broker.mjs',
  'scripts/maintenance-control-service.mjs',
  'scripts/rebuild-maintenance-audit-projection.mjs',
  'docs/maintenance-sessions.md',
  'packaging/deb/ragent-maintenance-admin',
  'packaging/deb/ragent-maintenance-broker.service',
  'packaging/deb/ragent-maintenance-control.service',
  'packaging/deb/deferred-maintenance-restart',
  'native/maintenance-peercred.c',
];

const FORBIDDEN_MARKERS = [
  /\bmaintenanceMode\b/i,
  /\/api\/maintenance\b/i,
  /ragent-maintenance(?:[-/.]|$)/i,
  /maintenance-(?:audit|broker|command|control|lifecycle|peercred|protocol|request|session|status)/i,
  /deferred-maintenance/i,
  /manageMaintenance/i,
  /OWNER_WEBAUTHN_MAINTENANCE/i,
  /RAGENT_[A-Z0-9_]*MAINTENANCE[A-Z0-9_]*/i,
  /\b(?:WebParityPage|SettingsPage)\.Maintenance\b/,
  /settings_maintenance_audit/i,
];

const LEGACY_SESSION_COMPAT_FILES = new Set([
  'chat/collaboration-leader-ingress.mjs',
  'chat/projects.mjs',
  'chat/session-migration.mjs',
]);
const LEGACY_MIGRATION_FILES = new Set(['packaging/deb/postinst', 'packaging/deb/postrm']);

async function pathExists(relativePath) {
  try {
    await access(join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(relativeDir) {
  const absoluteDir = join(ROOT, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

for (const retiredPath of RETIRED_PATHS) {
  assert.equal(await pathExists(retiredPath), false, `${retiredPath} must stay retired`);
}

const files = [...SOURCE_FILES];
for (const sourceDir of SOURCE_DIRS) files.push(...await collectFiles(sourceDir));

const violations = [];
for (const relativePath of files) {
  if (LEGACY_MIGRATION_FILES.has(relativePath)) continue;
  const source = await readFile(join(ROOT, relativePath), 'utf8');
  if (LEGACY_SESSION_COMPAT_FILES.has(relativePath)) {
    assert.ok(
      /sourceId\s*!==\s*'maintenance'|sourceId\s*===\s*'maintenance'/.test(source),
      `${relativePath} must keep only the explicit legacy sourceId filter for old stored sessions`,
    );
  }
  for (const marker of FORBIDDEN_MARKERS) {
    if (marker.test(source)) violations.push(`${relativePath}: ${marker}`);
  }
}

assert.deepEqual(violations, [], `retired developer control-plane markers remain:\n${violations.join('\n')}`);

const postinst = await readFile(join(ROOT, 'packaging/deb/postinst'), 'utf8');
assert.match(postinst, /retire_legacy_maintenance_runtime\(\)/);
assert.match(postinst, /retire_legacy_maintenance_data\(\)/);

console.log(`test-retired-control-plane: ok (${files.length} source files scanned)`);
