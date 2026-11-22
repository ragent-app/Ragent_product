import { randomBytes } from 'node:crypto';
import { read, transaction, receipt, recordObservation, activity, newId, now, digest, error } from './responsibility-store.mjs';

function principal(actor) {
  if(actor?.kind!=='user'||actor?.role!=='owner'||!actor.principalId) throw error('Owner access required',403);
  return actor.principalId;
}
function bindingRow(row) { const config=JSON.parse(row.config_json);return {id:row.id,triggerId:row.trigger_id,responsibilityId:row.responsibility_id,enabled:!!row.enabled,version:row.version,config,state:row.bridge_state,attempts:row.bridge_attempts,lastError:row.bridge_error,...(config.type==='event'?{deliveryGuarantee:'durable_after_observation',sourceCompleteness:'best_effort_snapshot'}:{})}; }
export function isResponsibilityTriggerObservationCurrent(db,responsibility,observation) {
  const payload=JSON.parse(observation.payload_json);
  if(!payload.bindingId&&!payload.triggerId) return true;
  const binding=db.prepare('SELECT * FROM responsibility_trigger_bindings WHERE id=? AND trigger_id=? AND responsibility_id=?').get(payload.bindingId,payload.triggerId,responsibility.id);
  const occurrence=db.prepare('SELECT wake_id FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=?').get(payload.bindingId,payload.occurrenceKey||`time:${payload.occurrence}`);
  const organization=db.prepare('SELECT project_id,root_session_id FROM organizations WHERE id=?').get(responsibility.organization_id);
  const source=payload.source==='run_terminal'?db.prepare('SELECT status FROM responsibility_trigger_event_sources WHERE binding_id=?').get(payload.bindingId):null;
  return !!binding&&binding.enabled===1&&binding.version===payload.bindingVersion&&binding.owner_id===responsibility.owner_principal_id&&binding.organization_id===responsibility.organization_id&&binding.project_id===responsibility.project_id&&organization?.project_id===binding.project_id&&organization.root_session_id===binding.session_id&&occurrence?.wake_id===observation.wake_id&&(payload.source!=='run_terminal'||['ready','backpressure'].includes(source?.status));
}
export async function createResponsibilityTrigger(id,input,actor) {
  const owner=principal(actor);
  if(input?.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>1024) throw error('Confirmation and idempotencyKey are required');
  let config;
  if(input.type==='event') {
    if(input.eventType!=='run_terminal'||input.source?.kind!=='root_session'||Object.keys(input.source).length!==1||input.observeFrom!=='binding_created') throw error('Only root session Run terminals after binding creation are supported',400,'RESPONSIBILITY_TRIGGER_UNSUPPORTED');
    config={type:'event',eventType:'run_terminal',source:{kind:'root_session'},observeFrom:'binding_created'};
  } else if(input.type==='at_time') {
    const at=Date.parse(input.scheduledAt); if(typeof input.scheduledAt!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/i.test(input.scheduledAt)||!Number.isFinite(at)) throw error('scheduledAt must include a time zone');
    const interval=input.intervalMs;if(interval!==undefined&&(!Number.isSafeInteger(interval)||interval<60000||interval>365*86400000)) throw error('Invalid intervalMs');
    config={type:'at_time',scheduledAt:new Date(at).toISOString(),...(interval===undefined?{}:{intervalMs:interval})};
  } else throw error('Unsupported trigger type',400,'RESPONSIBILITY_TRIGGER_UNSUPPORTED');
  return transaction(db=>receipt(db,owner,'trigger_create',id,input.idempotencyKey,input,()=>{
    const r=db.prepare('SELECT r.*,o.root_session_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=? AND r.owner_principal_id=?').get(id,owner);
    if(!r||!r.root_session_id) throw error('Responsibility not found',404);
    if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==r.row_version||!['active','paused','draft'].includes(r.lifecycle)) throw error('Responsibility version or state changed',409);
    const bindingId=newId('trigger_binding'), triggerId=`trg_${randomBytes(12).toString('hex')}`,ts=now();
    db.prepare('INSERT INTO responsibility_trigger_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(bindingId,triggerId,id,owner,r.organization_id,r.project_id,r.root_session_id,JSON.stringify(config),digest(config),1,1,ts,ts);
    db.prepare('INSERT INTO responsibility_trigger_bridge_state VALUES(?,?,?,?,?,?)').run(bindingId,config.type==='event'?'ready':'pending',0,null,null,ts);
    if(config.type==='event') db.prepare("INSERT INTO responsibility_trigger_event_sources VALUES(?,?,'','ready',NULL,?)").run(bindingId,ts,ts);
    else db.prepare('INSERT INTO responsibility_trigger_schedule VALUES(?,?,?)').run(bindingId,0,config.scheduledAt);
    activity(db,id,'trigger_binding_created',{bindingId,triggerId});
    return {schemaVersion:1,binding:{id:bindingId,triggerId,responsibilityId:id,enabled:true,version:1,config,state:config.type==='event'?'ready':'pending',...(config.type==='event'?{observeFrom:ts,deliveryGuarantee:'durable_after_observation',sourceCompleteness:'best_effort_snapshot'}:{})}};
  }));
}
export async function listResponsibilityTriggers(id,actor) {
  const owner=principal(actor); const result=await read(db=>{if(!db.prepare('SELECT 1 FROM responsibilities WHERE id=? AND owner_principal_id=?').get(id,owner)) throw error('Responsibility not found',404);const bindings=db.prepare('SELECT b.*,s.state AS bridge_state,s.attempts AS bridge_attempts,s.last_error AS bridge_error FROM responsibility_trigger_bindings b JOIN responsibility_trigger_bridge_state s ON s.binding_id=b.id WHERE b.responsibility_id=? ORDER BY b.created_at,b.id').all(id).map(bindingRow);for(const binding of bindings) if(binding.config.type==='event') {const source=db.prepare('SELECT starts_at,status,last_error FROM responsibility_trigger_event_sources WHERE binding_id=?').get(binding.id);binding.source=source?{observeFrom:source.starts_at,status:source.status,lastError:source.last_error}:null;binding.pendingCount=db.prepare('SELECT COUNT(*) AS n FROM responsibility_trigger_event_queue WHERE binding_id=?').get(binding.id).n;}return {schemaVersion:1,bindings};});
  const {getTrigger}=await import('./triggers.mjs'); for(const binding of result.bindings) {const trigger=await getTrigger(binding.triggerId); binding.delivery=trigger?{status:trigger.status,attempts:trigger.deliveryAttempts,nextAttemptAt:trigger.nextAttemptAt,lastError:trigger.lastError,occurrence:trigger.occurrence}:null;}return result;
}
export async function changeResponsibilityTrigger(id,bindingId,action,input,actor) {
  const owner=principal(actor);if(input?.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>1024) throw error('Confirmation and idempotencyKey are required');
  return transaction(db=>receipt(db,owner,`trigger_${action}`,bindingId,input.idempotencyKey,input,()=>{const b=db.prepare('SELECT b.*,r.lifecycle FROM responsibility_trigger_bindings b JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.id=? AND b.responsibility_id=? AND b.owner_id=? AND r.owner_principal_id=?').get(bindingId,id,owner,owner);if(!b) throw error('Binding not found',404);if(input.expectedVersion!==b.version) throw error('Binding version changed',409);if(action==='recover'&&(!b.enabled||!['active','paused','draft'].includes(b.lifecycle))) throw error('Binding cannot be recovered',409);const ts=now(),event=JSON.parse(b.config_json).type==='event',state=action==='revoke'?'revoked':event?'ready':'pending';db.prepare('UPDATE responsibility_trigger_bindings SET enabled=?,version=version+1,updated_at=? WHERE id=?').run(action==='revoke'?0:1,ts,bindingId);db.prepare('UPDATE responsibility_trigger_bridge_state SET state=?,attempts=0,next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE binding_id=?').run(state,ts,bindingId);if(event&&action==='recover') {db.prepare("UPDATE responsibility_trigger_event_sources SET status='ready',last_error=NULL,updated_at=? WHERE binding_id=?").run(ts,bindingId);db.prepare("UPDATE responsibility_trigger_event_queue SET state='pending',attempts=0,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE binding_id=? AND state='blocked'").run(ts,bindingId);}activity(db,id,`trigger_binding_${action}`,{bindingId});return {schemaVersion:1,id:bindingId,version:b.version+1,state};}));
}
export async function deliverResponsibilityTrigger(trigger) {
  const occurrenceKey=`time:${trigger.occurrence}`, payloadDigest=digest({triggerId:trigger.id,occurrence:trigger.occurrence,scheduledAt:trigger.scheduledAt});
  return transaction(db=>{
    const b=db.prepare('SELECT b.*,r.lifecycle,r.revision,r.policy_revision,r.owner_principal_id,r.organization_id AS current_organization,r.project_id AS responsibility_project,o.project_id AS current_project,o.root_session_id AS current_session FROM responsibility_trigger_bindings b JOIN responsibilities r ON r.id=b.responsibility_id JOIN organizations o ON o.id=r.organization_id WHERE b.trigger_id=?').get(trigger.id);
    if(!b) throw error('Trigger binding missing',409,'RESPONSIBILITY_TRIGGER_INACTIVE');
    const config=JSON.parse(b.config_json),schedule=db.prepare('SELECT * FROM responsibility_trigger_schedule WHERE binding_id=?').get(b.id);
    if(digest(config)!==b.config_digest||trigger.sessionId!==b.session_id||trigger.triggerType!=='at_time'||(trigger.recurrence?.intervalMs||null)!==(config.intervalMs||null)) throw error('Trigger configuration changed',409,'RESPONSIBILITY_TRIGGER_INACTIVE');
    const old=db.prepare('SELECT * FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=?').get(b.id,occurrenceKey);
    if(old){if(old.payload_digest!==payloadDigest||!schedule||schedule.occurrence!==trigger.occurrence+1)throw error('Occurrence identity conflict',409,'RESPONSIBILITY_TRIGGER_INACTIVE');return {wakeId:old.wake_id,nextScheduledAt:schedule.scheduled_at,replayed:true};}
    if(!b.enabled||b.lifecycle!=='active'||b.owner_id!==b.owner_principal_id||b.organization_id!==b.current_organization||b.project_id!==b.responsibility_project||b.project_id!==b.current_project||b.session_id!==b.current_session) throw error('Trigger binding is inactive',409,'RESPONSIBILITY_TRIGGER_INACTIVE');
    if(!schedule||schedule.occurrence!==trigger.occurrence||schedule.scheduled_at!==trigger.scheduledAt) throw error('Trigger schedule changed',409,'RESPONSIBILITY_TRIGGER_INACTIVE');
    const ts=now(),wakeId=newId('wake'),nextScheduledAt=config.intervalMs?new Date(Date.parse(ts)+config.intervalMs).toISOString():trigger.scheduledAt;
    db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(wakeId,b.responsibility_id,b.revision,b.policy_revision,ts,'pending',0,null,ts,ts);
    recordObservation(db,wakeId,'interval',{triggerId:trigger.id,bindingId:b.id,bindingVersion:b.version,occurrence:trigger.occurrence,scheduledAt:trigger.scheduledAt});
    db.prepare('INSERT INTO responsibility_trigger_receipts VALUES(?,?,?,?,?)').run(b.id,occurrenceKey,payloadDigest,wakeId,ts);
    db.prepare('UPDATE responsibility_trigger_schedule SET occurrence=?,scheduled_at=? WHERE binding_id=?').run(trigger.occurrence+1,nextScheduledAt,b.id);
    activity(db,b.responsibility_id,'wake_received',{wakeId,triggerId:trigger.id,bindingId:b.id});return {wakeId,nextScheduledAt};
  });
}
export async function reconcileResponsibilityTriggerBindings() {
  const stopped=await read(db=>db.prepare("SELECT b.* FROM responsibility_trigger_bindings b JOIN responsibility_trigger_bridge_state s ON s.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE s.state IN ('pending','ready','revoked') AND (b.enabled=0 OR r.lifecycle IN ('completed','cancelled','archived')) ORDER BY b.created_at LIMIT 20").all());
  const {ensureResponsibilityTrigger,stopResponsibilityTrigger}=await import('./triggers.mjs');
  for(const b of stopped) {
    try {await stopResponsibilityTrigger(b.trigger_id);await transaction(db=>{const current=db.prepare('SELECT version FROM responsibility_trigger_bindings WHERE id=?').get(b.id);if(current?.version===b.version) db.prepare("UPDATE responsibility_trigger_bridge_state SET state='stopped',updated_at=? WHERE binding_id=?").run(now(),b.id);});}
    catch(e) {await transaction(db=>db.prepare("UPDATE responsibility_trigger_bridge_state SET state='blocked',last_error=?,updated_at=? WHERE binding_id=? AND state IN ('pending','ready','revoked')").run(String(e?.message||'Unable to stop trigger').slice(0,500),now(),b.id));}
  }
  const bindings=await read(db=>db.prepare("SELECT b.*,s.attempts,q.occurrence AS schedule_occurrence,q.scheduled_at AS schedule_at FROM responsibility_trigger_bindings b JOIN responsibility_trigger_bridge_state s ON s.binding_id=b.id JOIN responsibility_trigger_schedule q ON q.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.enabled=1 AND r.lifecycle IN ('active','paused','draft') AND s.state='pending' AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=?) ORDER BY b.created_at LIMIT 20").all(now()));
  for(const b of bindings) {
    try {
      await ensureResponsibilityTrigger(b);
      await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(b.id);if(current?.enabled&&current.version===b.version) db.prepare("UPDATE responsibility_trigger_bridge_state SET state='ready',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE binding_id=? AND state='pending'").run(now(),b.id);});
    } catch(e) {
      const attempts=b.attempts+1, exhausted=attempts>=3, next=exhausted?null:new Date(Date.now()+(attempts===1?30000:120000)).toISOString();
      await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(b.id);if(current?.enabled&&current.version===b.version) db.prepare("UPDATE responsibility_trigger_bridge_state SET state=?,attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE binding_id=? AND state='pending'").run(exhausted?'blocked':'pending',attempts,next,String(e?.message||'Bridge unavailable').slice(0,500),now(),b.id);});
    }
  }
}
