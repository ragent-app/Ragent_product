import assert from 'node:assert/strict';
import { resolveProviderPermissionPolicy } from '../chat/provider-contract.mjs';
import {
  buildCodexAppServerThreadOptions,
  buildCodexAppServerTurnStartMessage,
  isCodexAppServerRagentApprovalGateEnabled,
  validateCodexAppServerApprovalContext,
} from '../chat/codex-app-server-protocol.mjs';

for (const [runtime, expected] of [
  ['claude-stream-json-bidi', 'default'],
  ['codex-app-server-json', 'on-request-danger-full-access'],
]) {
  const auto = resolveProviderPermissionPolicy(runtime, { riskMode: 'full-auto', platform: 'win32' });
  const ask = resolveProviderPermissionPolicy(runtime, { riskMode: 'recommended', platform: 'win32' });
  assert.equal(auto.id, expected, `${runtime} autonomous uses the gate`);
  assert.equal(auto.id, ask.id, `${runtime} shares approval gate`);
}
assert.equal(resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'conservative-auto', platform: 'win32' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'conservative-auto', platform: 'win32' }).id, 'untrusted-workspace-write');
assert.equal(resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'conservative-auto', platform: 'linux' }).id, 'untrusted-workspace-write');
assert.equal(resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'full-auto', platform: 'linux' }).id, 'on-request-danger-full-access');
assert.equal(resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'full-auto', platform: 'linux' }).id, 'bypassPermissions');
assert.equal(resolveProviderPermissionPolicy('claude-stream-json', { riskMode: 'full-auto', platform: 'win32' }), null);
for (const riskMode of ['safe', 'recommended', 'full-auto', 'conservative-auto']) {
  assert.equal(isCodexAppServerRagentApprovalGateEnabled({ riskMode, platform: 'win32' }), true);
}
assert.equal(isCodexAppServerRagentApprovalGateEnabled({ riskMode: 'recommended', platform: 'linux' }), true);
assert.equal(isCodexAppServerRagentApprovalGateEnabled({ riskMode: 'full-auto', platform: 'linux' }), true);
assert.equal(isCodexAppServerRagentApprovalGateEnabled({ riskMode: 'manual', platform: 'win32' }), false);
assert.equal(isCodexAppServerRagentApprovalGateEnabled({ permissionMode: 'untrusted-danger-full-access', platform: 'linux' }), true,
  'explicit untrusted permission modes use project-derived policy on every platform');
const windowsCodexMode = resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'recommended', platform: 'win32' }).id;
assert.throws(() => buildCodexAppServerThreadOptions({ permissionMode: 'untrusted-danger-full-access' }), /requires a Run-scoped project trust gate/,
  'retired explicit untrusted policy cannot be sent without the project trust override');
assert.throws(() => buildCodexAppServerTurnStartMessage({ threadId: 'thread', text: 'fixture', permissionMode: 'untrusted-danger-full-access' }), /requires a Run-scoped project trust gate/,
  'turn/start requires the project trust override for untrusted mode');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode, ragentApprovalGate: true }).approvalsReviewer, 'user');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode, ragentApprovalGate: true }).config.allow_login_shell, false);
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode, ragentApprovalGate: true }).approvalPolicy, 'on-request');
const codexOnRequestMode = 'on-request-danger-full-access';
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: codexOnRequestMode }).config.allow_login_shell, undefined);
assert.equal(buildCodexAppServerTurnStartMessage({ threadId: 'thread', text: 'fixture', permissionMode: windowsCodexMode, ragentApprovalGate: true }).params.approvalsReviewer, 'user');
assert.equal(buildCodexAppServerTurnStartMessage({ threadId: 'thread', text: 'fixture', permissionMode: windowsCodexMode, ragentApprovalGate: true }).params.approvalPolicy, 'on-request');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: codexOnRequestMode }).approvalsReviewer, undefined);

const verifiedContext = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'dangerFullAccess' },
  cwd: 'g:/agentoC/WORKSPACE',
  runtimeWorkspaceRoots: ['G:\\Ragent\\Workspace'],
};
assert.deepEqual(validateCodexAppServerApprovalContext({
  response: verifiedContext,
  cwd: 'G:\\Ragent\\Workspace',
  permissionMode: windowsCodexMode,
}), { ok: true, reasonCode: null });
assert.equal(validateCodexAppServerApprovalContext({
  response: { ...verifiedContext, approvalPolicy: 'untrusted' },
  cwd: 'G:\\Ragent\\Workspace',
  permissionMode: windowsCodexMode,
}).reasonCode, 'CODEX_APPROVAL_POLICY_UNVERIFIED');
assert.equal(validateCodexAppServerApprovalContext({
  response: { ...verifiedContext, sandbox: { type: 'workspaceWrite' } },
  cwd: 'G:\\Ragent\\Workspace',
  permissionMode: windowsCodexMode,
}).reasonCode, 'CODEX_APPROVAL_SANDBOX_UNVERIFIED');
const conservativeCodexMode = resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'conservative-auto', platform: 'win32' }).id;
assert.deepEqual(validateCodexAppServerApprovalContext({
  response: { ...verifiedContext, approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', networkAccess: false } },
  cwd: 'G:\\Ragent\\Workspace',
  permissionMode: conservativeCodexMode,
}), { ok: true, reasonCode: null });
console.log('windows-approval-profiles: harness mapping checks passed');
