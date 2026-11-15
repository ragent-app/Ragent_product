#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-session-account-policy-'));
const configDir = join(root, 'config');
await mkdir(configDir, { recursive: true });
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_PERF_WRITE_DEBOUNCE = 'off';

const { createSession } = await import('../chat/session-manager.mjs');
const { loadAccountPolicy, saveAccountPolicy } = await import('../lib/account-policy.mjs');
const { resolveSessionRiskModeForRun } = await import('../chat/session-manager.mjs');

// Without an account policy the built-in autonomous default applies to new sessions.
const plain = await createSession(root, 'codex', 'No policy', {});
assert.equal(plain.riskMode, 'full-auto');
assert.equal(plain.riskModeExplicit, true);
assert.equal(resolveSessionRiskModeForRun(plain), 'full-auto');

// Account policy 'approval' maps to the same built-in recommended posture.
await saveAccountPolicy({ permissionPolicy: 'approval' });
assert.equal((await loadAccountPolicy()).permissionPolicy, 'approval');
const approval = await createSession(root, 'codex', 'Approval policy', {});
assert.equal(approval.riskMode, 'recommended');
assert.equal(resolveSessionRiskModeForRun(approval), 'recommended');

// Account policy 'full-auto' is the owner's standing opt-in for sessions
// created without an explicit riskMode.
await saveAccountPolicy({ permissionPolicy: 'full-auto' });
const fullAuto = await createSession(root, 'codex', 'Full-auto policy', {});
assert.equal(fullAuto.riskMode, 'full-auto');
assert.equal(fullAuto.riskModeExplicit, true);
assert.equal(resolveSessionRiskModeForRun(fullAuto), 'full-auto');

await saveAccountPolicy({ permissionPolicy: 'conservative-auto' });
const conservative = await createSession(root, 'codex', 'Conservative auto policy', {});
assert.equal(conservative.riskMode, 'conservative-auto');
assert.equal(resolveSessionRiskModeForRun(conservative), 'conservative-auto');

// An explicit per-session riskMode always wins over the account policy.
const explicitSafe = await createSession(root, 'codex', 'Explicit safe', { riskMode: 'safe' });
assert.equal(explicitSafe.riskMode, 'safe');
assert.equal(resolveSessionRiskModeForRun(explicitSafe), 'safe');
const explicitRecommended = await createSession(root, 'codex', 'Explicit recommended', { riskMode: 'recommended' });
assert.equal(explicitRecommended.riskMode, 'recommended');
assert.equal(resolveSessionRiskModeForRun(explicitRecommended), 'recommended');

console.log('test-session-account-policy-default: ok');
