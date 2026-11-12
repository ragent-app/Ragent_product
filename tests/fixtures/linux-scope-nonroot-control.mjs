// Subprocess fixture: run as the non-root control UID, never as the runner.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const root = process.env.AGENTOC_TEST_ROOT;
const runnerUid = Number(process.env.AGENTOC_TEST_RUNNER_UID);
const runId = 'run_nonrootfixture1', sessionId = 's1', requestId = 't1';
const { createRun, getRunResult } = await import('../../chat/runs.mjs');
const { computeExecutionScopeDigest } = await import('../../chat/execution-scope.mjs');
const { issueLinuxRunScopeGrant } = await import('../../chat/linux-run-scope-issuance.mjs');
const { handleTemporaryControlRunCheck } = await import('../../chat/router-temporary-control-run-check.mjs');
const token = Buffer.alloc(32, 11).toString('base64url');
const scope = { sessionId, cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
  riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
if (process.env.AGENTOC_TEST_RECOVER !== '1') {
  await createRun({ status: { id: runId, sessionId, requestId, state: 'running', runnerLaunchAttempt: 0 },
    manifest: { sessionId, requestId, executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
      options: { approvedActionChannel: { turnId: requestId, token, tokenHash: createHash('sha256').update(token).digest('hex') } } } });
  await issueLinuxRunScopeGrant(runId, 0);
  for (const dir of [`${root}/spool`, `${root}/spool/${runId}`])
    execFileSync('/usr/bin/setfacl', ['-m', `u:${runnerUid}:rwx`, dir]);
}
const server = createServer((req, res) => {
  void handleTemporaryControlRunCheck({ req, res, pathname: new URL(req.url, 'http://127.0.0.1').pathname,
    writeJson: (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(`QA:${JSON.stringify({ port: server.address().port, runId, uid: process.geteuid() })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'read') process.stdout.write(`QA:${JSON.stringify({ result: await getRunResult(runId) })}\n`);
  if (line === 'exit') break;
}
process.stdin.destroy();
server.closeIdleConnections?.();
await new Promise((resolve) => server.close(resolve));
