import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMessageAttachmentSizes } from '../chat/message-attachment-account-policy.mjs';
import { parseMessagePreparation, messagePreparationFingerprint, messagePreparations } from '../chat/message-preparation-contract.mjs';

const base = { version: 1, requestId: 'large-message', text: 'hello', runOptions: {},
  expiresAt: '2030-01-01T00:00:00.000Z', attachments: [{ assetId: 'fasset_' + 'a'.repeat(24),
    sha256: 'b'.repeat(64), sizeBytes: 2 * 1024 * 1024 * 1024 }] };
const owner = { role: 'owner', accountId: 'account-a' };
const unlimited = async () => Number.MAX_SAFE_INTEGER;
const limited = async () => 1024 * 1024 * 1024;

test('large prepared messages require the live unlimited account policy', async () => {
  assert.throws(() => parseMessagePreparation(base), /Invalid prepared attachment/);
  assert.deepEqual(await authorizeMessageAttachmentSizes(base, owner, unlimited), base);
  await assert.rejects(authorizeMessageAttachmentSizes(base, owner, limited), /Invalid prepared attachment/);
  await assert.rejects(authorizeMessageAttachmentSizes(base, null, unlimited), /Invalid prepared attachment/);
  const batch = { ...base, attachments: [0, 1].map(i => ({ assetId: 'fasset_' + String(i).repeat(24),
    sha256: 'b'.repeat(64), sizeBytes: 60 * 1024 * 1024 })) };
  await assert.rejects(authorizeMessageAttachmentSizes(batch, owner, limited), /total is too large/);
  assert.deepEqual(await authorizeMessageAttachmentSizes(batch, owner, unlimited), batch);
  const overflow = { ...base, attachments: [0, 1].map(i => ({ assetId: 'fasset_' + String(i).repeat(24),
    sha256: 'b'.repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER })) };
  await assert.rejects(authorizeMessageAttachmentSizes(overflow, owner, unlimited), /total is too large/);
});

test('large durable preparation can be read and fingerprinted after policy changes', () => {
  const scope = { version: 1, sessionId: 'session-a', expectedProjectId: null,
    expectedScopeRevision: '01234567-0123-0123-0123-0123456789ab' };
  const row = { version: 1, preparationId: 'mprep_01234567-0123-0123-0123-0123456789ab',
    sessionId: scope.sessionId, requestId: base.requestId, scope, request: base,
    fingerprint: messagePreparationFingerprint(scope.sessionId, scope, base), createdAt: '2029-01-01T00:00:00.000Z' };
  assert.deepEqual(messagePreparations({ id: scope.sessionId, appApiMessagePreparations: [row] }), [row]);
  const altered = structuredClone(row); altered.request.attachments[0].sizeBytes--;
  assert.throws(() => messagePreparations({ id: scope.sessionId, appApiMessagePreparations: [altered] }),
    { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
});
