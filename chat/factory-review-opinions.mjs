// A reviewer opinion is a scoped agent statement, not proof that tests passed.
import { randomUUID, createHash } from 'node:crypto';
import { factoryTransaction, factoryRead, factoryError, decode, now } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { getResultPacket, computeResultPacketDigest } from './result-packets.mjs';

const fail = message => { throw factoryError('FACTORY_EVIDENCE_UNVERIFIED',message,409); };
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_review_opinions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, candidate_work_item_id TEXT NOT NULL, candidate_digest TEXT NOT NULL,
 contract_revision INTEGER NOT NULL, execution_epoch INTEGER NOT NULL, reviewer_work_item_id TEXT NOT NULL,
 reviewer_node_id TEXT NOT NULL, reviewer_attempt_id TEXT NOT NULL, reviewer_run_id TEXT NOT NULL,
 verdict TEXT NOT NULL, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(reviewer_run_id,idempotency_key), UNIQUE(reviewer_run_id,candidate_work_item_id,candidate_digest,contract_revision,execution_epoch));
 CREATE TABLE IF NOT EXISTS factory_review_opinion_receipts (opinion_id TEXT PRIMARY KEY,packet_id TEXT NOT NULL,packet_digest TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS factory_review_opinions_no_update BEFORE UPDATE ON factory_review_opinions BEGIN SELECT RAISE(ABORT,'immutable review opinion'); END;
 CREATE TRIGGER IF NOT EXISTS factory_review_opinions_no_delete BEFORE DELETE ON factory_review_opinions BEGIN SELECT RAISE(ABORT,'immutable review opinion'); END;
 CREATE TRIGGER IF NOT EXISTS factory_review_receipts_no_update BEFORE UPDATE ON factory_review_opinion_receipts BEGIN SELECT RAISE(ABORT,'immutable review receipt'); END;
 CREATE TRIGGER IF NOT EXISTS factory_review_receipts_no_delete BEFORE DELETE ON factory_review_opinion_receipts BEGIN SELECT RAISE(ABORT,'immutable review receipt'); END;`); }
function verifyContext(db, opinion, principal, requireRunning) {
 const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(opinion.organization_id);
 const source=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(opinion.candidate_work_item_id,opinion.organization_id);
 const review=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(opinion.reviewer_work_item_id,opinion.organization_id);
 if (!org || ['archived','lifecycle_pending'].includes(org.state) || !source || !review || review.kind!=='review' || source.state!=='review' || source.control_state!=='none' || source.candidate_digest!==opinion.candidate_digest || source.contract_revision!==opinion.contract_revision || source.execution_epoch!==opinion.execution_epoch || source.assignee_node_id===review.assignee_node_id || review.assignee_node_id!==opinion.reviewer_node_id) fail('Review or candidate changed');
 const dep=db.prepare("SELECT 1 FROM factory_dependencies WHERE predecessor_id=? AND successor_id=? AND milestone='candidate_ready' AND candidate_digest=?").get(source.id,review.id,source.candidate_digest); if (!dep) fail('Review does not reference the candidate');
 const author=db.prepare('SELECT n.*,r.agent_id FROM organization_nodes n LEFT JOIN role_instances r ON r.id=n.role_instance_id WHERE n.id=? AND n.organization_id=?').get(source.assignee_node_id,org.id);
 const reviewer=db.prepare('SELECT n.*,r.agent_id FROM organization_nodes n LEFT JOIN role_instances r ON r.id=n.role_instance_id WHERE n.id=? AND n.organization_id=?').get(review.assignee_node_id,org.id);
 if (!author || !reviewer || !author.agent_id || !reviewer.agent_id || author.agent_id===reviewer.agent_id || reviewer.retired_revision!==null || reviewer.binding_generation!==review.binding_generation) fail('Independent reviewer identity unavailable');
 const grant=decode(reviewer.grant_json,{}); if (grant.canReview!==true || grant.canWrite===true) fail('Reviewer must have read-only node authority');
 const latest=cap=>db.prepare('SELECT * FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(org.id,reviewer.id,cap,org.current_revision);
 const reviewGrant=latest('review'), writeGrant=latest('write'); if (!reviewGrant?.allow || writeGrant?.allow) fail('Reviewer grant is missing or permits writes');
 const reviewScope=decode(reviewGrant.scope_json,{}); if ((reviewScope.projectId && reviewScope.projectId!==org.project_id) || Object.keys(reviewScope).some(key=>!['projectId','writablePaths'].includes(key))) fail('Reviewer grant scope is unsupported');
 const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(review.id,review.contract_revision)?.contract_json,{});
 if (contract.accessMode!=='read' || contract.organizationRevision!==org.current_revision) fail('Review contract is not current and read-only');
 const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND attempt_id=? AND run_id=?').get(review.id,review.contract_revision,review.execution_epoch,review.binding_generation,opinion.reviewer_attempt_id,opinion.reviewer_run_id);
 if (!binding || (requireRunning && (binding.status!=='running' || review.state!=='running' || review.control_state!=='none'))) fail('Review execution binding changed');
 const attempt=db.prepare('SELECT * FROM collaboration_attempts WHERE id=? AND task_id=? AND run_id=?').get(binding.attempt_id,binding.task_id,binding.run_id); if (!attempt) fail('Review attempt missing');
 if (principal && (principal.principalKind!=='run_capability' || principal.capabilityOperation!=='factory.review.submit' || principal.runId!==binding.run_id || principal.sessionId!==attempt.session_id || principal.organizationMessageScope?.organizationId!==org.id || principal.organizationMessageScope?.nodeId!==reviewer.id || principal.organizationMessageScope?.workItemId!==review.id || principal.organizationMessageScope?.attemptId!==attempt.id || principal.organizationMessageScope?.executionEpoch!==review.execution_epoch || principal.organizationMessageScope?.bindingGeneration!==review.binding_generation || principal.organizationMessageScope?.organizationRevision!==org.current_revision || principal.organizationMessageScope?.managedSessionId!==reviewer.current_session_id || principal.organizationMessageScope?.reviewOpinionAllowed!==true || principal.organizationMessageScope?.reviewCandidate?.workItemId!==source.id || principal.organizationMessageScope?.reviewCandidate?.digest!==source.candidate_digest || principal.organizationMessageScope?.reviewCandidate?.contractRevision!==source.contract_revision || principal.organizationMessageScope?.reviewCandidate?.executionEpoch!==source.execution_epoch)) fail('Review capability scope changed');
 const workspace=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_validation_workspaces'").get() && db.prepare("SELECT * FROM factory_validation_workspaces WHERE validation_work_item_id=? AND run_id=? AND candidate_digest=? AND state='sealed'").get(review.id,binding.run_id,source.candidate_digest); if (!workspace) fail('Candidate-derived review workspace unavailable');
 return {binding,attempt,source,review,workspace};
}
export async function submitFactoryReviewOpinion(input,principal) {
 const scope=principal?.organizationMessageScope; if (!scope?.workItemId || !principal.runId) fail('Scoped reviewer required');
 const reason=typeof input?.reason==='string'?input.reason.trim():''; const key=typeof input?.idempotencyKey==='string'?input.idempotencyKey.trim():'';
 if (!reason || reason.length>4096 || !key || key.length>255 || !['pass','needs_changes','blocked'].includes(input?.verdict) || !/^[a-f0-9]{64}$/.test(input?.candidateDigest||'') || !Number.isInteger(input?.contractRevision) || !Number.isInteger(input?.executionEpoch)) fail('Invalid review opinion');
 const o={organization_id:scope.organizationId,candidate_work_item_id:input.candidateWorkItemId,candidate_digest:input.candidateDigest,contract_revision:input.contractRevision,execution_epoch:input.executionEpoch,reviewer_work_item_id:scope.workItemId,reviewer_node_id:scope.nodeId,reviewer_attempt_id:scope.attemptId,reviewer_run_id:principal.runId,verdict:input.verdict,reason,idempotency_key:key};
 const digest=createHash('sha256').update(JSON.stringify(o)).digest('hex');
 return factoryTransaction(db=>{schema(db);verifyContext(db,o,principal,true); const old=db.prepare('SELECT * FROM factory_review_opinions WHERE reviewer_run_id=? AND idempotency_key=?').get(o.reviewer_run_id,key); if(old) {if(old.payload_digest!==digest) fail('Review key reused'); return {opinionId:old.id,state:'pending_run',replayed:true};} const id=`review_${randomUUID()}`; db.prepare('INSERT INTO factory_review_opinions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,...Object.values(o),digest,now()); return {opinionId:id,state:'pending_run'};});
}
export async function reconcileFactoryReviewOpinion({organizationId,opinionId},actor) {
 const context=await factoryRead(db=>{schema(db); authorize(db,organizationId,actor,'factory.read'); if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required'); const o=db.prepare('SELECT * FROM factory_review_opinions WHERE id=? AND organization_id=?').get(opinionId,organizationId); if(!o) fail('Review opinion not found'); const checked=verifyContext(db,o,null,false); return {o,...checked};});
 const {checkWorkspace}=await import('./factory-checks.mjs'); await checkWorkspace(context.workspace);
 const packetId=context.attempt.result_packet_id; const [run,packet]=await Promise.all([getRunAcceptanceEvidence(context.o.reviewer_run_id),packetId?getResultPacket(packetId):null]);
 if (!run || run.state!=='completed' || !packet || packet.state!=='succeeded' || packet.digest!==computeResultPacketDigest(packet) || packet.producer?.runId!==context.o.reviewer_run_id || packet.producer?.attemptId!==context.o.reviewer_attempt_id || packet.producer?.taskId!==context.binding.task_id) fail('Review Run and packet not yet verified');
 return factoryTransaction(db=>{schema(db); const o=db.prepare('SELECT * FROM factory_review_opinions WHERE id=?').get(opinionId); const current=verifyContext(db,o,null,false); if(current.attempt.result_packet_id!==packetId || current.attempt.state!=='succeeded') fail('Review attempt changed'); db.prepare('INSERT OR IGNORE INTO factory_review_opinion_receipts VALUES(?,?,?,?)').run(opinionId,packetId,packet.digest,now()); return {opinionId,state:'verified',verdict:o.verdict};});
}
export function hasVerifiedIndependentReview(db,item) { schema(db); const rows=db.prepare("SELECT o.* FROM factory_review_opinions o JOIN factory_review_opinion_receipts r ON r.opinion_id=o.id WHERE o.candidate_work_item_id=? AND o.candidate_digest=? AND o.contract_revision=? AND o.execution_epoch=? AND o.verdict='pass'").all(item.id,item.candidateDigest,item.contractRevision,item.executionEpoch); return rows.some(o=>{try {verifyContext(db,o,null,false);return true;} catch {return false;}}); }
