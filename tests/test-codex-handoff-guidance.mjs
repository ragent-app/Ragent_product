import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

test('account handoff failures provide safe actionable messages', async () => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-handoff-guidance-'));
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_WORK_ROOT_DIR = join(root, 'workspace');
  try {
    const { createProviderPreparationError } = await import(process.env.RAGENT_TEST_RUN_LAUNCHER_ENTRY
      ? pathToFileURL(process.env.RAGENT_TEST_RUN_LAUNCHER_ENTRY).href : '../chat/run-launcher.mjs');
    for (const [code, expected] of [
      ['CODEX_RETIRE_BUSY', /Wait for it to finish/],
      ['CODEX_HANDOFF_UNAVAILABLE', /shared Codex account process is not ready/],
      ['CODEX_RETIRE_PROTOCOL', /restart the Ragent instance/],
      ['CODEX_HANDOFF_CREDENTIALS_DIVERGED', /credentials could not be reconciled safely/],
      ['CODEX_ACCOUNT_UNVERIFIED', /account identity could not be verified/],
    ]) {
      const error = createProviderPreparationError('generic', { app: 'codex', sourceError: Object.assign(new Error('private credential'), { code }) });
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private credential/);
      assert.equal(error.providerPreparation.causeCode, code);
    }
  } finally {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
