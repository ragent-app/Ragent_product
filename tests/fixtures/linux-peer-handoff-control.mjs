// Test control service running under an isolated, unprivileged UID.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const root = process.env.AGENTOC_TEST_ROOT;
const runnerUid = Number(process.env.AGENTOC_TEST_RUNNER_UID);
const runId = 'run_peerhandofffixture1', sessionId = 's1', requestId = 't1';
const { createRun, getRunAcceptanceEvidence, getRunManifest, getRunResult, clearRunResult } = await import('../../chat/runs.mjs');
const { computeExecutionScopeDigest } = await import('../../chat/execution-scope.mjs');
const { issueLinuxRunScopeGrant } = await import('../../chat/linux-run-scope-issuance.mjs');
const { getActivePrivilegedSigningKey } = await import('../../chat/privileged-signing-keys.mjs');
const { handleTemporaryControlRunCheck } = await import('../../chat/router-temporary-control-run-check.mjs');
const token = Buffer.alloc(32, 17).toString('base64url');
const scope = { sessionId, cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
  riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
await createRun({ status: { id: runId, sessionId, requestId, state: 'running', runnerLaunchAttempt: 0 },
  manifest: { sessionId, requestId, executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
    options: { approvedActionChannel: { turnId: requestId, token, tokenHash: createHash('sha256').update(token).digest('hex') } } } });
const grant = await issueLinuxRunScopeGrant(runId, 0, { resultChannel: 'peer-v1' });
for (const dir of [`${root}/spool`, `${root}/spool/${runId}`])
  execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:rwx`, dir]);
for (const name of ['status.json', 'manifest.json'])
  execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:r`, `${root}/spool/${runId}/${name}`]);
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
    else if (line === 'clear') { await clearRunResult(runId); process.stdout.write('QA:{"cleared":true}\n'); }
    else if (line === 'exit') break;
  } catch (error) { process.stdout.write(`QA:${JSON.stringify({ error: error.code || error.message })}\n`); }
}
process.stdin.destroy();
server.closeIdleConnections?.();
await new Promise(resolve => server.close(resolve));
