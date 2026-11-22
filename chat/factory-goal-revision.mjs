import { factoryRead, factoryTransaction, factoryError, digest, encode, decode, event, now, itemRow, goalRow } from './work-graph-store.mjs';
import { authorize, required, update } from './work-graph.mjs';

function owner(actor) { if (actor?.kind!=='user' || actor.role!=='owner' || !actor.principalId) throw factoryError('FACTORY_FORBIDDEN','Owner access required',403); }

function buildReusableArtifact(db, row) {
  if (!row || row.ownership !== 'active' || row.control_state !== 'none' || row.state !== 'completed') return null;
  if (db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(row.id)) return null;
  const candidate = row.candidate_digest
    ? db.prepare('SELECT id,digest,details_json,created_at FROM factory_candidates WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND digest=? ORDER BY created_at DESC LIMIT 1').get(row.id, row.contract_revision, row.execution_epoch, row.binding_generation, row.candidate_digest)
    : null;
  const hasPayloadTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_candidate_payloads'").get();
  const payloadRow = (!candidate && row.candidate_digest && hasPayloadTable)
    ? db.prepare('SELECT candidate_id,digest FROM factory_candidate_payloads WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND digest=? LIMIT 1').get(row.id, row.contract_revision, row.execution_epoch, row.binding_generation, row.candidate_digest)
    : null;
  const milestones = row.candidate_digest
    ? db.prepare('SELECT id,milestone,operation_id,target,result_digest FROM factory_delivery_milestones WHERE work_item_id=? AND candidate_digest=? ORDER BY created_at,id').all(row.id, row.candidate_digest)
    : [];
  const passedCriteria = row.candidate_digest
    ? db.prepare("SELECT criterion_id FROM factory_acceptance_decisions WHERE work_item_id=? AND contract_revision=? AND candidate_digest=? AND gate_generation=? AND decision='passed' ORDER BY criterion_id").all(row.id, row.contract_revision, row.candidate_digest, row.gate_generation).map(x => x.criterion_id)
    : [];
  return {
    workItemId: row.id,
    goalId: row.goal_id,
    kind: row.kind,
    state: row.state,
    contractRevision: row.contract_revision,
    executionEpoch: row.execution_epoch,
    bindingGeneration: row.binding_generation,
    gateGeneration: row.gate_generation,
    candidateDigest: row.candidate_digest || null,
    candidateId: candidate?.id || payloadRow?.candidate_id || null,
    candidateVerified: Boolean(candidate || payloadRow || (row.kind === 'review' && row.candidate_digest)),
    candidateDetails: candidate ? decode(candidate.details_json, {}) : null,
    milestones: milestones.map(m => ({ id: m.id, milestone: m.milestone, operationId: m.operation_id, target: m.target, resultDigest: m.result_digest })),
    passedCriteria,
    reusable: true,
    preservedReason: 'unaffected_completed_in_dag_revision',
  };
}

function collectGoalDagPartitions(db, organizationId, goalId, rootIds) {
  const allRows = db.prepare('SELECT * FROM factory_work_items WHERE goal_id=? AND organization_id=? ORDER BY id').all(goalId, organizationId);
  const byId = new Map(allRows.map(row => [row.id, row]));
  const successors = db.prepare('SELECT d.successor_id FROM factory_dependencies d JOIN factory_work_items w ON w.id=d.successor_id WHERE d.predecessor_id=? AND w.goal_id=? AND w.organization_id=? ORDER BY d.successor_id');
  const seen = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    const cur = queue.shift();
    for (const edge of successors.all(cur, goalId, organizationId)) {
      if (!seen.has(edge.successor_id)) {
        seen.add(edge.successor_id);
        queue.push(edge.successor_id);
      }
    }
  }
  const affectedIds = [...seen].sort();
  const unaffectedIds = allRows.map(r => r.id).filter(id => !seen.has(id)).sort();
  const mapAffected = id => {
    const row = byId.get(id) || db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(id, organizationId);
    const active = db.prepare("SELECT id,status,run_id,contract_revision,execution_epoch,binding_generation FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown') ORDER BY id").all(id);
    const invalidated = Boolean(db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(id));
    return {
      id: row.id,
      goalId: row.goal_id,
      ownership: row.ownership,
      kind: row.kind,
      state: row.state,
      controlState: row.control_state,
      rowVersion: row.row_version,
      contractRevision: row.contract_revision,
      executionEpoch: row.execution_epoch,
      bindingGeneration: row.binding_generation,
      gateGeneration: row.gate_generation,
      candidateDigest: row.candidate_digest,
      activeBindings: active,
      invalidated,
    };
  };
  const items = affectedIds.map(mapAffected);
  const unaffectedItems = [];
  const reusableArtifacts = [];
  for (const id of unaffectedIds) {
    const row = byId.get(id);
    const invalidated = Boolean(db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(id));
    const artifact = buildReusableArtifact(db, row);
    if (artifact) reusableArtifacts.push(artifact);
    unaffectedItems.push({
      id: row.id,
      goalId: row.goal_id,
      ownership: row.ownership,
      kind: row.kind,
      state: row.state,
      controlState: row.control_state,
      rowVersion: row.row_version,
      contractRevision: row.contract_revision,
      executionEpoch: row.execution_epoch,
      bindingGeneration: row.binding_generation,
      gateGeneration: row.gate_generation,
      candidateDigest: row.candidate_digest,
      invalidated,
      reusable: Boolean(artifact),
      ...(artifact ? { artifact } : {}),
    });
  }
  return { affectedIds, unaffectedIds, items, unaffectedItems, reusableArtifacts };
}

export function assertFactoryWorkItemGenerationFence(db, workItemId, fence = {}) {
  const row = db.prepare('SELECT id,goal_id,state,control_state,row_version,contract_revision,execution_epoch,binding_generation,gate_generation FROM factory_work_items WHERE id=?').get(workItemId);
  if (!row) throw factoryError('FACTORY_NOT_FOUND', 'Work item not found', 404);
  const invalidation = db.prepare('SELECT goal_id,goal_revision,command_id FROM factory_work_invalidations WHERE work_item_id=?').get(workItemId);
  if (invalidation) throw factoryError('FACTORY_WORK_INVALIDATED', 'Work item was invalidated by goal revision', 409, { invalidation });
  if (fence.requireActiveControl && row.control_state !== 'none') throw factoryError('FACTORY_CONFLICT', 'Work item control state prevents submission', 409);
  if (fence.expectedVersion !== undefined && row.row_version !== fence.expectedVersion) throw factoryError('FACTORY_CONFLICT', 'Stale work item version fence', 409);
  if (fence.contractRevision !== undefined && row.contract_revision !== fence.contractRevision) throw factoryError('FACTORY_CONFLICT', 'Stale contract revision fence', 409);
  if (fence.executionEpoch !== undefined && row.execution_epoch !== fence.executionEpoch) throw factoryError('FACTORY_CONFLICT', 'Stale execution epoch fence', 409);
  if (fence.bindingGeneration !== undefined && row.binding_generation !== fence.bindingGeneration) throw factoryError('FACTORY_CONFLICT', 'Stale binding generation fence', 409);
  if (fence.gateGeneration !== undefined && row.gate_generation !== fence.gateGeneration) throw factoryError('FACTORY_CONFLICT', 'Stale gate generation fence', 409);
  if (fence.goalRevision !== undefined) {
    const goal = db.prepare('SELECT revision FROM factory_goals WHERE id=?').get(row.goal_id);
    if (!goal || goal.revision !== fence.goalRevision) throw factoryError('FACTORY_CONFLICT', 'Stale goal revision fence', 409);
  }
  return row;
}

function impact(db,input) {
  const goal=db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(input.goalId,input.organizationId);
  if (!goal) throw factoryError('FACTORY_NOT_FOUND','Goal not found',404);
  if (decode(goal.body_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','Remote execution child is controlled by its source authority');
  if (goal.row_version!==input.expectedVersion) throw factoryError('FACTORY_CONFLICT','Goal version changed');
  const all=db.prepare('SELECT id FROM factory_work_items WHERE goal_id=? AND organization_id=? ORDER BY id').all(goal.id,input.organizationId).map(x=>x.id);
  const roots=input.affectedRootIds;
  if (roots!==undefined && (!Array.isArray(roots) || !roots.length || roots.some(id=>typeof id!=='string' || !all.includes(id)) || new Set(roots).size!==roots.length)) throw factoryError('FACTORY_INVALID','Affected roots must be distinct non-empty work items in this goal',400);
  const selected=(roots!==undefined ? roots : all).slice().sort();
  const partitions=collectGoalDagPartitions(db,input.organizationId,goal.id,selected);
  const facts={
    goalId:goal.id,
    goalRevision:goal.revision,
    goalVersion:goal.row_version,
    roots:selected,
    affectedRootIds:selected,
    items:partitions.items,
    affectedItemIds:partitions.affectedIds,
    unaffectedItems:partitions.unaffectedItems,
    unaffectedItemIds:partitions.unaffectedIds,
    reusableArtifacts:partitions.reusableArtifacts,
  };
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
    const invalidatedWorkItemIds=[];
    for(const affected of plan.facts.items) {
      if(affected.invalidated) continue;
      const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(affected.id,org);
      db.prepare('INSERT INTO factory_work_invalidations VALUES(?,?,?,?,?)').run(row.id,goalId,nextRevision,commandId,ts);
      const next=update(db,row,{
        control_state:affected.activeBindings.length?'cancel_requested':'paused',
        gate_generation:row.gate_generation+1,
        candidate_digest:null,
        ...(affected.activeBindings.length?{}:{execution_epoch:row.execution_epoch+1}),
      });
      invalidatedWorkItemIds.push(row.id);
      event(db,org,row.id,'WorkInvalidatedByGoalRevision',{goalId,goalRevision:nextRevision,commandId,stopRequested:affected.activeBindings.length>0,rowVersion:next.row_version,gateGeneration:next.gate_generation,executionEpoch:next.execution_epoch});
    }
    if(plan.facts.reusableArtifacts.length) {
      event(db,org,goalId,'GoalRevisionPreservedArtifacts',{
        commandId,
        goalRevision:nextRevision,
        reusableWorkItemIds:plan.facts.reusableArtifacts.map(a=>a.workItemId),
        reusableArtifacts:plan.facts.reusableArtifacts.map(a=>({workItemId:a.workItemId,candidateDigest:a.candidateDigest,candidateId:a.candidateId,contractRevision:a.contractRevision,executionEpoch:a.executionEpoch,bindingGeneration:a.bindingGeneration,gateGeneration:a.gateGeneration})),
      });
    }
    const changed=db.prepare('UPDATE factory_goals SET body_json=?,revision=revision+1,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?').run(encode({objective,acceptanceBaseline:input.acceptanceBaseline}),ts,goalId,input.expectedVersion);
    if(!changed.changes) throw factoryError('FACTORY_CONFLICT','Goal version changed');
    event(db,org,goalId,'GoalRevisedWithImpact',{commandId,impactDigest:plan.impactDigest,goalRevision:nextRevision,affectedItemIds:plan.facts.affectedItemIds,unaffectedItemIds:plan.facts.unaffectedItemIds,reusableArtifactCount:plan.facts.reusableArtifacts.length});
    const result={schemaVersion:1,operation:{commandId,state:'completed'},goalId,goalRevision:nextRevision,invalidatedWorkItemIds,unaffectedItems:plan.facts.unaffectedItems,reusableArtifacts:plan.facts.reusableArtifacts,impact:plan.facts,impactDigest:plan.impactDigest};
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,org,actor.principalId,'ReviseGoalWithImpact',goalId,key,payloadDigest,encode(result),ts);return result;
  });
}

// A scoped revision may add manual gates without weakening existing gates.
// Responsibility workflows use fixed catalog contracts and cannot use this.
function manualCriteria(db,root,value) {
  if(value===undefined) return null;
  if(!Array.isArray(value)||value.length<1||value.length>32) throw factoryError('FACTORY_INVALID','One to 32 manual criteria are required',400);
  for(const table of ['responsibility_work_links','responsibility_plan_executions']) {
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT 1 FROM ${table} WHERE goal_id=? LIMIT 1`).get(root.goal_id))
      throw factoryError('FACTORY_CONFLICT','Responsibility workflows require their fixed authorized contract');
  }
  const existing=itemRow(db,root).contract?.acceptanceCriteria;
  if(!Array.isArray(existing)) throw factoryError('FACTORY_CONFLICT','Existing criteria are unavailable');
  const ids=new Set(existing.map(entry=>entry.id));
  return value.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='id,method'||entry.method!=='manual') throw factoryError('FACTORY_INVALID','Only explicit manual criteria may be added',400);
    const id=required(entry.id,'criterion id');if(id!==entry.id||ids.has(id)) throw factoryError('FACTORY_INVALID','Criterion IDs must be normalized and unique',400);ids.add(id);return {id,method:'manual'};
  });
}
function scopedImpact(db,input) {
  const goal=db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(input.goalId,input.organizationId);
  if(!goal) throw factoryError('FACTORY_NOT_FOUND','Goal not found',404);
  if(goal.state!=='active'||goal.row_version!==input.expectedVersion||decode(goal.body_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','Goal is unavailable or changed');
  const root=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND goal_id=? AND organization_id=?').get(input.rootWorkItemId,goal.id,input.organizationId);
  if(!root||root.ownership!=='active'||!['proposed','ready','blocked','failed','review'].includes(root.state)||root.control_state!=='none'||decode(root.source_json,{})?.parentRemoteOperation) throw factoryError('FACTORY_CONFLICT','A stopped, nonterminal local root is required');
  if(db.prepare('SELECT 1 FROM factory_work_invalidations WHERE work_item_id=?').get(root.id)) throw factoryError('FACTORY_CONFLICT','Root was invalidated');
  const partitions=collectGoalDagPartitions(db,input.organizationId,goal.id,[root.id]);
  const items=partitions.items.map(entry=>{
    const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(entry.id,input.organizationId);
    if(row.ownership!=='active'||decode(row.source_json,{})?.parentRemoteOperation||entry.activeBindings.some(b=>b.status==='unknown')) throw factoryError('FACTORY_CONFLICT','Impact contains unsupported or unknown execution');
    if(entry.id===root.id&&entry.activeBindings.length) throw factoryError('FACTORY_CONFLICT','Root execution must be stopped before revision');
    return {id:row.id,goalId:row.goal_id,rowVersion:row.row_version,state:row.state,controlState:row.control_state,contractRevision:row.contract_revision,executionEpoch:row.execution_epoch,bindingGeneration:row.binding_generation,gateGeneration:row.gate_generation,candidateDigest:row.candidate_digest,activeBindings:entry.activeBindings,invalidated:entry.invalidated};
  });
  const added=manualCriteria(db,root,input.additionalManualCriteria);
  const facts={goalId:goal.id,goalRevision:goal.revision,goalVersion:goal.row_version,rootWorkItemId:root.id,objective:required(input.objective,'objective'),...(added?{additionalManualCriteria:added}:{}),items,affectedItemIds:partitions.affectedIds,unaffectedItems:partitions.unaffectedItems,unaffectedItemIds:partitions.unaffectedIds,reusableArtifacts:partitions.reusableArtifacts};
  return {goal,root,facts,impactDigest:digest(facts)};
}
export async function previewFactoryScopedRevision(input,actor) {
  if(input?.revisions!==undefined) return previewFactoryMultiScopedRevision(input,actor);
  owner(actor); required(input?.organizationId,'organizationId'); required(input?.goalId,'goalId'); required(input?.rootWorkItemId,'rootWorkItemId');
  return factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.read');const plan=scopedImpact(db,input);return {schemaVersion:1,...plan.facts,impactDigest:plan.impactDigest};});
}
export async function reviseFactoryScopeWithImpact(input,actor) {
  if(input?.revisions!==undefined) return reviseFactoryMultiScopeWithImpact(input,actor);
  owner(actor); const org=required(input?.organizationId,'organizationId'),goalId=required(input?.goalId,'goalId'),rootId=required(input?.rootWorkItemId,'rootWorkItemId');
  const commandId=required(input.commandId,'commandId'),key=required(input.idempotencyKey,'idempotencyKey');
  const payloadDigest=digest({org,goalId,rootId,expectedVersion:input.expectedVersion,objective:input.objective,impactDigest:input.impactDigest,...(input.additionalManualCriteria!==undefined?{additionalManualCriteria:input.additionalManualCriteria}:{})});
  return factoryTransaction(db=>{
    authorize(db,org,actor,'factory.AmendContract');
    const prior=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actor.principalId,'ReviseFactoryScope',rootId,key);
    if(prior){if(prior.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Revision key reused with different inputs');return {...decode(prior.result_json,{}),replayed:true};}
    if(db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const plan=scopedImpact(db,input);if(!input.impactDigest||input.impactDigest!==plan.impactDigest) throw factoryError('FACTORY_CONFLICT','Impact preview changed');
    const ts=now();
    const invalidatedWorkItemIds=[];
    for(const affected of plan.facts.items) {
      if(affected.id===rootId||affected.invalidated) continue;
      const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(affected.id,org);
      db.prepare('INSERT INTO factory_work_invalidations VALUES(?,?,?,?,?)').run(row.id,goalId,plan.goal.revision,commandId,ts);
      const next=update(db,row,{
        control_state:affected.activeBindings.length?'cancel_requested':'paused',
        gate_generation:row.gate_generation+1,
        candidate_digest:null,
        ...(affected.activeBindings.length?{}:{execution_epoch:row.execution_epoch+1}),
      });
      invalidatedWorkItemIds.push(row.id);
      event(db,org,row.id,'WorkInvalidatedByScopedRevision',{goalId,rootWorkItemId:rootId,commandId,stopRequested:affected.activeBindings.length>0,rowVersion:next.row_version,gateGeneration:next.gate_generation,executionEpoch:next.execution_epoch});
    }
    const previous=itemRow(db,plan.root).contract;
    const contract={...previous,objective:plan.facts.objective,...(plan.facts.additionalManualCriteria?{acceptanceCriteria:[...previous.acceptanceCriteria,...plan.facts.additionalManualCriteria]}:{})};
    const revision=plan.root.contract_revision+1;
    db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(rootId,revision,encode(contract),digest(contract),ts);
    const root=update(db,plan.root,{contract_revision:revision,state:'proposed',candidate_digest:null,execution_epoch:plan.root.execution_epoch+1,gate_generation:plan.root.gate_generation+1,blocked_json:null});
    event(db,org,rootId,'WorkScopedRevision',{commandId,impactDigest:plan.impactDigest,contractRevision:revision,executionEpoch:root.execution_epoch,gateGeneration:root.gate_generation});
    if(plan.facts.reusableArtifacts.length) {
      event(db,org,goalId,'GoalRevisionPreservedArtifacts',{commandId,goalRevision:plan.goal.revision,reusableWorkItemIds:plan.facts.reusableArtifacts.map(a=>a.workItemId)});
    }
    const result={schemaVersion:1,operation:{commandId,state:'completed'},goalId,goalRevision:plan.goal.revision,rootWorkItemId:rootId,contractRevision:revision,item:itemRow(db,root),invalidatedWorkItemIds,unaffectedItems:plan.facts.unaffectedItems,reusableArtifacts:plan.facts.reusableArtifacts,impact:plan.facts,impactDigest:plan.impactDigest};
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,org,actor.principalId,'ReviseFactoryScope',rootId,key,payloadDigest,encode(result),ts);return result;
  });
}

// Keep the original single-root contract and receipt identity intact. The
// multi-root form is one atomic command with a separately scoped receipt.
function normalizeScopedRevisions(input) {
  if(input.rootWorkItemId!==undefined || input.objective!==undefined || input.additionalManualCriteria!==undefined || !Array.isArray(input.revisions) || input.revisions.length<2 || input.revisions.length>32)
    throw factoryError('FACTORY_INVALID','Two to 32 scoped revisions are required without single-root fields',400);
  const revisions=input.revisions.map(entry=>{
    if(!entry || typeof entry!=='object' || Array.isArray(entry) || Object.keys(entry).some(key=>!['rootWorkItemId','objective','additionalManualCriteria'].includes(key)))
      throw factoryError('FACTORY_INVALID','Invalid scoped revision',400);
    return {rootWorkItemId:required(entry.rootWorkItemId,'rootWorkItemId'),objective:required(entry.objective,'objective'),...(entry.additionalManualCriteria!==undefined?{additionalManualCriteria:entry.additionalManualCriteria}:{})};
  }).sort((a,b)=>a.rootWorkItemId<b.rootWorkItemId?-1:a.rootWorkItemId>b.rootWorkItemId?1:0);
  if(new Set(revisions.map(entry=>entry.rootWorkItemId)).size!==revisions.length) throw factoryError('FACTORY_INVALID','Scoped roots must be distinct',400);
  return revisions;
}
function multiScopedImpact(db,input,revisions) {
  const roots=new Set(revisions.map(entry=>entry.rootWorkItemId)),items=new Map(),plans=[];
  for(const revision of revisions) {
    const plan=scopedImpact(db,{...input,...revision});
    if(plan.facts.items.some(item=>item.id!==revision.rootWorkItemId && roots.has(item.id)))
      throw factoryError('FACTORY_CONFLICT','Scoped roots must not depend on one another');
    plans.push(plan);
    for(const item of plan.facts.items) items.set(item.id,item);
  }
  const goal=plans[0].goal;
  const partitions=collectGoalDagPartitions(db,input.organizationId,goal.id,[...roots].sort());
  const facts={goalId:goal.id,goalRevision:goal.revision,goalVersion:goal.row_version,revisions,items:[...items.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),affectedItemIds:partitions.affectedIds,unaffectedItems:partitions.unaffectedItems,unaffectedItemIds:partitions.unaffectedIds,reusableArtifacts:partitions.reusableArtifacts};
  return {goal,plans,facts,impactDigest:digest(facts)};
}
async function previewFactoryMultiScopedRevision(input,actor) {
  owner(actor);required(input?.organizationId,'organizationId');required(input?.goalId,'goalId');
  const revisions=normalizeScopedRevisions(input);
  return factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.read');const plan=multiScopedImpact(db,input,revisions);return {schemaVersion:1,...plan.facts,impactDigest:plan.impactDigest};});
}
async function reviseFactoryMultiScopeWithImpact(input,actor) {
  owner(actor);const org=required(input?.organizationId,'organizationId'),goalId=required(input?.goalId,'goalId');
  const commandId=required(input.commandId,'commandId'),key=required(input.idempotencyKey,'idempotencyKey'),revisions=normalizeScopedRevisions(input);
  const payloadDigest=digest({org,goalId,expectedVersion:input.expectedVersion,revisions,impactDigest:input.impactDigest});
  return factoryTransaction(db=>{
    authorize(db,org,actor,'factory.AmendContract');
    const prior=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actor.principalId,'ReviseFactoryMultiScope',goalId,key);
    if(prior){if(prior.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Revision key reused with different inputs');return {...decode(prior.result_json,{}),replayed:true};}
    if(db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const plan=multiScopedImpact(db,input,revisions);
    if(!input.impactDigest || input.impactDigest!==plan.impactDigest) throw factoryError('FACTORY_CONFLICT','Impact preview changed');
    const roots=new Set(revisions.map(entry=>entry.rootWorkItemId)),ts=now();
    const invalidatedWorkItemIds=[];
    for(const affected of plan.facts.items) {
      if(roots.has(affected.id)||affected.invalidated) continue;
      const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(affected.id,org);
      db.prepare('INSERT INTO factory_work_invalidations VALUES(?,?,?,?,?)').run(row.id,goalId,plan.goal.revision,commandId,ts);
      const next=update(db,row,{
        control_state:affected.activeBindings.length?'cancel_requested':'paused',
        gate_generation:row.gate_generation+1,
        candidate_digest:null,
        ...(affected.activeBindings.length?{}:{execution_epoch:row.execution_epoch+1}),
      });
      invalidatedWorkItemIds.push(row.id);
      event(db,org,row.id,'WorkInvalidatedByScopedRevision',{goalId,rootWorkItemIds:[...roots],commandId,stopRequested:affected.activeBindings.length>0,rowVersion:next.row_version,gateGeneration:next.gate_generation,executionEpoch:next.execution_epoch});
    }
    const results=[];
    for(const entry of plan.plans) {
      const previous=itemRow(db,entry.root).contract;
      const contract={...previous,objective:entry.facts.objective,...(entry.facts.additionalManualCriteria?{acceptanceCriteria:[...previous.acceptanceCriteria,...entry.facts.additionalManualCriteria]}:{})},revision=entry.root.contract_revision+1;
      db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(entry.root.id,revision,encode(contract),digest(contract),ts);
      const root=update(db,entry.root,{contract_revision:revision,state:'proposed',candidate_digest:null,execution_epoch:entry.root.execution_epoch+1,gate_generation:entry.root.gate_generation+1,blocked_json:null});
      event(db,org,root.id,'WorkScopedRevision',{commandId,impactDigest:plan.impactDigest,contractRevision:revision,executionEpoch:root.execution_epoch,gateGeneration:root.gate_generation});
      results.push({rootWorkItemId:root.id,contractRevision:revision,item:itemRow(db,root)});
    }
    if(plan.facts.reusableArtifacts.length) {
      event(db,org,goalId,'GoalRevisionPreservedArtifacts',{commandId,goalRevision:plan.goal.revision,reusableWorkItemIds:plan.facts.reusableArtifacts.map(a=>a.workItemId)});
    }
    const result={schemaVersion:1,operation:{commandId,state:'completed'},goalId,goalRevision:plan.goal.revision,revisions:results,invalidatedWorkItemIds,unaffectedItems:plan.facts.unaffectedItems,reusableArtifacts:plan.facts.reusableArtifacts,impact:plan.facts,impactDigest:plan.impactDigest};
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,org,actor.principalId,'ReviseFactoryMultiScope',goalId,key,payloadDigest,encode(result),ts);return result;
  });
}

export async function getFactoryGoalRevisionArtifacts({ organizationId, goalId }, actor) {
  owner(actor);
  const org = required(organizationId, 'organizationId');
  const gid = required(goalId, 'goalId');
  return factoryRead(db => {
    authorize(db, org, actor, 'factory.read');
    const goal = db.prepare('SELECT * FROM factory_goals WHERE id=? AND organization_id=?').get(gid, org);
    if (!goal) throw factoryError('FACTORY_NOT_FOUND', 'Goal not found', 404);
    const rows = db.prepare('SELECT * FROM factory_work_items WHERE goal_id=? AND organization_id=? ORDER BY id').all(gid, org);
    const invalidatedItems = [];
    const reusableArtifacts = [];
    const activeItems = [];
    for (const row of rows) {
      const inv = db.prepare('SELECT goal_revision,command_id,created_at FROM factory_work_invalidations WHERE work_item_id=?').get(row.id);
      if (inv) {
        invalidatedItems.push({ workItemId: row.id, state: row.state, controlState: row.control_state, goalRevision: inv.goal_revision, commandId: inv.command_id, invalidatedAt: inv.created_at });
      } else {
        const artifact = buildReusableArtifact(db, row);
        if (artifact) reusableArtifacts.push(artifact);
        activeItems.push(itemRow(db, row));
      }
    }
    return { schemaVersion: 1, goal: goalRow(goal), invalidatedItems, reusableArtifacts, activeItems };
  });
}
