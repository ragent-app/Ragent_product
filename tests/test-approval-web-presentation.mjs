import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../static/chat/approval-explanation.js', import.meta.url), 'utf8');
const messages = { 'decisionSheet.operation.delete':'delete', 'decisionSheet.operation.may':'May {action}',
  'decisionSheet.operationRisk.partial':'Review conditional command', 'decisionSheet.operationRisk.delete':'Deletion may be irreversible',
  'decisionSheet.operationRisk.provider_conflict':'Description conflicts', 'decisionSheet.operation.git_force_push':'Force push', 'decisionSheet.operationRisk.force_push':'History may change', 'decisionSheet.operationSafer.force_push':'Consider --force-with-lease' };
const tr = (key, vars = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
const root = {};
vm.runInNewContext(source, { window: root });
const present = (value) => root.ragentApprovalExplanation(value, tr);
const original = { operation:'delete', targets:['/tmp/example'], conditional:true, partial:true,
  riskCode:'composite_unanalyzed', summary:'包含 3 步操作', reason:'old reason', providerConflict:true };
const shown = present(original);
assert.equal(shown.summary, 'May delete: /tmp/example');
assert.match(shown.reason, /Deletion may be irreversible/);
assert.match(shown.reason, /Review conditional command/);
assert.match(shown.reason, /Description conflicts/);
assert.equal(shown.saferAlternative, '');
assert.equal(present({ summary:'legacy' }).summary, 'legacy');
assert.match(present({ operation:'git_force_push', riskCode:'force_push' }).saferAlternative, /force-with-lease/);
assert.equal(present({ operation:'future_operation', riskCode:'unknown_command' }).operation, undefined);
assert.equal(present({ summary:'包含 3 步操作' }).summary, '');
const legacyComposite = present({summary:'包含 3 步操作', reason:'命令串联了多个步骤，部分行为无法静态确认', saferAlternative:'拆成单条命令逐步确认后再执行'});
assert.equal(legacyComposite.reason, 'Review conditional command');
assert.equal(legacyComposite.saferAlternative, '');
assert.equal(present(null), null);
console.log('approval web presentation: passed');
