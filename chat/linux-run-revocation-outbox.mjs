import { acknowledgeLinuxRunRevocation, listLinuxRunRevocationOutbox } from './linux-run-cancel-intent.mjs';
import { revokeLinuxRunScope } from './linux-run-scope-lifecycle.mjs';

// Independent of the runner-writable status and index. A successful root
// response includes its durable marker and the operation-lock barrier.
export function createLinuxRunRevocationOutboxRecovery({ list = listLinuxRunRevocationOutbox,
  acknowledge = acknowledgeLinuxRunRevocation, revoke = revokeLinuxRunScope } = {}) {
  let cursor = 0;
  return async function recover({ limit = 50, concurrency = 8 } = {}) {
    const { records, invalid } = await list();
    const count = Math.min(records.length, Math.max(1, Math.min(500, Math.floor(limit) || 50)));
    const batch = Array.from({ length: count }, (_, i) => records[(cursor + i) % records.length]);
    if (records.length) cursor = (cursor + count) % records.length;
    let next = 0, revoked = 0;
    async function worker() {
      while (next < batch.length) {
        const record = batch[next++];
        try {
          if ((await revoke({ id: record.runId, runnerLaunchAttempt: record.launchAttempt })).state !== 'revoked') continue;
          await acknowledge(record.runId, record.launchAttempt);
          revoked++;
        } catch { /* Keep the protected record for a later retry. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(count, Math.max(1, Math.min(32, Math.floor(concurrency) || 1))) }, worker));
    return { attempted: count, revoked, invalid };
  };
}
