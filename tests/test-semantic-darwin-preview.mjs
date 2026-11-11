import assert from 'node:assert/strict';
import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { prepareSemanticApproval, selectSemanticApproval } from '../chat/semantic-approval.mjs';
import { allowEligible, isRefusal, STRICTNESS } from '../chat/semantic-operation.mjs';

const binding = { sessionId: 's', runId: 'r', turnId: 't', requestKey: 'q', executionClass: 'host' };
const trustedContext = { platform: 'darwin', cwd: '/workspace', home: '/Users/test', projectRoot: '/workspace' };
const recognized = [
  ['/bin/launchctl kickstart -k gui/501/com.example.agent', 'service.control', 'launchd_service'],
  ['launchctl enable system/com.example.daemon', 'service.control', 'launchd_service'],
  ['/usr/sbin/installer -pkg /tmp/example.pkg -target /', 'package.install', 'package_artifact'],
  ['/opt/homebrew/bin/brew install git', 'package.install', 'package'],
];
const rejectedSyntax = [
  'sudo launchctl kickstart -k system/com.example',
  'launchctl bootout system/com.example',
  'launchctl kickstart -k gui/$UID/com.example',
  'launchctl kickstart -k gui/501/com.example; touch /tmp/pwn',
  'launchctl kickstart -k gui/501/com.example > /tmp/output',
  'launchctl kickstart -k gui/501/../../other',
  '/usr/sbin/installer -pkg /tmp/../evil.pkg -target /',
  '/usr/sbin/installer -pkg /tmp/a.pkg -target / -allowUntrusted',
  'brew install --cask example',
  'PATH=/tmp brew install example',
  'brew install example$(touch /tmp/x)',
  'rm -rf /',
];
for (const [rawCommand, action, kind] of recognized) {
  const compiled = compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
  assert.equal(compiled.operations.length, 1, rawCommand);
  assert.equal(compiled.operations[0].primaryAction, action, rawCommand);
  assert.equal(compiled.operations[0].target.kind, kind, rawCommand);
  assert.equal(compiled.operations[0].target.platform, 'darwin', rawCommand);
  assert.equal(compiled.operations[0].analysis.effectsComplete, false, rawCommand);
  assert.equal(isRefusal(compiled.operations[0]), true, rawCommand);
  assert.equal(allowEligible(compiled.operations[0]), false, rawCommand);
  assert.equal(compiled.strictness, STRICTNESS.DENY, rawCommand);
  const prepared = await prepareSemanticApproval({ request: { ...binding, rawCommand }, trustedContext });
  assert.equal(prepared.projection.decision, 'DENY', rawCommand);
  assert.equal(prepared.capabilityEligible, false, rawCommand);
  assert.throws(() => selectSemanticApproval(prepared.projection, [compiled.operations[0].operationId]),
    (error) => error.code === 'SEMANTIC_APPROVAL_SELECTION_DENIED', rawCommand);
}
for (const rawCommand of rejectedSyntax) {
  const compiled = compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
  assert.equal(compiled.operations[0].primaryAction, 'unknown.host_effect', rawCommand);
  assert.equal(compiled.strictness, STRICTNESS.DENY, rawCommand);
  assert.equal(isRefusal(compiled.operations[0]), true, rawCommand);
}
console.log(`macOS semantic preview: ${recognized.length} recognized and ${rejectedSyntax.length} unrecognized commands remain denied`);
