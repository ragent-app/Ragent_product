#!/usr/bin/env node
import assert from 'assert/strict';
import { parseCommandFacts } from '../chat/command-parser.mjs';
import { classifyRisk } from '../chat/risk-classifier.mjs';

import {
  codeForReason,
  isKnownReasonCode,
  normalizeReasonMessages,
  platformFor,
  RISK_POLICY_VERSION,
  RISK_REASON_CODES,
  RISK_REASON_MESSAGES,
  RISK_TARGET_SCOPE,
  classifyRiskTargetScope,
  systemPathRootsForPlatform,
} from '../chat/risk-policy.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

eq('policy version pinned to risk-v3', RISK_POLICY_VERSION, 'risk-v3');

// 每个 code 都有默认文案（展示兜底完整）。
for (const [key, code] of Object.entries(RISK_REASON_CODES)) {
  check(`message for ${key}`, typeof RISK_REASON_MESSAGES[code] === 'string' && RISK_REASON_MESSAGES[code].length > 0);
}

// 历史文案 → code 映射（分类器旧输出仍能归一化）。
eq('rmdir', codeForReason('remove empty directory'), RISK_REASON_CODES.DELETE_RMDIR);
eq('system delete param', codeForReason('delete on system path (/etc/evil)'), RISK_REASON_CODES.DELETE_SYSTEM_PATH);
eq('erase param', codeForReason('dropdb (irreversible data destruction)'), RISK_REASON_CODES.DESTRUCTIVE_ERASE);
eq('escalation', codeForReason('sudo / privilege escalation'), RISK_REASON_CODES.PRIVILEGE_ESCALATION);
eq('force push', codeForReason('git push --force/--delete'), RISK_REASON_CODES.GIT_PUSH_FORCE);
eq('composite', codeForReason('composite command (partly analyzed)'), RISK_REASON_CODES.COMPOSITE_UNANALYZED);
eq('sensitive read', codeForReason('read sensitive system file'), RISK_REASON_CODES.SENSITIVE_SYSTEM_READ);
eq('ordinary', codeForReason('ordinary command'), RISK_REASON_CODES.ORDINARY_COMMAND);
for (const brand of ['AgentoC', 'Ragent']) {
  eq(`${brand} protected write`, codeForReason(`targets ${brand} control-plane path`), RISK_REASON_CODES.PROTECTED_CONTROL_PATH);
  eq(`${brand} protected read`, codeForReason(`reads ${brand} control-plane path`), RISK_REASON_CODES.PROTECTED_CONTROL_READ);
}
eq('new text falls back to unclassified', codeForReason('brand new wording'), RISK_REASON_CODES.UNCLASSIFIED);
eq('empty falls back to unclassified', codeForReason('   '), RISK_REASON_CODES.UNCLASSIFIED);

const normalized = normalizeReasonMessages(['network egress', 'network egress', 'git remote operation']);
eq('dedupe keeps first', normalized.length, 2);
eq('first normalized code', normalized[0].code, RISK_REASON_CODES.NETWORK_EGRESS);
eq('second normalized code', normalized[1].code, RISK_REASON_CODES.GIT_REMOTE_OPERATION);

check('known code recognized', isKnownReasonCode(RISK_REASON_CODES.NETWORK_EGRESS));
check('unknown code rejected', !isKnownReasonCode('nope'));

eq('platform bash', platformFor('ls -la'), 'linux-bash');
eq('platform powershell prefix', platformFor('powershell -Command Get-Process'), 'powershell');
eq('platform none for empty', platformFor('   '), 'none');

// Scope precedence is security-significant: protected control roots win over
// a trusted workspace even when the roots overlap; system is only the fallback
// after those two decisions.
const linuxScope = {
  platform: 'linux',
  trustedWorkspaceRoot: '/var/lib/agentoc/workspace',
  protectedRoots: ['/var/lib/agentoc/workspace/.agentoc-control'],
  systemPathRoots: ['/etc', '/var'],
};
eq('protected outranks trusted workspace', classifyRiskTargetScope(
  '/var/lib/agentoc/workspace/.agentoc-control/events/1.json',
  { riskContext: linuxScope },
), RISK_TARGET_SCOPE.PROTECTED_CONTROL);
eq('trusted workspace outranks generic system root', classifyRiskTargetScope(
  '/var/lib/agentoc/workspace/src/index.js',
  { riskContext: linuxScope },
), RISK_TARGET_SCOPE.TRUSTED_WORKSPACE);
eq('system root remains system outside workspace', classifyRiskTargetScope(
  '/var/log/agentoc.log',
  { riskContext: linuxScope },
), RISK_TARGET_SCOPE.SYSTEM);
eq('unbound path remains outside workspace', classifyRiskTargetScope(
  '/home/example/other/file.txt',
  { riskContext: linuxScope },
), RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE);

const winScope = {
  platform: 'win32',
  trustedWorkspaceRoot: 'C:\\work\\project',
  protectedRoots: ['C:\\work\\project\\.agentoc-control'],
  systemPathRoots: ['C:\\Windows', 'C:\\Program Files'],
};
eq('Windows protected precedence', classifyRiskTargetScope(
  'C:\\work\\project\\.agentoc-control\\runs',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.PROTECTED_CONTROL);
eq('Windows trusted workspace', classifyRiskTargetScope(
  'C:\\work\\project\\src\\main.js',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.TRUSTED_WORKSPACE);
eq('Windows protected descendant with two leading dots', classifyRiskTargetScope(
  'C:\\work\\project\\.agentoc-control\\..metadata\\secret',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.PROTECTED_CONTROL);
eq('Windows workspace descendant with two leading dots', classifyRiskTargetScope(
  'C:\\work\\project\\..notes\\file.txt',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.TRUSTED_WORKSPACE);
eq('Windows sibling with common prefix remains outside', classifyRiskTargetScope(
  'C:\\work\\project-other\\file.txt',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE);
const dotContext = { ...winScope, cwd: 'C:\\work\\project' };
eq('protected Edit remains dangerous below two-dot directory', classifyRisk({
  toolName: 'Edit', toolInput: { file_path: 'C:\\work\\project\\.agentoc-control\\..metadata\\secret' },
  cwd: dotContext.cwd, projectRoot: dotContext.trustedWorkspaceRoot, riskContext: dotContext,
}).tier, 'danger');
check('command parser recognizes two-dot workspace directory', parseCommandFacts(
  'mkdir C:\\work\\project\\..notes',
  { cwd: dotContext.cwd, projectRoot: dotContext.trustedWorkspaceRoot, riskContext: dotContext },
).targetScopes.includes('inside-project'));
eq('POSIX protected descendant with two leading dots', classifyRiskTargetScope(
  '/var/lib/agentoc/workspace/.agentoc-control/..metadata/secret',
  { riskContext: linuxScope },
), RISK_TARGET_SCOPE.PROTECTED_CONTROL);
eq('Windows system root', classifyRiskTargetScope(
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.SYSTEM);
eq('Windows outside workspace', classifyRiskTargetScope(
  'C:\\Users\\andy\\Desktop\\other.txt',
  { riskContext: winScope },
), RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE);
check('Windows platform roots include host-provided roots',
  systemPathRootsForPlatform('win32', { SystemRoot: 'D:\\Windows' }).includes('D:\\Windows'));
assert.ok(systemPathRootsForPlatform('win32', { SystemRoot: 'D:\\Windows', ProgramFiles: 'E:\\Apps (x86)', ProgramW6432: 'E:\\Apps' }).includes('E:\\Apps'));

console.log(`risk-policy: ${passed} checks passed`);
