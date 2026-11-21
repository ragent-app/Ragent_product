import { read, transaction, receipt, activity, newId, now, digest, error } from './responsibility-store.mjs';
import { getResponsibility } from './responsibility-service.mjs';
import { itemRow } from './work-graph-store.mjs';
import { getResultPacket } from './result-packets.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { verifyFactoryReportEvidence } from './factory-report-evidence.mjs';
import { compileFactoryPlanSteps } from './factory-workflow.mjs';
import { admitResponsibilityPlan } from './factory-responsibility-admission.mjs';
import { isResponsibilityTriggerObservationCurrent } from './responsibility-trigger-bridge.mjs';

function fail(message) { throw error(message,409,'RESPONSIBILITY_PLAN_CONFLICT'); }
function retryableItemError(e) { return (Number.isInteger(e?.statusCode)&&e.statusCode>=400&&e.statusCode<500)||e?.statusCode===503||['ENOENT','EACCES','EPERM','ETIMEDOUT','EBUSY','ECONNRESET'].includes(e?.code); }
function matchingCatalogEntry(step,catalog) {
  const matches=catalog.filter(entry=>entry.entryId===step.entryId);
  if(matches.length!==1) return null;
  const entry=matches[0],{entryDigest,...content}=entry;
  if(typeof entry.entryId!=='string'||!entry.entryId||typeof entryDigest!=='string'||entryDigest!==step.entryDigest||digest(content)!==entryDigest||entry.templateId!==step.templateId||entry.templateVersion!==step.templateVersion||entry.templateDigest!==step.templateDigest||digest(entry.nodeBindings)!==digest(step.nodeBindings)) return null;
  return entry;
}
function validatePlan(plan,policy) {
  if(!plan || plan.schemaVersion!==1 || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length>20 || Object.keys(plan).sort().join(',')!=='schemaVersion,steps' || !Array.isArray(policy.planCatalog)) fail('Invalid plan or catalog');
  const ids=new Set(), catalog=policy.planCatalog, selected=[];
  for(const step of plan.steps) {
    if(!step || Object.keys(step).sort().join(',')!=='dependsOn,entryDigest,entryId,id,nodeBindings,templateDigest,templateId,templateVersion' || typeof step.id!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(step.id) || ids.has(step.id) || !Array.isArray(step.dependsOn) || step.dependsOn.some(id=>typeof id!=='string')) fail('Invalid plan step');
    ids.add(step.id);
    const entry=matchingCatalogEntry(step,catalog);
    if(!entry || !Number.isSafeInteger(entry.maxAttempts) || entry.maxAttempts<1 || !Number.isFinite(entry.maxCost) || entry.maxCost<=0) fail('Plan step is outside the authorized catalog');
    selected.push(entry);
  }
  const done=new Set(); while(done.size<plan.steps.length) {const before=done.size;for(const step of plan.steps) if(!done.has(step.id) && step.dependsOn.every(id=>ids.has(id)&&done.has(id))) done.add(step.id);if(done.size===before) fail('Plan dependencies are invalid or cyclic');}
  if(!Number.isSafeInteger(policy.planExecutionMaxAttempts) || policy.planExecutionMaxAttempts<1 || !Number.isFinite(policy.planExecutionMaxCost) || policy.planExecutionMaxCost<=0 || selected.reduce((n,c)=>n+c.maxAttempts,0)>policy.planExecutionMaxAttempts || selected.reduce((n,c)=>n+c.maxCost,0)>policy.planExecutionMaxCost) fail('Plan exceeds aggregate execution bounds');
  return plan;
}
function automaticAdmissionAllowed(plan,policy) {
  if(policy.planApproval!=='within_policy'||policy.planAutoAdmissionConfirmed!==true) return false;
  // No uncontrolled tools or external actions may be inferred from a model's proposal.
  return plan.steps.every(step=>{const entry=matchingCatalogEntry(step,policy.planCatalog);return entry?.capability==='project-report' && entry.templateId==='ragent-project-report' && entry.templateVersion===1 && entry.autoApproval===true && entry.requiresHumanApproval===false && (entry.resource?.networkPolicy==='deny' || (entry.resource?.networkPolicy==='inherit_existing_permissions' && policy.networkPermissionConfirmed===true));});
}

// Synchronous transaction-only verifier used again before admission and dispatch.
export function verifyResponsibilityPlanAuthority(db,{planId,planDigest,approvalId,organizationId,projectId}) {
  const plan=db.prepare('SELECT * FROM responsibility_plans WHERE id=?').get(planId), approval=db.prepare('SELECT * FROM responsibility_plan_approvals WHERE id=? AND plan_id=?').get(approvalId,planId);
  const r=plan&&db.prepare('SELECT * FROM responsibilities WHERE id=?').get(plan.responsibility_id),wake=plan&&db.prepare('SELECT * FROM responsibility_wakes WHERE id=? AND responsibility_id=?').get(plan.wake_id,plan.responsibility_id);
  const policyRow=r&&db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,r.policy_revision);
  if(!r || r.lifecycle!=='active'||r.organization_id!==organizationId||r.project_id!==projectId||r.revision!==plan.responsibility_revision||r.policy_revision!==plan.policy_revision||!wake||wake.responsibility_revision!==r.revision||wake.policy_revision!==r.policy_revision||!approval||approval.responsibility_row_version!==r.row_version||approval.proposal_digest!==plan.proposal_digest||planDigest!==plan.proposal_digest||!policyRow||!Number.isFinite(Date.parse(policyRow.valid_until))||Date.parse(policyRow.valid_until)<=Date.now()) fail('Plan authority changed');
  const policy=JSON.parse(policyRow.policy_json), proposal=JSON.parse(plan.proposal_json);
  if(approval.actor_id!==r.owner_principal_id && !(approval.actor_id==='responsibility-policy-auto' && automaticAdmissionAllowed(proposal,policy))) fail('Plan approval authority changed');
  if(digest(proposal)!==plan.proposal_digest||digest(policy.planCatalog)!==plan.catalog_digest) fail('Plan or catalog digest changed');
  for(const entry of policy.planCatalog||[]) {if(entry.capability==='project-code') {const repo=db.prepare('SELECT * FROM responsibility_repository_facts WHERE id=?').get(entry.repositoryFactId),baseline=db.prepare('SELECT * FROM responsibility_code_baselines WHERE id=?').get(entry.codeBaselineId);if(!repo||repo.project_id!==projectId||repo.repository!==entry.repository||!baseline||baseline.organization_id!==organizationId||baseline.project_id!==projectId||baseline.repository_fact_id!==repo.id||baseline.branch!==entry.targetBranch) fail('Authorized code baseline changed');} else if(entry.capability!=='project-report') fail('Unsupported catalog capability');}
  const observation=db.prepare('SELECT * FROM responsibility_observations WHERE wake_id=?').get(plan.wake_id),fact=db.prepare('SELECT * FROM responsibility_project_facts WHERE id=?').get(plan.project_fact_id);
  if(!observation||observation.payload_digest!==plan.observation_digest||digest(JSON.parse(observation.payload_json))!==observation.payload_digest||!isResponsibilityTriggerObservationCurrent(db,r,observation)||!fact||fact.organization_id!==organizationId||fact.project_id!==projectId) fail('Plan observation or project fact changed');
  validatePlan(proposal,policy);
  return {planId,approvalId,responsibilityId:r.id,wakeId:wake.id,responsibilityRevision:r.revision,policyRevision:r.policy_revision,organizationId,projectId,objective:r.objective,policy,plan:proposal,catalogDigest:plan.catalog_digest,planDigest:plan.proposal_digest,observationId:wake.id,observationDigest:observation.payload_digest,projectFactId:fact.id};
}

export async function listResponsibilityPlans(id,actor) {
  await getResponsibility(id,actor);
  return read(db=>{
    const hasExecutions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
    return {schemaVersion:1,plans:db.prepare('SELECT * FROM responsibility_plans WHERE responsibility_id=? ORDER BY created_at DESC LIMIT 100').all(id).map(p=>{
      const approval=db.prepare('SELECT * FROM responsibility_plan_approvals WHERE plan_id=? ORDER BY created_at DESC LIMIT 1').get(p.id),policy=db.prepare('SELECT policy_json FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(id,p.policy_revision);
      const executions=hasExecutions?db.prepare('SELECT step_id,goal_id,workflow_instance_id FROM responsibility_plan_executions WHERE plan_id=? ORDER BY rowid').all(p.id):[];
      const dispatchRetry=db.prepare('SELECT reason,next_retry_at FROM responsibility_plan_dispatch_retry WHERE plan_id=?').get(p.id);
      return {id:p.id,wakeId:p.wake_id,state:executions.length?'admitted':approval?'approved':'pending_review',approvalId:approval?.id||null,approvedBy:approval?.actor_id||null,approvedAt:approval?.created_at||null,admitted:executions.length>0,executions:executions.map(e=>({stepId:e.step_id,goalId:e.goal_id,workflowInstanceId:e.workflow_instance_id})),dispatchBlockedReason:dispatchRetry?.reason||null,dispatchNextRetryAt:dispatchRetry?.next_retry_at||null,proposalDigest:p.proposal_digest,responsibilityRevision:p.responsibility_revision,policyRevision:p.policy_revision,createdAt:p.created_at,proposal:JSON.parse(p.proposal_json),catalog:policy?JSON.parse(policy.policy_json).planCatalog:null};
    })};
  });
}
export async function approveResponsibilityPlan(id,planId,input,actor) {
  await getResponsibility(id,actor);
  if(input?.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||!Number.isSafeInteger(input.expectedVersion)||typeof input.proposalDigest!=='string') fail('Explicit confirmation, version, digest and idempotency key required');
  return transaction(db=>receipt(db,actor.principalId,'approve_plan',planId,input.idempotencyKey,input,()=>{const r=db.prepare('SELECT * FROM responsibilities WHERE id=? AND owner_principal_id=?').get(id,actor.principalId),p=db.prepare('SELECT * FROM responsibility_plans WHERE id=? AND responsibility_id=?').get(planId,id);if(!r||!p||r.lifecycle!=='active'||r.row_version!==input.expectedVersion||r.revision!==p.responsibility_revision||r.policy_revision!==p.policy_revision||p.proposal_digest!==input.proposalDigest) fail('Plan or responsibility changed');if(db.prepare('SELECT 1 FROM responsibility_plan_approvals WHERE plan_id=?').get(planId)) fail('Plan was already approved');const policy=db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(id,r.policy_revision);if(!policy||Date.parse(policy.valid_until)<=Date.now()) fail('Policy expired');validatePlan(JSON.parse(p.proposal_json),JSON.parse(policy.policy_json));if(digest(JSON.parse(p.proposal_json))!==p.proposal_digest||digest(JSON.parse(policy.policy_json).planCatalog)!==p.catalog_digest) fail('Plan or catalog changed');const approvalId=newId('plan_approval');db.prepare('INSERT INTO responsibility_plan_approvals VALUES(?,?,?,?,?,?,?)').run(approvalId,planId,actor.principalId,p.proposal_digest,r.row_version,input.idempotencyKey,now());activity(db,id,'plan_approved',{planId,approvalId,proposalDigest:p.proposal_digest});return {schemaVersion:1,planId,approvalId,proposalDigest:p.proposal_digest,state:'approved'};}));
}

// Only immutable packets belonging to a verified planning Work Item can become proposals.
export async function collectResponsibilityPlans() {
  const candidates=await read(db=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_workflow_instances'").get()) return [];
    return db.prepare(`SELECT l.responsibility_id,l.wake_id,l.goal_id,w.mapping_json,d.proposal_json FROM responsibility_work_links l
      JOIN responsibility_decisions d ON d.id=l.decision_id JOIN factory_workflow_instances w ON w.id=l.workflow_instance_id
      JOIN responsibilities r ON r.id=l.responsibility_id LEFT JOIN responsibility_planning_retry retry ON retry.wake_id=l.wake_id WHERE r.lifecycle='active' AND r.revision=l.responsibility_revision AND r.policy_revision=l.policy_revision
      AND (retry.next_retry_at IS NULL OR retry.next_retry_at<=?) AND json_extract(d.proposal_json,'$.providerId')='generic-planner' AND EXISTS(SELECT 1 FROM factory_work_items wi JOIN factory_execution_bindings b ON b.work_item_id=wi.id AND b.contract_revision=wi.contract_revision AND b.execution_epoch=wi.execution_epoch AND b.binding_generation=wi.binding_generation AND b.status='candidate' WHERE wi.id=json_extract(w.mapping_json,'$.planning') AND wi.goal_id=l.goal_id) AND NOT EXISTS(SELECT 1 FROM responsibility_plans p WHERE p.wake_id=l.wake_id) AND NOT EXISTS(SELECT 1 FROM responsibility_planning_outcomes o WHERE o.wake_id=l.wake_id) ORDER BY w.created_at LIMIT 20`).all(now());
  });
  for(const link of candidates) {
    try {
    const decision=JSON.parse(link.proposal_json);if(decision.providerId!=='generic-planner') continue;
    const workId=JSON.parse(link.mapping_json).planning;if(!workId) continue;
    const snapshot=await read(db=>{const raw=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND goal_id=?').get(workId,link.goal_id);const b=raw&&db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND status='candidate'").get(workId,raw.contract_revision,raw.execution_epoch,raw.binding_generation);const details=b&&JSON.parse(b.details_json||'{}');return b&&details?.packetId?{runId:b.run_id,packetId:details.packetId}:null;});
    if(!snapshot) throw error('Planner candidate evidence is incomplete',409,'PLANNING_EVIDENCE_UNAVAILABLE');
    const [packet,run]=await Promise.all([getResultPacket(snapshot.packetId),getRunAcceptanceEvidence(snapshot.runId)]);
    if(!packet||run?.state!=='completed'||run.id!==snapshot.runId) throw error('Planner Run or packet evidence is not yet available',409,'PLANNING_EVIDENCE_UNAVAILABLE');
    const rawSummary=String(packet.summary||'').trim(), fenced=/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(rawSummary);
    let output;try {output=JSON.parse(fenced?fenced[1]:rawSummary);} catch {output=null;}
    let kind=output?.decision||'plan',proposal=null;
    if(!output||typeof output!=='object'||Array.isArray(output)) kind='invalid_output';
    else if(kind==='plan') {if(output.decision==='plan' && Object.keys(output).sort().join(',')==='decision,schemaVersion,steps') proposal={schemaVersion:output.schemaVersion,steps:output.steps};else if(!output.decision) proposal=output;else kind='invalid_output';}
    else if(kind==='wait') {const refMs=Number.isFinite(Date.parse(run.createdAt))?Math.min(Date.now(),Date.parse(run.createdAt)):Date.now();const nextMs=Date.parse(output.nextCheckAt);if(output.schemaVersion!==1||Object.keys(output).sort().join(',')!=='decision,nextCheckAt,reason,schemaVersion'||typeof output.reason!=='string'||!output.reason.trim()||output.reason.length>2000||!Number.isFinite(nextMs)||nextMs<=Date.now()||nextMs<refMs+15*60000||nextMs>Date.now()+7*86400000) kind='invalid_output';}
    else if(kind==='needs_input') {if(output.schemaVersion!==1||Object.keys(output).sort().join(',')!=='decision,question,reason,requiredInput,schemaVersion'||['reason','question','requiredInput'].some(k=>typeof output[k]!=='string'||!output[k].trim()||output[k].length>2000)) kind='invalid_output';}
    else kind='invalid_output';
    await transaction(db=>{const existing=db.prepare('SELECT id FROM responsibility_plans WHERE wake_id=?').get(link.wake_id);if(existing) return;
      const r=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(link.responsibility_id),w=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(link.wake_id),o=db.prepare('SELECT * FROM responsibility_observations WHERE wake_id=?').get(link.wake_id),p=r&&db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,r.policy_revision);
      const raw=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND goal_id=?').get(workId,link.goal_id),b=raw&&db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND status='candidate'").get(workId,raw.contract_revision,raw.execution_epoch,raw.binding_generation);
      if(!r||r.lifecycle!=='active'||!w||w.responsibility_revision!==r.revision||w.policy_revision!==r.policy_revision||!p||!o||!b||b.run_id!==snapshot.runId||packet.packetId!==snapshot.packetId||run.sessionId!==packet.producer?.sessionId||decision.observationDigest!==o.payload_digest) throw error('Planner authority or evidence changed',409,'PLANNING_EVIDENCE_UNAVAILABLE');
      const item=itemRow(db,raw),binding={id:b.id,runId:b.run_id,attemptId:b.attempt_id,taskId:b.task_id};if(!verifyFactoryReportEvidence(db,item,binding,packet)) throw error('Planner packet could not be verified',409,'PLANNING_EVIDENCE_UNAVAILABLE');
      const policy=JSON.parse(p.policy_json);
      if(kind==='plan') {try {validatePlan(proposal,policy);compileFactoryPlanSteps({plan:proposal,policy,organizationId:r.organization_id,projectId:r.project_id,objective:r.objective});} catch {kind='invalid_output';}}
      if(kind!=='plan') {const safe=kind==='invalid_output'?{reason:'Planner output did not satisfy the authorized decision schema or catalog'}:output;db.prepare('INSERT INTO responsibility_planning_outcomes VALUES(?,?,?,?,?,?,?,?)').run(w.id,r.id,kind,JSON.stringify(safe),kind==='wait'?output.nextCheckAt:null,packet.packetId,packet.digest,now());activity(db,r.id,kind==='wait'?'planning_wait':kind==='needs_input'?'planning_needs_input':'planning_invalid_output',{wakeId:w.id,...safe,packetId:packet.packetId});return;}
      const id=newId('plan'), proposalDigest=digest(proposal);db.prepare('INSERT INTO responsibility_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,r.id,w.id,r.revision,r.policy_revision,o.payload_digest,decision.projectFactId,digest(policy.planCatalog),proposalDigest,JSON.stringify(proposal),packet.packetId,packet.digest,now());activity(db,r.id,'plan_proposed',{planId:id,wakeId:w.id,proposalDigest,packetId:packet.packetId});
      if(automaticAdmissionAllowed(proposal,policy)) {const approvalId=newId('plan_approval');db.prepare('INSERT INTO responsibility_plan_approvals VALUES(?,?,?,?,?,?,?)').run(approvalId,id,'responsibility-policy-auto',proposalDigest,r.row_version,`auto:${id}`,now());activity(db,r.id,'plan_approved_by_policy',{planId:id,approvalId,proposalDigest,policyRevision:r.policy_revision,reason:'owner_authorized_report_catalog'});}});
    } catch(error) {
      if(!retryableItemError(error)) throw error;
      await transaction(db=>{const reason=String(error.code||'PLANNING_EVIDENCE_UNAVAILABLE').slice(0,120),prior=db.prepare('SELECT reason FROM responsibility_planning_retry WHERE wake_id=?').get(link.wake_id),next=new Date(Date.now()+15*60000).toISOString();db.prepare('INSERT INTO responsibility_planning_retry VALUES(?,?,?) ON CONFLICT(wake_id) DO UPDATE SET reason=excluded.reason,next_retry_at=excluded.next_retry_at').run(link.wake_id,reason,next);if(prior?.reason!==reason) activity(db,link.responsibility_id,'planning_evidence_blocked',{wakeId:link.wake_id,reason,nextRetryAt:next});});
    }
  }
}

// Approval is durable before this handoff; an idempotent Factory receipt owns the graph.
export async function dispatchApprovedResponsibilityPlans() {
  const owner=String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim();if(!owner||process.env.RAGENT_FACTORY_CONTROL_ENABLED!=='true'||process.env.RAGENT_FACTORY_SCHEDULER_ENABLED!=='1') return;
  const pending=await read(db=>{const hasExecutions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();return db.prepare(`SELECT p.*,a.id AS approval_id,r.organization_id,r.project_id FROM responsibility_plans p JOIN responsibility_plan_approvals a ON a.plan_id=p.id JOIN responsibilities r ON r.id=p.responsibility_id
    LEFT JOIN responsibility_plan_dispatch_retry retry ON retry.plan_id=p.id WHERE r.lifecycle='active' AND r.revision=p.responsibility_revision AND r.policy_revision=p.policy_revision AND (retry.next_retry_at IS NULL OR retry.next_retry_at<=?) ${hasExecutions?'AND NOT EXISTS(SELECT 1 FROM responsibility_plan_executions e WHERE e.plan_id=p.id)':''} ORDER BY a.created_at LIMIT 20`).all(now());});
  const actor={kind:'service',role:'responsibility_admission',principalId:`responsibility-admission:${owner}`};
  for(const p of pending) {try {await admitResponsibilityPlan({organizationId:p.organization_id,projectId:p.project_id,planId:p.id,planDigest:p.proposal_digest,approvalId:p.approval_id,commandId:`responsibility-plan:${p.id}`,idempotencyKey:`responsibility-plan:${p.id}`},actor);} catch(error) {if(!retryableItemError(error)) throw error;await transaction(db=>{const reason=String(error.code||'PLAN_ADMISSION_REJECTED').slice(0,120),prior=db.prepare('SELECT reason FROM responsibility_plan_dispatch_retry WHERE plan_id=?').get(p.id),next=new Date(Date.now()+15*60000).toISOString();db.prepare('INSERT INTO responsibility_plan_dispatch_retry VALUES(?,?,?) ON CONFLICT(plan_id) DO UPDATE SET reason=excluded.reason,next_retry_at=excluded.next_retry_at').run(p.id,reason,next);if(prior?.reason!==reason) activity(db,p.responsibility_id,'plan_admission_blocked',{planId:p.id,reason,nextRetryAt:next});});}}
}
