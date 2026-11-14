import { getResponsibility } from './responsibility-service.mjs';
import { defaultProjectMemoryStore, projectMemoryConflictMutationDigest } from './project-memory-store.mjs';
import { read, transaction, digest, now, error } from './responsibility-store.mjs';
import { createHash } from 'node:crypto';

const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflictChanges(input) {
  if(!Array.isArray(input?.factIds)||input.factIds.length<2||input.factIds.length>20||!Array.isArray(input.changes)||input.changes.length!==input.factIds.length) throw error('Select two to twenty facts');
  const ids=input.factIds.map(id=>typeof id==='string'?id.trim():'').sort();
  if(ids.some(id=>!id||id.length>120)||new Set(ids).size!==ids.length) throw error('Invalid fact selection');
  const changes=input.changes.map(c=>({factId:typeof c?.factId==='string'?c.factId.trim():'',action:c?.action,value:c?.action==='correct'&&typeof c.value==='string'?c.value.trim():''})).sort((a,b)=>a.factId<b.factId?-1:a.factId>b.factId?1:0);
  if(changes.some((c,i)=>c.factId!==ids[i]||!['keep','correct','retract'].includes(c.action)||(c.action==='correct'&&(!c.value||c.value.length>1200)))) throw error('Invalid conflict changes');
  return changes;
}
function conflictSignature(facts) {return hashJson(facts.map(f=>({factId:f.factId,version:f.currentVersion,value:f.factValue,state:f.state})).sort((a,b)=>a.factId<b.factId?-1:a.factId>b.factId?1:0));}
export async function listResponsibilityMemoryConflicts(id,actor) {
  const {responsibility}=await getResponsibility(id,actor),memory=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId);
  if(!memory) return {schemaVersion:1,version:0,groups:[],truncated:false};
  const [facts,reviews,provenance]=await Promise.all([defaultProjectMemoryStore.listCurrentFacts(responsibility.projectId),defaultProjectMemoryStore.listConflictReviews(responsibility.projectId),defaultProjectMemoryStore.getFactProvenance(responsibility.projectId,memory.currentVersion)]);
  const latest=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId),checked=await getResponsibility(id,actor);
  if(latest?.currentVersion!==memory.currentVersion||latest?.digest!==memory.digest||checked.responsibility.rowVersion!==responsibility.rowVersion) throw error('Memory or responsibility changed',409,'RESPONSIBILITY_CONFLICT');
  const buckets=new Map();for(const fact of facts.slice(0,500)) {if(fact.state!=='active'||!fact.factValue||!fact.factKey)continue;const key=fact.factKey.normalize('NFKC').trim().toLowerCase();if(!key)continue;const list=buckets.get(key)||[];list.push(fact);buckets.set(key,list);}
  const groups=[];for(const [factKey,all] of buckets) {const selected=all.slice(0,20);if(selected.length<2||new Set(selected.map(f=>f.factValue.trim().replace(/\s+/g,' '))).size<2)continue;const ids=selected.map(f=>f.factId).sort(),review=reviews.find(r=>r.groupKey===hashJson(ids));groups.push({factKey,kind:'possible_conflict',reviewed:review?.factSignature===conflictSignature(selected),truncated:all.length>20,facts:selected.map(f=>({...f,sources:provenance.filter(p=>p.factId===f.factId&&p.factVersion===f.currentVersion)}))});}
  return {schemaVersion:1,version:memory.currentVersion,groups:groups.slice(0,100),truncated:facts.length>500||groups.length>100};
}
export async function previewResponsibilityMemoryConflict(id,input,actor) {
  const {responsibility}=await getResponsibility(id,actor),changes=conflictChanges(input);
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1) throw error('Invalid memory version');
  const memory=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId);if(!memory||memory.currentVersion!==input.expectedVersion) throw error('Memory version changed',409,'RESPONSIBILITY_CONFLICT');
  const [facts,provenance]=await Promise.all([defaultProjectMemoryStore.listCurrentFacts(responsibility.projectId),defaultProjectMemoryStore.getFactProvenance(responsibility.projectId,memory.currentVersion)]);
  const selected=changes.map(c=>facts.find(f=>f.factId===c.factId));if(selected.some(f=>!f||f.state!=='active')) throw error('Conflict facts changed',409,'RESPONSIBILITY_CONFLICT');
  const latest=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId),checked=await getResponsibility(id,actor);if(latest?.currentVersion!==memory.currentVersion||latest?.digest!==memory.digest||checked.responsibility.rowVersion!==responsibility.rowVersion) throw error('Memory or responsibility changed',409,'RESPONSIBILITY_CONFLICT');
  const changed=changes.some(c=>c.action!=='keep'),visible=facts.map(f=>{const c=changes.find(x=>x.factId===f.factId);return c&&c.action!=='keep'?{...f,state:c.action==='correct'?'active':'invalidated',factValue:c.value}:f;}).filter(f=>f.state==='active'&&f.factValue),lines=visible.map(f=>`- ${f.factValue}`).join('\n')||'No active structured facts.';
  const createdAt=now(),payload={responsibilityId:id,responsibilityVersion:responsibility.rowVersion,projectId:responsibility.projectId,actorId:actor.principalId,expectedVersion:memory.currentVersion,previousContentDigest:memory.digest,previousSummary:memory.summary||'',facts:selected.map(f=>({...f,sources:provenance.filter(p=>p.factId===f.factId&&p.factVersion===f.currentVersion)})),changes,projectedContent:changed?`# Project Memory\n\n${lines}`:memory.content,projectedSummary:changed?`v${memory.currentVersion+1}\n${lines}`:memory.summary,createdAt,expiresAt:new Date(Date.now()+15*60000).toISOString()};const previewDigest=digest(payload);
  await transaction(db=>db.prepare('INSERT OR IGNORE INTO responsibility_memory_previews VALUES(?,?,?,?,?)').run(previewDigest,actor.principalId,id,JSON.stringify(payload),createdAt));return {schemaVersion:1,preview:payload,previewDigest};
}
export async function commitResponsibilityMemoryConflict(id,input,actor) {
  const {responsibility}=await getResponsibility(id,actor),changes=conflictChanges(input);if(input.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.trim().length>160||typeof input.previewDigest!=='string') throw error('Confirmation, preview digest and idempotency key are required');
  const saved=await read(db=>db.prepare('SELECT * FROM responsibility_memory_previews WHERE digest=? AND actor_id=? AND responsibility_id=?').get(input.previewDigest,actor.principalId,id));if(!saved) throw error('Memory preview unavailable',409,'RESPONSIBILITY_CONFLICT');const p=JSON.parse(saved.payload_json);
  if(p.projectId!==responsibility.projectId||p.responsibilityVersion!==responsibility.rowVersion||p.expectedVersion!==input.expectedVersion||digest(p)!==input.previewDigest||digest(p.changes)!==digest(changes)) throw error('Memory preview does not match request',409,'RESPONSIBILITY_CONFLICT');
  const checkExpiry=async()=>{if(!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now()) {const prior=await defaultProjectMemoryStore.getMemoryMutationReceipt(p.projectId,actor.principalId,input.idempotencyKey),expected=projectMemoryConflictMutationDigest(p.projectId.trim().slice(0,160),changes,p.expectedVersion);if(!prior||prior.payloadDigest!==expected) throw error('Memory preview expired',409,'RESPONSIBILITY_CONFLICT');}};
  await checkExpiry();
  return defaultProjectMemoryStore.resolveFactConflict({projectId:p.projectId,changes,expectedVersion:p.expectedVersion,actorId:actor.principalId,requestId:input.idempotencyKey},{authorize:async()=>{const current=await getResponsibility(id,actor);if(current.responsibility.projectId!==p.projectId||current.responsibility.rowVersion!==p.responsibilityVersion) throw error('Responsibility changed',409,'RESPONSIBILITY_CONFLICT');await checkExpiry();}});
}

export async function previewResponsibilityMemory(id,factId,input,actor) {
  const {responsibility}=await getResponsibility(id,actor); const action=input?.action, value=typeof input?.value==='string'?input.value.trim():'';
  if(!['correct','retract'].includes(action)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||(action==='correct'&&(!value||value.length>1200))) throw error('Invalid memory preview');
  const memory=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId); if(!memory||memory.currentVersion!==input.expectedVersion) throw error('Memory version changed',409,'RESPONSIBILITY_CONFLICT');
  const facts=await defaultProjectMemoryStore.listCurrentFacts(responsibility.projectId), fact=facts.find(entry=>entry.factId===factId); if(!fact) throw error('Fact unavailable',404,'RESPONSIBILITY_NOT_FOUND');
  const latest=await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId); if(!latest||latest.currentVersion!==input.expectedVersion||latest.digest!==memory.digest) throw error('Memory changed during preview',409,'RESPONSIBILITY_CONFLICT');
  const visible=facts.map(entry=>entry.factId===factId?{...entry,state:action==='correct'?'active':'invalidated',factValue:action==='correct'?value:''}:entry).filter(entry=>entry.state==='active'&&entry.factValue);
  const lines=visible.map(entry=>`- ${entry.factValue}`).join('\n')||'No active structured facts.';
  const createdAt=now(),expiresAt=new Date(Date.now()+15*60000).toISOString();
  const payload={responsibilityId:id,projectId:responsibility.projectId,factId,action,value:action==='correct'?value:'',expectedVersion:input.expectedVersion,actorId:actor.principalId,previousValue:fact.factValue||'',previousState:fact.state||'',previousContentDigest:memory.digest,previousSummary:memory.summary||'',projectedContent:`# Project Memory\n\n${lines}`,projectedSummary:`v${input.expectedVersion+1}\n${lines}`,rebuildsContentAndSummary:true,createdAt,expiresAt}; const previewDigest=digest(payload);
  await transaction(db=>{db.prepare('INSERT OR IGNORE INTO responsibility_memory_previews VALUES(?,?,?,?,?)').run(previewDigest,actor.principalId,id,JSON.stringify(payload),createdAt);}); return {schemaVersion:1,preview:payload,previewDigest};
}
export async function reviseResponsibilityMemory(id,factId,action,input,actor) {
  const {responsibility}=await getResponsibility(id,actor); if(input?.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.trim().length>160||typeof input.previewDigest!=='string') throw error('Confirmation, preview digest and idempotency key are required');
  const saved=await read(db=>db.prepare('SELECT * FROM responsibility_memory_previews WHERE digest=? AND actor_id=? AND responsibility_id=?').get(input.previewDigest,actor.principalId,id)); if(!saved) throw error('Memory preview unavailable',409,'RESPONSIBILITY_CONFLICT'); const p=JSON.parse(saved.payload_json);
  if(p.projectId!==responsibility.projectId||p.factId!==factId||p.action!==action||p.expectedVersion!==input.expectedVersion||(action==='correct'&&p.value!==(typeof input.value==='string'?input.value.trim():''))||digest(p)!==input.previewDigest) throw error('Memory preview does not match request',409,'RESPONSIBILITY_CONFLICT');
  if(!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now()) {const prior=await defaultProjectMemoryStore.getMemoryMutationReceipt(p.projectId,actor.principalId,input.idempotencyKey); const expected=createHash('sha256').update(JSON.stringify({project:p.projectId.trim().slice(0,160),fact:factId.trim().slice(0,120),action,value:p.value,expectedVersion:p.expectedVersion})).digest('hex'); if(!prior||prior.payloadDigest!==expected) throw error('Memory preview expired',409,'RESPONSIBILITY_CONFLICT');}
  return defaultProjectMemoryStore.reviseFact({projectId:p.projectId,factId,action,value:p.value,expectedVersion:p.expectedVersion,actorId:actor.principalId,requestId:input.idempotencyKey});
}
