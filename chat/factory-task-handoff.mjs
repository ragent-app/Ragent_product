// Immutable, bounded references to Work Graph facts. A handoff is context,
// not an authorization or a replacement for the underlying records.
import { randomUUID, createHash } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode, itemRow } from './work-graph-store.mjs';
import { authorize, selectItem, required } from './work-graph.mjs';

function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_task_handoffs (
  id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,work_item_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,payload_digest TEXT NOT NULL,row_version INTEGER NOT NULL,contract_revision INTEGER NOT NULL,
  execution_epoch INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,organization_revision INTEGER NOT NULL
); CREATE TRIGGER IF NOT EXISTS factory_task_handoff_immutable_update BEFORE UPDATE ON factory_task_handoffs BEGIN SELECT RAISE(ABORT,'immutable task handoff'); END;
CREATE TRIGGER IF NOT EXISTS factory_task_handoff_immutable_delete BEFORE DELETE ON factory_task_handoffs BEGIN SELECT RAISE(ABORT,'immutable task handoff'); END;`); }
function safeFact(value,depth=0) {
  if(depth>5) return null;
  if(typeof value==='string') return value.slice(0,2000);
  if(value===null || typeof value==='boolean' || typeof value==='number') return value;
  if(Array.isArray(value)) return value.slice(0,50).map(entry=>safeFact(entry,depth+1));
  if(!value || typeof value!=='object') return null;
  const output={}; for(const [key,entry] of Object.entries(value).slice(0,50)) {
    if(/secret|credential|token|password|private.?key|cookie|environment/i.test(key)) continue;
    output[key]=safeFact(entry,depth+1);
  } return output;
}
function sourceRefs(db,organizationId,workItemId,contractRevision,executionEpoch,{skipMessages=false}={}) {
  const dependencies=db.prepare('SELECT predecessor_id,milestone,candidate_digest FROM factory_dependencies WHERE successor_id=? ORDER BY predecessor_id LIMIT 101').all(workItemId);
  const bindings=db.prepare('SELECT id,contract_revision,execution_epoch,binding_generation,status,attempt_id,run_id FROM factory_execution_bindings WHERE work_item_id=? ORDER BY execution_epoch DESC,id LIMIT 51').all(workItemId);
  const candidates=db.prepare('SELECT id,digest,contract_revision,execution_epoch FROM factory_candidates WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const decisions=db.prepare('SELECT id,criterion_id,decision,candidate_digest,contract_revision FROM factory_acceptance_decisions WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const failures=db.prepare("SELECT a.id,a.run_id,a.failure_kind FROM factory_execution_bindings b JOIN collaboration_attempts a ON a.id=b.attempt_id WHERE b.work_item_id=? AND a.state='failed' ORDER BY a.created_at DESC,a.id DESC LIMIT 51").all(workItemId);
  const hasMessages=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_messages'").get();
  const hasReplies=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_replies'").get();
  const hasRespondBy=hasMessages && db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c=>c.name==='respond_by');
  const questions=hasMessages && hasReplies && !skipMessages ? db.prepare(`SELECT m.message_id,${hasRespondBy?'m.respond_by':'NULL AS respond_by'} FROM organization_team_messages m WHERE m.organization_id=? AND m.work_item_id=? AND m.request_type='required_response' AND NOT EXISTS (SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) ORDER BY m.created_at,m.message_id LIMIT 51`).all(organizationId,workItemId) : [];
  const hasRelations=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relations'").get();
  const hasChanges=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relation_changes'").get();
  const relationVersion=hasRelations ? (hasChanges ? db.prepare('SELECT MAX(version) AS version FROM (SELECT version FROM organization_team_relations WHERE organization_id=? UNION ALL SELECT version FROM organization_team_relation_changes WHERE organization_id=?)').get(organizationId,organizationId).version : db.prepare('SELECT MAX(version) AS version FROM organization_team_relations WHERE organization_id=?').get(organizationId).version) || 0 : 0;
  return {workItemId,contractRevision,executionEpoch,relationVersion,dependencies:dependencies.slice(0,100),bindings:bindings.slice(0,50),candidates:candidates.slice(0,50),decisions:decisions.slice(0,50),failures:failures.slice(0,50),unansweredMessageRefs:hasMessages && hasReplies ? questions.slice(0,50) : 'unknown',remainingBudget:'unknown',truncated:dependencies.length>100||bindings.length>50||candidates.length>50||decisions.length>50||failures.length>50||questions.length>50};
}
function workerRefs(db,organizationId,workItemId,contractRevision,executionEpoch,nodeId) {
  const refs=sourceRefs(db,organizationId,workItemId,contractRevision,executionEpoch,{skipMessages:true});
  for (const key of ['dependencies','bindings','candidates','decisions','failures']) {
    if (refs[key].length>5) refs.truncated=true;
    refs[key]=refs[key].slice(0,5);
    refs[key]=refs[key].filter(entry=>{ const fits=Buffer.byteLength(encode(entry),'utf8')<=300; if(!fits) refs.truncated=true; return fits; });
  }
  if (Array.isArray(refs.unansweredMessageRefs)) {
    const hasRespondBy=db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c=>c.name==='respond_by');
    const messages=db.prepare(`SELECT m.message_id,m.body AS full_body,${hasRespondBy?'m.respond_by':'NULL AS respond_by'} FROM organization_team_messages m WHERE m.organization_id=? AND m.work_item_id=? AND m.recipient_node_id=? AND m.request_type='required_response' AND NOT EXISTS (SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 6`).all(organizationId,workItemId,nodeId).map(({full_body,...entry})=>({...entry,body:String(full_body || '').slice(0,100),body_truncated:String(full_body || '').length>100,body_digest:createHash('sha256').update(String(full_body || '')).digest('hex')}));
    refs.unansweredMessageRefs=messages.slice(0,5).filter(entry=>{ const fits=Buffer.byteLength(encode(entry),'utf8')<=700; if(!fits) refs.truncated=true; return fits; });
    refs.truncated=refs.truncated || messages.length>5 || messages.some(message=>message.body_truncated);
  }
  return refs;
}
function publicHandoff(db,row,item,org) { const facts=decode(row.snapshot_json,{}); const current=item && (facts.workerScope ? workerRefs(db,row.organization_id,row.work_item_id,item.contract_revision,item.execution_epoch,facts.workerScope.nodeId) : sourceRefs(db,row.organization_id,row.work_item_id,item.contract_revision,item.execution_epoch)); return {id:row.id,organizationId:row.organization_id,workItemId:row.work_item_id,contractRevision:row.contract_revision,executionEpoch:row.execution_epoch,organizationRevision:row.organization_revision,asOf:row.created_at,sourceVersion:row.row_version,stale:!item || (!facts.workerScope && facts.sourceRefs?.truncated === true) || item.row_version!==row.row_version || item.contract_revision!==row.contract_revision || item.execution_epoch!==row.execution_epoch || org.current_revision!==row.organization_revision || (facts.workerScope && (item.assignee_node_id!==facts.workerScope.nodeId || item.binding_generation!==facts.workerScope.bindingGeneration)) || JSON.stringify(current)!==JSON.stringify(facts.sourceRefs),freshness:facts.workerScope && (facts.sourceRefs?.truncated || facts.contractTruncated || facts.blockedReasonTruncated)?'unknown_truncated':'checked',facts,schemaVersion:1}; }

// Internal dispatch path only. The caller must enforce the scheduler lease and
// current grant fence immediately before and after this transaction.
export async function prepareFactoryWorkerHandoff(scope) {
  const {organizationId,workItemId,nodeId,contractRevision,executionEpoch,bindingGeneration,nodeBindingGeneration,organizationRevision,dispatchKey,managedSessionId}=scope || {};
  if (![organizationId,workItemId,nodeId,dispatchKey,managedSessionId].every(value=>typeof value==='string' && value) || ![contractRevision,executionEpoch,bindingGeneration,nodeBindingGeneration,organizationRevision].every(Number.isInteger)) throw factoryError('FACTORY_INVALID','Incomplete worker handoff scope',400);
  return factoryTransaction(db=>{
    schema(db);
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
    const item=selectItem(db,organizationId,workItemId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND dispatch_key=?').get(workItemId,dispatchKey);
    const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId);
    if (!org || org.state!=='active' || org.current_revision!==organizationRevision || item.assignee_node_id!==nodeId || item.state!=='claimed' || item.control_state!=='none' || item.contract_revision!==contractRevision || item.execution_epoch!==executionEpoch || item.binding_generation!==bindingGeneration || !node || node.retired_revision!==null || node.current_session_id!==managedSessionId || node.binding_generation!==nodeBindingGeneration || !binding || binding.status!=='intent' || binding.contract_revision!==contractRevision || binding.execution_epoch!==executionEpoch || binding.binding_generation!==bindingGeneration) throw factoryError('FACTORY_CONFLICT','Worker handoff scope changed');
    const work=itemRow(db,item), refs=workerRefs(db,organizationId,workItemId,contractRevision,executionEpoch,nodeId);
    let contract=safeFact(work.contract); const contractTooLarge=Buffer.byteLength(encode(contract),'utf8')>12000; const contractTruncated=contractTooLarge || encode(contract)!==encode(work.contract); if(contractTooLarge) contract={omitted:'Contract details exceed the context limit; use the bound task contract.'};
    let blockedReason=safeFact(work.blockedReason); const blockedReasonTooLarge=Buffer.byteLength(encode(blockedReason),'utf8')>2000; const blockedReasonTruncated=blockedReasonTooLarge || encode(blockedReason)!==encode(work.blockedReason); if(blockedReasonTooLarge) blockedReason={omitted:'Blocked reason exceeds the context limit.'};
    const snapshot={state:work.state,controlState:work.controlState,assigneeNodeId:nodeId,contract,contractTruncated,contractDigest:work.contractDigest,blockedReason,blockedReasonTruncated,sourceRefs:refs,workerScope:{nodeId,bindingGeneration,nodeBindingGeneration},summaryLimits:'Selected sources are bounded; text fields and recipient message bodies may be shortened. Full contract and source records remain authoritative.'};
    if(Buffer.byteLength(encode(snapshot),'utf8')>32768) throw factoryError('FACTORY_INVALID','Task context exceeds its bounded size',400);
    const commandId=`handoff_dispatch_${createHash('sha256').update(JSON.stringify([organizationId,workItemId,dispatchKey,item.row_version,organizationRevision,snapshot])).digest('hex')}`;
    const existing=db.prepare('SELECT policy_json FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,dispatchKey);
    if (existing) {
      const fixed=decode(existing.policy_json,{})?.factoryExecution;
      const prior=fixed?.handoffId && db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=? AND work_item_id=?').get(fixed.handoffId,organizationId,workItemId);
      if (!prior || fixed.handoffDigest!==createHash('sha256').update(prior.snapshot_json).digest('hex') || prior.command_id!==commandId || publicHandoff(db,prior,item,org).stale) throw factoryError('FACTORY_CONFLICT','Existing dispatch handoff is stale; reconcile the fixed dispatch');
      return publicHandoff(db,prior,item,org);
    }
    if (binding.collaboration_id || binding.task_id || binding.attempt_id || binding.run_id || db.prepare('SELECT 1 FROM collaboration_dispatch_commands d LEFT JOIN collaborations c ON c.id=d.collaboration_id WHERE d.task_id=? AND c.id IS NULL LIMIT 1').get(workItemId)) throw factoryError('FACTORY_CONFLICT','Dispatch facts are incomplete; reconcile before preparing new input');
    const prior=db.prepare('SELECT * FROM factory_task_handoffs WHERE command_id=?').get(commandId);
    if (prior) { const result=publicHandoff(db,prior,item,org); if(result.stale) throw factoryError('FACTORY_CONFLICT','Dispatch handoff is stale'); return result; }
    const id=`handoff_${randomUUID()}`,ts=now(),payloadDigest=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    db.prepare('INSERT INTO factory_task_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,organizationId,workItemId,commandId,'factory-dispatch-service',payloadDigest,item.row_version,contractRevision,executionEpoch,encode(snapshot),ts,organizationRevision);
    return publicHandoff(db,db.prepare('SELECT * FROM factory_task_handoffs WHERE id=?').get(id),item,org);
  });
}

export function verifyFactoryWorkerHandoff(db,context) {
  const row=db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=? AND work_item_id=?').get(context.handoffId,context.organizationId,context.workItemId);
  if (!row || createHash('sha256').update(row.snapshot_json).digest('hex')!==context.handoffDigest) return false;
  const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(context.organizationId), item=selectItem(db,context.organizationId,context.workItemId);
  const facts=decode(row.snapshot_json,{}), node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assignee_node_id,context.organizationId);
  return !!org && !!node && facts.workerScope?.nodeId===node.id && facts.workerScope?.bindingGeneration===context.bindingGeneration && facts.workerScope?.nodeBindingGeneration===node.binding_generation && node.current_session_id===context.managedSessionId && row.contract_revision===context.contractRevision && row.execution_epoch===context.executionEpoch && !publicHandoff(db,row,item,org).stale;
}
export async function createFactoryTaskHandoff(input,actor) {
  const organizationId=required(input?.organizationId,'organizationId'),workItemId=required(input?.workItemId,'workItemId'),commandId=required(input?.commandId,'commandId');
  if(actor?.kind!=='user' || actor?.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const payloadDigest=createHash('sha256').update(JSON.stringify({organizationId,workItemId,expectedVersion:input.expectedVersion,actor:actor.principalId})).digest('hex');
  return factoryTransaction(db=>{ schema(db); const org=authorize(db,organizationId,actor,'factory.read');
    const old=db.prepare('SELECT * FROM factory_task_handoffs WHERE command_id=?').get(commandId);
    if(old) { if(old.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Command ID belongs to another handoff'); return {...publicHandoff(db,old,selectItem(db,organizationId,workItemId),org),replayed:true}; }
    if (['archived','lifecycle_pending'].includes(org.state)) throw factoryError('FACTORY_CONFLICT','Organization lifecycle does not permit new handoffs');
    const row=selectItem(db,organizationId,workItemId); if(row.row_version!==input.expectedVersion) throw factoryError('FACTORY_CONFLICT','Work item version changed');
    const item=itemRow(db,row);
    const snapshot={state:item.state,controlState:item.controlState,assigneeNodeId:item.assigneeNodeId,contract:safeFact(item.contract),
      contractDigest:item.contractDigest,blockedReason:safeFact(item.blockedReason),sourceRefs:sourceRefs(db,organizationId,workItemId,item.contractRevision,item.executionEpoch)};
    if(Buffer.byteLength(encode(snapshot),'utf8')>32768) throw factoryError('FACTORY_INVALID','Task context exceeds its bounded size',400);
    const id=`handoff_${randomUUID()}`,ts=now(); db.prepare('INSERT INTO factory_task_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,organizationId,workItemId,commandId,actor.principalId,payloadDigest,row.row_version,row.contract_revision,row.execution_epoch,encode(snapshot),ts,org.current_revision);
    return publicHandoff(db,db.prepare('SELECT * FROM factory_task_handoffs WHERE id=?').get(id),row,org);
  });
}
export async function getFactoryTaskHandoff(organizationId,id,actor) {
  return factoryRead(db=>{ schema(db); const org=authorize(db,organizationId,actor,'factory.read'); const row=db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=?').get(id,organizationId); if(!row) throw factoryError('FACTORY_NOT_FOUND','Handoff not found',404); return publicHandoff(db,row,selectItem(db,organizationId,row.work_item_id),org); });
}
