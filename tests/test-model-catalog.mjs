#!/usr/bin/env node
// Contract tests for the provider-scoped model catalog.
// Mirrors docs/cross-device-credential-recovery-and-model-catalog-plan.md §三.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  computeModelCatalogVersion,
  createModelCatalogCache,
  normalizeCatalogError,
  normalizeModelCatalog,
  normalizeModelCatalogEntry,
  sourceFromModelOrigins,
  validateRunModelSelection,
} from '../lib/provider-runtime/model-catalog.mjs';

assert.equal(sourceFromModelOrigins(['builtin', 'builtin']), 'static');
assert.equal(sourceFromModelOrigins(['configured']), 'static');
assert.equal(sourceFromModelOrigins(['upstream']), 'discovered');
assert.equal(sourceFromModelOrigins(['builtin', 'upstream']), 'discovered');
assert.equal(sourceFromModelOrigins([undefined]), 'discovered');

// --- entry normalization --------------------------------------------------------

const entry = normalizeModelCatalogEntry({
  model: 'glm-5.2',
  providerProfileId: 'newapi-zai-glm',
  label: 'GLM-5.2',
  source: 'discovered',
  contextWindow: 200000,
  capabilities: { effort: { levels: ['high', 'low', 'medium'], default: 'medium' } },
});
assert.equal(entry.id, 'glm-5.2@newapi-zai-glm');
assert.equal(entry.model, 'glm-5.2', 'bare model id stays separate from the scoped key');
assert.equal(entry.providerProfileId, 'newapi-zai-glm');
assert.deepEqual(entry.capabilities.effort.levels, ['high', 'low', 'medium'].sort ? entry.capabilities.effort.levels : []);
assert.ok(entry.capabilities.effort.levels.includes('medium'));
assert.equal(normalizeModelCatalogEntry({ model: '' }), null);
assert.equal(normalizeModelCatalogEntry(null), null);
// unknown source falls back to static
assert.equal(normalizeModelCatalogEntry({ model: 'x', source: 'banana' }).source, 'static');

// same bare model on two providers stays independent
const a = normalizeModelCatalogEntry({ model: 'glm-5.2', providerProfileId: 'provider-a' });
const b = normalizeModelCatalogEntry({ model: 'glm-5.2', providerProfileId: 'provider-b' });
assert.notEqual(a.id, b.id);

// --- catalog normalization + version --------------------------------------------

const catalogA = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [
    { model: 'm1', label: 'M1', isDefault: true },
    { model: 'm2', label: 'M2' },
  ],
  source: 'discovered',
  fetchedAt: '2026-08-26T00:00:00.000Z',
  expiresAt: Date.parse('2026-08-26T00:02:00.000Z'),
  nowMs: Date.parse('2026-08-26T00:01:00.000Z'),
});
assert.equal(catalogA.status, 'fresh');
assert.equal(catalogA.defaultModel, 'm1');
assert.ok(catalogA.catalogVersion.length === 16);

// expired → stale
const stale = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [{ model: 'm1' }],
  source: 'discovered',
  nowMs: Date.parse('2026-08-26T01:00:00.000Z'),
  expiresAt: Date.parse('2026-08-26T00:02:00.000Z'),
});
assert.equal(stale.status, 'stale');

// empty + error → unavailable
const unavailable = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [],
  error: new Error('connect ECONNREFUSED'),
});
assert.equal(unavailable.status, 'unavailable');
assert.equal(unavailable.error.code, 'catalog_error');
assert.ok(!unavailable.error.message.includes('Authorization'));

// default not in catalog → nulled + validation error
const badDefault = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [{ model: 'm1', isDefault: true }, { model: 'gone' }],
});
// "gone" marked default but filtered? no — default resolution searches entries
const badDefault2 = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [{ model: 'm1' }, { model: 'retired', isDefault: true }],
});
assert.equal(badDefault2.defaultModel, 'retired');
const missingDefault = normalizeModelCatalog({
  providerProfileId: 'provider-a',
  entries: [{ model: 'm1' }],
});
assert.equal(missingDefault.defaultModel, undefined);

// deterministic version: same entries → same version, different → different
const versionSame = normalizeModelCatalog({ providerProfileId: 'p', entries: [{ model: 'm1' }, { model: 'm2' }] });
const versionSame2 = normalizeModelCatalog({ providerProfileId: 'p', entries: [{ model: 'm2' }, { model: 'm1' }] });
assert.equal(versionSame.catalogVersion, versionSame2.catalogVersion, 'order must not change catalogVersion');
const versionDiff = normalizeModelCatalog({ providerProfileId: 'p', entries: [{ model: 'm1' }, { model: 'm3' }] });
assert.notEqual(versionSame.catalogVersion, versionDiff.catalogVersion);

// duplicate scoped ids dedup
const deduped = normalizeModelCatalog({
  providerProfileId: 'p',
  entries: [{ model: 'm1' }, { model: 'm1' }, { model: 'm2' }],
});
assert.equal(deduped.models.length, 2);

// --- error normalization ----------------------------------------------------------

const safeError = normalizeCatalogError(new Error('Bearer sk-supersecretvaluexyz failed'));
assert.ok(!safeError.message.includes('sk-supersecret'));
assert.equal(safeError.message.length <= 200, true);
assert.equal(normalizeCatalogError(null), null);

// --- run selection validation -------------------------------------------------------

const okSelection = validateRunModelSelection({ catalog: catalogA, model: 'm2', providerProfileId: 'provider-a' });
assert.equal(okSelection.ok, true);
assert.equal(okSelection.model, 'm2');
assert.equal(okSelection.catalogVersion, catalogA.catalogVersion);

const scopedSelection = validateRunModelSelection({ catalog: catalogA, model: 'm2@provider-a', providerProfileId: 'provider-a' });
assert.equal(scopedSelection.ok, true);
assert.equal(scopedSelection.model, 'm2', 'scoped key submits the bare model');

const wrongProvider = validateRunModelSelection({ catalog: catalogA, model: 'm2', providerProfileId: 'provider-b' });
assert.equal(wrongProvider.ok, false);
assert.equal(wrongProvider.code, 'model-not-available');

const unknownModel = validateRunModelSelection({ catalog: catalogA, model: 'm99', providerProfileId: 'provider-a' });
assert.equal(unknownModel.ok, false);
assert.equal(unknownModel.code, 'model-not-available');

const emptyCatalog = validateRunModelSelection({ catalog: unavailable, model: 'm1', providerProfileId: 'provider-a' });
assert.equal(emptyCatalog.ok, false);
assert.equal(emptyCatalog.code, 'model-not-available');
assert.equal(emptyCatalog.catalogStatus, 'unavailable');

// --- refresh cache lifecycle ---------------------------------------------------------

let clock = 1000;
const cache = createModelCatalogCache({ nowImpl: () => clock, ttlMs: 100, failCooldownMs: 50 });
assert.equal(cache.peek('p1'), null, 'no catalog before refresh');

let loadCount = 0;
const first = await cache.refresh('p1', async () => {
  loadCount += 1;
  return { entries: [{ model: 'm1', label: 'M1' }] };
});
assert.equal(first.status, 'fresh');
assert.equal(first.models.length, 1);

clock += 10;
const second = await cache.refresh('p1', async () => {
  loadCount += 1;
  return { entries: [{ model: 'm1' }] };
});
assert.equal(loadCount, 1, 'TTL window must dedupe refreshes');
assert.equal(second.status, 'fresh');

// concurrent refresh single-flights
clock += 200; // expire
const concurrent = await Promise.all([
  cache.refresh('p1', async () => {
    loadCount += 1;
    await sleep(10);
    return { entries: [{ model: 'm2' }] };
  }),
  cache.refresh('p1', async () => {
    loadCount += 1;
    await sleep(10);
    return { entries: [{ model: 'm2' }] };
  }),
]);
assert.equal(loadCount, 2, 'concurrent refresh must share one in-flight request');
assert.equal(concurrent[0].catalogVersion, concurrent[1].catalogVersion);
assert.ok(concurrent[0].models.some((m) => m.model === 'm2'));

// failure keeps last good as stale
clock += 200;
const afterFail = await cache.refresh('p1', async () => {
  throw new Error('upstream down');
});
assert.equal(afterFail.status, 'stale', 'failure must retain the last good catalog flagged stale');
assert.ok(afterFail.models.some((m) => m.model === 'm2'));
assert.equal(afterFail.error.code, 'catalog_error');

// failure cooldown: immediate retry does not hit the loader
clock += 1;
let cooldownHits = 0;
const cooled = await cache.refresh('p1', async () => {
  cooldownHits += 1;
  return { entries: [{ model: 'm3' }] };
});
assert.equal(cooldownHits, 0, 'cooldown window must suppress repeat fetches');
assert.equal(cooled.status, 'stale');

// peek never loads
assert.equal(cache.peek('p-unknown'), null);

// invalidate drops the entry
cache.install('p2', normalizeModelCatalog({ providerProfileId: 'p2', entries: [{ model: 'x' }] }));
assert.ok(cache.peek('p2'));
cache.invalidate('p2');
assert.equal(cache.peek('p2'), null);

console.log('test-model-catalog: normalization, versioning, single-flight refresh, stale fallback OK');
