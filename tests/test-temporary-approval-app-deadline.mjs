import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { makeDeadlineTempRoot } from './helpers/deadline-temp-root.mjs';

test('queued createApp refuses an expired temporary approval before catalog replacement', async (t) => {
  const fixture = await makeDeadlineTempRoot('ragent-app-deadline-');
  t.after(() => fixture.cleanup());
  const { root } = fixture;
  const overrides = {
    RAGENT_INSTANCE_ROOT: root,
    RAGENT_CONFIG_DIR: join(root, 'config'),
    RAGENT_RUN_SPOOL_DIR: join(root, 'data', 'chat-runs'),
    RAGENT_PROVIDER_HOMES_DIR: join(root, 'provider-homes'),
    RAGENT_MEMORY_DIR: join(root, 'memory'),
    RAGENT_WORK_ROOT_DIR: join(root, 'workspace'),
    RAGENT_PLATFORM_SKILLS_DIR: join(root, 'platform', 'skills'),
    RAGENT_INSTANCE_KEY_FILE: join(root, 'config', 'instance-identity.json'),
  };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const originalNow = Date.now;
  const start = originalNow();
  let now = start;
  const deadline = start + 1000;
  try {
    Object.assign(process.env, overrides);
    const { createApp } = await import('../chat/apps.mjs');
    const { APPS_FILE } = await import('../lib/config.mjs');
    assert.equal(resolve(APPS_FILE).toLowerCase(), resolve(join(root, 'config', 'apps.json')).toLowerCase());
    const configDir = dirname(APPS_FILE);
    assert.equal((await realpath(configDir)).toLowerCase(), resolve(join(root, 'config')).toLowerCase());
    assert.equal((await lstat(configDir)).isSymbolicLink(), false);
    Date.now = () => now;
    const first = createApp({ name: 'first', tool: 'codex' }, {
      assertAuthorization: () => { now = deadline; },
    });
    const second = createApp({ name: 'expired', tool: 'codex' }, {
      assertAuthorization: () => {
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Temporary control approval expired'),
            { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
        }
      },
    });
    await first;
    await assert.rejects(second, { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    const apps = JSON.parse(await readFile(APPS_FILE, 'utf8'));
    assert.deepEqual(apps.map(app => app.name), ['first']);
  } finally {
    Date.now = originalNow;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
