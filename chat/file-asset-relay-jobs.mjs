import { randomBytes } from 'node:crypto';
import { openRelayAsset } from './file-asset-relay-receiver.mjs';
import { ingestFileAssetUpload } from './file-assets.mjs';

// A job holds only ephemeral transport credentials. The ordinary asset ingest
// validates the complete plaintext digest and publishes its private snapshot.
export function createFileAssetRelayJobs({ open = openRelayAsset, ingest = ingestFileAssetUpload,
  maxJobs = 16, timeoutMs = 180_000, retentionMs = 10 * 60_000 } = {}) {
  const jobs = new Map();
  function view(job) { return { version: 1, jobId: job.id, status: job.status }; }
  function start({ asset, accountsBaseUrl, relayId, readToken, transferId, key, scopeCondition }) {
    if (!asset || !/^fasset_[a-f0-9]{24}$/.test(asset.id) || asset.status !== 'pending_upload' ||
        asset.storage?.provider !== 'local' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 ||
        !/^[a-f0-9]{32}$/.test(relayId) || !/^[a-f0-9]{32}$/.test(transferId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(readToken) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      throw Object.assign(new Error('Invalid relay upload'), { code: 'INVALID_ARGUMENT', statusCode: 400 });
    }
    const decodedKey = Buffer.from(key, 'base64url');
    if (decodedKey.length !== 32 || decodedKey.toString('base64url') !== key)
      throw Object.assign(new Error('Invalid relay upload'), { code: 'INVALID_ARGUMENT', statusCode: 400 });
    if (jobs.has(asset.id) || jobs.size >= maxJobs)
      throw Object.assign(new Error('Relay upload is already active or capacity is exhausted'), { code: 'RESOURCE_LIMIT', statusCode: 429 });
    const controller = new AbortController();
    const job = { id: randomBytes(16).toString('hex'), status: 'receiving', controller, promise: null, timer: null };
    jobs.set(asset.id, job);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    job.promise = (async () => {
      try {
        const input = await open({ accountsBaseUrl, relayId, readToken, key: decodedKey, transferId,
          totalBytes: asset.sizeBytes, signal: controller.signal });
        await ingest(asset.id, input, { scopeCondition, signal: controller.signal });
        job.status = 'received';
      } catch {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      } finally {
        decodedKey.fill(0);
        clearTimeout(timeout);
        job.timer = setTimeout(() => { if (jobs.get(asset.id) === job) jobs.delete(asset.id); }, retentionMs);
        job.timer.unref?.();
      }
    })();
    return view(job);
  }
  function status(assetId, jobId) {
    const job = jobs.get(assetId);
    return job && job.id === jobId ? view(job) : null;
  }
  async function cancel(assetId, jobId) {
    const job = jobs.get(assetId);
    if (!job || job.id !== jobId) return null;
    job.controller.abort();
    await job.promise;
    clearTimeout(job.timer);
    if (jobs.get(assetId) === job) jobs.delete(assetId);
    return view(job);
  }
  function forgetReceived(assetId) {
    const job = jobs.get(assetId);
    if (!job || job.status !== 'received') return;
    clearTimeout(job.timer);
    jobs.delete(assetId);
  }
  async function waitForReceived(assetId) {
    const job = jobs.get(assetId);
    if (!job) return;
    await job.promise;
    if (job.status !== 'received') {
      throw Object.assign(new Error('Encrypted attachment was not received'),
        { code: 'FILE_ASSET_RELAY_FAILED', statusCode: 409 });
    }
  }
  return { start, status, cancel, forgetReceived, waitForReceived };
}

export const fileAssetRelayJobs = createFileAssetRelayJobs();
