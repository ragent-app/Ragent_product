#!/usr/bin/env node
// P0-C foundation: run spool and provider runtime homes are env-configurable
// so they can be relocated out of the control CONFIG_DIR in a migration step.
// Defaults are unchanged (dev / pre-migration production stay under config);
// this test proves the override channels work end to end:
//   1. AGENTOC_PROVIDER_HOMES_DIR relocates CODEX/CLAUDE_MANAGED_HOME_DIR;
//   2. the lifecycle broker passes an env-configured AGENTOC_RUN_SPOOL_DIR to
//      the Run instead of forcing the legacy config/chat-runs path.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFileCallback);

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'agentoc-env-dirs-'));
  try {
    // The harness may retain USER=root while dropping the process to the
    // unprivileged test UID. Resolve the service identity from the OS instead
    // of trusting that inherited environment label; this test does not need
    // to exercise cross-user chown (the provider runtime has separate tests
    // for that path).
    const currentUser = (await execFileAsync('id', ['-un'])).stdout.trim();
    const providerHomes = join(tmp, 'provider-homes');
    const spoolRoot = join(tmp, 'run-results');
    const configDir = join(tmp, 'config');
    const nativeRuntimeDir = join(configDir, 'native-provider-runtime');
    const secretsDir = join(nativeRuntimeDir, 'secrets');
    await mkdir(secretsDir, { recursive: true });
    await writeFile(join(nativeRuntimeDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'provider-luna', agentType: 'codex', protocol: 'openai-responses',
        displayName: 'Provider Luna', baseUrl: 'https://api.example.test/v1',
        authProfileId: 'auth-provider-luna', modelPolicy: { defaultModel: 'gpt-5.6-luna' },
      }],
    }));
    await writeFile(join(nativeRuntimeDir, 'auth-profiles.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'auth-provider-luna', agentType: 'codex', authType: 'api-key',
        displayName: 'Provider Luna', storageType: 'secret-store', storageRef: 'secret-provider-luna',
      }],
    }));
    await writeFile(join(secretsDir, 'secret-provider-luna.json'), JSON.stringify({
      authType: 'api-key', apiKey: 'test-provider-luna',
    }));
    process.env.AGENTOC_PROVIDER_HOMES_DIR = providerHomes;
    process.env.AGENTOC_CONFIG_DIR = configDir;
    delete process.env.AGENTOC_RUN_SPOOL_DIR;

    // 1) provider-homes base override flows into the managed home exports.
    const configUrl = new URL('../lib/config.mjs', import.meta.url);
    configUrl.searchParams.set('p0c-provider-homes', providerHomes);
    const freshConfig = await import(configUrl.href);
    assert.equal(
      freshConfig.CODEX_MANAGED_HOME_DIR,
      join(providerHomes, 'codex'),
      'codex managed home must resolve under the overridden provider-homes base',
    );
    assert.equal(
      freshConfig.CLAUDE_MANAGED_HOME_DIR,
      join(providerHomes, 'claude'),
      'claude managed home must resolve under the overridden base',
    );
    assert.equal(
      freshConfig.CODEX_CONTROL_HOME_DIR,
      join(configDir, 'provider-runtime-homes', 'codex-control'),
      'control-side Codex home must stay under the control config root',
    );
    assert.ok(
      !freshConfig.CODEX_CONTROL_HOME_DIR.startsWith(`${providerHomes}/`),
      'control-side Codex home must not land in the runner-owned provider-homes subtree',
    );
    assert.ok(
      !freshConfig.CODEX_MANAGED_HOME_DIR.includes('provider-runtime-homes'),
      'overridden base must not point at the legacy config subtree',
    );

    // 2) the lifecycle broker respects an env-configured spool root.
    const { launchLifecycleRunner, resolveCodexProviderHomesDir } = await import('../scripts/runner-lifecycle-broker.mjs');
    const captures = [];
    await launchLifecycleRunner('run_abc12345', {
      serviceUser: currentUser,
      serviceGroup: currentUser,
      serviceHome: join(tmp, 'runner-home'),
      resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
      readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
      environment: {
        PATH: '/usr/bin',
        AGENTOC_RUN_SPOOL_DIR: spoolRoot,
        AGENTOC_CONFIG_DIR: configDir,
      },
      execFileImpl: async (bin, args) => {
        if (bin === 'systemctl') return { stdout: '4242\n' };
        captures.push({ bin, args });
        return { stdout: '' };
      },
    });
    assert.equal(captures.length, 1, 'one systemd-run invocation expected');
    const setenv = [];
    for (let index = 0; index < captures[0].args.length - 1; index += 1) {
      if (captures[0].args[index] === '--setenv') setenv.push(captures[0].args[index + 1]);
    }
    assert.ok(
      setenv.includes(`AGENTOC_RUN_SPOOL_DIR=${spoolRoot}`),
      'broker must pass the env-configured spool root, not the legacy config/chat-runs',
    );
    assert.ok(
      setenv.every((value) => !value.startsWith('AGENTOC_CONFIG_DIR=')),
      'AGENTOC_CONFIG_DIR still never reaches a Run',
    );

    // 3) scoped providers receive stable, distinct homes. This prevents two
    // concurrent Runs selecting different providers from overwriting one
    // another's config/auth/marker in a shared Codex home.
    const lunaHomes = resolveCodexProviderHomesDir(providerHomes, 'provider-luna');
    assert.equal(lunaHomes, resolveCodexProviderHomesDir(providerHomes, 'provider-luna'));
    assert.notEqual(lunaHomes, resolveCodexProviderHomesDir(providerHomes, 'provider-deepseek'));
    assert.ok(lunaHomes.startsWith(join(providerHomes, 'by-provider')));

    const scopedCaptures = [];
    await launchLifecycleRunner('run_def67890', {
      serviceUser: currentUser,
      serviceGroup: currentUser,
      serviceHome: join(tmp, 'runner-home'),
      resolveRunnerOwnershipImpl: async () => ({ uid: 1234, gid: 1234 }),
      readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive', pid: null }),
      environment: {
        PATH: '/usr/bin',
        AGENTOC_RUN_SPOOL_DIR: spoolRoot,
        AGENTOC_PROVIDER_HOMES_DIR: providerHomes,
      },
      readManifestImpl: async () => ({
        tool: 'codex',
        options: { model: 'gpt-5.6-luna@provider-luna', runtimeFamily: 'codex-app-server-json' },
      }),
      execFileImpl: async (bin, args) => {
        if (bin === 'systemctl') return { stdout: '4242\n' };
        scopedCaptures.push({ bin, args });
        return { stdout: '' };
      },
    });
    const scopedSetenv = [];
    for (let index = 0; index < scopedCaptures[0].args.length - 1; index += 1) {
      if (scopedCaptures[0].args[index] === '--setenv') scopedSetenv.push(scopedCaptures[0].args[index + 1]);
    }
    const preparedRunHome = scopedSetenv
      .find((value) => value.startsWith('AGENTOC_PROVIDER_HOMES_DIR='))
      ?.slice('AGENTOC_PROVIDER_HOMES_DIR='.length) || '';
    assert.equal(preparedRunHome, lunaHomes);
    assert.equal(
      await readFile(join(preparedRunHome, 'codex', '.agentoc-provider-id'), 'utf8'),
      'provider-luna\n',
      'lifecycle broker must pass the prepared provider-scoped home to the Run',
    );
    assert.equal(
      await readFile(join(providerHomes, 'codex', '.agentoc-provider-id'), 'utf8').catch(() => null),
      null,
      'lifecycle provider preparation must not populate the shared flat Codex home',
    );

    console.log('test-runner-env-driven-dirs: ok');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
