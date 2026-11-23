import { factoryTransaction, factoryRead, factoryError, now, newId, encode, decode, digest, itemRow, goalRow, event } from './work-graph-store.mjs';

import { hasVerifiedIndependentReview } from './factory-review-opinions.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';
import { activityOnce } from './responsibility-store.mjs';
const terminal = new Set(['completed', 'cancelled']);
const required = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 255) throw factoryError('FACTORY_INVALID', `${name} is required`, 400); return value.trim(); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const conflict = message => { throw factoryError('FACTORY_CONFLICT', message); };
function authorize(db, organizationId, actor, capability) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
  if (!org) throw factoryError('FACTORY_NOT_FOUND', 'Organization not found', 404);
  if (org.state === 'archived' && capability !== 'factory.read') throw factoryError('FACTORY_CONFLICT', 'Archived organization is read-only', 409);
  if (org.state === 'lifecycle_pending' && !['factory.read', 'factory.RequestPause', 'factory.RequestCancel', 'factory.execution', 'factory.shadow.sync'].includes(capability)) throw factoryError('FACTORY_CONFLICT', 'Organization lifecycle transition is pending', 409);
  required(actor?.principalId, 'authenticated principal');
  if (actor.kind === 'user' && actor.role === 'owner') return org;
  if (actor.kind === 'service' && actor.role === 'factory_scheduler') {
    const configuredOwner = String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID || '').trim();
    const allowedOrganizations = String(process.env.RAGENT_FACTORY_ORGANIZATIONS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (configuredOwner && actor.principalId === `factory-scheduler:${configuredOwner}` && allowedOrganizations.includes(organizationId)
        && ['factory.read', 'factory.dispatch', 'factory.execution', 'factory.shadow.sync'].includes(capability)) return org;
    throw factoryError('FACTORY_FORBIDDEN', 'Factory service scope is not authorized', 403);
  }
  if (actor.kind !== 'node') throw factoryError('FACTORY_FORBIDDEN', 'Authenticated owner or authorized node required', 403);
  const node = db.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(actor.nodeId, organizationId);
  if (!node || node.retired_revision !== null || !['active','ready','provisioned'].includes(node.lifecycle_state)) throw factoryError('FACTORY_FORBIDDEN', 'Node is not active', 403);
  const grantCapability = capability === 'factory.read' ? 'read' : capability === 'factory.execution' || capability === 'factory.dispatch' ? 'run' : capability === 'factory.DecideAcceptance' ? 'review' : 'manage';
  const grant = db.prepare('SELECT * FROM organization_grants WHERE organization_id = ? AND node_id = ? AND capability = ? AND revision <= ? ORDER BY revision DESC, id DESC LIMIT 1').get(organizationId, actor.nodeId, grantCapability, org.current_revision);
  if (!grant || !grant.allow) throw factoryError('FACTORY_FORBIDDEN', `Missing ${capability} grant`, 403);
  const scope = decode(grant.scope_json, {});
  if (scope.projectId && scope.projectId !== org.project_id) throw factoryError('FACTORY_FORBIDDEN', 'Grant project scope mismatch', 403);
  if (Object.keys(scope).some(k => k !== 'projectId')) throw factoryError('FACTORY_FORBIDDEN', 'Restricted grant scope is not supported for this operation', 403);
  return org;
}
function contractValid(contract) {
  if (!contract || typeof contract !== 'object' || !String(contract.objective || '').trim()) throw factoryError('FACTORY_INVALID', 'Contract objective is required', 400);
  if (!Array.isArray(contract.acceptanceCriteria) || !contract.acceptanceCriteria.length) throw factoryError('FACTORY_INVALID', 'Acceptance criteria are required', 400);
  const ids = contract.acceptanceCriteria.map(x => required(x?.id, 'criterion id'));
  if (new Set(ids).size !== ids.length) throw factoryError('FACTORY_INVALID', 'Criterion IDs must be unique', 400);
  if (contract.allowedPaths && (!Array.isArray(contract.allowedPaths) || contract.allowedPaths.some(p => typeof p !== 'string' || !p || /^[\\\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')))) throw factoryError('FACTORY_INVALID', 'Allowed paths must be project-relative', 400);
}
function selectItem(db, org, id) { const row = db.prepare('SELECT * FROM factory_work_items WHERE organization_id = ? AND id = ?').get(org, id); if (!row) throw factoryError('FACTORY_NOT_FOUND', 'Work item not found', 404); return row; }
function checkVersion(row, version) { if (!Number.isInteger(version) || version !== row.row_version) conflict('Work item version mismatch'); }
function validateAssignee(db, org, nodeId) { if (!nodeId) return; const n = db.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(nodeId, org); if (!n || n.retired_revision !== null) throw factoryError('FACTORY_INVALID', 'Assignee is not an active organization node', 400); }
function unresolved(db, id) { return db.prepare(`SELECT d.*, p.state, p.control_state AS predecessor_control_state, p.candidate_digest AS predecessor_candidate_digest, EXISTS(SELECT 1 FROM factory_delivery_milestones m WHERE m.work_item_id=p.id AND m.milestone='integrated' AND m.candidate_digest=d.candidate_digest) AS integrated FROM factory_dependencies d JOIN factory_work_items p ON p.id=d.predecessor_id WHERE d.successor_id=?`).all(id).filter(d => d.predecessor_control_state !== 'none' ? true : d.milestone === 'candidate_ready' ? !d.candidate_digest || !d.predecessor_candidate_digest || d.candidate_digest !== d.predecessor_candidate_digest : d.milestone === 'accepted' ? d.state !== 'completed' : d.milestone === 'integrated' ? !d.candidate_digest || d.candidate_digest !== d.predecessor_candidate_digest || !d.integrated : true); }
function update(db, row, values) { const keys = Object.keys(values); const assignments = keys.map(k => `${k}=?`).join(','); const changes = db.prepare(`UPDATE factory_work_items SET ${assignments ? `${assignments},` : ''} row_version=row_version+1, updated_at=? WHERE id=? AND row_version=?`).run(...keys.map(k => values[k]), now(), row.id, row.row_version).changes; if (!changes) conflict('Work item version mismatch'); return selectItem(db, row.organization_id, row.id); }
function requestCancel(db,row,active) { return update(db,row,active?{control_state:'cancel_requested'}:{state:'cancelled',control_state:'none'}); }

// Only server-owned, same-project responsibility links may receive Factory facts.
export function recordFactoryResponsibilityActivity(db,row,type,key,details) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibilities'").get()) return;
  let link=db.prepare('SELECT l.responsibility_id FROM responsibility_work_links l JOIN responsibilities r ON r.id=l.responsibility_id WHERE l.goal_id=? AND r.organization_id=? AND r.project_id=?').get(row.goal_id,row.organization_id,row.project_id);
  if(!link && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get()) link=db.prepare('SELECT p.responsibility_id FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id JOIN responsibilities r ON r.id=p.responsibility_id WHERE e.goal_id=? AND r.organization_id=? AND r.project_id=?').get(row.goal_id,row.organization_id,row.project_id);
  if(link) activityOnce(db,link.responsibility_id,key,type,details);
}

// Called only within an existing responsibility lifecycle transaction.
// The owner and the exact work association are re-read from the same DB.
export function requestResponsibilityWorkCancellation(db,{responsibilityId,organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner'||!actor.principalId) throw factoryError('FACTORY_FORBIDDEN','Responsibility owner required',403);
  const responsibility=db.prepare('SELECT * FROM responsibilities WHERE id=? AND organization_id=? AND owner_principal_id=?').get(responsibilityId,organizationId,actor.principalId);
  const row=selectItem(db,organizationId,workItemId);
  if(!responsibility || row.project_id!==responsibility.project_id || row.ownership!=='active') throw factoryError('FACTORY_FORBIDDEN','Responsibility work authority unavailable',403);
  const linked=!!db.prepare('SELECT 1 FROM responsibility_work_links WHERE responsibility_id=? AND goal_id=?').get(responsibilityId,row.goal_id);
  const hasPlan=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
  const planned=hasPlan&&db.prepare('SELECT 1 FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=? AND e.goal_id=?').get(responsibilityId,row.goal_id);
  if(!linked&&!planned) throw factoryError('FACTORY_FORBIDDEN','Work is not linked to this responsibility',403);
  const bindings=db.prepare("SELECT id,status,contract_revision,execution_epoch,binding_generation FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown') ORDER BY execution_epoch,binding_generation").all(row.id);
  const active=bindings.length>0, staleBindingIds=bindings.filter(binding=>binding.contract_revision!==row.contract_revision||binding.execution_epoch!==row.execution_epoch||binding.binding_generation!==row.binding_generation).map(binding=>binding.id);
  if(!active && ['completed','cancelled','failed','review'].includes(row.state)) return {workItemId:row.id,state:row.state,controlState:row.control_state,stopRequested:false};
  if(row.control_state==='cancel_requested') return {workItemId:row.id,state:row.state,controlState:row.control_state,stopRequested:active,staleBindingIds};
  const next=requestCancel(db,row,active);
  event(db,organizationId,row.id,'RequestCancel',{responsibilityId,actorId:actor.principalId,stopRequested:active,bindingIds:bindings.map(binding=>binding.id),staleBindingIds});
  return {workItemId:row.id,state:next.state,controlState:next.control_state,stopRequested:active,staleBindingIds};
}
function deps(db, row, edges) {
  if (!Array.isArray(edges)) throw factoryError('FACTORY_INVALID', 'dependencies must be an array', 400);
  for (const edge of edges) { const pred = selectItem(db, row.organization_id, required(edge.predecessorId, 'predecessorId')); if (pred.project_id !== row.project_id || pred.id === row.id) conflict('Dependency endpoints must be distinct and in the same project'); if (!['accepted','candidate_ready','integrated'].includes(edge.milestone || 'accepted')) throw factoryError('FACTORY_INVALID', 'Invalid milestone', 400); }
  db.prepare('DELETE FROM factory_dependencies WHERE successor_id=?').run(row.id);
  for (const edge of edges) db.prepare('INSERT INTO factory_dependencies(predecessor_id,successor_id,milestone,candidate_digest,created_at) VALUES(?,?,?,?,?)').run(edge.predecessorId,row.id,edge.milestone || 'accepted',edge.candidateDigest || null,now());
  const cycle = db.prepare(`WITH RECURSIVE reachable(id) AS (SELECT successor_id FROM factory_dependencies WHERE predecessor_id=? UNION SELECT d.successor_id FROM factory_dependencies d JOIN reachable r ON d.predecessor_id=r.id) SELECT 1 FROM reachable WHERE id=? LIMIT 1`).get(row.id,row.id);
  if (cycle) conflict('Dependency cycle');
}
export async function executeWorkGraphCommand(command, actor, options = {}) {
  const c = object(command), p = object(c.payload); const orgId = required(c.organizationId, 'organizationId'), type = required(c.type, 'type'), commandId = required(c.commandId, 'commandId'), key = required(c.idempotencyKey, 'idempotencyKey'); const actorId = required(actor?.principalId, 'authenticated principal');
  const target = String(c.targetId || (type === 'CreateGoal' || type === 'CreateWorkItem' ? orgId : '')); required(target, 'targetId');
  const payloadDigest = digest({ organizationId: orgId, type, target, expectedVersion: c.expectedVersion ?? null, payload: p });
  return factoryTransaction(db => {
    const org = authorize(db, orgId, actor, `factory.${type}`);
    const replay = db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actorId,type,target,key);
    if (replay) { if (replay.payload_digest !== payloadDigest) conflict('Idempotency key reused with different content'); const previous=decode(replay.result_json, {}); if (previous.item) { const current=db.prepare('SELECT * FROM factory_work_items WHERE organization_id=? AND id=?').get(orgId,previous.item.id); if (current) previous.item=itemRow(db,current); } if (previous.goal) { const current=db.prepare('SELECT * FROM factory_goals WHERE organization_id=? AND id=?').get(orgId,previous.goal.id); if (current) previous.goal=goalRow(current); } return { ...previous, replayed: true };  }
    if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) conflict('Command ID already used');
    if (type==='CreateWorkItem' && p.contract?.knowledgeRefs!==undefined && (!Array.isArray(p.contract.knowledgeRefs) || p.contract.knowledgeRefs.length)) throw factoryError('FACTORY_FORBIDDEN','Knowledge references require explicit owner authorization',403);
    // References belong to this WorkItem. An objective-only amendment can
    // retain them, but the references never grant execution permissions.
    if (type==='AmendContract') {
      const existing=itemRow(db,selectItem(db,orgId,target)).contract.knowledgeRefs || [];
      const next=p.contract?.knowledgeRefs || [];
      if (!Array.isArray(next)) throw factoryError('FACTORY_INVALID','Knowledge references must be an array',400);
      if (encode(existing)!==encode(next) && (typeof options.verifyKnowledgeRefs!=='function' || options.verifyKnowledgeRefs({db,organization:org,actor,workItemId:target,refs:next})!==true)) throw factoryError('FACTORY_FORBIDDEN','Knowledge references require explicit owner authorization',403);
    }
    let result;
    if (type === 'CreateGoal') {
      const projectId = required(p.projectId || org.project_id, 'projectId'); if (org.project_id !== projectId) conflict('Goal project differs from organization');
      if (p.parentGoalId) { const parent = db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=? AND project_id=?').get(p.parentGoalId,orgId,projectId); if (!parent) conflict('Parent goal not found in project'); }
      required(p.objective, 'objective'); const id = newId('goal'), ts = now(); db.prepare('INSERT INTO factory_goals (id,organization_id,project_id,parent_goal_id,body_json,revision,row_version,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,orgId,projectId,p.parentGoalId || null,encode({ objective:p.objective, acceptanceBaseline:p.acceptanceBaseline || [] }),1,1,'active',ts,ts); result = { goal:goalRow(db.prepare('SELECT * FROM factory_goals WHERE id=?').get(id)) };
    } else if (type === 'ReviseGoal') {
      const g = db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(target,orgId); if (!g) throw factoryError('FACTORY_NOT_FOUND','Goal not found',404); if (g.row_version !== c.expectedVersion) conflict('Goal version mismatch'); if (db.prepare('SELECT 1 FROM factory_work_items WHERE goal_id=? LIMIT 1').get(target)) conflict('Existing work requires a new goal or explicit task-level amendments'); required(p.objective,'objective'); db.prepare('UPDATE factory_goals SET body_json=?, revision=revision+1, row_version=row_version+1, updated_at=? WHERE id=? AND row_version=?').run(encode({objective:p.objective,acceptanceBaseline:p.acceptanceBaseline || []}),now(),target,c.expectedVersion); result = {goal:goalRow(db.prepare('SELECT * FROM factory_goals WHERE id=?').get(target))};
    } else if (type === 'CreateWorkItem') {
      const goal = db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(required(p.goalId,'goalId'),orgId); if (!goal || goal.state !== 'active') conflict('Active goal required'); contractValid(p.contract); const pinnedContract={...p.contract,organizationRevision:org.current_revision}; validateAssignee(db,orgId,p.assigneeNodeId); const ownership = p.ownership || 'active'; if (!['legacy','shadow','active'].includes(ownership)) conflict('Invalid ownership'); if (ownership !== 'active' && (!p.source?.collaborationId || !p.source?.taskId)) conflict('Legacy projection requires exact source identifiers'); const id = newId('work'), ts = now(); db.prepare(`INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,goal.id,orgId,goal.project_id,p.kind || 'execution',ownership,'proposed','none',Number.isInteger(p.priority) ? p.priority : 0,p.assigneeNodeId || null,1,1,0,0,null,encode(p.source || {}),null,0,ts,ts); db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(id,1,encode(pinnedContract),digest(pinnedContract),ts); const row=selectItem(db,orgId,id); deps(db,row,p.dependencies || []); result={item:itemRow(db,row)};
    } else {
      let row = selectItem(db,orgId,target); checkVersion(row,c.expectedVersion); if (decode(row.source_json,{})?.parentRemoteOperation && !['RequestCancel','RequestPause'].includes(type)) conflict('Remote child execution is controlled by its source authority'); if (row.ownership !== 'active') conflict('Legacy and shadow items are read-only projections'); if (db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(row.id) && type!=='RequestCancel') conflict('Work was invalidated by a goal revision'); if (terminal.has(row.state)) conflict('Terminal work cannot be reopened');
      if (type==='DecideAcceptance') verifyFactoryResponsibilityFence(db,row);
      const active = db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown')").get(row.id);
      if (type === 'ApproveContract') { if (row.state !== 'proposed') conflict('Only proposed contracts can be approved'); const missing=unresolved(db,row.id); row=update(db,row,{state:missing.length?'blocked':'ready',blocked_json:missing.length?encode({code:'dependencies', predecessors:missing.map(x=>x.predecessor_id)}):null}); }
      else if (type === 'ChangePriority') { if (!Number.isInteger(p.priority)) throw factoryError('FACTORY_INVALID','Integer priority required',400); row=update(db,row,{priority:p.priority}); }
      else if (type === 'AssignWork') { if (active || row.state==='review') conflict('Existing execution or candidate must be resolved before reassignment'); validateAssignee(db,orgId,p.assigneeNodeId); row=update(db,row,{assignee_node_id:p.assigneeNodeId || null,execution_epoch:row.execution_epoch+1}); }
      else if (type === 'AmendContract' || type === 'ChangeDependencies') { if (active) conflict('Stop or isolate active execution before changing contract or dependencies'); if (db.prepare('SELECT 1 FROM factory_dependencies WHERE predecessor_id=? LIMIT 1').get(row.id)) conflict('Downstream work requires an impact-reviewed scoped revision'); const old=itemRow(db,row).contract; const next={...(type==='AmendContract'?p.contract:old),organizationRevision:org.current_revision}; contractValid(next); const impact={bindings:db.prepare('SELECT id,status FROM factory_execution_bindings WHERE work_item_id=?').all(row.id),candidates:db.prepare('SELECT id,digest FROM factory_candidates WHERE work_item_id=?').all(row.id),decisions:db.prepare('SELECT id FROM factory_acceptance_decisions WHERE work_item_id=?').all(row.id),successors:db.prepare('SELECT successor_id FROM factory_dependencies WHERE predecessor_id=?').all(row.id)}; if (type==='ChangeDependencies') deps(db,row,p.dependencies); const rev=row.contract_revision+1; db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(row.id,rev,encode(next),digest(next),now()); row=update(db,row,{contract_revision:rev,state:'proposed',candidate_digest:null,gate_generation:row.gate_generation+1,blocked_json:null}); result={impact}; }
      else if (type === 'RequestPause') { if (row.control_state !== 'none') conflict('Control request already pending'); row=update(db,row,{control_state:active?'pause_requested':'paused'}); }
      else if (type === 'WithdrawPauseWork') {
        if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner required to withdraw a pending pause',403);
        if(row.state!=='claimed'||row.control_state!=='pause_requested') conflict('Only an unconfirmed pause on a claimed work item can be withdrawn');
        const bindings=db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown')").all(row.id);
        const binding=bindings[0];
        if(bindings.length!==1||binding.status!=='intent'||binding.id!==p.bindingId||binding.execution_epoch!==p.executionEpoch
            ||binding.execution_epoch!==row.execution_epoch||binding.contract_revision!==row.contract_revision||binding.binding_generation!==row.binding_generation
            ||binding.collaboration_id||binding.task_id||binding.attempt_id||binding.run_id) conflict('A unique current unbound intent is required');
        if(db.prepare('SELECT 1 FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,binding.dispatch_key)) conflict('Collaboration already exists; reconcile its actual state');
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_factory_source_operations'").get()
            && db.prepare('SELECT 1 FROM remote_factory_source_operations WHERE source_factory_binding_id=?').get(binding.id)) conflict('Remote dispatch exists; reconcile its actual state');
        row=update(db,row,{control_state:'none'});
      }
      else if (type === 'ResumeWork') { if (row.control_state !== 'paused') conflict('Work is not paused'); if (active) conflict('Active execution has not stopped'); row=update(db,row,{control_state:'none'}); }
      else if (type === 'RequestCancel') { if (row.control_state === 'cancel_requested') conflict('Cancellation already requested'); row=requestCancel(db,row,active); }
      else if (type === 'RetryWork') { if (row.control_state!=='none') conflict('Pending control must be resolved before retry'); if (!['failed','blocked','review'].includes(row.state) || active) conflict('Retry requires stopped or isolated prior execution'); if (row.candidate_digest && db.prepare("SELECT 1 FROM factory_dependencies WHERE predecessor_id=? AND milestone='candidate_ready' LIMIT 1").get(row.id)) conflict('Candidate-dependent work must be explicitly amended before retry'); const prior=itemRow(db,row); const attempts=db.prepare('SELECT COUNT(*) AS count FROM factory_execution_bindings WHERE work_item_id=?').get(row.id).count; const maxAttempts=prior.contract.retry?.maxAttempts; if (attempts && (!Number.isInteger(maxAttempts) || maxAttempts<1 || attempts>=maxAttempts)) conflict('Retry limit missing or exhausted'); result={lineage:{previousCandidateDigest:row.candidate_digest,previousExecutionEpoch:row.execution_epoch}}; const missing=unresolved(db,row.id); row=update(db,row,{state:missing.length?'blocked':'ready',blocked_json:missing.length?encode({code:'dependencies',predecessors:missing.map(x=>x.predecessor_id)}):null,execution_epoch:row.execution_epoch+1,candidate_digest:null,gate_generation:row.gate_generation+1}); }
      else if (type === 'DecideAcceptance') { if (decode(row.source_json,{})?.parentRemoteOperation) conflict('Remote child execution is accepted only by its source authority'); if (row.control_state!=='none') conflict('Pending control must be resolved before acceptance'); if (row.state!=='review' || p.candidateDigest!==row.candidate_digest || p.contractRevision!==row.contract_revision || p.gateGeneration!==row.gate_generation) conflict('Candidate or acceptance generation changed'); const contract=itemRow(db,row).contract; if (contract.independentReview && p.decision==='passed' && !hasVerifiedIndependentReview(db,itemRow(db,row))) throw factoryError('FACTORY_EVIDENCE_UNVERIFIED','A verified independent review opinion is required',409); if (!contract.acceptanceCriteria.some(x=>x.id===p.criterionId)) conflict('Unknown criterion'); if (!['passed','failed'].includes(p.decision)) conflict('Invalid decision'); if (typeof options.verifyEvidence !== 'function' || options.verifyEvidence({db,item:itemRow(db,row),actor,decision:p}) !== true) throw factoryError('FACTORY_EVIDENCE_UNVERIFIED','Trusted evidence verification required',409); if (db.prepare('SELECT 1 FROM factory_acceptance_decisions WHERE work_item_id=? AND contract_revision=? AND candidate_digest=? AND gate_generation=? AND criterion_id=?').get(row.id,row.contract_revision,row.candidate_digest,row.gate_generation,p.criterionId)) conflict('Criterion already has a decision for this candidate'); db.prepare('INSERT INTO factory_acceptance_decisions VALUES(?,?,?,?,?,?,?,?,?,?)').run(newId('decision'),row.id,row.contract_revision,row.candidate_digest,row.gate_generation,p.criterionId,p.decision,actorId,encode(p.evidence || []),now()); const passed=db.prepare("SELECT criterion_id FROM factory_acceptance_decisions WHERE work_item_id=? AND contract_revision=? AND candidate_digest=? AND gate_generation=? AND decision='passed'").all(row.id,row.contract_revision,row.candidate_digest,row.gate_generation).map(x=>x.criterion_id); row=update(db,row,{state:contract.acceptanceCriteria.every(x=>passed.includes(x.id))?'completed':'review'}); }
      else throw factoryError('FACTORY_INVALID','Unsupported command',400);
      if(type==='DecideAcceptance' && row.state==='completed') {
        const workflow=db.prepare('SELECT id FROM factory_workflow_instances WHERE goal_id=? AND organization_id=?').get(row.goal_id,orgId);
        const pending=db.prepare("SELECT 1 FROM factory_work_items w WHERE w.goal_id=? AND (w.state<>'completed' OR EXISTS(SELECT 1 FROM factory_execution_bindings b WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown'))) LIMIT 1").get(row.goal_id);
        if(workflow && !pending) recordFactoryResponsibilityActivity(db,row,'workflow_completed',`workflow_completed:${workflow.id}`,{workflowInstanceId:workflow.id,goalId:row.goal_id});
      }
      result={...result,item:itemRow(db,row)};
    }
    event(db,orgId,result.item?.id || result.goal?.id,type,{commandId,actorId}); result={...result,operation:{commandId,state:'completed'},schemaVersion:1}; db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,orgId,actorId,type,target,key,payloadDigest,encode(result),now()); return result;
  });
}

// Advance only dependency-blocked work. This is not an execution retry and
// never changes an existing candidate pin or authorizes a new contract.
export async function reconcileFactoryDependencies(input, actor) {
  return factoryTransaction(db => {
    const orgId = required(input?.organizationId, 'organizationId');
    const org = authorize(db, orgId, actor, 'factory.dispatch');
    if (actor.kind !== 'service' || actor.role !== 'factory_scheduler') throw factoryError('FACTORY_FORBIDDEN', 'Scheduler service required', 403);
    const lease = db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(orgId);
    if (!lease || lease.owner_token !== input.leaseOwnerToken || lease.generation !== input.leaseGeneration || lease.expires_at <= now()) conflict('Scheduler lease expired or fenced');
    let row = selectItem(db, orgId, required(input.workItemId, 'workItemId'));
    checkVersion(row, input.expectedVersion);
    if (row.ownership !== 'active' || row.state !== 'blocked' || row.control_state !== 'none'
        || decode(row.blocked_json, {})?.code !== 'dependencies'
        || itemRow(db, row).contract.organizationRevision !== org.current_revision
        || db.prepare("SELECT 1 FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown')").get(row.id)) return { item: itemRow(db, row), changed: false };
    const instances = db.prepare('SELECT mapping_json FROM factory_workflow_instances WHERE organization_id=? AND goal_id=?').all(orgId, row.goal_id)
      .map(instance => Object.values(decode(instance.mapping_json, {})));
    const edges = db.prepare(`SELECT d.predecessor_id, p.candidate_digest, p.contract_revision, p.execution_epoch, p.binding_generation
      FROM factory_dependencies d JOIN factory_work_items p ON p.id=d.predecessor_id
      WHERE d.successor_id=? AND d.milestone='candidate_ready' AND d.candidate_digest IS NULL`).all(row.id);
    const pins = [];
    for (const edge of edges) {
      if (!edge.candidate_digest || !instances.some(ids => ids.includes(row.id) && ids.includes(edge.predecessor_id))) continue;
      const candidate = db.prepare('SELECT 1 FROM factory_candidates WHERE work_item_id=? AND digest=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?')
        .get(edge.predecessor_id, edge.candidate_digest, edge.contract_revision, edge.execution_epoch, edge.binding_generation);
      if (!candidate) continue;
      db.prepare('UPDATE factory_dependencies SET candidate_digest=? WHERE predecessor_id=? AND successor_id=? AND candidate_digest IS NULL').run(edge.candidate_digest, edge.predecessor_id, row.id);
      pins.push({ predecessorId: edge.predecessor_id, candidateDigest: edge.candidate_digest });
    }
    const missing = unresolved(db, row.id);
    if (!missing.length) row = update(db, row, { state: 'ready', blocked_json: null });
    else if (pins.length) row = update(db, row, { blocked_json: encode({ code: 'dependencies', predecessors: missing.map(edge => edge.predecessor_id) }) });
    if (pins.length || !missing.length) event(db, orgId, row.id, 'DependenciesReconciled', { contractRevision: row.contract_revision, pins, ready: !missing.length });
    return { item: itemRow(db, row), changed: pins.length > 0 || !missing.length };
  });
}
export { authorize, selectItem, checkVersion, update, unresolved, required };
