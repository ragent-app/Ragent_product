// Source-side binding and receipt journal; target execution never becomes a
// source Work Graph acceptance decision.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { signRemoteFactoryDelegation, signRemoteFactoryCancellation } from './remote-factory-operations.mjs';
import { verifySourceRemoteDelegation } from './factory-remote-admission.mjs';
import { remoteFactoryTaskSummary } from './factory-task-handoff.mjs';
import { proxyToTarget } from './router-target-runtime-routes.mjs';

const text=value=>typeof value==='string'?value.trim():'';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function required(value,name) { const result=text(value); if(!/^[A-Za-z0-9_-]{1,160}$/.test(result)) throw factoryError('REMOTE_INVALID',`${name} is invalid`,400); return result; }
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS remote_factory_source_bindings (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,target_instance_id TEXT NOT NULL,target_public_key TEXT NOT NULL,
 target_binding_id TEXT NOT NULL,target_binding_version INTEGER NOT NULL,version INTEGER NOT NULL,enabled INTEGER NOT NULL,expires_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS remote_factory_source_operations (
 binding_id TEXT NOT NULL,operation_id TEXT NOT NULL,source_factory_binding_id TEXT NOT NULL UNIQUE,payload_digest TEXT NOT NULL,
 request_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(binding_id,operation_id));`); }
function binding(row) { return {id:row.id,organizationId:row.organization_id,targetInstanceId:row.target_instance_id,targetPublicKey:row.target_public_key,targetBindingId:row.target_binding_id,targetBindingVersion:row.target_binding_version,version:row.version,enabled:!!row.enabled,expiresAt:row.expires_at}; }
export async function configureRemoteFactorySourceBinding(input,actor) {
  const id=required(input?.id,'id'), organizationId=required(input?.organizationId,'organizationId'), target=required(input?.targetInstanceId,'targetInstanceId'), targetBindingId=required(input?.targetBindingId,'targetBindingId');
  if(actor?.kind!=='user'||actor?.role!=='owner') throw factoryError('REMOTE_FORBIDDEN','Owner required',403);
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!Number.isSafeInteger(input.targetBindingVersion)||input.targetBindingVersion<1||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()) throw factoryError('REMOTE_INVALID','Binding version or expiry invalid',400);
  const key=text(input.targetPublicKey); try { if(createPublicKey(key).asymmetricKeyType!=='ed25519'||`inst_${createInstancePublicKeyFingerprint(key).slice(0,32)}`!==target) throw new Error(); } catch {throw factoryError('REMOTE_INVALID','Target key does not match instance',400);}
  return factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const old=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(id);
    if((old?.version||0)!==input.expectedVersion||(old&&old.organization_id!==organizationId)) throw factoryError('REMOTE_CONFLICT','Source binding changed',409);
    db.prepare(`INSERT INTO remote_factory_source_bindings VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target_instance_id=excluded.target_instance_id,target_public_key=excluded.target_public_key,target_binding_id=excluded.target_binding_id,target_binding_version=excluded.target_binding_version,version=excluded.version,enabled=excluded.enabled,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(id,organizationId,target,key,targetBindingId,input.targetBindingVersion,input.expectedVersion+1,input.enabled===false?0:1,new Date(input.expiresAt).toISOString(),now()); return binding(db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(id));});
}
function verifyReceipt(envelope,b,request,sourceId) {
  if(!envelope || envelope.targetInstanceId!==b.targetInstanceId || !envelope.receipt || envelope.receipt.bindingId!==b.targetBindingId
      || envelope.receipt.operationId!==request.operationId || envelope.receipt.sourceInstanceId!==sourceId
      || envelope.receipt.requestId!==request.requestId
      || envelope.receipt.bindingVersion!==b.targetBindingVersion || envelope.receipt.sourceFactoryBindingId!==request.sourceFactoryBindingId
      || envelope.receipt.contractRevision!==request.contractRevision || envelope.receipt.executionEpoch!==request.executionEpoch) throw factoryError('REMOTE_RECEIPT_INVALID','Receipt scope mismatch',502);
  let valid=false;try {valid=verify(null,Buffer.from(`agentoc-remote-receipt-v1:${hash({targetInstanceId:envelope.targetInstanceId,receipt:envelope.receipt})}`),createPublicKey(b.targetPublicKey),Buffer.from(text(envelope.signature),'base64url'));} catch {}
  if(!valid) throw factoryError('REMOTE_RECEIPT_INVALID','Receipt signature invalid',502);
  return envelope.receipt;
}
async function readTargetRevision(targetId) {
  const requestId=`summary_${randomUUID()}`;
  const {response,body}=await proxyToTarget({targetId,requestId,idempotencyKey:requestId,method:'GET',path:'/api/runtime/summary',operation:'runtime.summary',resourceId:targetId,expectedRevision:0});
  if(!response.ok) throw factoryError('REMOTE_UNAVAILABLE','Target revision unavailable',503);
  const summary=JSON.parse(body.toString('utf8'));
  const revision=Number(summary?.revision);
  if(!Number.isSafeInteger(revision)||revision<0) throw factoryError('REMOTE_UNAVAILABLE','Target revision invalid',503);
  return revision;
}
export async function dispatchRemoteFactoryOperation(input,actor,{verifyExternal}={}) {
  if(typeof verifyExternal!=='function') throw factoryError('REMOTE_UNAVAILABLE','External authorization recheck required',409);
  const bindingId=required(input?.bindingId,'bindingId'),operationId=required(input?.operationId,'operationId'),sourceId=(await loadOrCreateInstanceIdentity()).instanceId;
  const prepared=await factoryTransaction(db=>{schema(db); const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    if(!b||!b.enabled||Date.parse(b.expires_at)<=Date.now()||b.organization_id!==input.organizationId||b.version!==input.bindingVersion
        || input.payload?.sourceBindingId!==b.id || input.payload?.sourceBindingVersion!==b.version) throw factoryError('REMOTE_FORBIDDEN','Source binding unavailable',403);
    verifySourceRemoteDelegation(db,input,actor);
    const canonical={bindingId:b.target_binding_id,operationId,requestId:required(input.requestId,'requestId'),sourceFactoryBindingId:required(input.sourceFactoryBindingId,'sourceFactoryBindingId'),bindingVersion:b.target_binding_version,contractRevision:input.contractRevision,executionEpoch:input.executionEpoch,contractDigest:input.contractDigest,payload:{...input.payload,sourceWorkItemId:input.workItemId,taskSummary:null,taskSummaryDigest:'0'.repeat(64)}};
    // Reserve space for the signature field and its encoded value on the wire.
    const summaryBudget=32768-256-Buffer.byteLength(JSON.stringify(canonical),'utf8')+4;
    canonical.payload.taskSummary=remoteFactoryTaskSummary(db,input,summaryBudget);
    canonical.payload.taskSummaryDigest=hash(canonical.payload.taskSummary);
    if(Buffer.byteLength(JSON.stringify(canonical),'utf8')>32768) throw factoryError('REMOTE_INVALID','Remote operation exceeds its shared payload limit',400);
    const digest=hash(canonical), old=db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if(old) { const saved=JSON.parse(old.request_json).canonical;
      const withoutSummary=value=>{const payload={...value.payload}; delete payload.taskSummary; delete payload.taskSummaryDigest; if(!saved.payload.sourceWorkItemId) delete payload.sourceWorkItemId; return {...value,payload};};
      if(hash(saved)!==old.payload_digest || hash(withoutSummary(saved))!==hash(withoutSummary(canonical))) throw factoryError('REMOTE_CONFLICT','Operation identity reused',409);
      return {existing:true,binding:binding(b),canonical:saved}; }
    if(db.prepare('SELECT 1 FROM remote_factory_source_operations WHERE source_factory_binding_id=?').get(input.sourceFactoryBindingId)) throw factoryError('REMOTE_CONFLICT','Factory binding already delegated',409);
    const sourceBinding=binding(b),ts=now();db.prepare('INSERT INTO remote_factory_source_operations VALUES(?,?,?,?,?,?,?, ?,?)').run(bindingId,operationId,input.sourceFactoryBindingId,digest,JSON.stringify({canonical,binding:sourceBinding,sourceInstanceId:sourceId}),'unknown',null,ts,ts);return {binding:sourceBinding,canonical}; });
  if(prepared.existing) return {status:'unknown',operationId,reason:'query_required'};
  const evidence=await verifyExternal();
  if (!evidence || evidence.clean!==true || !/^[a-f0-9]{40,64}$/.test(text(evidence.baseHead)) || !text(evidence.baseBranch)
      || !/^[a-f0-9]{64}$/.test(text(evidence.baselineDigest)) || evidence.baselineDigest!==prepared.canonical.payload.expectedBaselineDigest
      || evidence.baseHead!==prepared.canonical.payload.expectedBaseHead || evidence.baseBranch!==prepared.canonical.payload.expectedBaseBranch) {
    throw factoryError('REMOTE_CONFLICT','Source repository baseline changed',409);
  }
  const checkBeforeSend=()=>factoryRead(db=>{const current=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId); if(!current||!current.enabled||current.version!==prepared.binding.version||Date.parse(current.expires_at)<=Date.now()) throw factoryError('REMOTE_FORBIDDEN','Source binding changed',403); verifySourceRemoteDelegation(db,input,actor);
    const template={...prepared.canonical,payload:{...prepared.canonical.payload,taskSummary:null,taskSummaryDigest:'0'.repeat(64)}};
    const summary=remoteFactoryTaskSummary(db,input,32768-256-Buffer.byteLength(JSON.stringify(template),'utf8')+4);
    if(hash(summary)!==prepared.canonical.payload.taskSummaryDigest) throw factoryError('REMOTE_CONFLICT','Remote task context changed before sending',409);
  });
  await checkBeforeSend();
  const signed=await signRemoteFactoryDelegation(prepared.canonical),path=`/api/remote-factory/bindings/${prepared.binding.targetBindingId}/operations/${operationId}`;
  const signedBody=JSON.stringify({...prepared.canonical,signature:signed.signature});
  if(Buffer.byteLength(signedBody,'utf8')>32768) throw factoryError('REMOTE_INVALID','Signed remote operation exceeds its shared payload limit',400);
  try {const targetRevision=await readTargetRevision(prepared.binding.targetInstanceId);await checkBeforeSend();const {response,body}=await proxyToTarget({targetId:prepared.binding.targetInstanceId,requestId:input.requestId,idempotencyKey:input.requestId,method:'POST',path,operation:'factory.remote.accept',resourceId:prepared.binding.targetBindingId,expectedRevision:targetRevision,body:signedBody,headers:{'content-type':'application/json'}});
    if(!response.ok) throw new Error('Target admission unavailable'); const envelope=JSON.parse(body.toString('utf8')),receipt=verifyReceipt(envelope,prepared.binding,prepared.canonical,sourceId);
    await factoryTransaction(db=>{schema(db);db.prepare('UPDATE remote_factory_source_operations SET status=?,receipt_json=?,updated_at=? WHERE binding_id=? AND operation_id=?').run(receipt.status,JSON.stringify(envelope),now(),bindingId,operationId);});return receipt;
  } catch {return {status:'unknown',operationId,reason:'query_required'};}
}
export async function queryRemoteFactoryOperation(bindingId,operationId,actor,{targetRevision=0}={}) {
  bindingId=required(bindingId,'bindingId');operationId=required(operationId,'operationId');
  const data=await factoryRead(db=>{schema(db);const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId),o=db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);if(!b||!o) throw factoryError('REMOTE_NOT_FOUND','Operation unavailable',404);authorize(db,b.organization_id,actor,'factory.read');const saved=JSON.parse(o.request_json);return {binding:saved.binding,request:saved.canonical};});
  const path=`/api/remote-factory/bindings/${data.binding.targetBindingId}/operations/${operationId}`,identity=await loadOrCreateInstanceIdentity();
  try {const requestId=`read_${randomUUID()}`;const {response,body}=await proxyToTarget({targetId:data.binding.targetInstanceId,requestId,idempotencyKey:requestId,method:'GET',path,operation:'factory.remote.read',resourceId:data.binding.targetBindingId,expectedRevision:targetRevision});
    if(!response.ok) throw new Error('Target receipt unavailable');const envelope=JSON.parse(body.toString('utf8')),receipt=verifyReceipt(envelope,data.binding,data.request,identity.instanceId);
    await factoryTransaction(db=>{schema(db);db.prepare('UPDATE remote_factory_source_operations SET status=?,receipt_json=?,updated_at=? WHERE binding_id=? AND operation_id=?').run(receipt.status,JSON.stringify(envelope),now(),bindingId,operationId);});return receipt;
  } catch {return {status:'unknown',operationId,reason:'query_required'};}
}
export async function fetchRemoteFactoryCandidate(bindingId,operationId,actor,{targetRevision=0}={}) {
  bindingId=required(bindingId,'bindingId'); operationId=required(operationId,'operationId');
  const data=await factoryRead(db=>{schema(db); const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId),o=db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if(!b||!o||!b.enabled||Date.parse(b.expires_at)<=Date.now()) throw factoryError('REMOTE_NOT_FOUND','Candidate authorization unavailable',404);
    authorize(db,b.organization_id,actor,'factory.read'); const saved=JSON.parse(o.request_json);
    if(!saved.binding||saved.binding.version!==b.version||saved.binding.targetInstanceId!==b.target_instance_id||saved.binding.targetPublicKey!==b.target_public_key) throw factoryError('REMOTE_CONFLICT','Source authorization changed',409);
    return {binding:saved.binding,request:saved.canonical}; });
  const path=`/api/remote-factory/bindings/${data.binding.targetBindingId}/operations/${operationId}/candidate`, requestId=`candidate_${randomUUID()}`;
  const {response,body}=await proxyToTarget({targetId:data.binding.targetInstanceId,requestId,idempotencyKey:requestId,method:'GET',path,operation:'factory.remote.candidate.read',resourceId:data.binding.targetBindingId,expectedRevision:targetRevision});
  if(!response.ok || body.length>4*1024*1024+4096) throw factoryError('REMOTE_UNAVAILABLE','Candidate unavailable or too large',503);
  let signed; try {signed=JSON.parse(body.toString('utf8'));} catch {throw factoryError('REMOTE_RECEIPT_INVALID','Invalid candidate envelope',502);}
  const e=signed?.envelope, q=data.request, local=(await loadOrCreateInstanceIdentity()).instanceId;
  if(!e || e.sourceInstanceId!==local || e.targetInstanceId!==data.binding.targetInstanceId || e.targetBindingId!==data.binding.targetBindingId
      || e.targetBindingVersion!==data.binding.targetBindingVersion || e.sourceBindingId!==bindingId || e.sourceBindingVersion!==data.binding.version
      || e.operationId!==operationId || e.requestId!==q.requestId || e.sourceFactoryBindingId!==q.sourceFactoryBindingId
      || e.sourceContractRevision!==q.contractRevision || e.sourceExecutionEpoch!==q.executionEpoch
      || e.baselineManifestDigest!==q.payload.expectedBaselineDigest) throw factoryError('REMOTE_RECEIPT_INVALID','Candidate scope or baseline mismatch',502);
  let valid=false; try {valid=verify(null,Buffer.from(`agentoc-remote-candidate-v1:${hash(e)}`),createPublicKey(data.binding.targetPublicKey),Buffer.from(text(signed.signature),'base64url'));} catch {}
  if(!valid) throw factoryError('REMOTE_RECEIPT_INVALID','Candidate signature invalid',502);
  return signed;
}
export async function requestRemoteFactoryCancellationFromSource(bindingId,operationId,actor,{targetRevision=0}={}) {
  bindingId=required(bindingId,'bindingId'); operationId=required(operationId,'operationId');
  const data=await factoryRead(db=>{schema(db);const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId),o=db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if(!b||!o) throw factoryError('REMOTE_NOT_FOUND','Operation unavailable',404);authorize(db,b.organization_id,actor,'factory.read');const saved=JSON.parse(o.request_json);return {binding:saved.binding,request:saved.canonical};});
  const cancellation={bindingId:data.binding.targetBindingId,operationId,cancelId:`cancel_${data.request.sourceFactoryBindingId}`,
    contractRevision:data.request.contractRevision,executionEpoch:data.request.executionEpoch};
  const signature=await signRemoteFactoryCancellation(cancellation), path=`/api/remote-factory/bindings/${cancellation.bindingId}/operations/${operationId}/cancel`, requestId=`cancel_${randomUUID()}`;
  try {const currentRevision=await readTargetRevision(data.binding.targetInstanceId);const {response,body}=await proxyToTarget({targetId:data.binding.targetInstanceId,requestId,idempotencyKey:cancellation.cancelId,method:'POST',path,operation:'factory.remote.cancel',resourceId:cancellation.bindingId,expectedRevision:currentRevision,body:JSON.stringify({...cancellation,signature}),headers:{'content-type':'application/json'}});
    if(!response.ok) throw new Error('Cancellation unconfirmed');const envelope=JSON.parse(body.toString('utf8')),receipt=envelope?.receipt;
    let valid=false;try {valid=envelope.targetInstanceId===data.binding.targetInstanceId && verify(null,Buffer.from(`agentoc-remote-receipt-v1:${hash({targetInstanceId:envelope.targetInstanceId,receipt})}`),createPublicKey(data.binding.targetPublicKey),Buffer.from(text(envelope.signature),'base64url'));} catch {}
    if(!valid||receipt?.bindingId!==cancellation.bindingId||receipt?.operationId!==operationId||receipt?.cancelId!==cancellation.cancelId||receipt?.contractRevision!==cancellation.contractRevision||receipt?.executionEpoch!==cancellation.executionEpoch) throw new Error('Cancellation receipt mismatch');
    return receipt;
  } catch {return {operationId,requestState:'unknown',reason:'query_required'};}
}
