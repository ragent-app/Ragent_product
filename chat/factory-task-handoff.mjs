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
function sourceRefs(db,organizationId,workItemId,contractRevision,executionEpoch) {
  const dependencies=db.prepare('SELECT predecessor_id,milestone,candidate_digest FROM factory_dependencies WHERE successor_id=? ORDER BY predecessor_id LIMIT 101').all(workItemId);
  const bindings=db.prepare('SELECT id,contract_revision,execution_epoch,binding_generation,status,attempt_id,run_id FROM factory_execution_bindings WHERE work_item_id=? ORDER BY execution_epoch DESC,id LIMIT 51').all(workItemId);
  const candidates=db.prepare('SELECT id,digest,contract_revision,execution_epoch FROM factory_candidates WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const decisions=db.prepare('SELECT id,criterion_id,decision,candidate_digest,contract_revision FROM factory_acceptance_decisions WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const failures=db.prepare("SELECT a.id,a.run_id,a.failure_kind FROM factory_execution_bindings b JOIN collaboration_attempts a ON a.id=b.attempt_id WHERE b.work_item_id=? AND a.state='failed' ORDER BY a.id LIMIT 51").all(workItemId);
  const hasMessages=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_messages'").get();
  const hasReplies=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_replies'").get();
  const hasRespondBy=hasMessages && db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c=>c.name==='respond_by');
  const questions=hasMessages && hasReplies ? db.prepare(`SELECT m.message_id,${hasRespondBy?'m.respond_by':'NULL AS respond_by'} FROM organization_team_messages m WHERE m.organization_id=? AND m.work_item_id=? AND m.request_type='required_response' AND NOT EXISTS (SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) ORDER BY m.created_at,m.message_id LIMIT 51`).all(organizationId,workItemId) : [];
  const hasRelations=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relations'").get();
  const hasChanges=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relation_changes'").get();
  const relationVersion=hasRelations ? (hasChanges ? db.prepare('SELECT MAX(version) AS version FROM (SELECT version FROM organization_team_relations WHERE organization_id=? UNION ALL SELECT version FROM organization_team_relation_changes WHERE organization_id=?)').get(organizationId,organizationId).version : db.prepare('SELECT MAX(version) AS version FROM organization_team_relations WHERE organization_id=?').get(organizationId).version) || 0 : 0;
  return {workItemId,contractRevision,executionEpoch,relationVersion,dependencies:dependencies.slice(0,100),bindings:bindings.slice(0,50),candidates:candidates.slice(0,50),decisions:decisions.slice(0,50),failures:failures.slice(0,50),unansweredMessageRefs:hasMessages && hasReplies ? questions.slice(0,50) : 'unknown',remainingBudget:'unknown',truncated:dependencies.length>100||bindings.length>50||candidates.length>50||decisions.length>50||failures.length>50||questions.length>50};
}
function publicHandoff(db,row,item,org) { const facts=decode(row.snapshot_json,{}); const current=item && sourceRefs(db,row.organization_id,row.work_item_id,item.contract_revision,item.execution_epoch); return {id:row.id,organizationId:row.organization_id,workItemId:row.work_item_id,contractRevision:row.contract_revision,executionEpoch:row.execution_epoch,organizationRevision:row.organization_revision,asOf:row.created_at,sourceVersion:row.row_version,stale:!item || facts.sourceRefs?.truncated === true || item.row_version!==row.row_version || item.contract_revision!==row.contract_revision || item.execution_epoch!==row.execution_epoch || org.current_revision!==row.organization_revision || JSON.stringify(current)!==JSON.stringify(facts.sourceRefs),facts,schemaVersion:1}; }
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
