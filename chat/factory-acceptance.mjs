// Owner acceptance is a human decision about a fixed candidate. It does not
// promote model-reported tests or arbitrary evidence references into facts.
import { getFactoryWorkItem, executeFactoryCommand } from './factory-control.mjs';
import { verifyFactoryCandidate } from './factory-candidates.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { getResultPacket, computeResultPacketDigest } from './result-packets.mjs';
import { factoryError, decode, digest } from './work-graph-store.mjs';
import { verifyFactoryReviewResult } from './factory-review-opinions.mjs';

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
  if(item.kind==='review' && item.contract.accessMode==='read') {
    const reviewBinding=item.bindings.find(entry=>entry.contractRevision===item.contractRevision && entry.executionEpoch===item.executionEpoch && entry.bindingGeneration===item.bindingGeneration && entry.status==='review_result');
    if(!reviewBinding?.details?.opinionId || reviewBinding.details.digest!==item.candidateDigest) invalid('Verified review result is unavailable');
    const evidence={kind:'owner_review_result',opinionId:reviewBinding.details.opinionId,candidateDigest:item.candidateDigest,rationale};
    const command={commandId,idempotencyKey,organizationId,targetId:workItemId,type:'DecideAcceptance',expectedVersion:input.expectedVersion,payload:{criterionId,decision:input.decision,contractRevision:item.contractRevision,candidateDigest:item.candidateDigest,gateGeneration:item.gateGeneration,evidence:[evidence]}};
    return executeFactoryCommand(command,actor,{verifyEvidence({db,item:current,actor:verifiedActor}) {
      if(verifiedActor.kind!=='user'||verifiedActor.role!=='owner'||current.id!==item.id||current.contractRevision!==item.contractRevision
          || current.executionEpoch!==item.executionEpoch||current.bindingGeneration!==item.bindingGeneration||current.candidateDigest!==item.candidateDigest
          || !current.contract.acceptanceCriteria.some(entry=>entry.id===criterionId&&entry.method==='manual')) return false;
      const raw=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(reviewBinding.id,current.id);
      if(!raw || raw.status!=='review_result' || raw.run_id!==reviewBinding.runId || raw.attempt_id!==reviewBinding.attemptId) return false;
      return verifyFactoryReviewResult(db,current,reviewBinding,reviewBinding.details);
    }});
  }
  const remoteBinding=item.bindings.find(entry=>entry.contractRevision===item.contractRevision && entry.executionEpoch===item.executionEpoch && entry.bindingGeneration===item.bindingGeneration && entry.status==='remote_candidate');
  if(remoteBinding) {
    const candidate=item.candidates.find(entry=>entry.contractRevision===item.contractRevision && entry.executionEpoch===item.executionEpoch && entry.digest===item.candidateDigest);
    const candidateId=candidate?.details?.candidateId;
    if(!candidateId) invalid('Remote candidate evidence is unavailable');
    const {factoryRead}=await import('./work-graph-store.mjs');
    const saved=await factoryRead(db=>db.prepare('SELECT envelope_json FROM factory_remote_evidence WHERE id=? AND work_item_id=?').get(candidateId,item.id));
    if(!saved) invalid('Remote candidate evidence is unavailable');
    const envelope=JSON.parse(saved.envelope_json), {getOrganization}=await import('./organization-store.mjs'), {getSession}=await import('./session-manager.mjs');
    const org=await getOrganization(organizationId), root=org?.rootSessionId&&await getSession(org.rootSessionId);
    const {inspectSourceRemoteBaseline}=await import('./factory-remote-admission.mjs');
    const baseline=await inspectSourceRemoteBaseline(root?.folder,item.contract.allowedPaths);
    if(baseline.baselineDigest!==envelope.baselineManifestDigest) invalid('Source baseline changed','FACTORY_CONFLICT');
    const evidence={kind:'owner_remote_review',candidateId,candidateDigest:item.candidateDigest,operationId:envelope.operationId,runId:envelope.runId,rationale};
    const command={commandId,idempotencyKey,organizationId,targetId:workItemId,type:'DecideAcceptance',expectedVersion:input.expectedVersion,payload:{criterionId,decision:input.decision,contractRevision:item.contractRevision,candidateDigest:item.candidateDigest,gateGeneration:item.gateGeneration,evidence:[evidence]}};
    return executeFactoryCommand(command,actor,{verifyEvidence({db,item:current,actor:verifiedActor}) {
      if(verifiedActor.kind!=='user'||verifiedActor.role!=='owner'||current.id!==item.id||current.contractRevision!==item.contractRevision||current.executionEpoch!==item.executionEpoch||current.bindingGeneration!==item.bindingGeneration||current.candidateDigest!==item.candidateDigest||!current.contract.acceptanceCriteria.some(entry=>entry.id===criterionId&&entry.method==='manual')) return false;
      const raw=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(remoteBinding.id,current.id);
      return !!raw && raw.status==='remote_candidate' && !!verifyFactoryCandidate({db,item:current,binding:{...remoteBinding,status:raw.status},payload:{candidateId,digest:current.candidateDigest}});
    }});
  }
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
  return executeFactoryCommand(command,actor,{verifyEvidence({db,item:current,decision}) { const row=db.prepare('SELECT * FROM factory_check_operations WHERE id=? AND organization_id=?').get(input.checkId,input.organizationId); if(!row||row.state!=='passed'||row.work_item_id!==current.id||row.candidate_digest!==current.candidateDigest||row.criterion_id!==decision.criterionId||row.action_id!==criterion.actionId||!row.evidence_json) return false; let stored; try { stored=JSON.parse(row.evidence_json); } catch { return false; } const org=db.prepare('SELECT policy_json FROM organizations WHERE id=?').get(input.organizationId), policy=decode(org?.policy_json,{}), action=Array.isArray(policy.factoryChecks)?policy.factoryChecks.find(entry=>entry.id===row.action_id):null; const validation=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(stored.validationWorkItemId,input.organizationId); const binding=validation&&db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND run_id=?').get(validation.id,stored.validationContractRevision,stored.validationExecutionEpoch,stored.validationBindingGeneration,stored.runId); const attempt=binding&&db.prepare('SELECT state,result_packet_id FROM collaboration_attempts WHERE id=? AND task_id=? AND run_id=?').get(binding.attempt_id,binding.task_id,stored.runId); const dep=validation&&db.prepare("SELECT 1 FROM factory_dependencies WHERE predecessor_id=? AND successor_id=? AND milestone='candidate_ready' AND candidate_digest=?").get(current.id,validation.id,current.candidateDigest); const workspace=db.prepare("SELECT 1 FROM factory_validation_workspaces WHERE id=? AND validation_work_item_id=? AND run_id=? AND candidate_digest=? AND state='sealed' AND provenance='candidate_materialized'").get(stored.workspaceId,stored.validationWorkItemId,stored.runId,current.candidateDigest); return !!action&&digest(action)===row.action_digest&&stored.actionDigest===row.action_digest&&!!validation&&validation.control_state==='none'&&validation.contract_revision===stored.validationContractRevision&&validation.execution_epoch===stored.validationExecutionEpoch&&validation.binding_generation===stored.validationBindingGeneration&&!!binding&&['running','candidate','review_result'].includes(binding.status)&&attempt?.state==='succeeded'&&attempt.result_packet_id===stored.packetId&&!!stored.packetDigest&&!!dep&&!!workspace&&stored.eventDigest===e.eventDigest&&stored.runId===e.runId&&stored.exitCode===0&&stored.workspaceId===e.workspaceId; }});
}
