import { createRagentHttpClient } from './ragent-http-client.mjs';

// Identity and review Work Item come only from the signed Run channel.
export async function runReviewOpinionCommand(argv = [], io = {}) {
  const options = {};
  const allowed = new Set(['candidate-work-item', 'candidate-digest', 'contract-revision', 'execution-epoch', 'verdict', 'reason', 'idempotency-key']);
  for (let i = 0; i < argv.length; i++) {
    const key = String(argv[i] || '').replace(/^--/, '');
    if (!String(argv[i]).startsWith('--') || !allowed.has(key) || options[key] !== undefined || i + 1 >= argv.length) throw new Error('Invalid review opinion options');
    options[key] = argv[++i];
  }
  const sessionId = String(process.env.RAGENT_SESSION_CONTROL_SESSION_ID || '').trim();
  if (!sessionId || !process.env.RAGENT_SESSION_CONTROL_TOKEN) throw new Error('A scoped review Run capability is required');
  const body = { candidateWorkItemId:options['candidate-work-item'], candidateDigest:options['candidate-digest'], contractRevision:Number(options['contract-revision']), executionEpoch:Number(options['execution-epoch']), verdict:options.verdict, reason:options.reason, idempotencyKey:options['idempotency-key'] };
  if (!body.candidateWorkItemId || !body.candidateDigest || !Number.isSafeInteger(body.contractRevision) || body.contractRevision < 1 || !Number.isSafeInteger(body.executionEpoch) || body.executionEpoch < 1 || !['pass','needs_changes','blocked'].includes(body.verdict) || !body.reason?.trim() || !body.idempotencyKey?.trim()) throw new Error('Review requires candidate, contract revision, execution epoch, verdict, reason and stable idempotency key');
  const result = await createRagentHttpClient().request(`/api/sessions/${encodeURIComponent(sessionId)}/factory/review-opinion`, { method:'POST', body });
  if (!result.response.ok) throw new Error(result.json?.error || result.text || `Review request failed (${result.response.status})`);
  (io.stdout || process.stdout).write(`${JSON.stringify(result.json)}\n`);
  return 0;
}
