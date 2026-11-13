import { getResponsibility } from './responsibility-service.mjs';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { read, transaction, digest, now, error } from './responsibility-store.mjs';
import { createHash } from 'node:crypto';

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
