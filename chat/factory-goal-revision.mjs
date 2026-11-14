import { factoryRead, factoryTransaction, factoryError, digest, encode, decode, event, now, itemRow } from './work-graph-store.mjs';
import { authorize, required, update } from './work-graph.mjs';

function owner(actor) { if (actor?.kind!=='user' || actor.role!=='owner' || !actor.principalId) throw factoryError('FACTORY_FORBIDDEN','Owner access required',403); }
function impact(db,input) {
  const goal=db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(input.goalId,input.organizationId);
  if (!goal) throw factoryError('FACTORY_NOT_FOUND','Goal not found',404);
  if (decode(goal.body_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','Remote execution child is controlled by its source authority');
  if (goal.row_version!==input.expectedVersion) throw factoryError('FACTORY_CONFLICT','Goal version changed');
  const all=db.prepare('SELECT id FROM factory_work_items WHERE goal_id=? ORDER BY id').all(goal.id).map(x=>x.id);
  const roots=input.affectedRootIds;
  if (roots!==undefined && (!Array.isArray(roots) || roots.some(id=>typeof id!=='string' || !all.includes(id)) || new Set(roots).size!==roots.length)) throw factoryError('FACTORY_INVALID','Affected roots must be distinct work items in this goal',400);
  // A goal-wide objective/baseline change does not provide authoritative
  // evidence that any existing contract is unaffected.
  if (roots?.length && roots.length!==all.length) throw factoryError('FACTORY_CONFLICT','Goal-wide revision requires all goal work as roots');
  const selected=all, seen=new Set(selected), queue=[...selected];
  const successors=db.prepare('SELECT d.successor_id FROM factory_dependencies d JOIN factory_work_items w ON w.id=d.successor_id WHERE d.predecessor_id=? AND w.organization_id=?');
  while(queue.length) for(const edge of successors.all(queue.shift(),input.organizationId)) if(!seen.has(edge.successor_id)){seen.add(edge.successor_id);queue.push(edge.successor_id);}
  const ids=[...seen].sort(), items=ids.map(id=>{
    const row=db.prepare('SELECT id,goal_id,ownership,state,control_state,row_version,contract_revision,execution_epoch,candidate_digest FROM factory_work_items WHERE id=? AND organization_id=?').get(id,input.organizationId);
    const active=db.prepare("SELECT id,status,run_id FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown') ORDER BY id").all(id);
    const invalidated=Boolean(db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(id));
    return {id:row.id,goalId:row.goal_id,ownership:row.ownership,state:row.state,controlState:row.control_state,rowVersion:row.row_version,contractRevision:row.contract_revision,executionEpoch:row.execution_epoch,candidateDigest:row.candidate_digest,activeBindings:active,invalidated};
  });
  const facts={goalId:goal.id,goalRevision:goal.revision,goalVersion:goal.row_version,roots:selected.slice().sort(),items};
  return {goal,facts,impactDigest:digest(facts)};
}
export async function previewFactoryGoalRevision(input,actor) {
  owner(actor); required(input?.organizationId,'organizationId'); required(input?.goalId,'goalId');
  return factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.read');const result=impact(db,input);return {schemaVersion:1,...result.facts,impactDigest:result.impactDigest};});
}
export async function reviseFactoryGoalWithImpact(input,actor) {
  owner(actor); const org=required(input?.organizationId,'organizationId'), goalId=required(input?.goalId,'goalId');
  const commandId=required(input.commandId,'commandId'), key=required(input.idempotencyKey,'idempotencyKey'), objective=required(input.objective,'objective');
  if (!Array.isArray(input.acceptanceBaseline)) throw factoryError('FACTORY_INVALID','Acceptance baseline must be an array',400);
  const payloadDigest=digest({org,goalId,expectedVersion:input.expectedVersion,affectedRootIds:input.affectedRootIds??null,impactDigest:input.impactDigest,objective,acceptanceBaseline:input.acceptanceBaseline});
  return factoryTransaction(db=>{
    authorize(db,org,actor,'factory.ReviseGoal');
    const prior=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actor.principalId,'ReviseGoalWithImpact',goalId,key);
    if(prior){if(prior.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Revision key reused with different inputs');return {...decode(prior.result_json,{}),replayed:true};}
    if(db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const plan=impact(db,input); if(!input.impactDigest || input.impactDigest!==plan.impactDigest) throw factoryError('FACTORY_CONFLICT','Impact preview changed');
    if(plan.goal.state!=='active' || plan.facts.items.some(item=>item.ownership!=='active')) throw factoryError('FACTORY_CONFLICT','Revision cannot invalidate legacy or shadow work');
    const nextRevision=plan.goal.revision+1, ts=now();
    for(const affected of plan.facts.items) {
      if(affected.invalidated) continue;
      const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(affected.id,org);
      db.prepare('INSERT INTO factory_work_invalidations VALUES(?,?,?,?,?)').run(row.id,goalId,nextRevision,commandId,ts);
      const next=update(db,row,{control_state:affected.activeBindings.length?'cancel_requested':'paused'});
      event(db,org,row.id,'WorkInvalidatedByGoalRevision',{goalId,goalRevision:nextRevision,commandId,stopRequested:affected.activeBindings.length>0,rowVersion:next.row_version});
    }
    const changed=db.prepare('UPDATE factory_goals SET body_json=?,revision=revision+1,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?').run(encode({objective,acceptanceBaseline:input.acceptanceBaseline}),ts,goalId,input.expectedVersion);
    if(!changed.changes) throw factoryError('FACTORY_CONFLICT','Goal version changed');
    event(db,org,goalId,'GoalRevisedWithImpact',{commandId,impactDigest:plan.impactDigest,goalRevision:nextRevision});
    const result={schemaVersion:1,operation:{commandId,state:'completed'},goalId,goalRevision:nextRevision,impact:plan.facts,impactDigest:plan.impactDigest};
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,org,actor.principalId,'ReviseGoalWithImpact',goalId,key,payloadDigest,encode(result),ts);return result;
  });
}

// A scoped revision changes only one task's objective. Authorization, Goal
// and acceptance criteria stay fixed; downstream history remains immutable.
function scopedImpact(db,input) {
  const goal=db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(input.goalId,input.organizationId);
  if(!goal) throw factoryError('FACTORY_NOT_FOUND','Goal not found',404);
  if(goal.state!=='active'||goal.row_version!==input.expectedVersion||decode(goal.body_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','Goal is unavailable or changed');
  const root=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND goal_id=? AND organization_id=?').get(input.rootWorkItemId,goal.id,input.organizationId);
  if(!root||root.ownership!=='active'||!['proposed','ready','blocked','failed','review'].includes(root.state)||root.control_state!=='none'||decode(root.source_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','A stopped, nonterminal local root is required');
  if(db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(root.id)) throw factoryError('FACTORY_CONFLICT','Root was invalidated');
  const successors=db.prepare('SELECT d.successor_id FROM factory_dependencies d JOIN factory_work_items w ON w.id=d.successor_id WHERE d.predecessor_id=? AND w.organization_id=?');
  const seen=new Set([root.id]),queue=[root.id];
  while(queue.length) for(const edge of successors.all(queue.shift(),input.organizationId)) if(!seen.has(edge.successor_id)){seen.add(edge.successor_id);queue.push(edge.successor_id);}
  const items=[...seen].sort().map(id=>{
    const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(id,input.organizationId);
    const active=db.prepare("SELECT id,status,run_id,contract_revision,execution_epoch,binding_generation FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown') ORDER BY id").all(id);
    if(row.ownership!=='active'||decode(row.source_json,{})?.parentRemoteOperation||active.some(b=>b.status==='unknown')) throw factoryError('FACTORY_CONFLICT','Impact contains unsupported or unknown execution');
    if(id===root.id&&active.length) throw factoryError('FACTORY_CONFLICT','Root execution must be stopped before revision');
    return {id:row.id,goalId:row.goal_id,rowVersion:row.row_version,state:row.state,controlState:row.control_state,contractRevision:row.contract_revision,executionEpoch:row.execution_epoch,candidateDigest:row.candidate_digest,activeBindings:active,invalidated:!!db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(id)};
  });
  const facts={goalId:goal.id,goalRevision:goal.revision,goalVersion:goal.row_version,rootWorkItemId:root.id,objective:required(input.objective,'objective'),items};
  return {goal,root,facts,impactDigest:digest(facts)};
}
export async function previewFactoryScopedRevision(input,actor) {
  owner(actor); required(input?.organizationId,'organizationId'); required(input?.goalId,'goalId'); required(input?.rootWorkItemId,'rootWorkItemId');
  return factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.read');const plan=scopedImpact(db,input);return {schemaVersion:1,...plan.facts,impactDigest:plan.impactDigest};});
}
export async function reviseFactoryScopeWithImpact(input,actor) {
  owner(actor); const org=required(input?.organizationId,'organizationId'),goalId=required(input?.goalId,'goalId'),rootId=required(input?.rootWorkItemId,'rootWorkItemId');
  const commandId=required(input.commandId,'commandId'),key=required(input.idempotencyKey,'idempotencyKey');
  const payloadDigest=digest({org,goalId,rootId,expectedVersion:input.expectedVersion,objective:input.objective,impactDigest:input.impactDigest});
  return factoryTransaction(db=>{
    authorize(db,org,actor,'factory.AmendContract');
    const prior=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actor.principalId,'ReviseFactoryScope',rootId,key);
    if(prior){if(prior.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Revision key reused with different inputs');return {...decode(prior.result_json,{}),replayed:true};}
    if(db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const plan=scopedImpact(db,input);if(!input.impactDigest||input.impactDigest!==plan.impactDigest) throw factoryError('FACTORY_CONFLICT','Impact preview changed');
    const ts=now();
    for(const affected of plan.facts.items) {
      if(affected.id===rootId||affected.invalidated) continue;
      const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(affected.id,org);
      db.prepare('INSERT INTO factory_work_invalidations VALUES(?,?,?,?,?)').run(row.id,goalId,plan.goal.revision,commandId,ts);
      const next=update(db,row,{control_state:affected.activeBindings.length?'cancel_requested':'paused'});
      event(db,org,row.id,'WorkInvalidatedByScopedRevision',{goalId,rootWorkItemId:rootId,commandId,stopRequested:affected.activeBindings.length>0,rowVersion:next.row_version});
    }
    const contract={...itemRow(db,plan.root).contract,objective:plan.facts.objective};
    const revision=plan.root.contract_revision+1;
    db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(rootId,revision,encode(contract),digest(contract),ts);
    const root=update(db,plan.root,{contract_revision:revision,state:'proposed',candidate_digest:null,gate_generation:plan.root.gate_generation+1,blocked_json:null});
    event(db,org,rootId,'WorkScopedRevision',{commandId,impactDigest:plan.impactDigest,contractRevision:revision});
    const result={schemaVersion:1,operation:{commandId,state:'completed'},goalId,rootWorkItemId:rootId,contractRevision:revision,item:itemRow(db,root),impact:plan.facts,impactDigest:plan.impactDigest};
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,org,actor.principalId,'ReviseFactoryScope',rootId,key,payloadDigest,encode(result),ts);return result;
  });
}
