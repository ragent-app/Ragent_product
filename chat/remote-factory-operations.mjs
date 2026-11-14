// Target-side execution receipts. Factory Work Graph remains authoritative on
// the source. Only a verified target-runtime principal can submit or read.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { getNode, getOrganization } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function required(value, name) { const result = text(value); if (!result || result.length > 256) throw factoryError('REMOTE_INVALID', `${name} is required`, 400); return result; }
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS remote_factory_bindings (
  id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, target_instance_id TEXT NOT NULL, source_public_key TEXT NOT NULL, expires_at TEXT NOT NULL,
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, node_id TEXT NOT NULL, session_id TEXT NOT NULL, node_generation INTEGER NOT NULL,
  scope_json TEXT NOT NULL, budget_limit REAL NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS remote_factory_operations (
  binding_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_digest TEXT NOT NULL, source_instance_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL, request_id TEXT NOT NULL, source_factory_binding_id TEXT NOT NULL, payload_json TEXT NOT NULL, source_signature TEXT NOT NULL, source_public_key TEXT NOT NULL,
  contract_revision INTEGER NOT NULL, execution_epoch INTEGER NOT NULL, status TEXT NOT NULL,
  work_item_id TEXT, attempt_id TEXT, run_id TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(binding_id,operation_id), UNIQUE(binding_id,request_id), UNIQUE(source_instance_id,source_factory_binding_id)
);`);
  const add=(table,column,definition)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(item=>item.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);};
  add('remote_factory_bindings','source_public_key',"TEXT NOT NULL DEFAULT ''");
  add('remote_factory_bindings','expires_at',"TEXT NOT NULL DEFAULT ''");
  add('remote_factory_bindings','node_generation','INTEGER NOT NULL DEFAULT 0');
  add('remote_factory_operations','payload_json',"TEXT NOT NULL DEFAULT '{}'");
  add('remote_factory_operations','source_signature',"TEXT NOT NULL DEFAULT ''");
  add('remote_factory_operations','source_public_key',"TEXT NOT NULL DEFAULT ''");
  add('remote_factory_operations','work_item_id','TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS remote_factory_source_binding_once ON remote_factory_operations(source_instance_id,source_factory_binding_id)');
}
function binding(row) { return { id:row.id, sourceInstanceId:row.source_instance_id, targetInstanceId:row.target_instance_id,
  organizationId:row.organization_id, projectId:row.project_id, nodeId:row.node_id, sessionId:row.session_id, nodeGeneration:row.node_generation,
  allowedContractDigests:JSON.parse(row.scope_json), budgetLimit:row.budget_limit, version:row.version, enabled:!!row.enabled, expiresAt:row.expires_at }; }
function receipt(row) { return { bindingId:row.binding_id, operationId:row.operation_id, sourceInstanceId:row.source_instance_id,
  bindingVersion:row.binding_version, requestId:row.request_id, sourceFactoryBindingId:row.source_factory_binding_id,
  contractRevision:row.contract_revision, executionEpoch:row.execution_epoch, status:row.status,
  workItemId:row.work_item_id || null, attemptId:row.attempt_id || null, runId:row.run_id || null, reason:row.reason || null, updatedAt:row.updated_at }; }

export async function configureRemoteFactoryBinding(input, actor) {
  const id=required(input?.id,'id'), source=required(input?.sourceInstanceId,'sourceInstanceId');
  const sourcePublicKey=typeof input?.sourcePublicKey==='string' ? input.sourcePublicKey.trim() : '';
  const organizationId=required(input?.organizationId,'organizationId'), projectId=required(input?.projectId,'projectId');
  const nodeId=required(input?.nodeId,'nodeId'), sessionId=required(input?.sessionId,'sessionId');
  if (actor?.kind!=='user' || actor?.role!=='owner') throw factoryError('REMOTE_FORBIDDEN','Owner required',403);
  if (!Array.isArray(input.allowedContractDigests) || !input.allowedContractDigests.length
      || input.allowedContractDigests.some(value => !/^[a-f0-9]{64}$/.test(value))
      || !Number.isFinite(input.budgetLimit) || input.budgetLimit <= 0 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<0
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt)<=Date.now()) throw factoryError('REMOTE_INVALID','Explicit scope, budget and version are required',400);
  try { if (createPublicKey(sourcePublicKey).asymmetricKeyType!=='ed25519' || `inst_${createInstancePublicKeyFingerprint(sourcePublicKey).slice(0,32)}`!==source) throw new Error(); }
  catch { throw factoryError('REMOTE_INVALID','Source public key does not match instance identity',400); }
  const identity=await loadOrCreateInstanceIdentity(), [org,node,session]=await Promise.all([getOrganization(organizationId),getNode(nodeId),getSession(sessionId)]);
  if (!org || org.projectId!==projectId || !node || node.organizationId!==organizationId || node.currentSessionId!==sessionId
      || node.retiredRevision!==null || !session || session.sessionPlane!=='organization') throw factoryError('REMOTE_CONFLICT','Target binding is unavailable',409);
  return factoryTransaction(db=>{ schema(db); authorize(db,organizationId,actor,'factory.read');
    const old=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(id);
    if ((old?.version || 0)!==input.expectedVersion || (old && old.organization_id!==organizationId)) throw factoryError('REMOTE_CONFLICT','Binding version changed',409);
    const version=input.expectedVersion+1;
    db.prepare(`INSERT INTO remote_factory_bindings (id,source_instance_id,target_instance_id,source_public_key,expires_at,organization_id,project_id,node_id,session_id,node_generation,scope_json,budget_limit,version,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      source_instance_id=excluded.source_instance_id,target_instance_id=excluded.target_instance_id,source_public_key=excluded.source_public_key,expires_at=excluded.expires_at,project_id=excluded.project_id,
      node_id=excluded.node_id,session_id=excluded.session_id,node_generation=excluded.node_generation,scope_json=excluded.scope_json,budget_limit=excluded.budget_limit,
      version=excluded.version,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(id,source,identity.instanceId,sourcePublicKey,new Date(input.expiresAt).toISOString(),organizationId,projectId,nodeId,sessionId,node.bindingGeneration,JSON.stringify([...new Set(input.allowedContractDigests)]),input.budgetLimit,version,input.enabled===false?0:1,now());
    return binding(db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(id)); });
}

function verifyPrincipal(principal, bindingId, operation) {
  if (!principal?.targetRuntime || principal.targetRuntimeOperation!==operation || principal.targetRuntimeResourceId!==bindingId
      || !text(principal.sourceInstanceId) || !text(principal.targetInstanceId)) throw factoryError('REMOTE_FORBIDDEN','Verified target grant required',403);
}
export async function signRemoteFactoryDelegation(canonical) {
  const identity=await loadOrCreateInstanceIdentity();
  return { sourceInstanceId:identity.instanceId, signature:signWithInstanceIdentity(identity, `agentoc-remote-factory-v1:${hash(canonical)}`) };
}
export async function signRemoteFactoryReceipt(receiptValue) {
  const identity=await loadOrCreateInstanceIdentity();
  const payload={targetInstanceId:identity.instanceId,receipt:receiptValue};
  return { ...payload, signature:signWithInstanceIdentity(identity, `agentoc-remote-receipt-v1:${hash(payload)}`) };
}
export async function signRemoteFactoryCandidate(envelope) {
  const identity=await loadOrCreateInstanceIdentity();
  if (!envelope || envelope.targetInstanceId!==identity.instanceId || Buffer.byteLength(JSON.stringify(envelope),'utf8')>4*1024*1024) throw factoryError('REMOTE_INVALID','Candidate envelope is invalid or too large',400);
  return { envelope, signature:signWithInstanceIdentity(identity, `agentoc-remote-candidate-v1:${hash(envelope)}`) };
}
export async function signRemoteFactoryCancellation(cancellation) {
  const identity=await loadOrCreateInstanceIdentity();
  return signWithInstanceIdentity(identity, `agentoc-remote-cancel-v1:${hash(cancellation)}`);
}
// Called by target admission inside its transaction. The stored signature, not
// a caller-provided actor or isolation claim, is the source delegation proof.
export function verifyRemoteFactoryAdmission(db, { binding: proposedBinding, operation } = {}) {
  schema(db);
  const bindingId=required(operation?.bindingId,'bindingId'), operationId=required(operation?.operationId,'operationId');
  const row=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(bindingId);
  const saved=db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
  if (!row || !saved || !row.enabled || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at)<=Date.now()
      || row.version!==saved.binding_version || row.version!==proposedBinding?.version || row.id!==proposedBinding?.id
      || saved.source_instance_id!==row.source_instance_id || saved.source_public_key!==row.source_public_key || proposedBinding.sourceInstanceId!==row.source_instance_id
      || proposedBinding.targetInstanceId!==row.target_instance_id || proposedBinding.organizationId!==row.organization_id
      || proposedBinding.projectId!==row.project_id || proposedBinding.nodeId!==row.node_id
      || proposedBinding.sessionId!==row.session_id || proposedBinding.nodeGeneration!==row.node_generation) throw factoryError('REMOTE_FORBIDDEN','Remote binding changed',403);
  const payload=JSON.parse(saved.payload_json);
  const canonical={ bindingId,operationId,requestId:saved.request_id,sourceFactoryBindingId:saved.source_factory_binding_id,
    bindingVersion:saved.binding_version,contractRevision:saved.contract_revision,executionEpoch:saved.execution_epoch,
    contractDigest:hash(payload.contract),payload };
  const payloadDigest=hash(canonical);
  if (payloadDigest!==saved.payload_digest || hash(operation)!==payloadDigest || !JSON.parse(row.scope_json).includes(canonical.contractDigest)
      || !text(payload.sourceReservationId) || !Number.isFinite(payload.reservedCost) || payload.reservedCost<=0 || payload.reservedCost>row.budget_limit) throw factoryError('REMOTE_FORBIDDEN','Remote operation changed',403);
  let signed=false; try { signed=verify(null,Buffer.from(`agentoc-remote-factory-v1:${payloadDigest}`),createPublicKey(row.source_public_key),Buffer.from(saved.source_signature,'base64url')); } catch {}
  if (!signed) throw factoryError('REMOTE_FORBIDDEN','Source delegation signature invalid',403);
  return { binding:binding(row), operation:canonical };
}
export async function acceptRemoteFactoryOperation(input, principal, { admit } = {}) {
  const bindingId=required(input?.bindingId,'bindingId'), operationId=required(input?.operationId,'operationId');
  verifyPrincipal(principal,bindingId,'factory.remote.accept');
  const requestId=required(input?.requestId,'requestId'), sourceFactoryBindingId=required(input?.sourceFactoryBindingId,'sourceFactoryBindingId');
  const contractDigest=required(input?.contractDigest,'contractDigest');
  const payload=input?.payload;
  if (!Number.isSafeInteger(input.bindingVersion) || !Number.isSafeInteger(input.contractRevision) || input.contractRevision<1
      || !Number.isSafeInteger(input.executionEpoch) || input.executionEpoch<1 || typeof admit!=='function'
      || !payload || typeof payload!=='object' || Array.isArray(payload) || !payload.contract || typeof payload.contract!=='object'
      || hash(payload.contract)!==contractDigest || !text(payload.sourceBindingId) || !Number.isSafeInteger(payload.sourceBindingVersion) || payload.sourceBindingVersion<1
      || !/^[a-f0-9]{40,64}$/.test(text(payload.expectedBaseHead)) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(text(payload.expectedBaseBranch))
      || !/^[a-f0-9]{64}$/.test(text(payload.expectedBaselineDigest))
      || text(payload.expectedBaseBranch).includes('..') || text(payload.expectedBaseBranch).includes('//') || text(payload.expectedBaseBranch).endsWith('/')
      || !text(payload.sourceReservationId) || !Number.isFinite(payload.reservedCost) || payload.reservedCost<=0
      || Buffer.byteLength(JSON.stringify(payload),'utf8')>32768) throw factoryError('REMOTE_INVALID','Operation identity, contract, budget or admission is invalid',400);
  const canonical={ bindingId,operationId,requestId,sourceFactoryBindingId,bindingVersion:input.bindingVersion,
    contractRevision:input.contractRevision,executionEpoch:input.executionEpoch,contractDigest,payload:input.payload };
  if(Buffer.byteLength(JSON.stringify({...canonical,signature:input.signature}),'utf8')>32768) throw factoryError('REMOTE_INVALID','Signed remote operation exceeds its shared payload limit',400);
  if(payload.taskSummary!==undefined) {
    const s=payload.taskSummary, allowed=['schemaVersion','workItemId','contractRevision','executionEpoch','contractDigest','sourceVersion','organizationRevision','facts','omitted','truncated'];
    const fields={dependencies:['predecessor_id','milestone','candidate_digest'],candidates:['id','digest','contract_revision','execution_epoch'],decisions:['id','criterion_id','decision','candidate_digest','contract_revision'],failures:['id','run_id','failure_kind']};
    if(!s || typeof s!=='object' || Array.isArray(s) || Object.keys(s).some(k=>!allowed.includes(k)) || s.schemaVersion!==1
        || !text(s.workItemId) || s.workItemId!==payload.sourceWorkItemId || s.contractRevision!==input.contractRevision || s.executionEpoch!==input.executionEpoch || s.contractDigest!==contractDigest
        || !Number.isSafeInteger(s.sourceVersion) || !Number.isSafeInteger(s.organizationRevision) || s.organizationRevision!==payload.contract.organizationRevision
        || !Array.isArray(s.omitted) || JSON.stringify(s.omitted)!==JSON.stringify(['inbox_messages','contract_duplicate']) || typeof s.truncated!=='boolean'
        || !s.facts || Object.keys(s.facts).length!==4 || Object.keys(fields).some(k=>!Array.isArray(s.facts[k]) || s.facts[k].length>5 || s.facts[k].some(e=>!e || typeof e!=='object' || Array.isArray(e) || Object.keys(e).some(f=>!fields[k].includes(f)) || Object.values(e).some(v=>v!==null && typeof v!=='string' && !Number.isSafeInteger(v)) || Buffer.byteLength(JSON.stringify(e),'utf8')>300))
        || hash(s)!==payload.taskSummaryDigest) throw factoryError('REMOTE_INVALID','Remote task summary is invalid',400);
  } else if(payload.taskSummaryDigest!==undefined) throw factoryError('REMOTE_INVALID','Remote task summary digest has no content',400);
  const payloadDigest=hash(canonical);
  const claim=await factoryTransaction(db=>{schema(db); const row=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(bindingId);
    if (!row || !row.enabled || Date.parse(row.expires_at)<=Date.now() || row.version!==input.bindingVersion || row.source_instance_id!==principal.sourceInstanceId
        || row.target_instance_id!==principal.targetInstanceId || !JSON.parse(row.scope_json).includes(contractDigest)
        || payload.reservedCost>row.budget_limit) throw factoryError('REMOTE_FORBIDDEN','Binding or scope changed',403);
    let signed=false; try { signed=verify(null,Buffer.from(`agentoc-remote-factory-v1:${payloadDigest}`),createPublicKey(row.source_public_key),Buffer.from(text(input.signature),'base64url')); } catch {}
    if (!signed) throw factoryError('REMOTE_FORBIDDEN','Source delegation signature invalid',403);
    const old=db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if (old) {if (old.payload_digest!==payloadDigest) throw factoryError('REMOTE_CONFLICT','Operation identity reused',409); return {existing:receipt(old)};}
    if (db.prepare('SELECT 1 FROM remote_factory_operations WHERE source_instance_id=? AND source_factory_binding_id=?').get(principal.sourceInstanceId,sourceFactoryBindingId)) throw factoryError('REMOTE_CONFLICT','Source Factory binding already has an operation',409);
    const ts=now(); db.prepare(`INSERT INTO remote_factory_operations (binding_id,operation_id,payload_digest,source_instance_id,binding_version,request_id,source_factory_binding_id,payload_json,source_signature,source_public_key,contract_revision,execution_epoch,status,work_item_id,attempt_id,run_id,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(bindingId,operationId,payloadDigest,principal.sourceInstanceId,row.version,requestId,sourceFactoryBindingId,JSON.stringify(payload),text(input.signature),row.source_public_key,input.contractRevision,input.executionEpoch,'unknown',null,null,null,'admission_not_confirmed',ts,ts);
    return {binding:binding(row)}; });
  if (claim.existing) return claim.existing;
  let outcome; try { outcome=await admit({binding:claim.binding,operation:canonical}); } catch { outcome={status:'unknown',reason:'admission_not_confirmed'}; }
  if (!['accepted','unknown'].includes(outcome?.status) || (outcome.status==='accepted' && !text(outcome.workItemId))) outcome={status:'unknown',reason:'admission_not_confirmed'};
  return factoryTransaction(db=>{schema(db); db.prepare('UPDATE remote_factory_operations SET status=?,work_item_id=?,attempt_id=?,run_id=?,reason=?,updated_at=? WHERE binding_id=? AND operation_id=? AND status=?')
    .run(outcome.status,text(outcome.workItemId)||null,text(outcome.attemptId)||null,text(outcome.runId)||null,text(outcome.reason)||null,now(),bindingId,operationId,'unknown');
    return receipt(db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId)); });
}
export async function getRemoteFactoryOperation(bindingId, operationId, principal, { queryChild, candidate = false } = {}) {
  bindingId=required(bindingId,'bindingId'); operationId=required(operationId,'operationId'); verifyPrincipal(principal,bindingId,candidate?'factory.remote.candidate.read':'factory.remote.read');
  const result=await factoryRead(db=>{schema(db); const b=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(bindingId), row=db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    if (!b || b.target_instance_id!==principal.targetInstanceId || !row || row.source_instance_id!==principal.sourceInstanceId) throw factoryError('REMOTE_NOT_FOUND','Operation unavailable',404); return receipt(row);});
  if (typeof queryChild!=='function') return result;
  const child=await queryChild(bindingId,operationId);
  return { ...result, target:child || null };
}
export function verifyRemoteFactoryCancellation(db,input,principal) {
  const bindingId=required(input?.bindingId,'bindingId'), operationId=required(input?.operationId,'operationId'), cancelId=required(input?.cancelId,'cancelId');
  verifyPrincipal(principal,bindingId,'factory.remote.cancel');
  if(!Number.isSafeInteger(input.contractRevision)||!Number.isSafeInteger(input.executionEpoch)) throw factoryError('REMOTE_INVALID','Cancellation identity invalid',400);
  const cancellation={bindingId,operationId,cancelId,contractRevision:input.contractRevision,executionEpoch:input.executionEpoch};
  schema(db);const b=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(bindingId),o=db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
  if(!b||!o||b.target_instance_id!==principal.targetInstanceId||o.source_instance_id!==principal.sourceInstanceId||o.contract_revision!==input.contractRevision||o.execution_epoch!==input.executionEpoch) throw factoryError('REMOTE_FORBIDDEN','Cancellation scope mismatch',403);
  let valid=false;try {valid=verify(null,Buffer.from(`agentoc-remote-cancel-v1:${hash(cancellation)}`),createPublicKey(o.source_public_key),Buffer.from(text(input.signature),'base64url'));} catch {}
  if(!valid) throw factoryError('REMOTE_FORBIDDEN','Cancellation signature invalid',403);
  return cancellation;
}
export async function requestRemoteFactoryCancellation(input, principal, { cancel } = {}) {
  if(typeof cancel!=='function') throw factoryError('REMOTE_UNAVAILABLE','Cancellation unavailable',503);
  const cancellation=await factoryRead(db=>verifyRemoteFactoryCancellation(db,input,principal));
  const {bindingId,operationId,cancelId}=cancellation;
  const result=await cancel({ ...cancellation,signature:input.signature },principal);
  const requestState=!result || result.state==='unknown' ? 'unknown' : ['review','completed','failed','cancelled'].includes(result.state) ? 'already_terminal' : result.controlState==='cancel_requested' ? 'requested' : 'unknown';
  return {bindingId,operationId,cancelId,contractRevision:input.contractRevision,executionEpoch:input.executionEpoch,requestState,target:result||null};
}
