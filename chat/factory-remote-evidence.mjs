import { createHash, createPublicKey, verify } from 'node:crypto';
import { factoryTransaction, factoryRead, factoryError, now, newId, encode, digest, event, itemRow } from './work-graph-store.mjs';
import { authorize, selectItem, update } from './work-graph.mjs';
import { getOrganization } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw factoryError('REMOTE_EVIDENCE_INVALID',message,409);};
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_remote_evidence (
 id TEXT PRIMARY KEY, source_binding_id TEXT NOT NULL, operation_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 contract_revision INTEGER NOT NULL, execution_epoch INTEGER NOT NULL, candidate_digest TEXT NOT NULL,
 envelope_json TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(source_binding_id,operation_id), UNIQUE(work_item_id,contract_revision,execution_epoch));
 CREATE TRIGGER IF NOT EXISTS factory_remote_evidence_no_update BEFORE UPDATE ON factory_remote_evidence BEGIN SELECT RAISE(ABORT,'immutable remote evidence'); END;
 CREATE TRIGGER IF NOT EXISTS factory_remote_evidence_no_delete BEFORE DELETE ON factory_remote_evidence BEGIN SELECT RAISE(ABORT,'immutable remote evidence'); END;`); }
function validate(db,item,binding,signed,sourceInstanceId) {
  const e=signed?.envelope, signature=signed?.signature;
  if(!e||typeof signature!=='string'||Buffer.byteLength(JSON.stringify(e),'utf8')>4*1024*1024) fail('Candidate envelope is invalid or too large');
  const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(e.sourceBindingId);
  const op=b&&db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(b.id,e.operationId);
  if(!b||!op||!b.enabled||Date.parse(b.expires_at)<=Date.now()||b.version!==e.sourceBindingVersion||b.organization_id!==item.organization_id
      || b.target_instance_id!==e.targetInstanceId||b.target_binding_id!==e.targetBindingId||b.target_binding_version!==e.targetBindingVersion
      || e.sourceInstanceId!==sourceInstanceId||op.source_factory_binding_id!==binding.id||e.sourceFactoryBindingId!==binding.id
      || binding.work_item_id!==item.id||binding.contract_revision!==item.contract_revision||binding.execution_epoch!==item.execution_epoch||binding.binding_generation!==item.binding_generation
      || e.sourceContractRevision!==item.contract_revision||e.sourceExecutionEpoch!==item.execution_epoch) fail('Candidate authority or source binding changed');
  const saved=JSON.parse(op.request_json), q=saved.canonical;
  if(!saved.binding||saved.binding.version!==b.version||saved.binding.targetPublicKey!==b.target_public_key
      || q.operationId!==e.operationId||q.requestId!==e.requestId||q.payload.expectedBaselineDigest!==e.baselineManifestDigest
      || q.payload.expectedBaseHead!==e.baseline?.head||q.payload.expectedBaseBranch!==e.baseline?.branch) fail('Candidate delegation or baseline changed');
  let valid=false; try {valid=verify(null,Buffer.from(`agentoc-remote-candidate-v1:${sha(JSON.stringify(e))}`),createPublicKey(b.target_public_key),Buffer.from(signature,'base64url'));} catch {}
  if(!valid||digest(e.baseline)!==e.baselineManifestDigest||digest(e.changes)!==e.contentDigest||!Array.isArray(e.baseline?.files)||!Array.isArray(e.changes)) fail('Candidate signature or content digest is invalid');
  if(!e.targetWorkItemId||!e.targetExecutionBindingId||!e.attemptId||!e.runId||!Number.isSafeInteger(e.targetContractRevision)||!Number.isSafeInteger(e.targetExecutionEpoch)||!Number.isSafeInteger(e.targetBindingGeneration)) fail('Target execution identity is incomplete');
  const expected=sha(JSON.stringify({workItemId:e.targetWorkItemId,contractRevision:e.targetContractRevision,executionEpoch:e.targetExecutionEpoch,
    bindingGeneration:e.targetBindingGeneration,runId:e.runId,baselineDigest:e.baselineDigest,filesJson:JSON.stringify(e.changes)}));
  if(expected!==e.candidateDigest) fail('Candidate payload digest differs');
  const paths=new Set(), allowed=q.payload.contract.allowedPaths || [];
  for(const change of e.changes) {
    const path=change?.path, parts=typeof path==='string'?path.split('/'):[];
    if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||/^(?:\.git|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|credentials?|secrets?|node_modules|\.cache|id_rsa|id_ed25519)$/i.test(p)||/\.(?:pem|key|p12|pfx)$/i.test(p))
        || path.includes('\\')||/^[A-Za-z]:/.test(path)||!allowed.some(root=>path===root||path.startsWith(`${root}/`))||paths.has(path)) fail('Candidate path is outside authorized scope');
    paths.add(path);
    if(change.type==='delete' ? (change.digest!==''||change.bytes!==undefined) : (!['add','modify'].includes(change.type)||typeof change.bytes!=='string'||sha(Buffer.from(change.bytes,'base64'))!==change.digest)) fail('Candidate content is invalid');
  }
  return e;
}
export function verifyRemoteFactoryEvidence(db,item,binding,payload) {
  try {schema(db);const row=db.prepare('SELECT * FROM factory_remote_evidence WHERE id=? AND work_item_id=?').get(payload.candidateId,item.id);
    if(!row||row.candidate_digest!==payload.digest||binding.status!=='remote_candidate') return null;
    const raw=db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(item.id), current=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(item.id,binding.contractRevision,binding.executionEpoch,binding.bindingGeneration);
    if(!raw||!current||current.status!=='remote_candidate'||(binding.id&&binding.id!==current.id)) return null;
    const e=validate(db,raw,current,{envelope:JSON.parse(row.envelope_json),signature:row.signature},JSON.parse(row.envelope_json).sourceInstanceId);
    return {candidateId:row.id,digest:e.candidateDigest,baselineDigest:e.baselineDigest,remote:true,terminalEvidenceRef:`remote:${e.operationId}:${e.runId}`,files:e.changes.map(({path,digest,type})=>({path,digest,type}))};
  } catch {return null;}
}
export { verifyRemoteTerminalReceipt } from './factory-remote-terminal.mjs';
export async function importRemoteFactoryCandidate({bindingId,operationId,signed},actor) {
  const identity=await loadOrCreateInstanceIdentity();
  const preliminary=await factoryRead(db=>{const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId),o=b&&db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if(!b||!o) fail('Remote operation unavailable'); authorize(db,b.organization_id,actor,'factory.execution');return {organizationId:b.organization_id,request:JSON.parse(o.request_json).canonical};});
  const org=await getOrganization(preliminary.organizationId),root=org?.rootSessionId&&await getSession(org.rootSessionId);
  const {inspectSourceRemoteBaseline}=await import('./factory-remote-admission.mjs');
  const current=await inspectSourceRemoteBaseline(root?.folder,preliminary.request.payload.contract.allowedPaths);
  if(current.baselineDigest!==preliminary.request.payload.expectedBaselineDigest||current.baseHead!==preliminary.request.payload.expectedBaseHead||current.baseBranch!==preliminary.request.payload.expectedBaseBranch) fail('Source workspace baseline changed');
  return factoryTransaction(db=>{schema(db);authorize(db,preliminary.organizationId,actor,'factory.execution');
    const source=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=?').get(preliminary.request.sourceFactoryBindingId);
    const item=source&&selectItem(db,preliminary.organizationId,source.work_item_id);
    if(!item) fail('Source execution is unavailable');
    verifyFactoryResponsibilityFence(db,item);
    const e=validate(db,item,source,signed,identity.instanceId);
    const old=db.prepare('SELECT * FROM factory_remote_evidence WHERE source_binding_id=? AND operation_id=?').get(bindingId,operationId);
    if(old) {if(old.candidate_digest!==e.candidateDigest) fail('Remote evidence conflicts');return {candidateId:old.id,candidateDigest:old.candidate_digest,replayed:true};}
    if(!['intent','unknown'].includes(source.status)||!['claimed','blocked'].includes(item.state)||item.control_state!=='none') fail('Source execution is not awaiting a remote result');
    const id=newId('remote_candidate'),ts=now();
    db.prepare('INSERT INTO factory_remote_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,bindingId,operationId,item.id,item.contract_revision,item.execution_epoch,e.candidateDigest,JSON.stringify(e),signed.signature,ts);
    db.prepare('INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)').run(newId('candidate'),item.id,item.contract_revision,item.execution_epoch,item.binding_generation,e.candidateDigest,encode({candidateId:id,remote:true}),ts);
    db.prepare('UPDATE factory_execution_bindings SET status=?,details_json=?,updated_at=? WHERE id=?').run('remote_candidate',encode({candidateId:id,digest:e.candidateDigest}),ts,source.id);
    const next=update(db,item,{state:'review',blocked_json:null,candidate_digest:e.candidateDigest,gate_generation:item.gate_generation+1});
    event(db,item.organization_id,item.id,'RemoteCandidateImported',{candidateId:id,operationId,sourceBindingId:bindingId,candidateDigest:e.candidateDigest});
    return {candidateId:id,candidateDigest:e.candidateDigest,item:itemRow(db,next),replayed:false};
  });
}
export async function getRemoteFactoryEvidence({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const item=selectItem(db,organizationId,workItemId);
    const raw=db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND status='remote_candidate'").get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    const candidate=raw&&db.prepare('SELECT details_json FROM factory_candidates WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND digest=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation,item.candidate_digest);
    const candidateId=candidate&&JSON.parse(candidate.details_json||'{}').candidateId;
    const projected=raw&&{id:raw.id,status:raw.status,contractRevision:raw.contract_revision,executionEpoch:raw.execution_epoch,bindingGeneration:raw.binding_generation};
    if(!projected||!verifyRemoteFactoryEvidence(db,{id:item.id},projected,{candidateId,digest:item.candidate_digest})) fail('Remote evidence is unavailable');
    const record=db.prepare('SELECT envelope_json FROM factory_remote_evidence WHERE id=?').get(candidateId);
    const e=JSON.parse(record.envelope_json);
    return {candidateId,candidateDigest:e.candidateDigest,operationId:e.operationId,runId:e.runId,baseline:e.baseline,changes:e.changes};
  });
}
