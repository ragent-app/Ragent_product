#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cacheBudget, resolveCacheBudgetBytes } from '../lib/cache-budget.mjs';

const env = { RAGENT_CACHE_BUDGET_BYTES: String(16 * 1024 * 1024) };
assert.equal(resolveCacheBudgetBytes(env), 16 * 1024 * 1024);
assert.equal(cacheBudget('small', 1, { env }), 2 * 1024 * 1024);
assert.equal(cacheBudget('large', 2, { env }), 4 * 1024 * 1024);
assert.equal(resolveCacheBudgetBytes({}), 128 * 1024 * 1024);
console.log('test-cache-budget: ok');
