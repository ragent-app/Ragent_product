#!/usr/bin/env node
import assert from 'assert/strict';

import {
  PRIVILEGED_GATE_DECISION,
  decidePrivilegedGate,
  decideRiskGate,
  isGatedPermissionMode,
  isKnownFileGate,
  isUserFacingGateKind,
  readGateCommand,
} from '../chat/privileged-gate.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

// Build a Claude bidi `can_use_tool` approval record (as readClaudeBidiApprovalRequest returns).
function bidiApproval(command, { toolName = 'Bash' } = {}) {
  const input = toolName === 'Bash' && command !== undefined ? { command } : {};
  return {
    approvalId: 'claude:req-1',
    providerRequestId: 'req-1',
    providerRequestIdString: 'req-1',
    providerMethod: 'can_use_tool',
    kind: toolName === 'Bash' ? 'command' : 'permissions',
    requestClass: toolName === 'Bash' ? 'command_invocation' : 'tool_invocation',
    params: { tool_name: toolName, input },
  };
}

// Build a Codex app-server approval record (as readCodexAppServerApprovalRequest returns).
function codexApproval(command) {
  return {
    approvalId: 'item/commandExecution/requestApproval:42',
    providerRequestId: 42,
    providerRequestIdString: '42',
    providerMethod: 'item/commandExecution/requestApproval',
    kind: 'command',
    params: typeof command === 'string' ? { command } : { command },
  };
}
for (const riskMode of ['recommended', 'full-auto']) {
  const base = bidiApproval('echo safe');
  for (const extra of [{ additionalPermissions: { network: true } }, { networkApprovalContext: { host: 'example.org' } }]) {
    eq(`${riskMode}: capability expansion requires review`, decideRiskGate({ ...base, params: { ...base.params, ...extra } }, { riskMode }).decision, PRIVILEGED_GATE_DECISION.PROMPT);
  }
  eq(`${riskMode}: explicit sandbox bypass requires review`, decideRiskGate({ ...base, params: { ...base.params, input: { ...base.params.input, dangerouslyDisableSandbox: true } } }, { riskMode }).decision, PRIVILEGED_GATE_DECISION.PROMPT);
}

const SENTINEL = (real, { category = 'install', desc = 'test op' } = {}) =>
  `agentoc-privileged --description "${desc}" --category ${category} -- ${real}`;

// --- readGateCommand: runtime shape extraction ---
{
  eq('bidi Bash command extracted', readGateCommand(bidiApproval('ls -la')), 'ls -la');
  eq('bidi non-Bash tool yields no command', readGateCommand(bidiApproval('x', { toolName: 'Read' })), '');
  eq('codex string command extracted', readGateCommand(codexApproval('rm -rf /tmp/x')), 'rm -rf /tmp/x');
  eq('codex argv command joined', readGateCommand(codexApproval(['apt-get', 'install', 'nginx'])), 'apt-get install nginx');
  eq('empty approval yields no command', readGateCommand({}), '');
}

// --- gated permission-mode recognition (plan/on-request emit per-tool requests) ---
{
  for (const gated of ['default', 'plan', 'acceptEdits', 'on-request', 'on-request-workspace-write',
    'on-request-danger-full-access', 'untrusted-read-only', 'untrusted-workspace-write', 'untrusted-danger-full-access', 'auto', 'never-read-only']) {
    check(`permission mode ${gated} is gated`, isGatedPermissionMode(gated));
  }
  for (const bypass of ['bypassPermissions', 'never-danger-full-access', 'bypass-approvals-and-sandbox']) {
    check(`permission mode ${bypass} is not gated`, !isGatedPermissionMode(bypass));
  }
  check('empty mode is not gated', !isGatedPermissionMode(''));
  check('unknown mode falls back to legacy', !isGatedPermissionMode('some-future-mode'));
}

// --- user-facing gate kinds never auto-answered by the classifier ---
{
  check('question kind is user-facing', isUserFacingGateKind('question'));
  check('plan kind is user-facing', isUserFacingGateKind('plan'));
  for (const kind of ['command', 'permissions', 'file_change', '', undefined, null]) {
    check(`kind ${String(kind)} is not user-facing`, !isUserFacingGateKind(kind));
  }
}

// --- default OFF: privileged mode off => always PASS (whole module is a no-op) ---
{
  const d = decidePrivilegedGate(bidiApproval('sudo rm -rf /'), { privilegedMode: false });
  eq('privileged mode off => PASS', d.decision, PRIVILEGED_GATE_DECISION.PASS);
  const dDefault = decidePrivilegedGate(bidiApproval('sudo rm -rf /'), {});
  eq('privileged mode unset => PASS', dDefault.decision, PRIVILEGED_GATE_DECISION.PASS);
}

// --- privileged mode on, ordinary command => AUTO_ALLOW ---
{
  const d = decidePrivilegedGate(bidiApproval('ls -la'), { privilegedMode: true });
  eq('ordinary command => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('ordinary command reason', d.reason, 'ordinary command');
}

// --- non-command gate (file change / permissions prompt) => AUTO_ALLOW ---
{
  const d = decidePrivilegedGate(bidiApproval(undefined, { toolName: 'Read' }), { privilegedMode: true });
  eq('non-command gate => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('non-command gate reason', d.reason, 'non-command gate');
}

// --- valid sentinel => ACCUMULATE with op carrying the real command ---
{
  const d = decidePrivilegedGate(bidiApproval(SENTINEL('apt-get install nginx', { category: 'install' })), {
    privilegedMode: true,
    cwd: '/srv/x',
  });
  eq('valid sentinel => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('accumulate reason (declared)', d.reason, 'declared sentinel');
  eq('op.command is the real command', d.op.command, 'apt-get install nginx');
  eq('op.declaredCategory carried', d.op.declaredCategory, 'install');
  eq('op.description carried', d.op.description, 'test op');
  eq('op.cwd carried', d.op.cwd, '/srv/x');
  eq('op.approvalId carried', d.op.approvalId, 'claude:req-1');
  // Wrapper preserved so the resolve slice can rewrite updatedInput.command.
  check('op.wrapperCommand is the sentinel string', d.op.wrapperCommand.startsWith('agentoc-privileged'));
}

// --- undeclared sudo => ACCUMULATE (the safety-net signal) ---
{
  const d = decidePrivilegedGate(bidiApproval('sudo systemctl restart nginx'), { privilegedMode: true });
  eq('undeclared sudo => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('accumulate reason (sudo)', d.reason, 'undeclared sudo');
  eq('op.command is the raw sudo command', d.op.command, 'sudo systemctl restart nginx');
  eq('op.wrapperCommand empty (no sentinel)', d.op.wrapperCommand, '');
}

// --- malformed sentinel (no `--`) => AUTO_ALLOW so the wrapper runs and fails loudly ---
{
  const d = decidePrivilegedGate(bidiApproval('agentoc-privileged --category install'), { privilegedMode: true });
  eq('malformed sentinel => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  check('malformed reason surfaced', /malformed sentinel/.test(d.reason));
}

// --- Codex runtime path parity: valid sentinel via app-server shape => ACCUMULATE ---
{
  const d = decidePrivilegedGate(codexApproval(SENTINEL('rm -rf /var/cache/x', { category: 'delete', desc: 'cleanup' })), {
    privilegedMode: true,
    cwd: '/tmp',
  });
  eq('codex sentinel => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('codex op.command real', d.op.command, 'rm -rf /var/cache/x');
  eq('codex op.declaredCategory', d.op.declaredCategory, 'delete');
}

// --- Codex ordinary command => AUTO_ALLOW ---
{
  const d = decidePrivilegedGate(codexApproval('cat /etc/hostname'), { privilegedMode: true });
  eq('codex ordinary => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
}

// --- not an approval request => PASS ---
{
  const d = decidePrivilegedGate({}, { privilegedMode: true });
  eq('no approvalId => PASS', d.decision, PRIVILEGED_GATE_DECISION.PASS);
}

// ==================== decideRiskGate (plan phase 2) ====================

// --- risk mode off => PASS; unattended profiles reuse the shared risk bands ---
{
  const dUnset = decideRiskGate(bidiApproval('sudo rm -rf /'), {});
  eq('risk mode unset => PASS', dUnset.decision, PRIVILEGED_GATE_DECISION.PASS);
  eq('risk mode off reason', dUnset.reason, 'risk mode off');
  const dFull = decideRiskGate(bidiApproval('sudo rm -rf /'), { riskMode: 'full-auto' });
  eq('full-auto danger => ACCUMULATE for caller denial', dFull.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  const dEmpty = decideRiskGate({}, { riskMode: 'recommended' });
  eq('no approvalId => PASS', dEmpty.decision, PRIVILEGED_GATE_DECISION.PASS);
}

// --- recommended + state-changing sudo admin (systemctl restart) => ACCUMULATE ---
{
  const d = decideRiskGate(bidiApproval('sudo systemctl restart nginx'), { riskMode: 'recommended', cwd: '/srv/x' });
  eq('recommended sudo admin => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('op.risk.tier danger', d.risk.tier, 'danger');
  check('op.risk.signals reasons', Array.isArray(d.risk.signals?.reasons) && d.risk.signals.reasons.length > 0);
}

// --- recommended + dangerous sudo (script interpreter) => ACCUMULATE with op.risk attached ---
{
  const d = decideRiskGate(bidiApproval("sudo bash -c 'rm -rf /tmp/x'"), { riskMode: 'recommended', cwd: '/srv/x' });
  eq('recommended sudo interpreter => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  check('danger reason surfaced', /risk danger/.test(d.reason));
  eq('op.risk.tier danger', d.op.risk.tier, 'danger');
}

// POSIX system-path behavior is tested on POSIX hosts; Windows has a separate
// native policy suite and intentionally uses Windows system roots.
if (process.platform !== 'win32') {
// --- recommended + destructive delete on system path => ACCUMULATE (classifier danger tier) ---
{
  const d = decideRiskGate(bidiApproval('rm -rf /etc/evil'), { riskMode: 'recommended' });
  eq('rm -rf /etc => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('risk tier danger', d.risk.tier, 'danger');
  check('destructive reason surfaced', /system path/.test(d.op.risk.signals.reasons.join(' ')));
}

// --- recommended + plain read of a system path => AUTO_ALLOW (reads are not danger) ---
{
  const d = decideRiskGate(bidiApproval('cat /etc/hostname'), { riskMode: 'recommended' });
  eq('read system path => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('risk tier safe', d.risk.tier, 'safe');
}
}

// --- recommended + safe command => AUTO_ALLOW with tier attached ---
{
  const d = decideRiskGate(bidiApproval('ls -la'), { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x' });
  eq('recommended safe => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('risk tier safe', d.risk.tier, 'safe');
  eq('command carried', d.command, 'ls -la');
  check('safe reason surfaced', /risk safe/.test(d.reason));
}

// --- recommended + caution (network egress) => AUTO_ALLOW in v1 (execution gap until phase 4) ---
{
  const d = decideRiskGate(bidiApproval('curl https://example.com'), { riskMode: 'recommended' });
  eq('recommended caution => AUTO_ALLOW (v1)', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('risk tier caution', d.risk.tier, 'caution');
}

// --- full-auto reuses recommended's safe+caution classifier band ---
{
  const d = decideRiskGate(bidiApproval('curl https://example.com'), { riskMode: 'full-auto' });
  eq('full-auto caution => AUTO_ALLOW for caller policy', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
}

// --- conservative-auto reuses safe's band, allowing the sidecar to deny caution without waiting ---
{
  const d = decideRiskGate(bidiApproval('curl https://example.com'), { riskMode: 'conservative-auto' });
  eq('conservative-auto caution => PROMPT for caller denial', d.decision, PRIVILEGED_GATE_DECISION.PROMPT);
}

// --- safe + caution => owner approval ---
{
  const d = decideRiskGate(bidiApproval('curl https://example.com'), { riskMode: 'safe' });
  eq('safe caution => PROMPT', d.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  eq('risk tier caution', d.risk.tier, 'caution');
}

// --- safe + danger => ACCUMULATE (same as recommended for danger) ---
{
  const d = decideRiskGate(bidiApproval('sudo rm -rf /tmp/x'), { riskMode: 'safe' });
  eq('safe danger => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('risk tier danger', d.risk.tier, 'danger');
}

// --- in-scope install => ACCUMULATE via needsPrivilegedExecution, no human prompt (install-auto) ---
{
  const d = decideRiskGate(bidiApproval('apt-get install nginx'), { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x' });
  eq('in-scope install => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('risk tier safe (user-facing)', d.risk.tier, 'safe');
  eq('autoExecute signal', d.risk.signals.autoExecute, true);
  check('install-auto reason surfaced', /install-auto/.test(d.risk.signals.reasons.join(' ')));
}

// --- sudo in-scope install uses the same bounded install-auto path ---
{
  const d = decideRiskGate(bidiApproval('sudo apt-get install nginx'), { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x' });
  eq('sudo in-scope install => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('sudo install remains user-facing safe', d.risk.tier, 'safe');
  eq('sudo install autoExecute', d.risk.signals.autoExecute, true);
  eq('sudo install requires executor', d.risk.signals.needsPrivilegedExecution, true);
  check('sudo install reason surfaced', /install-auto/.test(d.risk.signals.reasons.join(' ')));
}

// --- file tool inside project => AUTO_ALLOW with tier attached ---
{
  const editApproval = {
    approvalId: 'claude:req-edit',
    providerRequestId: 'req-edit',
    providerRequestIdString: 'req-edit',
    providerMethod: 'can_use_tool',
    kind: 'permissions',
    params: { tool_name: 'Edit', input: { file_path: '/srv/x/src/a.js' } },
  };
  const d = decideRiskGate(editApproval, { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x' });
  eq('in-project Edit => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('no command', d.command, '');
  eq('risk tier safe', d.risk.tier, 'safe');
  check('Edit is a known file gate', isKnownFileGate(editApproval, 'Edit'));
}

// --- file tool outside project => AUTO_ALLOW, caution tier (v1: no native execute path) ---
{
  const writeOutside = {
    approvalId: 'claude:req-write',
    providerRequestId: 'req-write',
    providerRequestIdString: 'req-write',
    providerMethod: 'can_use_tool',
    kind: 'permissions',
    params: { tool_name: 'Write', input: { file_path: '/home/u/outside.md' } },
  };
  const d = decideRiskGate(writeOutside, { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x', home: '/home/u' });
  eq('out-of-project Write => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('risk tier caution', d.risk.tier, 'caution');
}

// --- danger-tier file tools must use the owner approval path ---
{
  const protectedWrite = {
    approvalId: 'claude:req-protected-write',
    providerRequestId: 'req-protected-write',
    providerRequestIdString: 'req-protected-write',
    providerMethod: 'can_use_tool',
    kind: 'permissions',
    params: { tool_name: 'Write', input: { file_path: '/etc/agentoc/config.json' } },
  };
  const d = decideRiskGate(protectedWrite, {
    riskMode: 'recommended',
    cwd: '/srv/x',
    projectRoot: '/srv/x',
    riskContext: {
      platform: 'linux',
      protectedRoots: ['/etc/agentoc'],
      systemPathRoots: ['/etc', '/var'],
    },
  });
  eq('protected Write => PROMPT', d.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  eq('protected Write risk tier', d.risk.tier, 'danger');
  check('dangerous file prompt reason', /dangerous file gate requires owner approval/.test(d.reason));
}

// --- unknown no-command gates fail closed into the owner approval path ---
{
  const unknownTool = bidiApproval(undefined, { toolName: 'FutureProviderTool' });
  const d = decideRiskGate(unknownTool, { riskMode: 'recommended' });
  eq('unknown Claude tool => PROMPT', d.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  check('unknown tool prompt reason', /unknown non-command gate requires owner approval/.test(d.reason));
  eq('unknown tool still carries classifier tier', d.risk.tier, 'safe');

  const unknownCodexPermission = {
    approvalId: 'item/permissions/requestApproval:43',
    providerRequestId: 43,
    providerRequestIdString: '43',
    providerMethod: 'item/permissions/requestApproval',
    kind: 'permissions',
    params: { permissions: { network: true } },
  };
  const codexPrompt = decideRiskGate(unknownCodexPermission, { riskMode: 'recommended' });
  eq('Codex permissions request => PROMPT', codexPrompt.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  check('Codex permissions prompt reason', /permission gate requires owner approval/.test(codexPrompt.reason));

  const codexPermissionWithSafeCommand = decideRiskGate({
    ...unknownCodexPermission,
    approvalId: 'item/permissions/requestApproval:46',
    providerRequestId: 46,
    providerRequestIdString: '46',
    params: { permissions: { network: true }, command: 'ls -la' },
  }, { riskMode: 'recommended' });
  eq('Codex permission grant with safe command => PROMPT', codexPermissionWithSafeCommand.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  check('permission grant cannot inherit command allow', /permission gate requires owner approval/.test(codexPermissionWithSafeCommand.reason));

  const missingCommand = bidiApproval(undefined, { toolName: 'Bash' });
  const missingCommandDecision = decideRiskGate(missingCommand, { riskMode: 'recommended' });
  eq('Bash without command => PROMPT', missingCommandDecision.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  check('missing command prompt reason', /unknown non-command gate/.test(missingCommandDecision.reason));
}

// --- known Codex file-change protocol shape remains auto-allow ---
{
  const fileChange = {
    approvalId: 'item/fileChange/requestApproval:44',
    providerRequestId: 44,
    providerRequestIdString: '44',
    providerMethod: 'item/fileChange/requestApproval',
    kind: 'file_change',
    params: { changes: [{ path: '/srv/x/src/a.js', kind: { type: 'update' } }] },
  };
  check('Codex file-change method is known', isKnownFileGate(fileChange));
  const d = decideRiskGate(fileChange, { riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x' });
  eq('Codex file-change => AUTO_ALLOW', d.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  const missing = decideRiskGate({ ...fileChange, params: { itemId: 'patch-1' } }, {
    riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x',
  });
  eq('Codex file-change without correlated details => PROMPT', missing.decision, PRIVILEGED_GATE_DECISION.PROMPT);
  const deletion = decideRiskGate({ ...fileChange, params: { changes: [{ path: '/srv/x/src/a.js', kind: { type: 'delete' } }] } }, {
    riskMode: 'recommended', cwd: '/srv/x', projectRoot: '/srv/x',
  });
  eq('Codex file deletion => PROMPT', deletion.decision, PRIVILEGED_GATE_DECISION.PROMPT);
}

// --- sentinel-declared op => ACCUMULATE with wrapper preserved for resolve rewrite ---
{
  const d = decideRiskGate(bidiApproval(SENTINEL('apt-get install nginx', { category: 'install', desc: 'test op' })), {
    riskMode: 'recommended',
    cwd: '/srv/x',
  });
  eq('sentinel => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('op.command is the real command', d.op.command, 'apt-get install nginx');
  eq('op.declaredCategory carried', d.op.declaredCategory, 'install');
  eq('op.description carried', d.op.description, 'test op');
  check('op.wrapperCommand preserves sentinel', d.op.wrapperCommand.startsWith('agentoc-privileged'));
  // Declared in-scope install takes the install-auto early return in the
  // classifier (risk-classifier.mjs): user-facing tier is safe, no human prompt.
  eq('op.risk.tier safe (install-auto)', d.op.risk.tier, 'safe');
  eq('autoExecute signal', d.op.risk.signals.autoExecute, true);
}

// --- sentinel-declared non-install op (delete) => ACCUMULATE at danger tier ---
{
  const d = decideRiskGate(bidiApproval(SENTINEL('rm -rf /var/cache/x', { category: 'delete', desc: 'cleanup' })), {
    riskMode: 'recommended',
    cwd: '/tmp',
  });
  eq('declared delete sentinel => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('op.risk.tier danger (declared non-install)', d.op.risk.tier, 'danger');
  check('declared reason surfaced', /declared privileged op/.test(d.op.risk.signals.reasons.join(' ')));
}

// --- Codex runtime shape parity under the risk gate ---
{
  const d = decideRiskGate(codexApproval('sudo systemctl restart nginx'), { riskMode: 'recommended' });
  eq('codex sudo admin => ACCUMULATE', d.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  eq('codex op.risk.tier danger', d.risk.tier, 'danger');
  const dDanger = decideRiskGate(codexApproval('sudo bash -c "x"'), { riskMode: 'recommended' });
  eq('codex sudo interpreter => ACCUMULATE', dDanger.decision, PRIVILEGED_GATE_DECISION.ACCUMULATE);
  const dSafe = decideRiskGate(codexApproval('cat README.md'), { riskMode: 'recommended' });
  eq('codex ordinary => AUTO_ALLOW', dSafe.decision, PRIVILEGED_GATE_DECISION.AUTO_ALLOW);
  eq('codex risk tier safe', dSafe.risk.tier, 'safe');

  const dUnknown = decideRiskGate({
    approvalId: 'item/permissions/requestApproval:45',
    providerRequestId: 45,
    providerRequestIdString: '45',
    providerMethod: 'item/permissions/requestApproval',
    kind: 'permissions',
    params: {},
  }, { riskMode: 'recommended' });
  eq('codex unknown permission parity => PROMPT', dUnknown.decision, PRIVILEGED_GATE_DECISION.PROMPT);
}

console.log(`privileged-gate: ${passed} checks passed`);
