import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPersistentCodexCatalog, writePersistentCodexCatalog } from '../chat/codex-model-persistent-cache.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-catalog-cache-'));
const key = 'a'.repeat(64), otherKey = 'b'.repeat(64), now = Date.now();
try {
  const entry = { at: now, models: [{ id: 'discovered-model', label: 'Discovered',
    effortLevels: ['medium', 'high'], defaultEffort: 'high', inputModalities: ['text'],
    authBearerToken: 'must-not-be-persisted' }] };
  assert.equal(await writePersistentCodexCatalog(root, key, entry), true);
  const stored = await readFile(join(root, 'model-catalog-cache', `${key}.json`), 'utf8');
  assert.equal(stored.includes('must-not-be-persisted'), false);
  const recovered = await readPersistentCodexCatalog(root, key, now);
  assert.equal(recovered.models[0].id, 'discovered-model');
  assert.deepEqual(recovered.models[0].effortLevels, ['medium', 'high']);
  assert.equal(await readPersistentCodexCatalog(root, otherKey, now), null);
  assert.equal(await readPersistentCodexCatalog(root, key, now + 8 * 86400_000), null);
  assert.equal(await readPersistentCodexCatalog(root, key, now - 1), null);
  assert.equal(await writePersistentCodexCatalog(root, '../bad', entry), false);
  assert.equal(await writePersistentCodexCatalog(root, key, { at: now, models: [entry.models[0], entry.models[0]] }), false);
  assert.equal((await readPersistentCodexCatalog(root, key, now)).models[0].id, 'discovered-model');
  await writeFile(join(root, 'model-catalog-cache', `${key}.json`), '{broken');
  assert.equal(await readPersistentCodexCatalog(root, key, now), null);
  console.log('test-codex-model-persistent-cache: account binding, expiry and metadata-only persistence passed');
} finally { await rm(root, { recursive: true, force: true }); }
