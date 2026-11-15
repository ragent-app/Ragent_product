#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-session-folder-'));
const configDir = join(tempHome, '.config', 'ragent');
const sessionsPath = join(configDir, 'chat-sessions.json');
const managedWorkRoot = join(tempHome, '.ragent', 'workspace');
const missingLegacyProjectPath = join(tempHome, 'missing-legacy-project');
const missingLegacyUserPath = join(tempHome, 'missing-legacy-user');
const inaccessibleLegacyPath = join(tempHome, 'inaccessible-legacy-project');

mkdirSync(configDir, { recursive: true });
mkdirSync(inaccessibleLegacyPath, { recursive: true });
chmodSync(inaccessibleLegacyPath, 0o000);

writeFileSync(
  sessionsPath,
  JSON.stringify([
    {
      id: 'legacy_session',
      folder: missingLegacyProjectPath,
      tool: 'codex',
      name: 'Legacy migrated session',
      created: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
    },
  ], null, 2),
  'utf8',
);

const previousHome = process.env.HOME;
const previousConfigDir = process.env.RAGENT_CONFIG_DIR;
const previousWorkRootDir = process.env.RAGENT_WORK_ROOT_DIR;

try {
  process.env.HOME = tempHome;
  process.env.RAGENT_CONFIG_DIR = configDir;
  process.env.RAGENT_WORK_ROOT_DIR = managedWorkRoot;

  const cacheBust = `?t=${Date.now()}`;
  const folderModule = await import(pathToFileURL(join(repoRoot, 'chat', 'session-folder.mjs')).href + cacheBust);
  const metaStoreModule = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href + cacheBust);

  const repaired = folderModule.resolveRunnableSessionFolder(missingLegacyProjectPath);
  assert.equal(repaired.repaired, true, 'missing session folder should be repaired');
  assert.equal(repaired.cwd, managedWorkRoot, 'missing folders should fall back to the managed work root');
  assert.equal(repaired.reason, 'missing-session-folder-fallback-managed-work-root');

  const inaccessibleRepaired = folderModule.resolveRunnableSessionFolder(inaccessibleLegacyPath);
  assert.equal(inaccessibleRepaired.repaired, true, 'inaccessible session folder should be repaired');
  assert.equal(inaccessibleRepaired.cwd, managedWorkRoot, 'inaccessible folders should fall back to the managed work root');
  assert.equal(inaccessibleRepaired.reason, 'inaccessible-session-folder-fallback-managed-work-root');

  const fallback = folderModule.normalizeStoredSessionFolder(missingLegacyUserPath);
  assert.equal(fallback.changed, false, 'missing stored folder should not be rewritten to the managed work root');
  assert.equal(fallback.folder, missingLegacyUserPath, 'missing stored folder should preserve its original ownership path');

  const loaded = await metaStoreModule.loadSessionsMeta();
  assert.equal(loaded[0]?.folder, missingLegacyProjectPath, 'stored session metadata should preserve missing legacy paths on load');

  const persisted = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert.equal(persisted[0]?.folder, missingLegacyProjectPath, 'missing stored folder should not be persisted as the managed work root');
} finally {
  try { chmodSync(inaccessibleLegacyPath, 0o700); } catch {}
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousConfigDir === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousConfigDir;

  if (previousWorkRootDir === undefined) delete process.env.RAGENT_WORK_ROOT_DIR;
  else process.env.RAGENT_WORK_ROOT_DIR = previousWorkRootDir;

  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-folder-repair: ok');
