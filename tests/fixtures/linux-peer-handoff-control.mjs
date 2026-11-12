// Test control service running under an isolated, unprivileged UID.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const root = process.env.AGENTOC_TEST_ROOT;
const runnerUid = Number(process.env.AGENTOC_TEST_RUNNER_UID);
const realSidecar = process.env.AGENTOC_TEST_REAL_SIDECAR === '1';
const cancellation = process.env.AGENTOC_TEST_CANCEL_HANDOFF === '1';
const runId = cancellation ? 'run_peercancelfixture1' : realSidecar ? 'run_peersidecarfixture1' : 'run_peerhandofffixture1';
const sessionId = 's1', requestId = 't1';
const { createRun, getRunAcceptanceEvidence, getRunManifest, getRunResult, clearRunResult, requestRunCancel } = await import('../../chat/runs.mjs');
const { computeExecutionScopeDigest } = await import('../../chat/execution-scope.mjs');
const { issueLinuxRunScopeGrant } = await import('../../chat/linux-run-scope-issuance.mjs');
const { getActivePrivilegedSigningKey } = await import('../../chat/privileged-signing-keys.mjs');
const { handleTemporaryControlRunCheck } = await import('../../chat/router-temporary-control-run-check.mjs');
const token = Buffer.alloc(32, 17).toString('base64url');
const workspace = realSidecar ? `${root}/workspace` : '/srv/work';
const scope = { sessionId, cwd: { realPath: workspace }, scopeRoot: { realPath: workspace },
  riskContext: { platform: 'linux', cwd: workspace, trustedWorkspaceRoot: workspace } };
await createRun({ status: { id: runId, sessionId, requestId, state: 'running', runnerLaunchAttempt: 0,
    ...(realSidecar ? { tool: 'fixture-cline', runtimeFamily: 'cline-json' } : {}) },
  manifest: { sessionId, requestId, executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
    ...(realSidecar ? { tool: 'fixture-cline', prompt: 'fixture request' } : {}),
    options: { ...(realSidecar ? { runtimeFamily: 'cline-json', toolCommand: `${root}/fixture-cline` } : {}),
      approvedActionChannel: { turnId: requestId, token, tokenHash: createHash('sha256').update(token).digest('hex') } } } });
const grant = await issueLinuxRunScopeGrant(runId, 0, { resultChannel: 'peer-v1' });
for (const dir of [`${root}/spool`, `${root}/spool/${runId}`])
  execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:rwx`, dir]);
for (const name of ['status.json', 'manifest.json'])
  execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:${realSidecar ? 'rw' : 'r'}`, `${root}/spool/${runId}/${name}`]);
if (realSidecar) {
  for (const name of ['run-index.jsonl', 'request-index.jsonl'])
    execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:rw`, `${root}/spool/${name}`]);
}
const server = createServer((req, res) => {
  void handleTemporaryControlRunCheck({ req, res, pathname: new URL(req.url, 'http://127.0.0.1').pathname,
    writeJson: (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const publicKey = getActivePrivilegedSigningKey().publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.stdout.write(`QA:${JSON.stringify({ run: await getRunAcceptanceEvidence(runId), manifest: await getRunManifest(runId),
  grant, publicKey, port: server.address().port })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  try {
    if (line === 'read') process.stdout.write(`QA:${JSON.stringify({ result: await getRunResult(runId) })}\n`);
    else if (line === 'cancel') { await requestRunCancel(runId); process.stdout.write('QA:{"cancelRequested":true}\n'); }
    else if (line === 'clear') { await clearRunResult(runId); process.stdout.write('QA:{"cleared":true}\n'); }
    else if (line === 'exit') break;
  } catch (error) { process.stdout.write(`QA:${JSON.stringify({ error: error.code || error.message })}\n`); }
}
process.stdin.destroy();
server.closeIdleConnections?.();
await new Promise(resolve => server.close(resolve));
