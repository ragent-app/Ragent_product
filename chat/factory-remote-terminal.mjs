// Pure verification of a persisted remote terminal receipt; no application initialization.
import { createHash, createPublicKey, verify } from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');

// Called inside the source transition transaction. A signed request receipt is
// not terminal evidence; both canonical Run and Attempt must be terminal.
export function verifyRemoteTerminalReceipt(db,item,binding,sourceInstanceId) {
  try {
    const op=db.prepare('SELECT * FROM remote_factory_source_operations WHERE source_factory_binding_id=?').get(binding.id);
    const saved=op&&JSON.parse(op.request_json), signed=op&&JSON.parse(op.receipt_json||'null'), receipt=signed?.receipt, target=receipt?.target, execution=target?.execution;
    if(!saved?.binding||!saved?.canonical||!receipt||!target||signed.targetInstanceId!==saved.binding.targetInstanceId
        || receipt.bindingId!==saved.binding.targetBindingId||receipt.bindingVersion!==saved.binding.targetBindingVersion
        || receipt.operationId!==saved.canonical.operationId||receipt.sourceInstanceId!==sourceInstanceId
        || receipt.sourceFactoryBindingId!==binding.id||receipt.contractRevision!==item.contract_revision||receipt.executionEpoch!==item.execution_epoch
        || binding.work_item_id!==item.id||binding.contract_revision!==item.contract_revision||binding.execution_epoch!==item.execution_epoch||binding.binding_generation!==item.binding_generation
        || saved.canonical.sourceFactoryBindingId!==binding.id || !target.workItemId) return null;
    const message=`agentoc-remote-receipt-v1:${sha(JSON.stringify({targetInstanceId:signed.targetInstanceId,receipt}))}`;
    if(!verify(null,Buffer.from(message),createPublicKey(saved.binding.targetPublicKey),Buffer.from(signed.signature,'base64url'))) return null;
    if(!execution||!target.attemptId||!target.runId||execution.attemptRunId!==target.runId
        || !['completed','failed','cancelled'].includes(execution.runState)||!['succeeded','failed','cancelled'].includes(execution.attemptState)
        || execution.failureKind==='unknown_outcome'||(execution.attemptState==='succeeded' && execution.runState!=='completed')) return null;
    return {operationId:receipt.operationId,workItemId:target.workItemId,attemptId:target.attemptId,runId:target.runId,
      runState:execution.runState,attemptState:execution.attemptState,targetState:target.state,signed};
  } catch {return null;}
}
