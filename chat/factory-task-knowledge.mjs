// Explicit, per-work-item references to existing Project Memory facts.
// A pinned fact is context, not an authorization or acceptance decision.
import { createHash } from 'node:crypto';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { getFactoryWorkItem } from './factory-control.mjs';
import { executeWorkGraphCommand } from './work-graph.mjs';
import { authorize } from './work-graph.mjs';
import { factoryRead, decode } from './work-graph-store.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'FACTORY_KNOWLEDGE_UNAVAILABLE',statusCode:409});};

async function fact(projectId,ref) {
  const row=await defaultProjectMemoryStore.getFactForTask(projectId,ref.factId,ref.memoryVersion);
  if(!row || row.state!=='active' || row.currentState!=='active' || row.contestedBy || row.currentContestedBy
      || row.factVersion!==row.currentVersion || row.factKey!==row.currentKey || row.factValue!==row.currentValue || !row.factValue || !row.sources.length || row.sources.length>10
      || Buffer.byteLength(row.factValue,'utf8')>2000) fail('Referenced project fact is missing, contested, changed or lacks bounded provenance');
  return row;
}

export async function resolveFactoryTaskKnowledge(projectId,refs) {
  if(!Array.isArray(refs) || refs.length>10) fail('Invalid task knowledge references');
  const facts=[];
  for(const ref of refs) {
    if(!ref || ref.projectId!==projectId || typeof ref.factId!=='string' || !Number.isSafeInteger(ref.memoryVersion)
        || !Number.isSafeInteger(ref.factVersion) || !/^[a-f0-9]{64}$/.test(ref.valueDigest || '') || !/^[a-f0-9]{64}$/.test(ref.provenanceDigest || '')) fail('Invalid task knowledge reference');
    const row=await fact(projectId,ref);
    if(row.factVersion!==ref.factVersion || digest({key:row.factKey,value:row.factValue})!==ref.valueDigest || digest(row.sources)!==ref.provenanceDigest) fail('Project fact or its provenance changed after authorization');
    facts.push({factId:row.factId,memoryVersion:row.memoryVersion,factVersion:row.factVersion,key:row.factKey,value:row.factValue,
      sources:row.sources.map(s=>({id:s.id,sessionId:s.session_id,runId:s.run_id,eventStart:s.source_event_start,eventEnd:s.source_event_end}))});
  }
  return facts;
}

export async function setFactoryTaskKnowledge(input,actor) {
  if(actor?.kind!=='user' || actor?.role!=='owner' || !actor.principalId) fail('Owner access required');
  if(!Array.isArray(input?.refs) || input.refs.length>10) fail('At most ten explicit fact references are allowed');
  const replay=await factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.read'); const row=db.prepare("SELECT * FROM factory_command_receipts WHERE organization_id=? AND actor_id=? AND command_type='AmendContract' AND target_id=? AND idempotency_key=?").get(input.organizationId,actor.principalId,input.workItemId,input.idempotencyKey); return row ? decode(row.result_json,{}) : null;});
  if(replay) {
    const contract=replay.item?.contract, refs=contract?.knowledgeRefs;
    if(!Array.isArray(refs) || JSON.stringify(refs.map(({factId,memoryVersion})=>({factId,memoryVersion})))!==JSON.stringify(input.refs)) fail('Idempotency key belongs to another request');
    return executeWorkGraphCommand({organizationId:input.organizationId,targetId:input.workItemId,type:'AmendContract',expectedVersion:input.expectedVersion,commandId:input.commandId,idempotencyKey:input.idempotencyKey,payload:{contract}},actor);
  }
  const item=(await getFactoryWorkItem(input.organizationId,input.workItemId,actor)).item;
  const refs=[];
  for(const requested of input.refs) {
    if(!requested || Object.keys(requested).some(key=>!['factId','memoryVersion'].includes(key)) || typeof requested.factId!=='string'
        || !requested.factId || requested.factId!==requested.factId.trim() || requested.factId.length>120 || !Number.isSafeInteger(requested.memoryVersion) || requested.memoryVersion<1 || refs.some(r=>r.factId===requested.factId)) fail('Invalid or duplicate fact reference');
    const row=await fact(item.projectId,requested);
    refs.push({projectId:item.projectId,factId:row.factId,memoryVersion:row.memoryVersion,factVersion:row.factVersion,valueDigest:digest({key:row.factKey,value:row.factValue}),provenanceDigest:digest(row.sources)});
  }
  const pinned=digest(refs);
  if(digest(item.contract.knowledgeRefs || [])===pinned) fail('Task knowledge references are unchanged');
  return executeWorkGraphCommand({organizationId:input.organizationId,targetId:item.id,type:'AmendContract',expectedVersion:input.expectedVersion,
    commandId:input.commandId,idempotencyKey:input.idempotencyKey,payload:{contract:{...item.contract,knowledgeRefs:refs}}},actor,{
    verifyKnowledgeRefs:({organization,actor:current,workItemId,refs:proposed})=>current.kind==='user' && current.role==='owner' && workItemId===item.id && organization.current_revision===item.contract.organizationRevision && digest(proposed)===pinned,
  });
}
