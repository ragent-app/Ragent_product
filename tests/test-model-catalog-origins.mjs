import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'agentoc-catalog-origin-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.HOME = root;
try {
  const { getToolModelCatalogs } = await import('../chat/models.mjs');
  const result = await getToolModelCatalogs('codex', '', { fast:true, getModelsImpl:async () => ({ models:[
    { id:'fallback@offline', label:'Fallback', catalogSource:'builtin' },
    { id:'live@online', label:'Live', catalogSource:'upstream' },
    { id:'configured@custom', label:'Configured', catalogSource:'configured' },
  ] }) });
  const byProvider = new Map(result.map(catalog => [catalog.providerProfileId, catalog]));
  assert.equal(byProvider.get('offline').source, 'static');
  assert.equal(byProvider.get('offline').models[0].source, 'static');
  assert.equal(byProvider.get('online').source, 'discovered');
  assert.equal(byProvider.get('online').models[0].source, 'discovered');
  assert.equal(byProvider.get('custom').source, 'static');
  console.log('test-model-catalog-origins: ok');
} finally {
  const suffix = relative(tmpdir(), root);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw Error('Unsafe fixture root');
  await rm(root, { recursive:true, force:true });
}
