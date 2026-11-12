import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRunnerSupervisorServer } from '../chat/runner-supervisor-daemon.mjs';
import { buildDetachedRunnerEnvironment, launchDetachedRunnerViaSupervisor } from '../chat/run-launcher.mjs';

test('runner does not inherit untrusted rollout source paths', () => {
  const previous = process.env.AGENTOC_CODEX_ROLLOUT_SOURCES;
  try {
    process.env.AGENTOC_CODEX_ROLLOUT_SOURCES = '["untrusted"]';
    assert.equal(buildDetachedRunnerEnvironment({}).AGENTOC_CODEX_ROLLOUT_SOURCES, '[]');
  } finally {
    if (previous === undefined) delete process.env.AGENTOC_CODEX_ROLLOUT_SOURCES;
    else process.env.AGENTOC_CODEX_ROLLOUT_SOURCES = previous;
  }
});

test('supervisor forwards only scoped legacy Codex homes', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-rollout-supervisor-'));
  const homes = join(root, 'homes');
  const canonical = join(homes, 'by-provider', 'a'.repeat(32));
  const legacy = join(homes, 'by-provider', 'b'.repeat(32), 'by-account', 'c'.repeat(32));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ragent-rollout-${randomBytes(12).toString('hex')}` : join(root, 's.sock');
  let observed;
  const supervisor = await createRunnerSupervisorServer({ socketPath, providerHomesRoot: homes,
    spawnRunner: async (runId, options) => { observed = { runId, options }; return { pid: 12345 }; } });
  t.after(async () => {
    await supervisor.close();
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const prepare = (sources) => async () => ({ manifest: {}, providerId: 'codex', providerHomesDir: canonical, codexRolloutSources: sources });
  await launchDetachedRunnerViaSupervisor('run_sources_12345678', { socketPath, prepareProviderImpl: prepare([legacy]) });
  assert.deepEqual(observed.options.codexRolloutSources, [legacy]);
  await assert.rejects(launchDetachedRunnerViaSupervisor('run_sources_87654321', { socketPath, prepareProviderImpl: prepare([join(root, 'outside')]) }), /Invalid scoped Provider homes directory/);
});
