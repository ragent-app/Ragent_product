import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'agentoc-codex-projection-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
try {
  const { getToolModelCatalogs } = await import('../chat/models.mjs');
  let live = false;
  let calls = 0;
  const getModelsImpl = async () => {
    calls++;
    return { models: live
      ? [{ id: 'actual@official', label: 'Actual', catalogSource: 'upstream' }]
      : [{ id: 'fallback@official', label: 'Fallback', catalogSource: 'builtin' }] };
  };
  const first = await getToolModelCatalogs('codex', 'official', { getModelsImpl });
  assert.equal(first[0].source, 'static');
  live = true;
  const recovered = await getToolModelCatalogs('codex', 'official', { fast: true, getModelsImpl });
  assert.equal(recovered[0].source, 'discovered');
  assert.equal(recovered[0].models[0].model, 'actual');
  assert.equal(calls, 2);

  let revision = 'old';
  const staleThenFresh = async () => ({ models: [{
    id: `${revision}@other`, label: revision, catalogSource: 'upstream',
  }] });
  const stale = await getToolModelCatalogs('codex-cli', 'other', { getModelsImpl: staleThenFresh });
  assert.equal(stale[0].models[0].model, 'old');
  revision = 'new';
  const fresh = await getToolModelCatalogs('codex-cli', 'other', { fast: true, getModelsImpl: staleThenFresh });
  assert.equal(fresh[0].models[0].model, 'new');

  let claudeCalls = 0;
  const claude = async () => {
    claudeCalls++;
    return { models: [{ id: 'claude-fixture', label: 'Claude', catalogSource: 'configured' }] };
  };
  await getToolModelCatalogs('claude', '', { getModelsImpl: claude });
  await getToolModelCatalogs('claude', '', { fast: true, getModelsImpl: claude });
  assert.equal(claudeCalls, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}
