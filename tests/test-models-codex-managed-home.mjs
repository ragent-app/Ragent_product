#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-models-codex-'));
const configDir = join(tempHome, 'config');
const managedCodexHome = join(configDir, 'provider-runtime-homes', 'codex');

mkdirSync(managedCodexHome, { recursive: true });
writeFileSync(join(managedCodexHome, 'config.toml'), 'model = "gpt-managed"\n', 'utf8');

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;

const { getModelsForTool, readPreferredCodexModelFromConfig } = await import(pathToFileURL(join(repoRoot, 'chat', 'models.mjs')).href);

try {
  const personalCodexHome = join(tempHome, '.codex');
  mkdirSync(personalCodexHome, { recursive: true });
  writeFileSync(join(personalCodexHome, 'config.toml'), 'model = "gpt-personal"\n', 'utf8');
  assert.equal(
    await readPreferredCodexModelFromConfig({ homeDir: managedCodexHome }),
    'gpt-managed',
    'explicit runner home lookup must not fall back to the owner home',
  );

  const result = await getModelsForTool('codex');
  assert.deepEqual(result.models, [], 'Native model catalog must not resurrect a stale managed-home cache');
  assert.equal(result.defaultModel, null);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-models-codex-managed-home: ok');
