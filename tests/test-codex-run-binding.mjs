import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexRunBindingPath, createCodexRunBinding, verifyCodexRunBinding } from '../lib/provider-runtime/codex-run-binding.mjs';

test('shared Codex home binds each run to its provider and account', () => {
  const context = { runId: 'run_alpha', providerId: 'profile-a', accountId: 'account-a' };
  const binding = createCodexRunBinding(context);
  assert.equal(verifyCodexRunBinding(binding, context), true);
  assert.equal(verifyCodexRunBinding(binding, { ...context, runId: 'run_beta' }), false);
  assert.equal(verifyCodexRunBinding(binding, { ...context, providerId: 'profile-b' }), false);
  assert.equal(verifyCodexRunBinding(binding, { ...context, accountId: 'account-b' }), false);
  assert.equal(verifyCodexRunBinding(binding, { ...context, accountId: '' }), false);
  assert.doesNotMatch(JSON.stringify(binding), /account-a/);
  assert.notEqual(codexRunBindingPath(join(tmpdir(), 'codex'), 'run_alpha'), codexRunBindingPath(join(tmpdir(), 'codex'), 'run_beta'));
});
