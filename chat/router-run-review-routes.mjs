import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readBody } from '../lib/utils.mjs';
import { RUN_REVIEW_ENDPOINT, RUN_REVIEW_OPERATION, isStrictLoopbackRequest } from './run-review-capability.mjs';
import { reviewApprovalContext } from './approval-context-review.mjs';
import { readRunSpoolRecords, runManifestPath } from './runs.mjs';
import { assertRunPublication } from './run-publication-contract.mjs';

const usedReviews = new Map();
const activeReviews = new Set();

export async function handleRunReviewRoute({ req, res, pathname, writeJson, authenticate, getRun, getRunManifest }) {
  if (pathname !== RUN_REVIEW_ENDPOINT) return false;
  if (req.method !== 'POST' || !isStrictLoopbackRequest(req)) { writeJson(res, 403, { verdict: 'unknown', reason: 'review_loopback_required' }); return true; }
  const principal = await authenticate(req, { pathname, method: req.method });
  if (principal?.capabilityOperation !== RUN_REVIEW_OPERATION) { writeJson(res, 401, { verdict: 'unknown', reason: 'review_capability_invalid' }); return true; }
  let binding = {};
  try {
    const payload = JSON.parse(await readBody(req, 48 * 1024));
    const { approvalId, requestId, context, requestHash } = payload;
    const digest = createHash('sha256').update(JSON.stringify({ approvalId, requestId, context })).digest('hex');
    if (typeof approvalId !== 'string' || !approvalId || approvalId.length > 512 || typeof requestId !== 'string'
      || requestId !== principal.turnId || !context || typeof context !== 'object' || Array.isArray(context)
      || digest !== requestHash) { writeJson(res, 400, { verdict: 'unknown', reason: 'review_request_invalid' }); return true; }
    binding = { approvalId, requestHash };
    const reviewKey = `${principal.runId}\u0000${approvalId}`;
    const now = Date.now();
    for (const [key, time] of usedReviews) if (now - time > 24 * 60 * 60 * 1000) usedReviews.delete(key);
    const runPrefix = `${principal.runId}\u0000`;
    if (usedReviews.has(reviewKey) || usedReviews.size >= 10000 || activeReviews.size >= 8
      || [...activeReviews].filter(key => key.startsWith(runPrefix)).length >= 2
      || [...usedReviews.keys()].filter(key => key.startsWith(runPrefix)).length >= 512) {
      writeJson(res, 409, { verdict: 'unknown', reason: 'review_limit', ...binding }); return true;
    }
    usedReviews.set(reviewKey, now);
    activeReviews.add(reviewKey);
    let result;
    try {
      const records = await readRunSpoolRecords(principal.runId);
      const matching = records.filter(record => record?.json?.type === 'agentoc.approval_review_request'
        && record.json.runId === principal.runId && record.json.approvalId === approvalId
        && record.json.requestId === requestId && record.json.requestHash === requestHash);
      if (matching.length !== 1) { writeJson(res, 403, { verdict: 'unknown', reason: 'review_spool_binding_invalid', ...binding }); return true; }
      const [run, baseline, text] = await Promise.all([getRun(principal.runId), getRunManifest(principal.runId),
        readFile(runManifestPath(principal.runId), 'utf8')]);
      const manifest = JSON.parse(text);
      if (!assertRunPublication(run, manifest) || manifest.id !== principal.runId || manifest.sessionId !== principal.sessionId
        || manifest.requestId !== principal.turnId
        || baseline?.runPublication?.publicationId !== manifest?.runPublication?.publicationId) {
        writeJson(res, 409, { verdict: 'unknown', reason: 'review_run_binding_invalid', ...binding }); return true;
      }
      result = await reviewApprovalContext({ run, manifest, request: context });
    }
    finally { activeReviews.delete(reviewKey); }
    // Check liveness again after the network operation before returning a signal.
    if (!await authenticate(req, { pathname, method: req.method })) { writeJson(res, 409, { verdict: 'unknown', reason: 'review_run_inactive', ...binding }); return true; }
    writeJson(res, 200, { ...result, approvalId, requestHash });
  } catch { writeJson(res, 200, { verdict: 'unknown', reason: 'review_internal_error', ...binding }); }
  return true;
}
