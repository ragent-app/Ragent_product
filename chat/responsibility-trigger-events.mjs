import { randomUUID } from 'node:crypto';
import { read, transaction, recordObservation, activity, newId, now, digest } from './responsibility-store.mjs';
import { listDurableSessionRunIndexEntries, getRunAcceptanceEvidence } from './runs.mjs';

const MAX_PENDING=200, MAX_RECEIPTS=10000, SCAN_BATCH=50, DELIVERY_BATCH=20;
const terminal=new Set(['completed','failed','cancelled']);
function validRun(run,sessionId) {return run?.sessionId===sessionId && !!run.runPublication && terminal.has(run.state) && typeof run.finalizedAt==='string' && Number.isFinite(Date.parse(run.finalizedAt));}
function validConfig(binding) {try {const config=JSON.parse(binding.config_json);return config.type==='event'&&config.eventType==='run_terminal'&&config.source?.kind==='root_session'&&digest(config)===binding.config_digest;}catch{return false;}}
function sourceChanged(db,bindingId,status,reason=null) {
  const old=db.prepare('SELECT status,last_error FROM responsibility_trigger_event_sources WHERE binding_id=?').get(bindingId);
  if(!old||old.status===status&&old.last_error===reason) return;
  db.prepare('UPDATE responsibility_trigger_event_sources SET status=?,last_error=?,updated_at=? WHERE binding_id=?').run(status,reason,now(),bindingId);
  const b=db.prepare('SELECT responsibility_id FROM responsibility_trigger_bindings WHERE id=?').get(bindingId);
  if(b) activity(db,b.responsibility_id,'trigger_source_status',{bindingId,status,reason});
}
async function blockSource(binding,status,reason) {await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(binding.id);if(current?.enabled&&current.version===binding.version) sourceChanged(db,binding.id,status,reason);});}
async function scanBinding(binding) {
  let session,entries;
  try {
    const {getSession}=await import('./session-manager.mjs');session=await getSession(binding.session_id);
    if(!session||session.archived||session.projectId!==binding.project_id) return blockSource(binding,'source_unavailable','source_session_unavailable');
    entries=await listDurableSessionRunIndexEntries(binding.session_id);
  } catch {return blockSource(binding,'source_unavailable','source_index_unavailable');}
  const ordered=entries.filter(x=>typeof x.id==='string').sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  let batch=ordered.filter(x=>x.id>binding.cursor).slice(0,SCAN_BATCH);
  if(!batch.length) {await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(binding.id);if(current?.enabled&&current.version===binding.version) {db.prepare("UPDATE responsibility_trigger_event_sources SET cursor='',updated_at=? WHERE binding_id=? AND cursor<>''").run(now(),binding.id);sourceChanged(db,binding.id,'ready');}});return;}
  for(const entry of batch) {
    let run=null;
    if(terminal.has(entry.state)) {
      try {run=await getRunAcceptanceEvidence(entry.id);} catch {return blockSource(binding,'source_unavailable','run_evidence_unavailable');}
      if(!run) return blockSource(binding,'retention_gap','run_removed_before_observation');
      if(run.sessionId!==binding.session_id) return blockSource(binding,'source_unavailable','run_session_mismatch');
    }
    const eligible=validRun(run,binding.session_id)&&Date.parse(run.finalizedAt)>=Date.parse(binding.starts_at);
    const result=await transaction(db=>{
      const current=db.prepare('SELECT b.*,r.lifecycle,r.owner_principal_id,o.project_id AS current_project,o.root_session_id AS current_session FROM responsibility_trigger_bindings b JOIN responsibilities r ON r.id=b.responsibility_id JOIN organizations o ON o.id=r.organization_id WHERE b.id=?').get(binding.id);
      if(!current?.enabled||current.version!==binding.version||current.lifecycle!=='active'||current.owner_id!==current.owner_principal_id||current.project_id!==current.current_project||current.session_id!==current.current_session) return 'fenced';
      if(!validConfig(current)) {sourceChanged(db,binding.id,'source_unavailable','binding_configuration_invalid');return 'fenced';}
      if(eligible) {
        const key=`run:${run.id}`,hash=digest({runId:run.id,sessionId:run.sessionId,state:run.state,finalizedAt:run.finalizedAt,publication:run.runPublication}),existing=db.prepare('SELECT payload_digest FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=? UNION ALL SELECT payload_digest FROM responsibility_trigger_event_queue WHERE binding_id=? AND occurrence_key=?').get(binding.id,key,binding.id,key);
        if(existing&&existing.payload_digest!==hash) {sourceChanged(db,binding.id,'source_unavailable','run_identity_changed');return 'fenced';}
        if(!existing) {
          const pending=db.prepare('SELECT COUNT(*) AS n FROM responsibility_trigger_event_queue WHERE binding_id=?').get(binding.id).n,receipts=db.prepare('SELECT COUNT(*) AS n FROM responsibility_trigger_receipts WHERE binding_id=?').get(binding.id).n;
          if(pending>=MAX_PENDING||receipts>=MAX_RECEIPTS) {sourceChanged(db,binding.id,'backpressure',pending>=MAX_PENDING?'pending_capacity':'receipt_capacity');return 'full';}
          const ts=now();
          db.prepare("INSERT INTO responsibility_trigger_event_queue(binding_id,occurrence_key,run_id,finalized_at,payload_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(binding.id,key,run.id,run.finalizedAt,hash,ts,ts);
        }
      }
      db.prepare('UPDATE responsibility_trigger_event_sources SET cursor=?,updated_at=? WHERE binding_id=?').run(entry.id,now(),binding.id);sourceChanged(db,binding.id,'ready');return 'ok';
    });
    if(result!=='ok') return;
  }
}
async function deliverOne(entry) {
  const token=randomUUID();
  const claim=await transaction(db=>{const current=db.prepare('SELECT q.*,b.enabled,b.version,r.lifecycle FROM responsibility_trigger_event_queue q JOIN responsibility_trigger_bindings b ON b.id=q.binding_id JOIN responsibilities r ON r.id=b.responsibility_id WHERE q.binding_id=? AND q.occurrence_key=?').get(entry.binding_id,entry.occurrence_key),ts=now();if(!current?.enabled||current.lifecycle!=='active'||!['pending','claimed'].includes(current.state)||current.state==='claimed'&&current.lease_until>ts||current.next_attempt_at&&current.next_attempt_at>ts)return null;const generation=current.lease_generation+1;db.prepare("UPDATE responsibility_trigger_event_queue SET state='claimed',lease_token=?,lease_generation=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE binding_id=? AND occurrence_key=?").run(token,generation,new Date(Date.now()+120000).toISOString(),ts,entry.binding_id,entry.occurrence_key);return {generation,version:current.version};});
  if(!claim)return;
  let run,unavailable=false;try {run=await getRunAcceptanceEvidence(entry.run_id);}catch {run=null;unavailable=true;}
  await transaction(db=>{const q=db.prepare('SELECT * FROM responsibility_trigger_event_queue WHERE binding_id=? AND occurrence_key=?').get(entry.binding_id,entry.occurrence_key),b=db.prepare('SELECT b.*,r.lifecycle,r.revision,r.policy_revision,r.owner_principal_id,r.organization_id AS current_org,r.project_id AS responsibility_project,o.project_id AS current_project,o.root_session_id AS current_session FROM responsibility_trigger_bindings b JOIN responsibilities r ON r.id=b.responsibility_id JOIN organizations o ON o.id=r.organization_id WHERE b.id=?').get(entry.binding_id),ts=now();
    if(!q||q.state!=='claimed'||q.lease_token!==token||q.lease_generation!==claim.generation||q.lease_until<=ts)return;
    const source=db.prepare('SELECT status FROM responsibility_trigger_event_sources WHERE binding_id=?').get(entry.binding_id);
    if(!b?.enabled||b.version!==claim.version||b.lifecycle!=='active'||b.owner_id!==b.owner_principal_id||b.organization_id!==b.current_org||b.project_id!==b.responsibility_project||b.project_id!==b.current_project||b.session_id!==b.current_session||!validConfig(b)||!['ready','backpressure'].includes(source?.status)) {db.prepare("UPDATE responsibility_trigger_event_queue SET state='pending',lease_token=NULL,lease_until=NULL,updated_at=? WHERE binding_id=? AND occurrence_key=?").run(ts,q.binding_id,q.occurrence_key);return;}
    if(!validRun(run,b.session_id)||digest({runId:run?.id,sessionId:run?.sessionId,state:run?.state,finalizedAt:run?.finalizedAt,publication:run?.runPublication})!==q.payload_digest) {db.prepare("UPDATE responsibility_trigger_event_queue SET state='blocked',last_error='run_evidence_unavailable',lease_token=NULL,lease_until=NULL,updated_at=? WHERE binding_id=? AND occurrence_key=?").run(ts,q.binding_id,q.occurrence_key);sourceChanged(db,b.id,!run&&!unavailable?'retention_gap':'source_unavailable','run_evidence_unavailable');return;}
    const old=db.prepare('SELECT wake_id,payload_digest FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=?').get(b.id,q.occurrence_key);if(old&&old.payload_digest!==q.payload_digest) throw new Error('Trigger occurrence identity conflict');
    if(!old) {const wakeId=newId('wake');db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(wakeId,b.responsibility_id,b.revision,b.policy_revision,ts,'pending',0,null,ts,ts);recordObservation(db,wakeId,'event',{triggerId:b.trigger_id,bindingId:b.id,bindingVersion:b.version,occurrenceKey:q.occurrence_key,source:'run_terminal',runId:q.run_id,finalizedAt:q.finalized_at});db.prepare('INSERT INTO responsibility_trigger_receipts VALUES(?,?,?,?,?)').run(b.id,q.occurrence_key,q.payload_digest,wakeId,ts);activity(db,b.responsibility_id,'wake_received',{wakeId,triggerId:b.trigger_id,bindingId:b.id,source:'run_terminal'});}
    db.prepare('DELETE FROM responsibility_trigger_event_queue WHERE binding_id=? AND occurrence_key=?').run(q.binding_id,q.occurrence_key);
  });
}
export async function processResponsibilityTriggerEvents() {
  const bindings=await read(db=>db.prepare("SELECT b.*,s.starts_at,s.cursor FROM responsibility_trigger_bindings b JOIN responsibility_trigger_event_sources s ON s.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.enabled=1 AND r.lifecycle='active' AND s.status IN ('ready','backpressure') ORDER BY s.updated_at,b.id LIMIT 20").all());
  for(const binding of bindings) {await scanBinding(binding);await transaction(db=>db.prepare('UPDATE responsibility_trigger_event_sources SET updated_at=? WHERE binding_id=?').run(now(),binding.id));}
  const due=await read(db=>db.prepare("SELECT q.binding_id,q.occurrence_key,q.run_id FROM responsibility_trigger_event_queue q JOIN responsibility_trigger_bindings b ON b.id=q.binding_id JOIN responsibility_trigger_event_sources s ON s.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.enabled=1 AND r.lifecycle='active' AND s.status IN ('ready','backpressure') AND (q.state='pending' OR (q.state='claimed' AND q.lease_until<=?)) AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=?) ORDER BY q.created_at LIMIT ?").all(now(),now(),DELIVERY_BATCH));
  for(const entry of due) await deliverOne(entry);
}
