import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCodexAccountHomeHandoff } from '../lib/provider-runtime/codex-account-handoff.mjs';

test('legacy ownership remains fenced through reconciliation and canonical startup', async () => {
  const events = [];
  const legacy = join(tmpdir(), 'legacy');
  const canonical = join(tmpdir(), 'canonical');
  const result = await withCodexAccountHomeHandoff({ accountId: 'account', legacyHomeRoot: legacy, canonicalHomeRoot: canonical,
    acquireCreationLock: async () => { events.push('creation-acquired'); return { release: async () => events.push('creation-released') }; },
    retireAndAcquireHome: async () => { events.push('legacy-fenced'); return { release: async () => events.push('legacy-released') }; },
    reconcileCredentials: async () => { events.push('reconciled'); },
    startCanonical: async () => { events.push('canonical-started'); return 'ready'; },
  });
  assert.equal(result, 'ready');
  assert.deepEqual(events, ['creation-acquired', 'legacy-fenced', 'reconciled', 'canonical-started', 'legacy-released', 'creation-released']);
});

test('failed reconciliation releases both locks and never starts canonical', async () => {
  const events = [];
  await assert.rejects(withCodexAccountHomeHandoff({ accountId: 'account', legacyHomeRoot: join(tmpdir(), 'legacy'), canonicalHomeRoot: join(tmpdir(), 'canonical'),
    acquireCreationLock: async () => ({ release: async () => events.push('creation-released') }),
    retireAndAcquireHome: async () => ({ release: async () => events.push('legacy-released') }),
    reconcileCredentials: async () => { throw new Error('ambiguous credentials'); },
    startCanonical: async () => events.push('unsafe-start'),
  }), /ambiguous credentials/);
  assert.deepEqual(events, ['legacy-released', 'creation-released']);
});
