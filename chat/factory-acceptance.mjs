// Owner acceptance is a human decision about a fixed candidate. It does not
// promote model-reported tests or arbitrary evidence references into facts.
import { getFactoryWorkItem, executeFactoryCommand } from './factory-control.mjs';
import { verifyFactoryCandidate } from './factory-candidates.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { getResultPacket, computeResultPacketDigest } from './result-packets.mjs';
import { factoryError } from './work-graph-store.mjs';

function invalid(message, code='FACTORY_EVIDENCE_UNVERIFIED', statusCode=409) { throw factoryError(code,message,statusCode); }
function text(value,name) { if (typeof value!=='string'||!value.trim()||value.length>4096) invalid(`${name} is required`,'FACTORY_INVALID',400); return value.trim(); }

export async function decideFactoryManualAcceptance(input,actor) {
  if (actor?.kind!=='user'||actor.role!=='owner') invalid('Owner authorization required','FACTORY_FORBIDDEN',403);
  const organizationId=text(input?.organizationId,'organizationId'), workItemId=text(input?.workItemId,'workItemId');
  const criterionId=text(input?.criterionId,'criterionId'), rationale=text(input?.rationale,'rationale');
  const commandId=text(input?.commandId,'commandId'), idempotencyKey=text(input?.idempotencyKey,'idempotencyKey');
  if (!['passed','failed'].includes(input?.decision)) invalid('Invalid decision','FACTORY_INVALID',400);
  const item=(await getFactoryWorkItem(organizationId,workItemId,actor)).item;
  const criterion=item.contract?.acceptanceCriteria?.find(entry=>entry.id===criterionId);
  if (!criterion || criterion.method!=='manual') invalid('Criterion is not explicitly designated for manual acceptance');
  if (item.contractRevision!==input.contractRevision || item.gateGeneration!==input.gateGeneration || item.candidateDigest!==input.candidateDigest) invalid('Candidate or criterion generation changed','FACTORY_CONFLICT');
  const binding=item.bindings.find(entry=>entry.contractRevision===item.contractRevision && entry.executionEpoch===item.executionEpoch && entry.bindingGeneration===item.bindingGeneration && entry.status==='candidate');
  const candidate=item.candidates.find(entry=>entry.contractRevision===item.contractRevision && entry.executionEpoch===item.executionEpoch && entry.bindingGeneration===item.bindingGeneration && entry.digest===item.candidateDigest);
  const candidateId=candidate?.details?.candidateId, packetId=candidate?.details?.resultPacketId;
  if (!binding?.runId || !binding.attemptId || !candidateId || !packetId) invalid('Candidate execution evidence is incomplete');
  const [run,packet]=await Promise.all([getRunAcceptanceEvidence(binding.runId),getResultPacket(packetId)]);
  if (!run || run.id!==binding.runId || run.state!=='completed' || !packet || packet.kind!=='execution' || packet.state!=='succeeded'
      || packet.packetId!==packetId || packet.digest!==computeResultPacketDigest(packet) || packet.producer?.runId!==binding.runId
      || packet.producer?.taskId!==binding.taskId || packet.producer?.attemptId!==binding.attemptId || packet.producer?.projectId!==item.projectId) {
    invalid('Canonical Run or ResultPacket does not match the frozen execution');
  }
  const evidence={kind:'owner_manual_review',criterionId,candidateId,candidateDigest:item.candidateDigest,runId:binding.runId,packetId,packetDigest:packet.digest,rationale};
  const command={commandId,idempotencyKey,organizationId,targetId:workItemId,type:'DecideAcceptance',expectedVersion:input.expectedVersion,payload:{criterionId,decision:input.decision,contractRevision:item.contractRevision,candidateDigest:item.candidateDigest,gateGeneration:item.gateGeneration,evidence:[evidence]}};
  return executeFactoryCommand(command,actor,{verifyEvidence({db,item:current,actor:verifiedActor,decision}) {
    if (verifiedActor.kind!=='user'||verifiedActor.role!=='owner'||current.id!==item.id||current.contractRevision!==item.contractRevision
        || current.executionEpoch!==item.executionEpoch||current.bindingGeneration!==item.bindingGeneration||current.candidateDigest!==item.candidateDigest
        || decision.criterionId!==criterionId||decision.gateGeneration!==item.gateGeneration
        || !current.contract.acceptanceCriteria.some(entry=>entry.id===criterionId&&entry.method==='manual')) return false;
    const raw=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(binding.id,current.id);
    if (!raw||raw.status!=='candidate'||raw.run_id!==binding.runId||raw.attempt_id!==binding.attemptId||raw.task_id!==binding.taskId||raw.collaboration_id!==binding.collaborationId) return false;
    const verified=verifyFactoryCandidate({db,binding:{...binding,status:raw.status},item:current,payload:{candidateId,digest:current.candidateDigest}});
    return Boolean(verified && verified.resultPacketId===packetId && verified.runId===binding.runId);
  }});
}

// A registered check can satisfy only the criterion and candidate it recorded.
export async function decideFactoryCheckAcceptance(input,actor) {
  if (actor?.kind!=='user'||actor.role!=='owner') invalid('Owner authorization required','FACTORY_FORBIDDEN',403);
  const { reconcileFactoryCheck }=await import('./factory-checks.mjs');
  const result=await reconcileFactoryCheck({organizationId:input.organizationId,checkId:input.checkId},actor);
  if(result.state!=='passed'||!result.evidence) invalid('Registered check has not passed with verifiable evidence');
  const e=result.evidence, item=(await getFactoryWorkItem(input.organizationId,input.workItemId,actor)).item;
  const criterion=item.contract?.acceptanceCriteria?.find(entry=>entry.id===input.criterionId);
  if(!criterion||criterion.method!=='check'||criterion.actionId!==e.actionId||e.criterionId!==input.criterionId||e.candidateDigest!==item.candidateDigest||item.contractRevision!==input.contractRevision||item.gateGeneration!==input.gateGeneration||item.candidateDigest!==input.candidateDigest) invalid('Check is not for the current criterion and candidate');
  const command={commandId:text(input.commandId,'commandId'),idempotencyKey:text(input.idempotencyKey,'idempotencyKey'),organizationId:input.organizationId,targetId:input.workItemId,type:'DecideAcceptance',expectedVersion:input.expectedVersion,payload:{criterionId:input.criterionId,decision:'passed',contractRevision:item.contractRevision,candidateDigest:item.candidateDigest,gateGeneration:item.gateGeneration,evidence:[e]}};
  return executeFactoryCommand(command,actor,{verifyEvidence({db,item:current,decision}) { const row=db.prepare('SELECT * FROM factory_check_operations WHERE id=? AND organization_id=?').get(input.checkId,input.organizationId); if(!row||row.state!=='passed'||row.work_item_id!==current.id||row.candidate_digest!==current.candidateDigest||row.criterion_id!==decision.criterionId||row.action_id!==criterion.actionId||!row.evidence_json) return false; let stored; try { stored=JSON.parse(row.evidence_json); } catch { return false; } return stored.eventDigest===e.eventDigest&&stored.runId===e.runId&&stored.exitCode===0&&stored.workspaceId===e.workspaceId; }});
}
