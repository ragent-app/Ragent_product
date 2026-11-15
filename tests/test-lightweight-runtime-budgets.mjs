#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cacheBudget, resolveCacheBudgetBytes } from '../lib/cache-budget.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const source = (path) => readFileSync(resolve(root, path), 'utf8');

const budgetEnv = { RAGENT_CACHE_BUDGET_BYTES: String(128 * 1024 * 1024) };
assert.equal(resolveCacheBudgetBytes(budgetEnv), 128 * 1024 * 1024);
assert.equal(cacheBudget('status', 1, { env: budgetEnv }), 16 * 1024 * 1024);
assert.equal(cacheBudget('status', 2, { env: budgetEnv }), 32 * 1024 * 1024);

const history = source('chat/history.mjs');
const runs = source('chat/runs.mjs');
const router = source('chat/router.mjs');
const server = source('chat-server.mjs');
const triggers = source('chat/triggers.mjs');
const archive = source('chat/run-spool-archive.mjs');

assert.match(history, /cacheBudget\('history\.events'/);
assert.match(history, /cacheBudget\('history\.bodies'/);
assert.match(runs, /cacheBudget\('runs\.artifact'/);
assert.match(router, /cacheBudget\('router\.staticAssets'/);
assert.match(server, /lastMemorySnapshot \|\| buildMemorySnapshot\(\)/);
assert.match(server, /import\('\.\/lib\/embedded-mail-worker\.mjs'\)/);
assert.match(server, /startDeferredBackgroundServices/);
assert.doesNotMatch(triggers, /setInterval\(/);
assert.doesNotMatch(archive, /setInterval\(/);
assert.match(triggers, /MAX_TRIGGER_IDLE_DELAY_MS/);
assert.match(archive, /archiveSchedulerEnabled/);

console.log('test-lightweight-runtime-budgets: cache budget, idle scheduling, deferred loading and health snapshot wiring ok');
