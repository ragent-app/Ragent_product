import { hasLinuxRunResultTransaction, listLinuxRunResultTransactions } from './linux-run-result-transaction.mjs';

export function createLinuxRunResultTransactionRecovery({ list = listLinuxRunResultTransactions,
  recoverResult = async (runId) => (await import('./runs.mjs')).getRunResult(runId),
  remains = hasLinuxRunResultTransaction } = {}) {
  let cursor = 0;
  return async function recover({ limit = 50, concurrency = 4 } = {}) {
    const { records, invalid } = await list();
    const count = Math.min(records.length, Math.max(1, Math.min(500, Math.floor(limit) || 50)));
    const batch = Array.from({ length: count }, (_, index) => records[(cursor + index) % records.length]);
    if (records.length) cursor = (cursor + count) % records.length;
    let next = 0, recovered = 0;
    async function worker() {
      while (next < batch.length) {
        const record = batch[next++];
        try {
          await recoverResult(record.runId);
          if (!await remains(record.runId, record.launchAttempt)) recovered++;
        } catch { /* A conflicting or unavailable record remains for retry. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(count, Math.max(1, Math.min(16, Math.floor(concurrency) || 1))) }, worker));
    return { attempted: count, recovered, invalid };
  };
}
