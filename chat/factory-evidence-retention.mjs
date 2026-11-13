// Explicit retirement only: no time-based sweep, no implicit deletion.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { discardStaging } from './managed-writer.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { streamStoredEvents } from './history.mjs';
import { collectUnansweredApprovalRequestsFromHistory } from './session-manager.mjs';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode, digest } from './work-graph-store.mjs';
import { authorize, required } from './work-graph.mjs';
const fail=(message,code='FACTORY_RETENTION_BLOCKED')=>{throw factoryError(code,message,409);};
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function schema(db){db.exec(`CREATE TABLE IF NOT EXISTS factory_retirement_operations (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,preview_digest TEXT NOT NULL,source_json TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(organization_id,actor_id,idempotency_key));`);}
function owner(actor){if(actor?.kind!=='user'||actor?.role!=='owner'||!actor.principalId)throw factoryError('FACTORY_FORBIDDEN','Owner required',403);}
function scoped(db,organizationId,kind,id){
 const blockers=[];let path='',source;
 if(has(db,'organization_operations')&&db.prepare("SELECT 1 FROM organization_operations WHERE organization_id=? AND state NOT IN ('completed','failed_terminal','cancelled') LIMIT 1").get(organizationId)) blockers.push('organization_operation_pending');
 if(has(db,'orchestration_interrupts')&&db.prepare("SELECT 1 FROM orchestration_interrupts WHERE state IN ('pending','waiting','open') LIMIT 1").get()) blockers.push('approval_pending_or_unscoped');
 if(kind==='validation'){
  if(!has(db,'factory_validation_workspaces'))fail('Validation workspace unavailable');
  const w=db.prepare(`SELECT v.*,i.organization_id,i.state AS item_state,i.control_state FROM factory_validation_workspaces v JOIN factory_work_items i ON i.id=v.validation_work_item_id WHERE v.id=? AND i.organization_id=?`).get(id,organizationId);if(!w)fail('Validation workspace not found','FACTORY_NOT_FOUND');
  path=w.cwd;source={workspaceId:w.id,workItemId:w.validation_work_item_id,runId:w.run_id,sessionId:w.session_id,candidateDigest:w.candidate_digest,manifestDigest:digest(decode(w.input_manifest_json,[])),provenance:w.provenance};
  if(!['sealed','retiring'].includes(w.state)||!['completed','failed','cancelled'].includes(w.item_state)||w.control_state!=='none')blockers.push('validation_not_terminal');
  if(db.prepare("SELECT 1 FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown') LIMIT 1").get(w.validation_work_item_id))blockers.push('active_or_unknown_binding');
  if(db.prepare("SELECT 1 FROM factory_dependencies d JOIN factory_work_items p ON p.id=d.predecessor_id WHERE d.successor_id=? AND p.state NOT IN ('completed','failed','cancelled') LIMIT 1").get(w.validation_work_item_id))blockers.push('candidate_still_actionable');
  if(has(db,'factory_combination_validations')&&db.prepare("SELECT 1 FROM factory_combination_validations v JOIN factory_integration_queue q ON q.id=v.queue_id WHERE v.validation_work_item_id=? AND q.state NOT IN ('integrated','stale') LIMIT 1").get(w.validation_work_item_id))blockers.push('combination_still_actionable');
  if(has(db,'factory_check_operations')&&db.prepare("SELECT 1 FROM factory_check_operations WHERE workspace_id=? AND (evidence_json IS NULL OR state NOT IN ('passed','failed')) LIMIT 1").get(w.id))blockers.push('check_not_final');
  if(has(db,'factory_combination_checks')&&db.prepare("SELECT 1 FROM factory_combination_checks WHERE workspace_id=? AND (evidence_json IS NULL OR state NOT IN ('passed','failed')) LIMIT 1").get(w.id))blockers.push('combination_check_not_final');
  if(db.prepare('SELECT 1 FROM factory_validation_workspaces WHERE cwd=? AND id<>? LIMIT 1').get(path,w.id))blockers.push('directory_shared');
  if(has(db,'factory_integration_queue')&&db.prepare('SELECT 1 FROM factory_integration_queue WHERE workspace=? LIMIT 1').get(path))blockers.push('directory_shared');
 } else if(kind==='combination'){
  if(!has(db,'factory_integration_queue'))fail('Combination unavailable');const q=db.prepare('SELECT * FROM factory_integration_queue WHERE id=? AND organization_id=?').get(id,organizationId);if(!q)fail('Combination not found','FACTORY_NOT_FOUND');
  path=q.workspace;source={queueId:q.id,inputDigest:q.input_digest,combinationDigest:q.combination_digest,baseHead:q.base_head,inputs:decode(q.inputs_json,[]),manifestDigest:digest(decode(q.manifest_json,[]))};
  if(has(db,'factory_combination_validations')&&!has(db,'factory_validation_workspaces')&&db.prepare('SELECT 1 FROM factory_combination_validations WHERE queue_id=?').get(q.id))blockers.push('validation_workspace_unavailable');
  source.validationRuns=has(db,'factory_combination_validations')&&has(db,'factory_validation_workspaces')?db.prepare('SELECT w.run_id AS runId,w.session_id AS sessionId FROM factory_combination_validations v LEFT JOIN factory_validation_workspaces w ON w.validation_work_item_id=v.validation_work_item_id WHERE v.queue_id=? ORDER BY v.validation_work_item_id,w.id').all(q.id):[];
  if(!['integrated','stale','retiring'].includes(q.state))blockers.push('combination_not_terminal');
  if(has(db,'factory_combination_validations')&&db.prepare("SELECT 1 FROM factory_combination_validations v JOIN factory_work_items i ON i.id=v.validation_work_item_id WHERE v.queue_id=? AND (i.state NOT IN ('completed','failed','cancelled') OR i.control_state<>'none') LIMIT 1").get(q.id))blockers.push('validation_still_actionable');
  if(has(db,'factory_combination_validations')&&db.prepare("SELECT 1 FROM factory_combination_validations v JOIN factory_execution_bindings b ON b.work_item_id=v.validation_work_item_id WHERE v.queue_id=? AND b.status IN ('intent','running','unknown') LIMIT 1").get(q.id))blockers.push('active_or_unknown_binding');
  if(has(db,'factory_validation_workspaces')&&db.prepare('SELECT 1 FROM factory_validation_workspaces WHERE cwd=? LIMIT 1').get(path))blockers.push('directory_shared');
  if(db.prepare('SELECT 1 FROM factory_integration_queue WHERE workspace=? AND id<>? LIMIT 1').get(path,q.id))blockers.push('directory_shared');
 } else fail('Unknown retirement target','FACTORY_INVALID');
 if(typeof path!=='string'||!path)blockers.push('workspace_unavailable');return {kind,id,path,source,blockers};
}
async function checkedPath(path){const root=await realpath(join(MANAGED_WORK_ROOT_DIR,'managed-writer-staging'));const before=await lstat(path);if(!before.isDirectory()||before.isSymbolicLink())fail('Staging target is not a regular directory');const actual=await realpath(path),rel=relative(root,actual);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`)||dirname(actual)!==root||!basename(actual).startsWith('sw__'))fail('Staging target is outside its owned root');return {root,actual,dev:before.dev,ino:before.ino};}
async function runBlocker(data){
 if(data.kind==='combination'){for(const source of data.source.validationRuns||[]){const issue=await runBlocker({kind:'validation',source});if(issue)return issue;}return null;}
 if(data.kind!=='validation')return 'unsupported_target';
 if(!data.source.runId||!data.source.sessionId)return 'run_identity_unavailable';
 try {const run=await getRunAcceptanceEvidence(data.source.runId);if(!run||run.sessionId!==data.source.sessionId||!['completed','failed','cancelled'].includes(run.state)||!run.finalizedAt)return 'run_not_finalized';if(run.approvedActionPending?.batchId||run.actionPause?.state==='waiting_user')return 'approval_pending';const history=[];for await(const event of streamStoredEvents(data.source.sessionId,{strict:true})){if(['approval_request','approval_response','privileged_batch_request'].includes(event?.type)){if(history.length>=10000)return 'approval_history_unavailable';history.push(event);}}if(history.some(event=>['approval_request','privileged_batch_request'].includes(event.type)&&!event.runId))return 'approval_scope_unknown';if(collectUnansweredApprovalRequestsFromHistory(history,run.id).length)return 'approval_pending';if(history.some(event=>event?.runId===run.id&&event.type==='privileged_batch_request'))return 'privileged_approval_history_requires_reconciliation';return null;} catch{return 'run_unavailable';}
}
export async function previewFactoryRetirement({organizationId,kind,targetId},actor){owner(actor);required(organizationId,'organizationId');required(targetId,'targetId');const data=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');return scoped(db,organizationId,kind,targetId);});const runIssue=await runBlocker(data);if(runIssue)data.blockers.push(runIssue);let identity=null;if(!data.blockers.length)try{identity=await checkedPath(data.path);}catch{data.blockers.push('workspace_path_unavailable');}const previewDigest=digest({organizationId,kind,targetId,source:data.source,blockers:data.blockers,identity});return {schemaVersion:1,kind,targetId,eligible:!data.blockers.length,blockers:data.blockers,source:data.source,previewDigest,identity,asOf:now()};}
export async function retireFactoryWorkspace({organizationId,kind,targetId,idempotencyKey,previewDigest},actor){owner(actor);required(organizationId,'organizationId');required(targetId,'targetId');required(idempotencyKey,'idempotencyKey');if(!/^[a-f0-9]{64}$/.test(previewDigest||''))fail('Preview digest required','FACTORY_INVALID');
 const prior=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');return db.prepare('SELECT * FROM factory_retirement_operations WHERE organization_id=? AND actor_id=? AND idempotency_key=?').get(organizationId,actor.principalId,idempotencyKey);});
 if(prior&&(prior.kind!==kind||prior.target_id!==targetId||prior.preview_digest!==previewDigest))fail('Retirement key conflicts');
 if(prior?.state==='retired')return {schemaVersion:1,operationId:prior.id,state:'retired',source:decode(prior.source_json,{}).source,replayed:true};
 let reserved=prior;
 if(!reserved){
  const preview=await previewFactoryRetirement({organizationId,kind,targetId},actor);if(!preview.eligible||preview.previewDigest!==previewDigest)fail('Retirement preview changed');
  reserved=await factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.CreateWorkItem');const duplicate=db.prepare('SELECT * FROM factory_retirement_operations WHERE organization_id=? AND actor_id=? AND idempotency_key=?').get(organizationId,actor.principalId,idempotencyKey);if(duplicate){if(duplicate.kind!==kind||duplicate.target_id!==targetId||duplicate.preview_digest!==previewDigest)fail('Retirement key conflicts');return duplicate;}const current=scoped(db,organizationId,kind,targetId);if(current.blockers.length||digest(current.source)!==digest(preview.source))fail('Retirement references changed');const id=`retire_${randomUUID()}`,ts=now();db.prepare('INSERT INTO factory_retirement_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,organizationId,actor.principalId,kind,targetId,idempotencyKey,previewDigest,encode({source:current.source,path:current.path,identity:preview.identity,originalState:kind==='combination'?db.prepare('SELECT state FROM factory_integration_queue WHERE id=?').get(targetId).state:null}), 'removing',ts,ts);if(kind==='validation'&&!db.prepare("UPDATE factory_validation_workspaces SET state='retiring' WHERE id=? AND state='sealed'").run(targetId).changes)fail('Workspace state changed');if(kind==='combination'&&!db.prepare("UPDATE factory_integration_queue SET state='retiring' WHERE id=? AND organization_id=? AND state IN ('integrated','stale')").run(targetId,organizationId).changes)fail('Queue state changed');return db.prepare('SELECT * FROM factory_retirement_operations WHERE id=?').get(id);});
 }
 if(reserved.state==='retired')return {schemaVersion:1,operationId:reserved.id,state:'retired',source:decode(reserved.source_json,{}).source,replayed:true};
 const stored=decode(reserved.source_json,{});let absent=false;try{await lstat(stored.path);}catch(error){if(error?.code==='ENOENT')absent=true;else throw error;}
 const runIssue=await runBlocker({kind,source:stored.source});if(runIssue)fail(runIssue);
 await factoryRead(db=>{authorize(db,organizationId,actor,'factory.read');const current=scoped(db,organizationId,kind,targetId);if(current.blockers.length||digest(current.source)!==digest(stored.source))fail('Retirement references changed');});
 if(!absent){

  const checked=await checkedPath(stored.path);if(!stored.identity||checked.actual!==stored.identity.actual||checked.root!==stored.identity.root||checked.dev!==stored.identity.dev||checked.ino!==stored.identity.ino)fail('Workspace identity changed');
  await factoryRead(db=>{authorize(db,organizationId,actor,'factory.read');const current=scoped(db,organizationId,kind,targetId);if(current.blockers.length||digest(current.source)!==digest(stored.source))fail('Retirement references changed');});
  const again=await lstat(checked.actual);if(again.dev!==checked.dev||again.ino!==checked.ino||again.isSymbolicLink())fail('Workspace identity changed');if(!await discardStaging(checked.actual,{stagingRoot:checked.root}))fail('Workspace removal was refused');
 }
 return factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const operation=db.prepare('SELECT * FROM factory_retirement_operations WHERE id=?').get(reserved.id);if(!operation||operation.state!=='removing')fail('Retirement operation changed');const current=scoped(db,organizationId,kind,targetId);if(current.blockers.length||digest(current.source)!==digest(stored.source))fail('Retirement references changed');let changed;if(kind==='validation')changed=db.prepare("UPDATE factory_validation_workspaces SET state='retired' WHERE id=? AND state='retiring'").run(targetId).changes;else changed=db.prepare("UPDATE factory_integration_queue SET workspace=NULL,state=? WHERE id=? AND organization_id=? AND state='retiring'").run(stored.originalState,targetId,organizationId).changes;if(!changed)fail('Retirement target changed');const outcome=absent?'absent_on_recovery':'removed';db.prepare("UPDATE factory_retirement_operations SET state='retired',source_json=?,updated_at=? WHERE id=? AND state='removing'").run(encode({...stored,outcome}),now(),operation.id);return {schemaVersion:1,operationId:operation.id,state:'retired',source:stored.source,outcome};});
}
