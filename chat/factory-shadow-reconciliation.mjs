// Bounded comparison of shadow references against canonical Run and Packet
// stores. Observation is not acceptance and is not a cross-store snapshot.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { CONFIG_DIR } from '../lib/config.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { computeResultPacketDigest } from './result-packets.mjs';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode } from './work-graph-store.mjs';
import { authorize, required } from './work-graph.mjs';

function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_shadow_reconciliation_receipts (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, cursor TEXT NOT NULL, next_cursor TEXT,
 source_as_of TEXT NOT NULL, observed_at TEXT NOT NULL, result_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS factory_shadow_reconciliation_org ON factory_shadow_reconciliation_receipts(organization_id,observed_at,id);
 CREATE TRIGGER IF NOT EXISTS factory_shadow_reconciliation_no_update BEFORE UPDATE ON factory_shadow_reconciliation_receipts BEGIN SELECT RAISE(ABORT,'immutable shadow receipt'); END;
 CREATE TRIGGER IF NOT EXISTS factory_shadow_reconciliation_no_delete BEFORE DELETE ON factory_shadow_reconciliation_receipts BEGIN SELECT RAISE(ABORT,'immutable shadow receipt'); END;`); }
function parseCursor(value) { if(!value) return ['',-1]; try { if(typeof value!=='string'||value.length>512) throw 0; const x=JSON.parse(Buffer.from(value,'base64url').toString('utf8')); if(!Array.isArray(x)||x.length!==2||typeof x[0]!=='string'||!Number.isSafeInteger(x[1])||x[1]<-1) throw 0;return x; } catch {throw factoryError('FACTORY_INVALID','Invalid reconciliation cursor',400);} }
function encodedCursor(task,number) {return Buffer.from(JSON.stringify([task,number])).toString('base64url');}
function safeId(value) { return typeof value==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
async function packetReader() {
 const path=join(CONFIG_DIR,'project-workflow.db');
 try {const info=await stat(path);if(!info.isFile()) return null;return new DatabaseSync(path,{readOnly:true,timeout:1000});}
 catch {return null;}
}
function packetFor(db,id) { if(!db) return {kind:'unavailable'};try {const row=db.prepare('SELECT packet_id,run_id,project_id,digest,packet_json FROM result_packets WHERE packet_id=?').get(id);if(!row)return {kind:'missing'};const packet=JSON.parse(row.packet_json);if(packet.packetId!==row.packet_id||packet.digest!==row.digest||computeResultPacketDigest(packet)!==row.digest)return {kind:'inconsistent'};return {kind:'present',row,packet};}catch{return {kind:'unavailable'};} }
export async function reconcileFactoryShadow({organizationId,cursor='',limit=20}={},actor) {
 required(organizationId,'organizationId'); if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
 const [afterTask,afterAttempt]=parseCursor(cursor), count=Number.isInteger(limit)?Math.max(1,Math.min(limit,50)):20;
 const page=await factoryRead(db=>{authorize(db,organizationId,actor,'factory.read');if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_shadow_sources'").get()) return [];return db.prepare(`SELECT s.task_id,s.collaboration_id,s.project_id,s.source_digest,s.last_observed_at,
 a.id AS attempt_id,a.attempt_number,a.state AS attempt_state,a.session_id,a.run_id,a.result_packet_id,a.failure_kind
 FROM factory_shadow_sources s LEFT JOIN collaboration_attempts a ON a.task_id=s.task_id
 WHERE s.organization_id=? AND (s.task_id>? OR (s.task_id=? AND COALESCE(a.attempt_number,-1)>?))
 ORDER BY s.task_id,COALESCE(a.attempt_number,-1) LIMIT ?`).all(organizationId,afterTask,afterTask,afterAttempt,count+1);});
 const selected=page.slice(0,count), reader=await packetReader(), results=[];
 try {for(const row of selected) {const record={taskId:row.task_id,collaborationId:row.collaboration_id,sourceDigest:row.source_digest,sourceObservedAt:row.last_observed_at,attemptId:row.attempt_id||null,runId:row.run_id||null,packetId:row.result_packet_id||null,classification:'matched',issues:[]};
 if(!row.attempt_id) record.issues.push('attempt_missing');
 if(row.attempt_id&&!row.run_id) record.issues.push('run_reference_missing');
 let run=null; if(row.run_id){if(!safeId(row.run_id)) record.issues.push('run_reference_invalid');else try {run=await getRunAcceptanceEvidence(row.run_id);if(!run) record.issues.push('run_missing');else if(run.id!==row.run_id || (row.session_id&&run.sessionId!==row.session_id)) record.issues.push('run_identity_mismatch');else {const expected={succeeded:'completed',failed:'failed',cancelled:'cancelled'}[row.attempt_state];if(expected&&run.state!==expected)record.issues.push('terminal_state_mismatch');}} catch {record.issues.push('run_unavailable');}}
 if(row.attempt_id&&!row.result_packet_id) record.issues.push('packet_reference_missing');
 if(row.result_packet_id){const result=packetFor(reader,row.result_packet_id);if(result.kind!=='present')record.issues.push(`packet_${result.kind}`);else {const p=result.packet,producer=p.producer||{};if((row.run_id&&result.row.run_id!==row.run_id)||(producer.runId&&producer.runId!==row.run_id)||(producer.taskId&&producer.taskId!==row.task_id)||(producer.attemptId&&producer.attemptId!==row.attempt_id)||(row.project_id&&result.row.project_id!==row.project_id))record.issues.push('packet_identity_mismatch');if(!producer.runId||!producer.taskId||!producer.attemptId)record.issues.push('packet_producer_incomplete');}}
 if(record.issues.some(x=>x.includes('mismatch')||x==='packet_inconsistent'||x==='run_reference_invalid'))record.classification='inconsistent';else if(record.issues.some(x=>x.includes('unavailable')))record.classification='unavailable';else if(record.issues.length)record.classification='missing';results.push(record);}}
 finally {reader?.close();}
 const next=page.length>count?encodedCursor(selected.at(-1).task_id,selected.at(-1).attempt_number??-1):null,observedAt=now(),sourceAsOf=selected.reduce((a,r)=>!a||r.last_observed_at<a?r.last_observed_at:a,'')||observedAt;
 return factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');for(const row of selected){const current=db.prepare('SELECT source_digest FROM factory_shadow_sources WHERE organization_id=? AND task_id=? AND collaboration_id=?').get(organizationId,row.task_id,row.collaboration_id);if(!current||current.source_digest!==row.source_digest)throw factoryError('FACTORY_CONFLICT','Shadow changed during reconciliation');if(row.attempt_id){const a=db.prepare('SELECT state,session_id,run_id,result_packet_id,failure_kind FROM collaboration_attempts WHERE id=? AND task_id=?').get(row.attempt_id,row.task_id);if(!a||a.state!==row.attempt_state||a.session_id!==row.session_id||a.run_id!==row.run_id||a.result_packet_id!==row.result_packet_id||a.failure_kind!==row.failure_kind)throw factoryError('FACTORY_CONFLICT','Source attempt changed during reconciliation');}else if(db.prepare('SELECT 1 FROM collaboration_attempts WHERE task_id=? LIMIT 1').get(row.task_id))throw factoryError('FACTORY_CONFLICT','Source attempt appeared during reconciliation');}const id=`shadow_reconcile_${randomUUID()}`;const result={schemaVersion:1,id,organizationId,cursor,nextCursor:next,sourceAsOf,observedAt,scope:'page',crossStoreAtomic:false,items:results};db.prepare('INSERT INTO factory_shadow_reconciliation_receipts VALUES(?,?,?,?,?,?,?)').run(id,organizationId,cursor,next,sourceAsOf,observedAt,encode(result));return result;});
}
export async function listFactoryShadowReconciliation(organizationId,{limit=20}={},actor) {return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const n=Number.isInteger(limit)?Math.max(1,Math.min(limit,50)):20;return {schemaVersion:1,items:db.prepare('SELECT result_json FROM factory_shadow_reconciliation_receipts WHERE organization_id=? ORDER BY observed_at DESC,id DESC LIMIT ?').all(organizationId,n).map(row=>decode(row.result_json,{}))};});}
