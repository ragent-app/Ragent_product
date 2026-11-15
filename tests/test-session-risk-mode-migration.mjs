#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-risk-mode-migration-'));
const configDir = join(home, '.config', 'ragent');
mkdirSync(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;

const sessionsPath = join(configDir, 'chat-sessions.json');
writeFileSync(sessionsPath, JSON.stringify([
  { id: 'legacy-default', name: 'Legacy default', folder: home, riskMode: 'full-auto' },
  { id: 'explicit-opt-out', name: 'Explicit opt-out', folder: home, riskMode: 'full-auto', riskModeExplicit: true },
  { id: 'already-gated', name: 'Already gated', folder: home, riskMode: 'recommended' },
], null, 2));

const { flushSessionsMetaNow, loadSessionsMeta } = await import('../chat/session-meta-store.mjs');

try {
  const sessions = await loadSessionsMeta();
  const byId = new Map(sessions.map((session) => [session.id, session]));

  assert.equal(byId.get('legacy-default')?.riskMode, 'recommended');
  assert.equal(byId.get('legacy-default')?.riskModeExplicit, undefined);
  assert.equal(byId.get('explicit-opt-out')?.riskMode, 'full-auto');
  assert.equal(byId.get('explicit-opt-out')?.riskModeExplicit, true);
  assert.equal(byId.get('already-gated')?.riskMode, 'recommended');

  await flushSessionsMetaNow();
  const persisted = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  assert.equal(persisted.find((session) => session.id === 'legacy-default')?.riskMode, 'recommended');
  assert.equal(persisted.find((session) => session.id === 'explicit-opt-out')?.riskMode, 'full-auto');
  console.log('test-session-risk-mode-migration: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
