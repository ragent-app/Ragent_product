import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  AGY_APP_DATA_DIR_ENV,
  AGY_GEMINI_DIR_ENV,
  AGY_RUNTIME_HOME_ENV,
  AGY_RUNTIME_LAUNCHER_PATH,
  AGY_SESSION_STATE_FILES,
  AGY_SESSION_STATE_SUBDIRS,
  DEFAULT_AGY_APP_DATA_REL_DIR,
  buildAgyRuntimeEnv,
  ensureAgySessionStorage,
  isAgyRuntime,
  normalizeAgyAppDataRelDir,
  normalizeAgySessionKey,
  resolveAgyGeminiDir,
  resolveAgySessionStorage,
} from '../lib/agy-runtime.mjs';

const execFileAsync = promisify(execFile);

assert.equal(isAgyRuntime({ toolId: 'agy' }), true);
assert.equal(isAgyRuntime({ toolId: 'antigravity' }), true);
assert.equal(isAgyRuntime({ runtimeFamily: 'agy-acp' }), true);
assert.equal(isAgyRuntime({ runtimeFamily: 'agy-stream-json' }), true);
assert.equal(isAgyRuntime({ runtimeFamily: 'agy-stream-json-bidi' }), true);
assert.equal(isAgyRuntime({ runtimeFamily: 'agy-json' }), true);
assert.equal(isAgyRuntime({ toolId: 'codex', runtimeFamily: 'codex-app-server-json' }), false);

assert.equal(normalizeAgySessionKey(''), '');
assert.equal(normalizeAgySessionKey('ses_abc-123.v2'), 'ses_abc-123.v2');
assert.throws(() => normalizeAgySessionKey('../escape'), /Invalid AgY session identifier/);
assert.throws(() => normalizeAgySessionKey('a/b'), /Invalid AgY session identifier/);

assert.equal(AGY_SESSION_STATE_SUBDIRS.includes('conversations'), true);
assert.equal(AGY_SESSION_STATE_SUBDIRS.includes('brain'), true);
assert.equal(AGY_SESSION_STATE_FILES.includes('conversation_summaries.db'), true);

const tempRoot = await mkdtemp(join(tmpdir(), 'ragent-agy-storage-test-'));

try {
  const homeDir = join(tempRoot, 'home-a');
  const explicitGemini = resolveAgyGeminiDir({
    homeDir,
    environment: { [AGY_GEMINI_DIR_ENV]: join(tempRoot, 'custom-gemini') },
  });
  assert.equal(explicitGemini, resolve(tempRoot, 'custom-gemini'));
  assert.equal(resolveAgyGeminiDir({ homeDir, environment: {} }), join(homeDir, '.gemini'));

  assert.equal(normalizeAgyAppDataRelDir('', { sessionId: 'ses-42' }), 'sessions/ses-42');
  assert.equal(normalizeAgyAppDataRelDir('', {}), DEFAULT_AGY_APP_DATA_REL_DIR);
  assert.equal(normalizeAgyAppDataRelDir('sessions\\ses-win'), 'sessions/ses-win');

  const geminiDir = join(homeDir, '.gemini');
  assert.equal(
    normalizeAgyAppDataRelDir(join(geminiDir, 'sessions', 'ses-inside'), { geminiDir }),
    'sessions/ses-inside',
  );

  assert.throws(
    () => normalizeAgyAppDataRelDir(join(tempRoot, 'outside-app-data'), {}),
    /relative path under --gemini-dir/,
  );
  assert.throws(
    () => normalizeAgyAppDataRelDir(join(tempRoot, 'outside-app-data'), { geminiDir }),
    /must stay inside --gemini-dir/,
  );
  assert.throws(
    () => normalizeAgyAppDataRelDir('sessions/../escape', { geminiDir }),
    /path traversal/,
  );
  assert.throws(
    () => normalizeAgyAppDataRelDir('sessions\0bad', { geminiDir }),
    /null byte/,
  );

  const storageSpec = resolveAgySessionStorage({
    homeDir,
    sessionId: 'ses-storage-1',
    environment: {},
  });
  assert.equal(storageSpec.homeDir, homeDir);
  assert.equal(storageSpec.geminiDir, geminiDir);
  assert.equal(storageSpec.appDataRelDir, 'sessions/ses-storage-1');
  assert.equal(storageSpec.appDataDir, resolve(geminiDir, 'sessions', 'ses-storage-1'));

  const ensured = await ensureAgySessionStorage({
    homeDir,
    sessionId: 'ses-storage-1',
    environment: {},
  });
  assert.equal((await stat(join(ensured.appDataDir, 'conversations'))).isDirectory(), true);
  assert.equal((await stat(join(ensured.appDataDir, 'brain'))).isDirectory(), true);

  const envHome = join(tempRoot, 'home-env');
  const runtimeEnv = await buildAgyRuntimeEnv(
    { PATH: process.env.PATH || '', AGY_HOME: join(tempRoot, 'stale-external-home') },
    { homeDir: envHome, sessionId: 'ses-env-9', platform: 'win32' },
  );
  assert.equal(runtimeEnv.HOME, envHome);
  assert.equal(runtimeEnv.USERPROFILE, envHome);
  assert.equal(runtimeEnv.AGY_HOME, undefined);
  assert.equal(runtimeEnv[AGY_GEMINI_DIR_ENV], join(envHome, '.gemini'));
  assert.equal(runtimeEnv[AGY_APP_DATA_DIR_ENV], 'sessions/ses-env-9');
  assert.equal((await stat(join(envHome, '.gemini', 'sessions', 'ses-env-9', 'brain'))).isDirectory(), true);

  const launcherHome = join(tempRoot, 'launcher-home');
  const launcherGemini = join(tempRoot, 'launcher-gemini');
  await mkdir(launcherHome, { recursive: true });
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      AGY_RUNTIME_LAUNCHER_PATH,
      '--',
      process.execPath,
      '-e',
      'console.log(JSON.stringify({ home: process.env.HOME, gemini: process.env.RAGENT_AGY_GEMINI_DIR, appData: process.env.RAGENT_AGY_APP_DATA_DIR, argv: process.argv.slice(1) }))',
      '--',
      '--gemini-dir',
      launcherGemini,
      '--app-data-dir',
      'sessions/launcher-ses-1',
    ],
    {
      env: {
        ...process.env,
        [AGY_RUNTIME_HOME_ENV]: launcherHome,
        [AGY_GEMINI_DIR_ENV]: '',
        [AGY_APP_DATA_DIR_ENV]: '',
      },
    },
  );
  const launched = JSON.parse(stdout.trim());
  assert.equal(launched.home, launcherHome);
  assert.equal(launched.gemini, launcherGemini);
  assert.equal(launched.appData, 'sessions/launcher-ses-1');
  assert.deepEqual(launched.argv, [
    '--gemini-dir',
    launcherGemini,
    '--app-data-dir',
    'sessions/launcher-ses-1',
  ]);
  assert.equal(
    (await stat(join(launcherGemini, 'sessions', 'launcher-ses-1', 'conversations'))).isDirectory(),
    true,
  );
  assert.equal(
    (await stat(join(launcherGemini, 'sessions', 'launcher-ses-1', 'brain'))).isDirectory(),
    true,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('agy session storage tests passed');
