import { randomUUID } from 'node:crypto';
import { read, transaction, recordObservation, activity, newId, now, digest, error } from './responsibility-store.mjs';
import { listDurableSessionRunIndexEntries, getRunAcceptanceEvidence } from './runs.mjs';

const MAX_PENDING=200, MAX_RECEIPTS=10000, SCAN_BATCH=50, DELIVERY_BATCH=20;
const DEFAULT_PRODUCER_MAX_ROWS=2000, DEFAULT_PRODUCER_MAX_AGE_MS=30*86400000;
const terminal=new Set(['completed','failed','cancelled']);
function validRun(run,sessionId) {return run?.sessionId===sessionId && !!run.runPublication && terminal.has(run.state) && typeof run.finalizedAt==='string' && Number.isFinite(Date.parse(run.finalizedAt));}
function runPayloadDigest(run) {return digest({runId:run?.id,sessionId:run?.sessionId,state:run?.state,finalizedAt:run?.finalizedAt,publication:run?.runPublication});}
function validConfig(binding) {try {const config=JSON.parse(binding.config_json);return config.type==='event'&&config.eventType==='run_terminal'&&config.source?.kind==='root_session'&&digest(config)===binding.config_digest;}catch{return false;}}
function producerEventRow(row) {
  if(!row) return null;
  let payload={}; try {payload=JSON.parse(row.payload_json);} catch {}
  return {sequence:Number(row.sequence),eventKey:row.event_key,eventType:row.event_type,sourceKind:row.source_kind,organizationId:row.organization_id||null,projectId:row.project_id||null,sessionId:row.session_id||null,runId:row.run_id||null,eventId:row.event_id||null,state:row.state||null,occurredAt:row.occurred_at,payloadDigest:row.payload_digest,payload,createdAt:row.created_at};
}
function retentionRow(db) {
  const row=db.prepare('SELECT min_available_sequence,max_pruned_occurred_at,pruned_count,last_pruned_at FROM responsibility_producer_event_retention WHERE id=1').get();
  return row ? {minAvailableSequence:Number(row.min_available_sequence||0),maxPrunedOccurredAt:row.max_pruned_occurred_at||null,prunedCount:Number(row.pruned_count||0),lastPrunedAt:row.last_pruned_at||null} : {minAvailableSequence:0,maxPrunedOccurredAt:null,prunedCount:0,lastPrunedAt:null};
}
function resolveRetentionLimits(options={}) {
  const rawMaxRows=options.maxRows!==undefined?options.maxRows:Number(process.env.RAGENT_RESPONSIBILITY_PRODUCER_EVENT_MAX_ROWS||DEFAULT_PRODUCER_MAX_ROWS);
  const maxRows=Number.isSafeInteger(rawMaxRows)&&rawMaxRows>=1?Math.min(rawMaxRows,100000):DEFAULT_PRODUCER_MAX_ROWS;
  const rawMaxAge=options.maxAgeMs!==undefined?options.maxAgeMs:Number(process.env.RAGENT_RESPONSIBILITY_PRODUCER_EVENT_MAX_AGE_MS||DEFAULT_PRODUCER_MAX_AGE_MS);
  const maxAgeMs=options.maxAgeMs===null?0:(Number.isFinite(rawMaxAge)&&rawMaxAge>0?rawMaxAge:DEFAULT_PRODUCER_MAX_AGE_MS);
  return {maxRows,maxAgeMs,nowMs:Number.isFinite(options.nowMs)?options.nowMs:Date.now()};
}
function pruneProducerEventsInTx(db,options={}) {
  const {maxRows,maxAgeMs,nowMs}=resolveRetentionLimits(options);
  let deletedCount=0, maxDeletedSeq=0, maxPrunedOccurredAt=null;
  if(maxAgeMs>0) {
    const cutoff=new Date(nowMs-maxAgeMs).toISOString();
    const expired=db.prepare('SELECT COUNT(*) AS n, MAX(sequence) AS max_seq, MAX(occurred_at) AS max_occ FROM responsibility_producer_events WHERE occurred_at<?').get(cutoff);
    if(expired?.n>0) {
      db.prepare('DELETE FROM responsibility_producer_events WHERE occurred_at<?').run(cutoff);
      deletedCount+=expired.n;
      maxDeletedSeq=Math.max(maxDeletedSeq,Number(expired.max_seq||0));
      if(expired.max_occ && (!maxPrunedOccurredAt || expired.max_occ>maxPrunedOccurredAt)) maxPrunedOccurredAt=expired.max_occ;
    }
  }
  const total=db.prepare('SELECT COUNT(*) AS n FROM responsibility_producer_events').get().n;
  if(total>maxRows) {
    const excess=total-maxRows;
    const rows=db.prepare('SELECT sequence,occurred_at FROM responsibility_producer_events ORDER BY sequence ASC LIMIT ?').all(excess);
    if(rows.length) {
      const capSeq=Number(rows.at(-1).sequence);
      db.prepare('DELETE FROM responsibility_producer_events WHERE sequence<=?').run(capSeq);
      deletedCount+=rows.length;
      maxDeletedSeq=Math.max(maxDeletedSeq,capSeq);
      for(const r of rows) if(r.occurred_at && (!maxPrunedOccurredAt || r.occurred_at>maxPrunedOccurredAt)) maxPrunedOccurredAt=r.occurred_at;
    }
  }
  if(deletedCount>0) {
    const ts=now();
    const prev=retentionRow(db);
    const nextFloor=Math.max(prev.minAvailableSequence,maxDeletedSeq);
    const nextMaxOcc=!prev.maxPrunedOccurredAt?maxPrunedOccurredAt:(!maxPrunedOccurredAt?prev.maxPrunedOccurredAt:(maxPrunedOccurredAt>prev.maxPrunedOccurredAt?maxPrunedOccurredAt:prev.maxPrunedOccurredAt));
    db.prepare('INSERT INTO responsibility_producer_event_retention(id,min_available_sequence,max_pruned_occurred_at,pruned_count,last_pruned_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET min_available_sequence=excluded.min_available_sequence,max_pruned_occurred_at=excluded.max_pruned_occurred_at,pruned_count=responsibility_producer_event_retention.pruned_count+excluded.pruned_count,last_pruned_at=excluded.last_pruned_at').run(nextFloor,nextMaxOcc,deletedCount,ts);
  }
  const current=retentionRow(db), remainingCount=db.prepare('SELECT COUNT(*) AS n FROM responsibility_producer_events').get().n;
  return {deletedCount,maxDeletedSequence:maxDeletedSeq,minAvailableSequence:current.minAvailableSequence,maxPrunedOccurredAt:current.maxPrunedOccurredAt,prunedCount:current.prunedCount,remainingCount};
}
export async function recordProducerTriggerEvent(input={},options={}) {
  const eventKey=typeof input.eventKey==='string'?input.eventKey.trim():'';
  const eventType=typeof input.eventType==='string'?input.eventType.trim():'';
  const sourceKind=typeof input.sourceKind==='string'?input.sourceKind.trim():'';
  const occurredAtMs=Date.parse(input.occurredAt||'');
  if(!eventKey||eventKey.length>512||!eventType||eventType.length>128||!sourceKind||sourceKind.length>64||!Number.isFinite(occurredAtMs)) throw error('Valid producer event key, type, sourceKind, and occurredAt are required',400);
  if(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload)) throw error('Producer event payload must be an object',400);
  const occurredAt=new Date(occurredAtMs).toISOString();
  const payloadDigest=typeof input.payloadDigest==='string'&&input.payloadDigest?input.payloadDigest:digest(input.payload);
  const payloadJson=JSON.stringify(input.payload);
  return transaction(db=>{
    const existing=db.prepare('SELECT * FROM responsibility_producer_events WHERE event_key=?').get(eventKey);
    if(existing) {
      if(existing.payload_digest!==payloadDigest||existing.event_type!==eventType||existing.source_kind!==sourceKind) throw error('Producer event key reused with conflicting payload',409,'RESPONSIBILITY_CONFLICT');
      return {recorded:false,deduplicated:true,event:producerEventRow(existing)};
    }
    const ts=now();
    const res=db.prepare('INSERT INTO responsibility_producer_events(event_key,event_type,source_kind,organization_id,project_id,session_id,run_id,event_id,state,occurred_at,payload_digest,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(eventKey,eventType,sourceKind,input.organizationId||null,input.projectId||null,input.sessionId||null,input.runId||null,input.eventId||null,input.state||null,occurredAt,payloadDigest,payloadJson,ts);
    const inserted=producerEventRow(db.prepare('SELECT * FROM responsibility_producer_events WHERE sequence=?').get(res.lastInsertRowid));
    const pruned=options.autoPrune===false?null:pruneProducerEventsInTx(db,options);
    return {recorded:true,deduplicated:false,event:inserted,pruned};
  });
}
export async function captureRunTerminalProducerEvent(run,options={}) {
  if(!run||typeof run.id!=='string'||!run.id||typeof run.sessionId!=='string'||!run.sessionId||!terminal.has(run.state)||typeof run.finalizedAt!=='string'||!Number.isFinite(Date.parse(run.finalizedAt))||!run.runPublication) {
    return {recorded:false,reason:'not_terminal_or_unverified'};
  }
  const payload={id:run.id,runId:run.id,sessionId:run.sessionId,state:run.state,finalizedAt:run.finalizedAt,runPublication:run.runPublication,...(run.completedAt?{completedAt:run.completedAt}:{}),...(run.failureReason?{failureReason:run.failureReason}:{})};
  return recordProducerTriggerEvent({eventKey:`run_terminal:${run.id}`,eventType:'run_terminal',sourceKind:'root_session',organizationId:options.organizationId||null,projectId:options.projectId||null,sessionId:run.sessionId,runId:run.id,eventId:run.id,state:run.state,occurredAt:new Date(Date.parse(run.finalizedAt)).toISOString(),payloadDigest:runPayloadDigest(run),payload},options);
}
export async function captureOrganizationProducerEvent(orgEvent,options={}) {
  const organizationId=typeof orgEvent?.organizationId==='string'?orgEvent.organizationId.trim():'';
  const eventType=typeof orgEvent?.type==='string'?orgEvent.type.trim():'';
  const rawEventKey=typeof orgEvent?.eventKey==='string'&&orgEvent.eventKey.trim()?orgEvent.eventKey.trim():(orgEvent?.id!==undefined&&orgEvent?.id!==null?String(orgEvent.id):'');
  if(!organizationId||!eventType||!rawEventKey) return {recorded:false,reason:'invalid_organization_event'};
  const occurredAt=orgEvent.createdAt&&Number.isFinite(Date.parse(orgEvent.createdAt))?new Date(Date.parse(orgEvent.createdAt)).toISOString():now();
  const payload={organizationId,eventKey:rawEventKey,type:eventType,organizationRevision:orgEvent.organizationRevision??null,phaseId:orgEvent.phaseId||null,nodeId:orgEvent.nodeId||null,taskId:orgEvent.taskId||null,attemptId:orgEvent.attemptId||null,payload:orgEvent.payload&&typeof orgEvent.payload==='object'?orgEvent.payload:{},createdAt:occurredAt};
  return recordProducerTriggerEvent({eventKey:`org:${organizationId}:${rawEventKey}`,eventType,sourceKind:'organization',organizationId,projectId:orgEvent.projectId||null,sessionId:orgEvent.actorSessionId||null,runId:orgEvent.payload?.runId||null,eventId:String(orgEvent.id??rawEventKey),state:typeof orgEvent.payload?.state==='string'?orgEvent.payload.state:null,occurredAt,payload},options);
}
export async function listProducerTriggerEvents({organizationId='',sessionId='',eventType='',afterSequence=0,limit=100}={}) {
  if(!Number.isSafeInteger(afterSequence)||afterSequence<0) throw error('Invalid producer event cursor',400);
  const boundedLimit=Math.max(1,Math.min(Number(limit)||100,500));
  return read(db=>{
    const clauses=['sequence>?'], params=[afterSequence];
    if(organizationId) {clauses.push('organization_id=?');params.push(organizationId);}
    if(sessionId) {clauses.push('session_id=?');params.push(sessionId);}
    if(eventType) {clauses.push('event_type=?');params.push(eventType);}
    const rows=db.prepare(`SELECT * FROM responsibility_producer_events WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC LIMIT ?`).all(...params,boundedLimit).map(producerEventRow);
    const retention=retentionRow(db);
    return {schemaVersion:1,events:rows,nextSequence:rows.length?rows.at(-1).sequence:afterSequence,retention,cursorGapDetected:afterSequence>0&&retention.minAvailableSequence>afterSequence};
  });
}
export async function pruneProducerTriggerEvents(options={}) {
  return transaction(db=>pruneProducerEventsInTx(db,options));
}
function sourceChanged(db,bindingId,status,reason=null) {
  const old=db.prepare('SELECT status,last_error FROM responsibility_trigger_event_sources WHERE binding_id=?').get(bindingId);
  if(!old||old.status===status&&old.last_error===reason) return;
  db.prepare('UPDATE responsibility_trigger_event_sources SET status=?,last_error=?,updated_at=? WHERE binding_id=?').run(status,reason,now(),bindingId);
  const b=db.prepare('SELECT responsibility_id FROM responsibility_trigger_bindings WHERE id=?').get(bindingId);
  if(b) activity(db,b.responsibility_id,'trigger_source_status',{bindingId,status,reason});
}
async function blockSource(binding,status,reason) {await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(binding.id);if(current?.enabled&&current.version===binding.version) sourceChanged(db,binding.id,status,reason);});}
function enqueueTerminalRunInTx(db,binding,run,producerSeq=null) {
  const current=db.prepare('SELECT b.*,r.lifecycle,r.owner_principal_id,o.project_id AS current_project,o.root_session_id AS current_session FROM responsibility_trigger_bindings b JOIN responsibilities r ON r.id=b.responsibility_id JOIN organizations o ON o.id=r.organization_id WHERE b.id=?').get(binding.id);
  if(!current?.enabled||current.version!==binding.version||current.lifecycle!=='active'||current.owner_id!==current.owner_principal_id||current.project_id!==current.current_project||current.session_id!==current.current_session) return 'fenced';
  if(!validConfig(current)) {sourceChanged(db,binding.id,'source_unavailable','binding_configuration_invalid');return 'fenced';}
  const eligible=validRun(run,binding.session_id)&&Date.parse(run.finalizedAt)>=Date.parse(binding.starts_at);
  if(eligible) {
    const key=`run:${run.id}`,hash=runPayloadDigest(run),existing=db.prepare('SELECT payload_digest FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=? UNION ALL SELECT payload_digest FROM responsibility_trigger_event_queue WHERE binding_id=? AND occurrence_key=?').get(binding.id,key,binding.id,key);
    if(existing&&existing.payload_digest!==hash) {sourceChanged(db,binding.id,'source_unavailable','run_identity_changed');return 'fenced';}
    if(!existing) {
      const pending=db.prepare('SELECT COUNT(*) AS n FROM responsibility_trigger_event_queue WHERE binding_id=?').get(binding.id).n,receipts=db.prepare('SELECT COUNT(*) AS n FROM responsibility_trigger_receipts WHERE binding_id=?').get(binding.id).n;
      if(pending>=MAX_PENDING||receipts>=MAX_RECEIPTS) {sourceChanged(db,binding.id,'backpressure',pending>=MAX_PENDING?'pending_capacity':'receipt_capacity');return 'full';}
      const ts=now();
      db.prepare("INSERT INTO responsibility_trigger_event_queue(binding_id,occurrence_key,run_id,finalized_at,payload_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(binding.id,key,run.id,run.finalizedAt,hash,ts,ts);
    }
  }
  if(Number.isSafeInteger(producerSeq)&&producerSeq>0) {
    db.prepare('INSERT INTO responsibility_trigger_producer_cursors(binding_id,last_sequence,retained_floor_sequence,updated_at) VALUES(?,?,0,?) ON CONFLICT(binding_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence),updated_at=excluded.updated_at').run(binding.id,producerSeq,now());
  }
  return 'ok';
}
async function scanBinding(binding) {
  let session,entries;
  try {
    const {getSession}=await import('./session-manager.mjs');session=await getSession(binding.session_id);
    if(!session||session.archived||session.projectId!==binding.project_id) return blockSource(binding,'source_unavailable','source_session_unavailable');
    entries=await listDurableSessionRunIndexEntries(binding.session_id);
  } catch {return blockSource(binding,'source_unavailable','source_index_unavailable');}
  // 1. Check durable producer-side log first (recovers terminal runs even if raw Run files/index were pruned).
  const producerStep=await read(db=>{
    const cursorRow=db.prepare('SELECT last_sequence,retained_floor_sequence FROM responsibility_trigger_producer_cursors WHERE binding_id=?').get(binding.id);
    const lastSeq=Number(cursorRow?.last_sequence||0);
    const retention=retentionRow(db);
    const gap=retention.minAvailableSequence>lastSeq && retention.maxPrunedOccurredAt && Date.parse(retention.maxPrunedOccurredAt)>=Date.parse(binding.starts_at);
    const events=db.prepare("SELECT * FROM responsibility_producer_events WHERE session_id=? AND event_type='run_terminal' AND sequence>? ORDER BY sequence ASC LIMIT ?").all(binding.session_id,lastSeq,SCAN_BATCH).map(producerEventRow);
    return {lastSeq,retention,gap,events};
  });
  if(producerStep.gap) {
    const handledGap=await transaction(db=>{
      const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(binding.id);
      if(!current?.enabled||current.version!==binding.version) return 'fenced';
      db.prepare('INSERT INTO responsibility_trigger_producer_cursors(binding_id,last_sequence,retained_floor_sequence,updated_at) VALUES(?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence),retained_floor_sequence=MAX(retained_floor_sequence,excluded.retained_floor_sequence),updated_at=excluded.updated_at').run(binding.id,producerStep.retention.minAvailableSequence,producerStep.retention.minAvailableSequence,now());
      sourceChanged(db,binding.id,'retention_gap','producer_event_retention_gap');
      return 'gap';
    });
    if(handledGap==='gap'||handledGap==='fenced') return;
  }
  for(const pe of producerStep.events) {
    const run=pe.payload;
    const result=await transaction(db=>{
      const r=enqueueTerminalRunInTx(db,binding,run,pe.sequence);
      if(r==='ok') sourceChanged(db,binding.id,'ready');
      return r;
    });
    if(result!=='ok') return;
  }
  // 2. Reconcile against session run index for any legacy/pre-existing runs not yet in producer log.
  const ordered=entries.filter(x=>typeof x.id==='string').sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  let batch=ordered.filter(x=>x.id>binding.cursor).slice(0,SCAN_BATCH);
  if(!batch.length) {await transaction(db=>{const current=db.prepare('SELECT enabled,version FROM responsibility_trigger_bindings WHERE id=?').get(binding.id);if(current?.enabled&&current.version===binding.version) {db.prepare("UPDATE responsibility_trigger_event_sources SET cursor='',updated_at=? WHERE binding_id=? AND cursor<>''").run(now(),binding.id);sourceChanged(db,binding.id,'ready');}});return;}
  for(const entry of batch) {
    let run=null;
    if(terminal.has(entry.state)) {
      try {run=await getRunAcceptanceEvidence(entry.id);} catch {run=null;}
      if(!run) {
        const cachedProducer=await read(db=>producerEventRow(db.prepare('SELECT * FROM responsibility_producer_events WHERE event_key=?').get(`run_terminal:${entry.id}`)));
        if(cachedProducer&&cachedProducer.sessionId===binding.session_id) run=cachedProducer.payload;
        else if(!cachedProducer) return blockSource(binding,'retention_gap','run_removed_before_observation');
      }
      if(!run) return blockSource(binding,'source_unavailable','run_evidence_unavailable');
      if(run.sessionId!==binding.session_id) return blockSource(binding,'source_unavailable','run_session_mismatch');
      if(validRun(run,binding.session_id)) {
        try {await captureRunTerminalProducerEvent(run,{autoPrune:false});} catch {}
      }
    }
    const result=await transaction(db=>{
      const r=enqueueTerminalRunInTx(db,binding,run,null);
      if(r!=='ok') return r;
      db.prepare('UPDATE responsibility_trigger_event_sources SET cursor=?,updated_at=? WHERE binding_id=?').run(entry.id,now(),binding.id);
      sourceChanged(db,binding.id,'ready');
      return 'ok';
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
    let producerRow=null;
    if(!run) {
      producerRow=producerEventRow(db.prepare('SELECT * FROM responsibility_producer_events WHERE event_key=?').get(`run_terminal:${entry.run_id}`));
      if(producerRow?.payload) run=producerRow.payload;
    }
    if(!validRun(run,b.session_id)||runPayloadDigest(run)!==q.payload_digest) {db.prepare("UPDATE responsibility_trigger_event_queue SET state='blocked',last_error='run_evidence_unavailable',lease_token=NULL,lease_until=NULL,updated_at=? WHERE binding_id=? AND occurrence_key=?").run(ts,q.binding_id,q.occurrence_key);sourceChanged(db,b.id,!run&&!unavailable?'retention_gap':'source_unavailable','run_evidence_unavailable');return;}
    const old=db.prepare('SELECT wake_id,payload_digest FROM responsibility_trigger_receipts WHERE binding_id=? AND occurrence_key=?').get(b.id,q.occurrence_key);if(old&&old.payload_digest!==q.payload_digest) throw new Error('Trigger occurrence identity conflict');
    if(!old) {const wakeId=newId('wake');db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(wakeId,b.responsibility_id,b.revision,b.policy_revision,ts,'pending',0,null,ts,ts);recordObservation(db,wakeId,'event',{triggerId:b.trigger_id,bindingId:b.id,bindingVersion:b.version,occurrenceKey:q.occurrence_key,source:'run_terminal',runId:q.run_id,runState:run.state,finalizedAt:q.finalized_at,...(producerRow?{producerSequence:producerRow.sequence}:{})});db.prepare('INSERT INTO responsibility_trigger_receipts VALUES(?,?,?,?,?)').run(b.id,q.occurrence_key,q.payload_digest,wakeId,ts);activity(db,b.responsibility_id,'wake_received',{wakeId,triggerId:b.trigger_id,bindingId:b.id,source:'run_terminal',runState:run.state});}
    db.prepare('DELETE FROM responsibility_trigger_event_queue WHERE binding_id=? AND occurrence_key=?').run(q.binding_id,q.occurrence_key);
  });
}
export async function processResponsibilityTriggerEvents() {
  const bindings=await read(db=>db.prepare("SELECT b.*,s.starts_at,s.cursor FROM responsibility_trigger_bindings b JOIN responsibility_trigger_event_sources s ON s.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.enabled=1 AND r.lifecycle='active' AND s.status IN ('ready','backpressure') ORDER BY s.updated_at,b.id LIMIT 20").all());
  for(const binding of bindings) {await scanBinding(binding);await transaction(db=>db.prepare('UPDATE responsibility_trigger_event_sources SET updated_at=? WHERE binding_id=?').run(now(),binding.id));}
  const due=await read(db=>db.prepare("SELECT q.binding_id,q.occurrence_key,q.run_id FROM responsibility_trigger_event_queue q JOIN responsibility_trigger_bindings b ON b.id=q.binding_id JOIN responsibility_trigger_event_sources s ON s.binding_id=b.id JOIN responsibilities r ON r.id=b.responsibility_id WHERE b.enabled=1 AND r.lifecycle='active' AND s.status IN ('ready','backpressure') AND (q.state='pending' OR (q.state='claimed' AND q.lease_until<=?)) AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=?) ORDER BY q.created_at LIMIT ?").all(now(),now(),DELIVERY_BATCH));
  for(const entry of due) await deliverOne(entry);
}
