// Live source authorization for one remotely delegated task. A signed response
// is meaningful only as the response to a fresh Accounts-authorized request.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { factoryRead, factoryError, itemRow } from './work-graph-store.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { resolveFactoryTaskKnowledge } from './factory-task-knowledge.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';
import { proxyToTarget } from './router-target-runtime-routes.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => { throw factoryError('REMOTE_KNOWLEDGE_UNAVAILABLE', 'Remote task knowledge authorization unavailable', 409); };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

function sourceSnapshot(db, sourceBindingId, operationId, principal, sourceInstanceId) {
  const b=db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(sourceBindingId);
  const o=db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(sourceBindingId,operationId);
  if (!b || !o || !b.enabled || !Number.isFinite(Date.parse(b.expires_at)) || Date.parse(b.expires_at)<=Date.now()
      || principal?.principalKind!=='target_runtime_gateway' || principal.targetRuntime!==true
      || principal.targetRuntimeOperation!=='factory.remote.read' || principal.targetRuntimeResourceId!==sourceBindingId
      || principal.sourceInstanceId!==b.target_instance_id || principal.targetInstanceId!==sourceInstanceId) unavailable();
  const saved=parse(o.request_json), canonical=saved?.canonical, old=saved?.binding;
  if (!canonical || hash(canonical)!==o.payload_digest || old?.version!==b.version || old?.id!==b.id
      || old?.targetInstanceId!==b.target_instance_id || old?.targetBindingId!==b.target_binding_id
      || old?.targetBindingVersion!==b.target_binding_version || old?.targetPublicKey!==b.target_public_key
      || canonical.operationId!==operationId || canonical.sourceFactoryBindingId!==o.source_factory_binding_id
      || canonical.bindingId!==b.target_binding_id || canonical.bindingVersion!==b.target_binding_version
      || canonical.payload?.sourceBindingId!==b.id || canonical.payload?.sourceBindingVersion!==b.version) unavailable();
  const row=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(canonical.payload.sourceWorkItemId,b.organization_id);
  const binding=row && db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(o.source_factory_binding_id,row.id);
  const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(b.organization_id);
  const node=row && db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(row.assignee_node_id,b.organization_id);
  const item=row && itemRow(db,row), reason=parse(row?.blocked_json);
  if (!item || !binding || !org || !node || row.ownership!=='active' || row.control_state!=='none'
      || !((row.state==='claimed' && binding.status==='intent') || (row.state==='blocked' && binding.status==='unknown'
        && reason?.code==='remote_outcome_pending' && reason.bindingId===sourceBindingId && reason.operationId===operationId))
      || ['archived','lifecycle_pending'].includes(org.state) || node.retired_revision!==null || !node.current_session_id
      || node.binding_generation!==binding.binding_generation || row.binding_generation!==binding.binding_generation
      || row.execution_epoch!==binding.execution_epoch || row.contract_revision!==binding.contract_revision
      || canonical.executionEpoch!==binding.execution_epoch || canonical.contractRevision!==binding.contract_revision
      || item.contract.organizationRevision!==org.current_revision || hash(item.contract)!==canonical.contractDigest
      || hash(canonical.payload.contract)!==canonical.contractDigest || !Array.isArray(item.contract.knowledgeRefs)
      || !item.contract.knowledgeRefs.length) unavailable();
  const budgetKey=`factory:${binding.id}`;
  const counter=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(b.organization_id,org.current_revision);
  const reservation=parse(counter?.reservations_json)?.[budgetKey];
  if (!reservation || reservation.state!=='reserved' || reservation.reservationId!==budgetKey
      || reservation.factoryWorkItemId!==row.id || canonical.payload.sourceReservationId!==budgetKey
      || !Number.isFinite(canonical.payload.reservedCost) || canonical.payload.reservedCost<=0
      || !Number.isFinite(reservation.delta?.cost) || reservation.delta.cost<=0
      || canonical.payload.reservedCost>reservation.delta?.cost
      || !Number.isSafeInteger(canonical.payload.reservedTokens) || canonical.payload.reservedTokens<=0
      || !Number.isSafeInteger(reservation.delta?.tokens) || canonical.payload.reservedTokens!==reservation.delta.tokens) unavailable();
  verifyFactoryResponsibilityFence(db,row);
  return { sourceBindingId, operationId, sourceInstanceId, targetInstanceId:b.target_instance_id,
    sourceFactoryBindingId:binding.id, workItemId:row.id, projectId:row.project_id, nodeId:node.id,
    nodeSessionId:node.current_session_id, bindingGeneration:binding.binding_generation,
    contractRevision:binding.contract_revision, executionEpoch:binding.execution_epoch,
    contractDigest:canonical.contractDigest, refs:item.contract.knowledgeRefs, item,
    operationDigest:o.payload_digest, bindingVersion:b.version };
}

export async function readLiveRemoteKnowledge({sourceBindingId,operationId,nonce},principal) {
  if (process.env.RAGENT_REMOTE_FACTORY_ENABLED!=='1' || !validId(sourceBindingId) || !validId(operationId)
      || !/^n_[A-Za-z0-9_-]{30,100}$/.test(nonce || '')) unavailable();
  const identity=await loadOrCreateInstanceIdentity();
  const read=()=>factoryRead(db=>sourceSnapshot(db,sourceBindingId,operationId,principal,identity.instanceId));
  const before=await read();
  const {executionAuthorityRevoked}=await import('./factory-execution-adapter.mjs');
  if (await executionAuthorityRevoked(before.item.organizationId,before.item,{bindingGeneration:before.bindingGeneration})) unavailable();
  const facts=await resolveFactoryTaskKnowledge(before.projectId,before.refs);
  if (Buffer.byteLength(JSON.stringify(facts),'utf8')>24000) unavailable();
  const after=await read();
  if (hash(before)!==hash(after)
      || await executionAuthorityRevoked(after.item.organizationId,after.item,{bindingGeneration:after.bindingGeneration})) unavailable();
  const currentFacts=await resolveFactoryTaskKnowledge(after.projectId,after.refs);
  if(hash(facts)!==hash(currentFacts) || hash(after)!==hash(await read())) unavailable();
  const envelope={version:1,nonce,sourceBindingId,operationId,sourceInstanceId:identity.instanceId,
    targetInstanceId:after.targetInstanceId,sourceFactoryBindingId:after.sourceFactoryBindingId,
    workItemId:after.workItemId,contractRevision:after.contractRevision,executionEpoch:after.executionEpoch,
    contractDigest:after.contractDigest,refsDigest:hash(after.refs),facts,issuedAt:new Date().toISOString()};
  return {envelope,signature:signWithInstanceIdentity(identity,`ragent-remote-knowledge-v1:${hash(envelope)}`)};
}

export async function fetchLiveRemoteKnowledge(remote) {
  if (!remote?.knowledgeRefs?.length) return [];
  if (!validId(remote.sourceBindingId) || !validId(remote.operationId) || !validId(remote.sourceInstanceId)
      || !validId(remote.sourceFactoryBindingId) || !validId(remote.sourceWorkItemId)) unavailable();
  const identity=await loadOrCreateInstanceIdentity(), nonce=`n_${randomUUID().replaceAll('-','')}`;
  const summaryId=`summary_${randomUUID()}`;
  const summary=await proxyToTarget({targetId:remote.sourceInstanceId,requestId:summaryId,idempotencyKey:summaryId,
    method:'GET',path:'/api/runtime/summary',operation:'runtime.summary',resourceId:remote.sourceInstanceId,expectedRevision:0});
  if (!summary.response.ok) unavailable();
  const revision=Number(parse(summary.body.toString('utf8'))?.revision);
  if (!Number.isSafeInteger(revision) || revision<0) unavailable();
  const path=`/api/remote-factory/source-bindings/${remote.sourceBindingId}/operations/${remote.operationId}/knowledge/${nonce}`;
  const response=await proxyToTarget({targetId:remote.sourceInstanceId,requestId:nonce,idempotencyKey:nonce,method:'GET',path,
    operation:'factory.remote.read',resourceId:remote.sourceBindingId,expectedRevision:revision});
  if (!response.response.ok || response.body.length>32768) unavailable();
  const signed=parse(response.body.toString('utf8')), e=signed?.envelope, ts=Date.parse(e?.issuedAt);
  if (!e || e.version!==1 || e.nonce!==nonce || e.sourceBindingId!==remote.sourceBindingId
      || e.operationId!==remote.operationId || e.sourceInstanceId!==remote.sourceInstanceId
      || e.targetInstanceId!==identity.instanceId || e.sourceFactoryBindingId!==remote.sourceFactoryBindingId
      || e.workItemId!==remote.sourceWorkItemId || e.contractRevision!==remote.sourceContractRevision
      || e.executionEpoch!==remote.sourceExecutionEpoch || e.contractDigest!==remote.sourceContractDigest
      || e.refsDigest!==hash(remote.knowledgeRefs) || !Array.isArray(e.facts)
      || e.facts.length!==remote.knowledgeRefs.length || !Number.isFinite(ts) || Math.abs(Date.now()-ts)>60000) unavailable();
  let valid=false;
  try { valid=verify(null,Buffer.from(`ragent-remote-knowledge-v1:${hash(e)}`),createPublicKey(remote.sourcePublicKey),
    Buffer.from(signed.signature,'base64url')); } catch {}
  if (!valid || Buffer.byteLength(JSON.stringify(e.facts),'utf8')>24000) unavailable();
  return e.facts;
}
