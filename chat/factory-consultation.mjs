// One explicitly requested, read-only expert consultation over an existing
// Factory WorkItem. The journal fences dispatch; it is not task authority.
import { randomUUID, createHash } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { ensureConsultationSchema, getConsultationRound, dispatchConsultationRound, linkPacketToRound, beginAggregation } from './consultation-store.mjs';
import { compileConsultationExpertTask } from './consultation-compiler-gate.mjs';
import { reserveFactoryBudget } from './organization-governor.mjs';
import { getSession } from './session-manager.mjs';
import { getCollaborationByIdempotencyKey } from './collaboration-store.mjs';
import { getDefaultCollaborationOrchestrator } from './collaboration-orchestrator.mjs';
import { getResultPacket, computeResultPacketDigest } from './result-packets.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { factoryGrantDenial } from './factory-grant-authority.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const text=x=>typeof x==='string'?x.trim():'';
const fail=(message,code='FACTORY_CONSULTATION_CONFLICT')=>{throw factoryError(code,message,409);};
function schema(db) { ensureConsultationSchema(db); db.exec(`CREATE TABLE IF NOT EXISTS factory_consultations (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,work_item_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 command_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL,input_digest TEXT NOT NULL,round_id TEXT NOT NULL UNIQUE,
 expert_id TEXT NOT NULL,dispatch_key TEXT NOT NULL UNIQUE,context_json TEXT NOT NULL,state TEXT NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(organization_id,actor_id,idempotency_key));`);
 if(!db.prepare('PRAGMA table_info(factory_consultations)').all().some(c=>c.name==='result_json')) db.exec('ALTER TABLE factory_consultations ADD COLUMN result_json TEXT'); }
function current(db,context) {
 const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(context.organizationId);
 const item=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(context.workItemId,context.organizationId);
 const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(context.nodeId,context.organizationId);
 if(!org || org.state!=='active' || org.current_revision!==context.organizationRevision || org.root_session_id!==context.rootSessionId
   || !item || item.project_id!==context.projectId || item.ownership!=='active' || item.contract_revision!==context.contractRevision
   || item.execution_epoch!==context.executionEpoch || item.control_state!=='none' || ['completed','cancelled'].includes(item.state)
   || !node || node.retired_revision!==null || ['retired','deleted'].includes(node.lifecycle_state) || node.created_revision!==context.nodeCreatedRevision || node.current_session_id!==context.sessionId || node.binding_generation!==context.nodeGeneration
   || (text(node.node_role).toLowerCase()==='reviewer'?'reviewer':'specialist')!==context.role) fail('Consultation work or managed node changed');
 const budget=decode(org.budget_json,{});
 if(!Number.isFinite(budget.maxCost) || budget.maxCost<context.cost || !Number.isSafeInteger(budget.maxTokens) || budget.maxTokens<context.tokens) fail('Consultation organization budget changed');
 const denial=factoryGrantDenial(db,org,node,{projectId:item.project_id,contract:{accessMode:'read',allowedPaths:[]}});
 if(denial) fail(`Expert authority unavailable: ${denial}`);
 return {org,item,node};
}
async function sessionFor(context) {
 const session=await getSession(context.sessionId);
 if(!session || session.sessionPlane!=='organization' || session.organizationId!==context.organizationId || session.organizationNodeId!==context.nodeId
   || session.organizationRevision!==context.nodeCreatedRevision || session.templateId!==context.agentId || session.tool!==context.runtime.tool || text(session.providerProfile)!==text(context.runtime.provider)
   || session.model!==context.runtime.model || session.effort!==context.runtime.effort) fail('Expert managed session changed');
 return session;
}
export async function assertFactoryConsultationFence(context,collaborationId='') {
 await sessionFor(context);
 const {currentRevisedGrant,revisedGrantMatches}=await import('./factory-execution-adapter.mjs');
 const revisedGrant=await currentRevisedGrant(context.organizationId,context.nodeId);
 return factoryRead(db=>{schema(db);const job=db.prepare('SELECT * FROM factory_consultations WHERE id=?').get(context.id);
  if(!job || !['sending','observing'].includes(job.state) || job.context_json!==encode(context)) fail('Consultation journal identity changed');
  current(db,context);
  if(!revisedGrantMatches(db,context.organizationId,context.nodeId,revisedGrant)) fail('Expert Agent profile authority changed');
  if(collaborationId) {
   const c=db.prepare('SELECT root_session_id,idempotency_key,policy_json FROM collaborations WHERE id=?').get(collaborationId);
   if(!c || c.root_session_id!==context.rootSessionId || c.idempotency_key!==context.dispatchKey || JSON.stringify(decode(c.policy_json,{}).factoryConsultation)!==JSON.stringify(context)) fail('Consultation collaboration changed');
   const tasks=db.prepare('SELECT task_kind,read_only_required,access_mode,writable_paths_json FROM collaboration_tasks WHERE collaboration_id=?').all(collaborationId);
   if(tasks.length!==1 || tasks[0].task_kind!=='consultation' || !tasks[0].read_only_required || tasks[0].access_mode!=='read' || decode(tasks[0].writable_paths_json,[]).length) fail('Consultation task is not read-only');
  }
  const orgBudget=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(context.organizationId,context.organizationRevision);
  const consultBudget=db.prepare('SELECT reservations_json FROM budget_scope_counters WHERE scope=?').get(`consult:${context.roundId}`);
  if(decode(orgBudget?.reservations_json,{})[context.reservationId]?.state!=='reserved' || decode(consultBudget?.reservations_json,{})[context.reservationId]?.state!=='reserved') fail('Consultation budget reservation unavailable');
  if(Date.parse(context.deadline)<=Date.now()) fail('Consultation deadline expired');
  return true;
 });
}

export async function startFactoryConsultation(input,actor) {
 if(actor?.kind!=='user'||actor.role!=='owner'||!text(actor.principalId)) fail('Owner required','FACTORY_FORBIDDEN');
 const org=text(input?.organizationId),work=text(input?.workItemId),nodeId=text(input?.expertNodeId),key=text(input?.idempotencyKey),commandId=text(input?.commandId),question=text(input?.question);
 const cost=input?.budget?.maxCost,tokens=input?.budget?.maxTokens,deadline=text(input?.deadline);
 if(!org||!work||!nodeId||!key||key.length>160||!commandId||commandId.length>160||!question||Buffer.byteLength(question)>2000
   || !Number.isSafeInteger(input?.expectedVersion)||!Number.isFinite(cost)||cost<=0||!Number.isSafeInteger(tokens)||tokens<=0
   || !Number.isFinite(Date.parse(deadline))) fail('Invalid bounded consultation request','FACTORY_INVALID');
 const inputDigest=hash({org,work,nodeId,key,commandId,question,deadline,cost,tokens,expectedVersion:input.expectedVersion});
 const initial=await factoryRead(db=>{schema(db);authorize(db,org,actor,'factory.read');const prior=db.prepare('SELECT * FROM factory_consultations WHERE organization_id=? AND actor_id=? AND idempotency_key=?').get(org,actor.principalId,key);if(prior){if(prior.input_digest!==inputDigest)fail('Consultation key belongs to another request');return {prior};}const o=db.prepare('SELECT * FROM organizations WHERE id=?').get(org),w=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(work,org),n=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,org);if(!o||!w||!n||!n.current_session_id)fail('Consultation target unavailable');const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(work,w.contract_revision)?.contract_json,{});if(!text(contract.objective))fail('Work contract unavailable');return {o,w,n,contract};});
 if(initial.prior) {
  if(initial.prior.state==='created') return advanceSafely(decode(initial.prior.context_json,{}));
  return {consultationId:initial.prior.id,state:initial.prior.state==='sending'?'unknown':initial.prior.state,replayed:true};
 }
 if(Date.parse(deadline)<=Date.now()||Date.parse(deadline)>Date.now()+86400000) fail('Consultation deadline must be in the next 24 hours','FACTORY_INVALID');
 const session=await getSession(initial.n.current_session_id); if(!session?.templateId||!session?.tool||!session?.model||!session?.effort)fail('Expert runtime unavailable');
 const id=`fconsult_${randomUUID()}`,roundId=`round_${randomUUID()}`,expertId=`expert_${randomUUID()}`,dispatchKey=`consult_${id}`,reservationId=`consult:${id}`;
 const context={id,organizationId:org,workItemId:work,projectId:initial.w.project_id,rootSessionId:initial.o.root_session_id,organizationRevision:initial.o.current_revision,
  contractRevision:initial.w.contract_revision,executionEpoch:initial.w.execution_epoch,nodeId,sessionId:session.id,nodeGeneration:initial.n.binding_generation,nodeCreatedRevision:initial.n.created_revision,
  agentId:session.templateId,role:text(initial.n.node_role).toLowerCase()==='reviewer'?'reviewer':'specialist',runtime:{tool:session.tool,model:session.model,effort:session.effort,...(session.providerProfile?{provider:session.providerProfile}:{})},roundId,expertId,dispatchKey,reservationId,deadline,question,objective:initial.contract.objective,cost,tokens};
 await sessionFor(context);
 const prepared=await factoryTransaction(db=>{schema(db);authorize(db,org,actor,'factory.dispatch');const old=db.prepare('SELECT * FROM factory_consultations WHERE organization_id=? AND actor_id=? AND idempotency_key=?').get(org,actor.principalId,key);if(old){if(old.input_digest!==inputDigest)fail('Consultation key belongs to another request');return {old};}
  const {org:o,item}=current(db,context),budget=decode(o.budget_json,{});if(item.row_version!==input.expectedVersion || !Number.isFinite(budget.maxCost)||budget.maxCost<cost||!Number.isSafeInteger(budget.maxTokens)||budget.maxTokens<tokens)fail('Work version or organization budget changed');
  const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(work,item.contract_revision)?.contract_json,{});
  if(!text(contract.objective) || Buffer.byteLength(contract.objective)>4000 || contract.objective!==context.objective) fail('Work contract changed or exceeds the consultation limit');
  const roundNumber=db.prepare('SELECT COALESCE(MAX(round_number),0)+1 AS n FROM consultation_rounds WHERE root_session_id=?').get(context.rootSessionId).n,ts=now();
  db.prepare("INSERT INTO consultation_rounds (id,root_session_id,round_number,state,objective,question,quorum,budget_json,deadline,created_at,updated_at) VALUES (?,?,?,'PLANNED',?,?,1,?,?,?,?)").run(roundId,context.rootSessionId,roundNumber,contract.objective,question,encode({maxTotalAgents:1,maxTotalRuns:1,maxCost:cost,maxTokens:tokens}),deadline,ts,ts);
  db.prepare("INSERT INTO consultation_expert_assignments (id,round_id,role,writable_paths_json,status,created_at) VALUES (?,?,?,'[]','assigned',?)").run(expertId,roundId,context.role,ts);
  db.prepare('INSERT INTO factory_consultations (id,organization_id,work_item_id,actor_id,command_id,idempotency_key,input_digest,round_id,expert_id,dispatch_key,context_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,org,work,actor.principalId,commandId,key,inputDigest,roundId,expertId,dispatchKey,encode(context),'created',ts,ts);
  return {}; });
 if(prepared.old) return prepared.old.state==='created' ? advanceSafely(decode(prepared.old.context_json,{})) : {consultationId:prepared.old.id,state:prepared.old.state==='sending'?'unknown':prepared.old.state,replayed:true};
 return advanceSafely(context);
}

async function advanceSafely(context) {
 try { return await advanceFactoryConsultation(context); }
 catch(error) {
  const reason=text(error?.code).slice(0,100) || 'ADMISSION_UNAVAILABLE';
  const saved=await factoryTransaction(db=>{schema(db);return db.prepare("UPDATE factory_consultations SET result_json=?,updated_at=? WHERE id=? AND state='created'").run(encode({reason,usage:'reservation_pending_if_reserved'}),now(),context.id).changes===1;});
  return saved ? {consultationId:context.id,state:'admission_blocked',reason,usage:'reservation_pending_if_reserved',recovery:'retry_same_request_before_deadline'} : {consultationId:context.id,state:'unknown',reason:'reconciliation_required'};
 }
}

async function advanceFactoryConsultation(context) {
 const {organizationId:org,workItemId:work,id,roundId,expertId,dispatchKey,reservationId,cost,tokens,question,objective}=context;
 if(Date.parse(context.deadline)<=Date.now()) {
  const expired=await factoryTransaction(db=>{schema(db);return db.prepare("UPDATE factory_consultations SET state='expired',result_json=?,updated_at=? WHERE id=? AND state='created'").run(encode({reason:'deadline_before_dispatch',usage:'reservation_pending_if_reserved'}),now(),id).changes===1;});
  return expired?{consultationId:id,state:'expired',usage:'reservation_pending_if_reserved'}:{consultationId:id,state:'unknown',reason:'reconciliation_required'};
 }
 await sessionFor(context);
 await factoryRead(db=>current(db,context));
 await reserveFactoryBudget({organizationId:org,revision:context.organizationRevision,reservationId,idempotencyKey:reservationId,factoryWorkItemId:work,delta:{runs:1,tokens,cost}});
 const compiled=await compileConsultationExpertTask({roundId,expertAssignmentId:expertId,controllerSessionId:context.rootSessionId,reservationId,idempotencyKey:reservationId,
  delta:{agents:1,runs:1,tokens,cost},task:{id:`consult-task-${id}`,objective:`${objective}\n\nConsultation question: ${question}`,agentId:context.agentId,role:context.role,projectId:context.projectId,accessMode:'read',writablePaths:[],retry:{maxAttempts:1}}});
 const claimed=await factoryTransaction(db=>{schema(db);current(db,context);return db.prepare("UPDATE factory_consultations SET state='sending',updated_at=? WHERE id=? AND state='created'").run(now(),id).changes===1;});
 if(!claimed)return {consultationId:id,state:'unknown',reason:'reconciliation_required'};
 const task={...compiled.task,managedSessionId:context.sessionId,runtime:context.runtime};
 const policy={role:'manager',canDelegate:true,canWrite:false,canReview:true,maxChildren:1,maxConcurrent:1,workspacePolicy:'shared-exclusive',accessMode:'read',executionIsolation:'shared',allowedAgentIds:[context.agentId],allowedRoles:[context.role],organizationId:org,organizationNodeId:context.nodeId,organizationBindingGeneration:context.nodeGeneration};
 try {const collaboration=await getDefaultCollaborationOrchestrator().dispatchFactoryConsultation({rootSessionId:context.rootSessionId,projectId:context.projectId,idempotencyKey:dispatchKey,policy,plan:{version:1,title:'Task consultation',tasks:[task]}},context);
  await factoryTransaction(db=>{schema(db);db.prepare("UPDATE factory_consultations SET state='observing',updated_at=? WHERE id=? AND state='sending'").run(now(),id);});
  return {consultationId:id,state:'observing',collaborationId:collaboration.id};
 } catch {return {consultationId:id,state:'unknown',reason:'reconciliation_required'};}
}

export async function getFactoryConsultation({organizationId,workItemId,consultationId},actor) {
 if(actor?.kind!=='user'||actor.role!=='owner'||!text(actor.principalId)) fail('Owner required','FACTORY_FORBIDDEN');
 const row=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');return db.prepare('SELECT * FROM factory_consultations WHERE id=? AND organization_id=? AND work_item_id=?').get(consultationId,organizationId,workItemId);});
 if(!row)fail('Consultation not found','FACTORY_NOT_FOUND');
 const saved=decode(row.result_json,null); let opinion=null;
 if(row.state==='opinion_recorded' && saved?.packetId) {
  const packet=await getResultPacket(saved.packetId).catch(()=>null);
  if(packet && packet.digest===saved.packetDigest && packet.digest===computeResultPacketDigest(packet) && packet.producer?.attemptId===saved.attemptId && packet.producer?.runId===saved.runId && packet.taskKind==='consultation') opinion=packet.consultation?.recommendation || null;
 }
 return {consultationId:row.id,state:row.state==='sending'?'unknown':row.state,round:await getConsultationRound(row.round_id),result:saved,opinion,
  recovery:row.state==='created'?'retry_same_request_before_deadline':row.state==='sending'?'reconcile_only_no_automatic_resend':null,
  usage:'reservation_pending_if_reserved',createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function listFactoryConsultations({organizationId,workItemId},actor) {
 if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required','FACTORY_FORBIDDEN');
 return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');const rows=db.prepare('SELECT id,state,created_at,updated_at FROM factory_consultations WHERE organization_id=? AND work_item_id=? ORDER BY created_at DESC,id DESC LIMIT 51').all(organizationId,workItemId);return {items:rows.slice(0,50).map(r=>({consultationId:r.id,state:r.state==='sending'?'unknown':r.state,createdAt:r.created_at,updatedAt:r.updated_at})),truncated:rows.length>50};});
}
export async function resumeFactoryConsultation(input,actor) {
 const record=await getFactoryConsultation(input,actor);
 if(record.state!=='created') return {...record,recovery:'reconcile_only_no_automatic_resend'};
 const saved=await factoryRead(db=>{authorize(db,input.organizationId,actor,'factory.dispatch');return db.prepare('SELECT * FROM factory_consultations WHERE id=? AND organization_id=? AND work_item_id=?').get(input.consultationId,input.organizationId,input.workItemId);});
 if(!saved || saved.state!=='created') return {...await getFactoryConsultation(input,actor),recovery:'reconcile_only_no_automatic_resend'};
 return advanceSafely(decode(saved.context_json,{}));
}
export async function reconcileFactoryConsultation(input,actor) {
 const result=await getFactoryConsultation(input,actor);
 if(['opinion_recorded','failed','cancelled','expired'].includes(result.state)) return {...result,replayed:true};
 const saved=await factoryRead(db=>db.prepare('SELECT * FROM factory_consultations WHERE id=? AND organization_id=? AND work_item_id=?').get(input.consultationId,input.organizationId,input.workItemId));
 const context=decode(saved.context_json,{}),collaboration=await getCollaborationByIdempotencyKey(context.rootSessionId,context.dispatchKey);
 if(!collaboration || JSON.stringify(collaboration.policy?.factoryConsultation)!==JSON.stringify(context)) return {...result,reconciliation:'unknown'};
 const attempts=collaboration.attempts || []; if(attempts.length!==1) return {...result,reconciliation:attempts.length?'inconsistent':'awaiting_attempt'};
 const attempt=attempts[0],round=await getConsultationRound(context.roundId),expert=round.experts.find(e=>e.id===context.expertId);
 if(!expert || (expert.attemptId && expert.attemptId!==attempt.id) || (expert.expertSessionId && expert.expertSessionId!==attempt.sessionId)) fail('Consultation attempt binding changed');
 if(!expert.attemptId && attempt.sessionId) await dispatchConsultationRound(context.roundId,{expertAssignmentId:context.expertId,expertSessionId:attempt.sessionId,attemptId:attempt.id,version:round.version});
 if(['failed','cancelled'].includes(attempt.state) && attempt.failureKind!=='unknown_outcome' && attempt.runId) {
  const run=await getRunAcceptanceEvidence(attempt.runId), expected=attempt.state==='cancelled'?'cancelled':'failed';
  // A completed Run can still produce a failed Attempt (for example, if its
  // consultation packet cannot be built). Preserve both facts independently.
  if(run?.id===attempt.runId && run.sessionId===attempt.sessionId && run.finalizedAt && (run.state===expected || (expected==='failed' && run.state==='completed'))) {
   const terminal={attemptId:attempt.id,runId:attempt.runId,runState:run.state,reason:attempt.failureKind || expected,usage:'reservation_pending'};
   await factoryTransaction(db=>{schema(db);authorize(db,input.organizationId,actor,'factory.read');const row=db.prepare('SELECT state,failure_kind,run_id FROM collaboration_attempts WHERE id=? AND collaboration_id=?').get(attempt.id,collaboration.id);if(!row||row.state!==attempt.state||row.run_id!==attempt.runId||row.failure_kind==='unknown_outcome')fail('Attempt changed during reconciliation');db.prepare("UPDATE factory_consultations SET state=?,result_json=?,updated_at=? WHERE id=? AND state IN ('sending','observing')").run(expected,encode(terminal),now(),context.id);});
   return getFactoryConsultation(input,actor);
  }
 }
 if(attempt.state==='failed' && attempt.failureKind==='deterministic_failure' && !attempt.runId) {
  const recorded=await factoryTransaction(db=>{
   schema(db); authorize(db,input.organizationId,actor,'factory.read');
   const row=db.prepare('SELECT state,failure_kind,run_id FROM collaboration_attempts WHERE id=? AND collaboration_id=?').get(attempt.id,collaboration.id);
   const command=db.prepare('SELECT id FROM collaboration_dispatch_commands WHERE attempt_id=?').get(attempt.id);
   if(!row || row.state!=='failed' || row.failure_kind!=='deterministic_failure' || row.run_id || command) return false;
   return db.prepare("UPDATE factory_consultations SET state='failed',result_json=?,updated_at=? WHERE id=? AND state IN ('sending','observing')").run(encode({attemptId:attempt.id,runState:'not_created',reason:'deterministic_failure_before_outbox',usage:'reservation_pending'}),now(),context.id).changes===1;
  });
  if(recorded) return getFactoryConsultation(input,actor);
 }
 if(attempt.state!=='succeeded'||!attempt.runId||!attempt.resultPacketId) return {...result,reconciliation:attempt.failureKind==='unknown_outcome'?'unknown':'awaiting_verified_result',attemptId:attempt.id};
 const packet=await getResultPacket(attempt.resultPacketId);
 if(!packet || packet.taskKind!=='consultation' || packet.state!=='succeeded' || packet.digest!==computeResultPacketDigest(packet) || packet.producer?.runId!==attempt.runId || packet.producer?.taskId!==attempt.taskId || packet.producer?.projectId!==context.projectId || packet.producer?.attemptId!==attempt.id || packet.producer?.sessionId!==attempt.sessionId || packet.consultation?.runId!==attempt.runId || packet.consultation?.attemptId!==attempt.id || !packet.consultation?.recommendation) return {...result,reconciliation:'packet_unavailable_or_unverified',attemptId:attempt.id};
 await linkPacketToRound(context.roundId,attempt.id,packet.packetId);
 const latest=await getConsultationRound(context.roundId); if(latest.state==='DISPATCHED') await beginAggregation(context.roundId,{version:latest.version,verifyAllExpertsDone:true});
 await factoryTransaction(db=>{schema(db);authorize(db,input.organizationId,actor,'factory.read');const row=db.prepare('SELECT state,run_id,result_packet_id FROM collaboration_attempts WHERE id=? AND collaboration_id=?').get(attempt.id,collaboration.id);if(!row||row.state!=='succeeded'||row.run_id!==attempt.runId||row.result_packet_id!==packet.packetId)fail('Attempt changed during packet reconciliation');db.prepare("UPDATE factory_consultations SET state='opinion_recorded',result_json=?,updated_at=? WHERE id=? AND state IN ('sending','observing')").run(encode({packetId:packet.packetId,packetDigest:packet.digest,attemptId:attempt.id,runId:attempt.runId,usage:'reservation_pending'}),now(),context.id);});
 return {...await getFactoryConsultation(input,actor),reconciliation:'verified_packet'};
}
