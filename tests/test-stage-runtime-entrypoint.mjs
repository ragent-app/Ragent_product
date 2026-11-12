import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(fileURLToPath(new URL('../scripts/stage-runtime-payload.mjs', import.meta.url)));

test('runtime staging CLI starts through a symlink', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ragent-stage-entry-'));
  try {
    const link = join(directory, 'stage-runtime-payload.mjs');
    try { await symlink(script, link); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Windows account cannot create symbolic links');
        return;
      }
      throw error;
    }
    const result = spawnSync(process.execPath, [link, '--bogus'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing value for --bogus/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
