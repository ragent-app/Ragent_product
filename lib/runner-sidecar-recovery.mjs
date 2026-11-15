// Fixed launcher for a replacement runner sidecar after a stale Codex resume.
// Keep this boundary small so lifecycle tests do not need to initialize the
// full runner/provider module graph.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlatformSpawnSpec } from './executable-resolution.mjs';
import { spawnManagedProviderProcess } from './windows-managed-spawn.mjs';

export const CODEX_FRESH_RECOVERY_ENV = 'RAGENT_CODEX_FORCE_FRESH_RECOVERY';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function spawnFreshCodexRecoverySidecar({
  runId: requestedRunId,
  env = process.env,
  cwd = PROJECT_ROOT,
  runnerScriptPath = join(PROJECT_ROOT, 'chat', 'runner-sidecar.mjs'),
  spawnManagedImpl = spawnManagedProviderProcess,
} = {}) {
  const normalizedRunId = typeof requestedRunId === 'string' ? requestedRunId.trim() : '';
  if (!normalizedRunId) throw new Error('Codex fresh recovery sidecar requires a run id');
  const spawnSpec = buildPlatformSpawnSpec(process.execPath, [runnerScriptPath, normalizedRunId], {
    cwd,
    env: { ...env, [CODEX_FRESH_RECOVERY_ENV]: '1' },
  });
  const replacement = await spawnManagedImpl(spawnSpec, {
    stdio: 'ignore',
    detached: true,
    preserveOnControllerExit: true,
  });
  replacement.unref?.();
  return replacement;
}
