// Local-only device acceptance fixture. Provider requests and owner identity
// are isolated test inputs; projection, HTTP routes, risk gate and queue are production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32' || process.env.AGENTOC_SAMSUNG_APPROVAL_QA !== '1') {
  console.log('samsung-windows-approval-bridge: skipped (explicit Windows device opt-in required)');
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-phone-approval-'));
const instance = path.join(root, 'instance');
const workspace = path.join(instance, 'workspace');
await mkdir(workspace, { recursive: true });
process.env.AGENTOC_INSTANCE_ROOT = instance;
process.env.AGENTOC_CONFIG_DIR = path.join(instance, 'config');
process.env.AGENTOC_WORK_ROOT_DIR = workspace;
process.env.AGENTOC_MEMORY_DIR = path.join(instance, 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(instance, 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(instance, 'data', 'chat-runs');

const { appendRunSpoolRecord, createRun, getRun } = await import('../chat/runs.mjs');
const { withSessionsMetaMutation, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { getHistory } = await import('../chat/session-manager.mjs');
const { trackClaudeBidiApprovalRequest, trackCodexAppServerApprovalRequest } = await import('../chat/runner-sidecar.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const sessionId = 'samsung-fixture';
const groupedCodex = process.env.AGENTOC_SAMSUNG_APPROVAL_GROUP === '1';
const tool = groupedCodex ? 'codex' : 'claude';
const runtimeFamily = groupedCodex ? 'codex-app-server-json' : 'claude-stream-json-bidi';
await withSessionsMetaMutation(async (rows, save) => {
  rows.push({ id: sessionId, name: 'Samsung approval fixture', folder: workspace, tool,
    sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
  await save(rows, { immediate: true, durable: true });
});
const run = await createRun({
  status: { sessionId, requestId: 'phone-fixture', state: 'running', tool, runtimeFamily },
  manifest: { sessionId, requestId: 'phone-fixture', folder: workspace, tool, runtimeFamily, prompt: 'local fixture', options: { riskMode: 'recommended', permissionMode: 'default' } },
});
await mutateSessionMeta(sessionId, row => { row.activeRunId = run.id; return true; });
const state = { riskMode: 'recommended', turnActive: true, cwd: workspace, riskContextValid: true,
  riskContext: { platform: 'win32', trustedWorkspaceRoot: workspace, protectedRoots: [] },
  pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set(), activeItems: new Map(),
  threadId: 'fixture-thread', turnId: 'fixture-turn', startedTurn: true };
const sent = [];
const proc = { stdin: { writable: true, write(value) { sent.push(value); return true; } } };
const target = path.join(workspace, 'example');
const command = `Remove-Item -Recurse -Force '${target}'`;
if (groupedCodex) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = `'${shell}' -NoProfile -Command '${command.replaceAll("'", "'\\''")}'`;
  for (const id of [1, 2]) {
    const request = { id, method: 'item/commandExecution/requestApproval',
      params: { threadId: state.threadId, turnId: state.turnId, itemId: `item-${id}`, cwd: workspace, command: encoded } };
    await trackCodexAppServerApprovalRequest(run.id, state, request, proc);
    await appendRunSpoolRecord(run.id, { stream: 'stdout', json: request });
  }
} else {
  const request = { type: 'control_request', request_id: 'phone-danger',
    request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command } } };
  await trackClaudeBidiApprovalRequest(run.id, state, request, proc);
  await appendRunSpoolRecord(run.id, { stream: 'stdout', json: request });
}
assert.equal(sent.length, 0, 'dangerous operation must remain pending');
const pending = (await getRun(run.id)).appServerPendingApprovals;
assert.equal(pending.length, groupedCodex ? 2 : 1);
const approvalId = pending[0].approvalId;
const history = await getHistory(sessionId);
assert.ok(history.some(event => event.type === 'approval_request' && event.approvalId === approvalId), 'provider request must project to durable session history');
let queued = false;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith(`/api/sessions/${sessionId}/events`)) {
      let status = 0; let body;
      const handled = await handleSessionMainRoutes({ req, res, pathname: url.pathname,
        parsedUrl: { pathname: url.pathname, query: Object.fromEntries(url.searchParams) },
        sessionGetRoute: { kind: 'event-delta', sessionId },
        authSession: { role: 'owner', principalKind: 'trusted_device' },
        requireSessionAccess: async (_response, _auth, requestedSession) => requestedSession === sessionId,
        writeJson: (_response, code, value) => { status = code; body = value; },
        writeJsonCached: (_request, _response, value) => { status = 200; body = value; },
      });
      assert.equal(handled, true); assert.equal(status, 200);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === `/api/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(approvalId)}`) {
      let routeStatus = 0; let routeBody;
      const handled = await handleSessionMainRoutes({ req, res, pathname: url.pathname,
        parsedUrl: { pathname: url.pathname, query: Object.fromEntries(url.searchParams) },
        authSession: { role: 'owner', principalKind: 'trusted_device' },
        requireSessionAccess: async (_response, _auth, requestedSession) => requestedSession === sessionId,
        writeJson: (_response, status, body) => { routeStatus = status; routeBody = body; },
      });
      assert.equal(handled, true); assert.equal(routeStatus, 202);
      assert.equal(routeBody?.approval?.decision, 'deny');
      const current = await getRun(run.id);
      assert.equal(current.appServerApprovalResponseQueue.filter(entry => pending.some(item => item.approvalId === entry.approvalId)
        && entry.decision === 'deny').length, pending.length);
      queued = true;
      res.writeHead(routeStatus, { 'content-type': 'application/json' }).end(JSON.stringify(routeBody));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/fixture/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ queued }));
      return;
    }
    res.writeHead(404).end();
  } catch (error) { console.error(error); res.writeHead(500).end(); }
});
server.listen(18667, '127.0.0.1', () => console.log('SAMSUNG_APPROVAL_FIXTURE_READY'));
