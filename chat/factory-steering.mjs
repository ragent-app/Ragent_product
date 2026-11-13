// A steering receipt describes a request to one current Run, not task success.
import { createHash } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now } from './work-graph-store.mjs';
import { authorize, selectItem } from './work-graph.mjs';
import { getFactoryWorkItem } from './factory-control.mjs';
import { getRun, getRunManifest, updateRun } from './runs.mjs';

const fail=(message,code='FACTORY_STEER_CONFLICT',statusCode=409)=>{throw factoryError(code,message,statusCode);};
function schema(db){db.exec(`CREATE TABLE IF NOT EXISTS factory_steer_commands (
  command_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,work_item_id TEXT NOT NULL,actor_id TEXT NOT NULL,
  row_version INTEGER NOT NULL,execution_epoch INTEGER NOT NULL,binding_generation INTEGER NOT NULL,
  binding_id TEXT NOT NULL,attempt_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,body TEXT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL);`);}
const owner=actor=>{if(actor?.kind!=='user'||actor.role!=='owner'||!actor.principalId) fail('Owner access required','FACTORY_FORBIDDEN',403);};
function check(db,row) {
  const item=selectItem(db,row.organization_id,row.work_item_id);
  if(item.row_version!==row.row_version || item.execution_epoch!==row.execution_epoch || item.binding_generation!==row.binding_generation || item.state!=='running' || item.control_state!=='none') fail('Work Item changed or is not running');
  const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(row.binding_id,item.id);
  const attempt=db.prepare('SELECT * FROM collaboration_attempts WHERE id=?').get(row.attempt_id);
  if(!binding || binding.status!=='running' || binding.execution_epoch!==row.execution_epoch || binding.binding_generation!==row.binding_generation || binding.run_id!==row.run_id || binding.attempt_id!==row.attempt_id || !attempt || attempt.state!=='running' || attempt.run_id!==row.run_id || attempt.session_id!==row.session_id) fail('Execution binding or Attempt changed');
  return {item,binding};
}
async function activeAuthority(row) {
  const actor={kind:'user',role:'owner',principalId:row.actor_id};
  const {item}=await getFactoryWorkItem(row.organization_id,row.work_item_id,actor);
  const binding=item.bindings.find(b=>b.id===row.binding_id);
  const {executionAuthorityRevoked}=await import('./factory-execution-adapter.mjs');
  if(!binding || await executionAuthorityRevoked(row.organization_id,item,binding)) fail('Current execution authorization is unavailable');
  return {item,binding};
}
function view(row,run) {
  const entry=Array.isArray(run?.appServerSteerQueue)?run.appServerSteerQueue.find(e=>e.id===row.command_id && e.factorySteer===true):null;
  const receipt=entry?.providerReceipt;
  return {commandId:row.command_id,workItemId:row.work_item_id,runId:row.run_id,executionEpoch:row.execution_epoch,
    state:row.mode==='next_turn'?'unsupported':receipt?.state || (entry?.state==='sent'?'sent_unknown':entry?'queued':'pending'),
    ...(receipt?{providerReceipt:receipt}:{}),asOf:now(),schemaVersion:1};
}
export async function getFactorySteer(organizationId,commandId,actor) {
  owner(actor); const row=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const r=db.prepare('SELECT * FROM factory_steer_commands WHERE organization_id=? AND command_id=?').get(organizationId,commandId);if(!r) fail('Steer request not found','FACTORY_NOT_FOUND',404);return r;});
  return view(row,await getRun(row.run_id));
}
export async function submitFactorySteer(input,actor) {
  owner(actor); const {organizationId,workItemId,commandId,expectedVersion,executionEpoch,bindingGeneration}=input || {};
  const body=typeof input?.text==='string'?input.text.trim():'';
  if(![organizationId,workItemId,commandId].every(v=>typeof v==='string' && v.trim() && v.length<=160) || !Number.isInteger(expectedVersion) || !Number.isInteger(executionEpoch) || !Number.isInteger(bindingGeneration) || !body || Buffer.byteLength(body,'utf8')>8192) fail('Bounded request and current execution identities are required','FACTORY_INVALID',400);
  const requestDigest=createHash('sha256').update(JSON.stringify({organizationId,workItemId,commandId,expectedVersion,executionEpoch,bindingGeneration,body,actor:actor.principalId})).digest('hex');
  let row=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');return db.prepare('SELECT * FROM factory_steer_commands WHERE command_id=?').get(commandId);});
  if(row && row.request_digest!==requestDigest) fail('Command ID belongs to a different request');
  if(!row) {
    const snapshot=await factoryRead(db=>{authorize(db,organizationId,actor,'factory.ChangePriority');const item=selectItem(db,organizationId,workItemId);if(item.row_version!==expectedVersion || item.execution_epoch!==executionEpoch || item.binding_generation!==bindingGeneration || item.state!=='running' || item.control_state!=='none') fail('Work Item changed or is not running');
      const b=db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND execution_epoch=? AND binding_generation=? AND status='running'").get(workItemId,executionEpoch,bindingGeneration);
      const a=b && db.prepare('SELECT * FROM collaboration_attempts WHERE id=?').get(b.attempt_id);if(!b?.run_id || !a || a.state!=='running' || a.run_id!==b.run_id || !a.session_id) fail('Running Attempt is unavailable');return {binding:b,attempt:a};});
    const run=await getRun(snapshot.binding.run_id),manifest=await getRunManifest(snapshot.binding.run_id);
    if(!run || run.sessionId!==snapshot.attempt.session_id || run.state!=='running' || run.cancelRequested) fail('Bound Run is not running');
    const mode=(manifest?.runtimeFamily || manifest?.options?.runtimeFamily)==='codex-app-server-json'?'live':'next_turn';
    const candidate={organization_id:organizationId,work_item_id:workItemId,actor_id:actor.principalId,row_version:expectedVersion,execution_epoch:executionEpoch,binding_generation:bindingGeneration,binding_id:snapshot.binding.id,attempt_id:snapshot.attempt.id,run_id:run.id,session_id:run.sessionId};
    await activeAuthority(candidate);
    row=await factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.ChangePriority');const old=db.prepare('SELECT * FROM factory_steer_commands WHERE command_id=?').get(commandId);if(old){if(old.request_digest!==requestDigest) fail('Command ID belongs to a different request');return old;}check(db,candidate);
      db.prepare('INSERT INTO factory_steer_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(commandId,organizationId,workItemId,actor.principalId,expectedVersion,executionEpoch,bindingGeneration,candidate.binding_id,candidate.attempt_id,run.id,run.sessionId,requestDigest,body,mode,now());return db.prepare('SELECT * FROM factory_steer_commands WHERE command_id=?').get(commandId);});
  }
  if(row.mode==='next_turn') return view(row,null);
  await activeAuthority(row);
  const run=await updateRun(row.run_id,current=>{ if(current.sessionId!==row.session_id || current.state!=='running' || current.cancelRequested) fail('Bound Run is no longer running');
    const queue=Array.isArray(current.appServerSteerQueue)?current.appServerSteerQueue:[];const prior=queue.find(entry=>entry.id===commandId);if(prior){if(!prior.factorySteer || prior.requestId!==commandId || prior.text!==row.body) fail('Steer queue identity conflicts');return current;}
    return {...current,appServerSteerQueue:[...queue,{id:commandId,requestId:commandId,text:row.body,state:'pending',factorySteer:true,createdAt:now()}]};
  },{authorizeWrite:async()=>{await activeAuthority(row);await factoryRead(db=>{authorize(db,organizationId,actor,'factory.ChangePriority');check(db,row);});}});
  if(!run) fail('Bound Run disappeared');
  return view(row,run);
}
export async function assertFactorySteerDispatch(commandId,runId,sessionId) {
  const row=await factoryRead(db=>{schema(db);const r=db.prepare('SELECT * FROM factory_steer_commands WHERE command_id=?').get(commandId);if(!r || r.mode!=='live' || r.run_id!==runId || r.session_id!==sessionId) fail('Steer command does not match Run');authorize(db,r.organization_id,{kind:'user',role:'owner',principalId:r.actor_id},'factory.ChangePriority');check(db,r);return r;});
  await activeAuthority(row);
  const run=await getRun(runId), manifest=await getRunManifest(runId);
  if (!run || run.sessionId!==sessionId || run.state!=='running' || run.cancelRequested || (manifest?.runtimeFamily || manifest?.options?.runtimeFamily)!=='codex-app-server-json') fail('Bound Run is no longer eligible for steering');
  return true;
}
