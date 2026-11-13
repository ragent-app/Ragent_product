import { factoryTransaction, factoryError, digest, encode, now } from './work-graph-store.mjs';
import { compileFactoryWorkflow, instantiateFactoryWorkflowInTransaction } from './factory-workflow.mjs';
import { verifyResponsibilityAuthority } from './responsibility-authority.mjs';
import { verifyCurrentResponsibilityRepository } from './responsibility-repository.mjs';

const deny = message => { throw factoryError('FACTORY_FORBIDDEN',message,403); };
function authorizeService(actor, organizationId) {
  const owner=String(process.env.AGENTOC_FACTORY_SCHEDULER_OWNER_ID || '').trim();
  const organizations=String(process.env.AGENTOC_FACTORY_ORGANIZATIONS || '').split(',').map(x=>x.trim()).filter(Boolean);
  if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true' || process.env.AGENTOC_FACTORY_SCHEDULER_ENABLED!=='1'
      || !owner || actor?.kind!=='service' || actor.role!=='responsibility_admission'
      || actor.principalId!==`responsibility-admission:${owner}` || !organizations.includes(organizationId)) deny('Responsibility admission service is not configured for this organization');
  return owner;
}
function checkAssignments(db,org,proposal,bindings) {
  const keys=proposal.workItems.map(spec=>spec.key);
  if (!bindings || Object.keys(bindings).sort().join('\0')!==keys.slice().sort().join('\0')) deny('Assignments do not match the fixed template');
  const nodes={};
  for (const spec of proposal.workItems) {
    const pin=bindings[spec.key];
    const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(pin?.nodeId,org.id);
    if (!node || node.retired_revision!==null || !['active','ready','provisioned'].includes(node.lifecycle_state)
        || !node.current_session_id || node.binding_generation!==pin.bindingGeneration) deny('Assigned node binding changed');
    const grant=JSON.parse(node.grant_json || '{}');
    const capabilities=spec.kind==='review'?['run','review']:['run','write'];
    if (spec.kind==='review' ? grant.canReview!==true || grant.canWrite===true : grant.canWrite!==true) deny('Node authority does not satisfy the template role');
    if (spec.kind==='review') {
      const write=db.prepare("SELECT allow FROM organization_grants WHERE organization_id=? AND node_id=? AND capability='write' AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1").get(org.id,node.id,org.current_revision);
      if (write?.allow) deny('Reviewer has a write grant');
    }
    for (const capability of capabilities) {
      const row=db.prepare('SELECT allow,scope_json FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(org.id,node.id,capability,org.current_revision);
      if (!row?.allow) deny('Required current grant is unavailable');
      const scope=JSON.parse(row.scope_json || '{}');
      if ((scope.projectId && scope.projectId!==org.project_id) || Object.keys(scope).some(key=>!['projectId','writablePaths'].includes(key))) deny('Unsupported grant scope');
      if (capability==='write') {
        const within=(path,root)=>path===root || path.startsWith(`${root}/`);
        if (!Array.isArray(grant.writablePaths) || spec.contract.allowedPaths.some(path=>!grant.writablePaths.some(root=>within(path,root)))
            || (Array.isArray(scope.writablePaths) && spec.contract.allowedPaths.some(path=>!scope.writablePaths.some(root=>within(path,root))))) deny('Template paths exceed node grant');
      }
    }
    nodes[spec.key]=node;
  }
  if (nodes.implementation?.id===nodes.review?.id) deny('Review must use an independent node');
  const author=db.prepare('SELECT agent_id FROM role_instances WHERE id=?').get(nodes.implementation?.role_instance_id);
  const reviewer=db.prepare('SELECT agent_id FROM role_instances WHERE id=?').get(nodes.review?.role_instance_id);
  if (!author?.agent_id || !reviewer?.agent_id || author.agent_id===reviewer.agent_id) deny('Review must use an independent agent');
}
function githubEvent(db,link,proposal) {
  const rows=db.prepare('SELECT e.* FROM responsibility_wake_events we JOIN responsibility_events e ON e.id=we.event_id WHERE we.wake_id=?').all(link.wake_id);
  if(rows.length!==1 || rows[0].source!=='github' || rows[0].verification!=='github_api') deny('A single verified GitHub event is required');
  const data=JSON.parse(rows[0].payload_json);
  if(rows[0].payload_digest!==digest(data) || data.repository!==proposal.repository || data.branch!==proposal.targetBranch
      || !/^\d+$/.test(String(data.runId || '')) || !Number.isSafeInteger(data.attempt) || data.attempt<1
      || !/^[a-f0-9]{40}$/i.test(data.headSha || '') || !/^\d+$/.test(String(data.workflowId || ''))) deny('GitHub event does not match the authorized scope');
  return {eventId:rows[0].id,data};
}

// Identity and policy are checked in the same SQLite transaction as the
// template rows and command receipt; external repository state is rechecked
// immediately before it and again at dispatch.
export async function admitResponsibilityWorkflow(input,actor) {
  const owner=authorizeService(actor,input?.organizationId);
  if (!input?.commandId || !input?.idempotencyKey || !input?.repositoryFactId) deny('Admission identity is incomplete');
  await verifyCurrentResponsibilityRepository(input.repositoryFactId);
  const {wakeLeaseOwnerToken: _ownerToken,wakeLeaseGeneration: _leaseGeneration,commandId: _commandId,...businessInput}=input;
  const payloadDigest=digest(businessInput);
  return factoryTransaction(db=>{
    const prior=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actor.principalId,'AdmitResponsibilityWorkflow',input.responsibilityId,input.idempotencyKey);
    if (prior) { if(prior.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Admission key reused with different inputs'); return {...JSON.parse(prior.result_json),replayed:true}; }
    if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(input.commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const authority=verifyResponsibilityAuthority(db,input);
    const wake=db.prepare('SELECT lease_generation FROM responsibility_wakes WHERE id=? AND responsibility_id=?').get(input.wakeId,input.responsibilityId);
    const lease=db.prepare('SELECT * FROM responsibility_wake_leases WHERE wake_id=?').get(input.wakeId);
    if (!wake || !lease || !input.wakeLeaseOwnerToken || lease.owner_token!==input.wakeLeaseOwnerToken
        || !Number.isSafeInteger(input.wakeLeaseGeneration) || lease.generation!==input.wakeLeaseGeneration
        || wake.lease_generation!==lease.generation || lease.expires_at<=now()) deny('Responsibility wake lease expired or fenced');
    const responsibility=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(input.responsibilityId);
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(input.organizationId);
    if (!org || org.project_id!==input.projectId || ['archived','lifecycle_pending'].includes(org.state) || responsibility.owner_principal_id!==owner) deny('Organization or owner changed');
    const proposal=compileFactoryWorkflow({...input,objective:responsibility.objective});
    if (proposal.templateDigest!==input.templateDigest) deny('Template digest changed');
    if (proposal.templateVersion===3) {
      const policy=JSON.parse(org.policy_json || '{}');
      const decision=JSON.parse(db.prepare('SELECT proposal_json FROM responsibility_decisions WHERE id=?').get(input.decisionId)?.proposal_json || '{}');
      if (!input.checkActionId || authority.policy.checkActionId!==input.checkActionId || decision.checkActionId!==input.checkActionId) deny('Check action is not authorized by the responsibility and decision');
      const action=Array.isArray(policy.factoryChecks) && policy.factoryChecks.find(entry=>entry.id===input.checkActionId);
      if (!action || typeof action.command!=='string' || !action.command.trim() || action.env!==undefined) deny('Authorized registered check is unavailable');
    }
    const ci=githubEvent(db,{wake_id:input.wakeId},input);
    for(const spec of proposal.workItems) spec.contract.triggerEvidence={eventId:ci.eventId,...ci.data};
    checkAssignments(db,org,proposal,input.nodeBindings);
    const result=instantiateFactoryWorkflowInTransaction(db,proposal,org,input.commandId,{assignments:input.nodeBindings});
    db.prepare('INSERT INTO responsibility_work_links VALUES(?,?,?,?,?,?,?)').run(input.responsibilityId,input.wakeId,input.decisionId,result.goal.id,result.instance.id,input.policyRevision,input.responsibilityRevision);
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(input.commandId,input.organizationId,actor.principalId,'AdmitResponsibilityWorkflow',input.responsibilityId,input.idempotencyKey,payloadDigest,encode(result),now());
    return result;
  });
}

// A linked workflow may run only while its exact originating decision remains
// authorized. Legacy owner-created workflows have no responsibility link.
export function verifyFactoryResponsibilityFence(db,item,{bindingGeneration=item.binding_generation}={}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_work_links'").get()) return null;
  const link=db.prepare('SELECT * FROM responsibility_work_links WHERE goal_id=?').get(item.goal_id);
  if (!link) return null;
  const decision=db.prepare('SELECT proposal_json FROM responsibility_decisions WHERE id=?').get(link.decision_id);
  if (!decision) deny('Responsibility decision is unavailable');
  const proposal=JSON.parse(decision.proposal_json);
  verifyResponsibilityAuthority(db,{...proposal,organizationId:item.organization_id,projectId:item.project_id,
    responsibilityId:link.responsibility_id,wakeId:link.wake_id,decisionId:link.decision_id,
    responsibilityRevision:link.responsibility_revision,policyRevision:link.policy_revision});
  const source=JSON.parse(item.source_json || '{}');
  const pin=proposal.nodeBindings?.[source.templateKey];
  if (!pin || pin.nodeId!==item.assignee_node_id || pin.bindingGeneration!==bindingGeneration) deny('Responsibility node binding changed');
  const ci=githubEvent(db,link,proposal);
  return {repositoryFactId:proposal.repositoryFactId,eventId:ci.eventId,event:ci.data};
}
