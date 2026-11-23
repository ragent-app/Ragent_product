import { read, transaction, error, digest } from './responsibility-store.mjs';
import { getResultPacket, computeResultPacketDigest } from './result-packets.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { projectFactoryReport } from './factory-report-projection.mjs';
import { validateProjectReportPolicy } from './responsibility-providers.mjs';
import { factoryGrantDenial } from './factory-grant-authority.mjs';

const parse=(value,fallback=null)=>{ try { return JSON.parse(value); } catch { return fallback; } };

// Preserve real declaration fields in their original shapes. Limit the whole
// serialized projection, dropping only complete array entries and flagging
// omissions; text fields may be shortened at a UTF-16 character boundary.
function boundedBaselineReport(report,maxBytes=14000) {
 const value={source:report.source,readable:report.readable===true,visibleText:'',
  declaration:{status:report.declaration?.status || 'unavailable'}};
 let truncated=false;
 const fits=()=>Buffer.byteLength(JSON.stringify(value),'utf8')<=maxBytes;
 if (report.declaration?.state!==undefined) value.declaration.state=report.declaration.state;
 const addText=(container,key,original)=>{
  const text=typeof original==='string'?original:'';
  container[key]=text;
  if (fits()) return;
  let low=0,high=text.length;
  while (low<high) {
   const middle=Math.ceil((low+high)/2);
   container[key]=text.slice(0,middle);
   if (fits()) low=middle; else high=middle-1;
  }
  if (low>0 && /[\uD800-\uDBFF]/.test(text.charAt(low-1))) low--;
  container[key]=text.slice(0,low);
  truncated=true;
 };
 const declaration=report.declaration || {};
 for (const field of ['risks','blockers','unresolvedItems','acceptanceNotes','tests','changedFiles']) {
  if (!Array.isArray(declaration[field])) continue;
  value.declaration[field]=[];
  if (!fits()) { delete value.declaration[field]; truncated=true; continue; }
  for (const entry of declaration[field]) {
   value.declaration[field].push(entry);
   if (!fits()) { value.declaration[field].pop(); truncated=true; break; }
  }
 }
 if (typeof declaration.summary==='string') addText(value.declaration,'summary',declaration.summary);
 addText(value,'visibleText',report.visibleText);
 return {...value,truncated};
}

// Return only a fully owner-accepted report in this responsibility's own graph.
export function latestAcceptedReport(db,responsibility,{excludeWorkItemId='',onlyWorkItemId=''}={}) {
 const plans=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
 const goals=plans
  ? `SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=?
     UNION SELECT e.goal_id FROM responsibility_plan_executions e
     JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=?`
  : 'SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=?';
 const args=plans?[responsibility.id,responsibility.id]:[responsibility.id];
 const rows=db.prepare(`SELECT w.*,c.contract_json,fc.details_json,wi.mapping_json,b.run_id,b.attempt_id,b.task_id,
   a.session_id,a.result_packet_id,a.state AS attempt_state
   FROM factory_work_items w
   JOIN factory_workflow_instances wi ON wi.goal_id=w.goal_id AND wi.organization_id=w.organization_id
     AND wi.template_id='ragent-project-report' AND wi.template_version=1
   JOIN factory_work_contracts c ON c.work_item_id=w.id AND c.revision=w.contract_revision
   JOIN factory_candidates fc ON fc.work_item_id=w.id AND fc.contract_revision=w.contract_revision
     AND fc.execution_epoch=w.execution_epoch AND fc.binding_generation=w.binding_generation AND fc.digest=w.candidate_digest
   JOIN factory_execution_bindings b ON b.work_item_id=w.id AND b.contract_revision=w.contract_revision
     AND b.execution_epoch=w.execution_epoch AND b.binding_generation=w.binding_generation AND b.status='candidate'
   JOIN collaboration_attempts a ON a.id=b.attempt_id AND a.task_id=b.task_id AND a.run_id=b.run_id
   WHERE w.organization_id=? AND w.project_id=? AND w.goal_id IN (${goals})
     AND w.state='completed' AND w.control_state='none' AND w.id<>? AND (?='' OR w.id=?)
   ORDER BY w.updated_at DESC,w.id DESC`).all(responsibility.organization_id,responsibility.project_id,...args,
     excludeWorkItemId,onlyWorkItemId,onlyWorkItemId);
 const accepted=[];
 for (const row of rows) {
  const contract=parse(row.contract_json,{}),details=parse(row.details_json,{});
  if (row.kind!=='execution' || parse(row.mapping_json,{})?.report!==row.id
      || contract.accessMode!=='read' || contract.resource?.readScope!=='entire_project'
      || contract.resource?.projectId!==responsibility.project_id || row.attempt_state!=='succeeded'
      || !details.packetId || details.packetId!==row.result_packet_id
      || details.packetDigest!==`sha256:${row.candidate_digest}`) continue;
  const criteria=contract.acceptanceCriteria;
  if (!Array.isArray(criteria) || !criteria.length || criteria.some(c=>c.method!=='manual')) continue;
  const decisions=db.prepare(`SELECT criterion_id,decision,evidence_json,created_at FROM factory_acceptance_decisions
    WHERE work_item_id=? AND contract_revision=? AND candidate_digest=? AND gate_generation=? AND actor_id=?`)
    .all(row.id,row.contract_revision,row.candidate_digest,row.gate_generation,responsibility.owner_principal_id);
  if (!criteria.every(c=>decisions.some(d=>d.criterion_id===c.id && d.decision==='passed'
      && parse(d.evidence_json,[]).some(e=>e.kind==='owner_report_review' && e.packetId===details.packetId
        && e.packetDigest===details.packetDigest)))) continue;
  const direct=db.prepare('SELECT policy_revision FROM responsibility_work_links WHERE responsibility_id=? AND goal_id=?')
    .get(responsibility.id,row.goal_id);
  const planned=plans && db.prepare(`SELECT p.policy_revision FROM responsibility_plan_executions e
    JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=? AND e.goal_id=?`)
    .get(responsibility.id,row.goal_id);
  accepted.push({workItemId:row.id,projectId:row.project_id,policyRevision:direct?.policy_revision ?? planned?.policy_revision ?? null,
    organizationRevision:contract.organizationRevision ?? null,contractRevision:row.contract_revision,
    executionEpoch:row.execution_epoch,candidateDigest:row.candidate_digest,packetId:details.packetId,
    packetDigest:details.packetDigest,runId:row.run_id,attemptId:row.attempt_id,taskId:row.task_id,
    sessionId:row.session_id,acceptedAt:decisions.map(d=>d.created_at).sort().at(-1),
    objective:contract.objective || '',resource:contract.resource});
 }
 accepted.sort((a,b)=>b.acceptedAt.localeCompare(a.acceptedAt) || b.workItemId.localeCompare(a.workItemId));
 return accepted[0] || null;
}

export async function weeklyReportStatus(id,actor,{excludeWorkItemId=''}={}) {
 if (actor?.kind!=='user' || actor.role!=='owner' || !actor.principalId) throw error('Owner required',403);
 const data=await read(db=>{
  const r=db.prepare(`SELECT r.*,p.policy_json,p.valid_until,o.current_revision AS organization_revision FROM responsibilities r
    JOIN responsibility_policy_revisions p ON p.responsibility_id=r.id AND p.revision=r.policy_revision
    JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id
    WHERE r.id=? AND r.owner_principal_id=?`).get(id,actor.principalId);
  if (!r) throw error('Responsibility not found',404);
  const policy=parse(r.policy_json,{});
  const hasGraph=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get();
  let authorityValid=false;
  try {
   validateProjectReportPolicy(policy,r.project_id);
   const org=db.prepare('SELECT * FROM organizations WHERE id=? AND project_id=?').get(r.organization_id,r.project_id);
   const binding=policy.nodeBindings?.report;
   const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(binding?.nodeId,r.organization_id);
   const grant=node ? parse(node.grant_json,{}) : null;
   const writeGrant=node && org && db.prepare(`SELECT allow FROM organization_grants
     WHERE organization_id=? AND node_id=? AND capability='write' AND revision<=?
     ORDER BY revision DESC,id DESC LIMIT 1`).get(org.id,node.id,org.current_revision);
   authorityValid=!!org && !['archived','lifecycle_pending'].includes(org.state) && !!node
    && node.retired_revision===null && !!node.current_session_id && node.binding_generation===binding.bindingGeneration
    && grant?.canWrite!==true && !writeGrant?.allow && !factoryGrantDenial(db,org,node,{kind:'execution',projectId:r.project_id,
      contract:{accessMode:'read',resource:policy.resource,allowedPaths:[]}});
  } catch { authorityValid=false; }
  return {responsibility:r,policy,authorityValid,baseline:hasGraph?latestAcceptedReport(db,r,{excludeWorkItemId}):null};
 });
 const {responsibility:r,policy,authorityValid,baseline}=data;
 let reason='';
 if (!authorityValid || policy.providerId!=='project-report' || policy.resource?.projectId!==r.project_id
     || policy.resource?.readScope!=='entire_project') reason='report_authorization_unavailable';
 else if (!Number.isFinite(Date.parse(r.valid_until)) || Date.parse(r.valid_until)<=Date.now()) reason='authorization_expired';
 else if (!baseline) reason='no_accepted_baseline';
 else if (baseline.policyRevision!==r.policy_revision || baseline.organizationRevision!==r.organization_revision
     || digest(baseline.resource)!==digest(policy.resource) || baseline.objective!==r.objective) reason='scope_changed';
 let report=null;
 if (baseline && !reason) {
  try {
   const [packet,run]=await Promise.all([getResultPacket(baseline.packetId),getRunAcceptanceEvidence(baseline.runId)]);
   if (!packet || packet.kind!=='execution' || packet.state!=='succeeded'
       || packet.packetId!==baseline.packetId || packet.digest!==baseline.packetDigest
       || computeResultPacketDigest(packet)!==packet.digest || packet.producer?.projectId!==baseline.projectId
       || packet.producer?.runId!==baseline.runId || packet.producer?.attemptId!==baseline.attemptId
       || packet.producer?.taskId!==baseline.taskId || packet.producer?.sessionId!==baseline.sessionId
       || run?.state!=='completed' || !run.finalizedAt || run.sessionId!==baseline.sessionId) throw new Error('unverified');
   report=projectFactoryReport(packet);
   if (!report.readable) throw new Error('unreadable');
   report=boundedBaselineReport(report);
   baseline.packetCreatedAt=packet.createdAt || null;
   baseline.capturedAt=null; // Packet creation is not evidence of collection time.
   baseline.source='persisted_assistant_final';
  } catch { reason=reason || 'baseline_evidence_unavailable'; report=null; }
 }
 return {schemaVersion:1,responsibilityId:id,policyRevision:r.policy_revision,organizationRevision:r.organization_revision,eligible:!reason,reason:reason || null,
  comparison:reason?{status:'unavailable',reason}:{status:'available'},
  baseline:baseline?(reason?{workItemId:baseline.workItemId,projectId:baseline.projectId,
    candidateDigest:baseline.candidateDigest,acceptedAt:baseline.acceptedAt}:{...baseline,report}):null};
}

// Resolve a weekly wall time in an IANA zone. A nonexistent DST wall time is
// skipped; an ambiguous time uses its first occurrence.
export function nextWeeklyReportAt(config,after=Date.now()) {
 const {weekday,hour,minute,timeZone}=config || {};
 if (!Number.isInteger(weekday) || weekday<0 || weekday>6 || !Number.isInteger(hour) || hour<0 || hour>23
     || !Number.isInteger(minute) || minute<0 || minute>59 || typeof timeZone!=='string' || !timeZone.trim()) {
  throw error('Invalid weekly schedule',400,'RESPONSIBILITY_TRIGGER_UNSUPPORTED');
 }
 let formatter;
 try { formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); formatter.format(new Date(after)); }
 catch { throw error('Invalid IANA time zone',400,'RESPONSIBILITY_TRIGGER_UNSUPPORTED'); }
 const parts=ms=>Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 const nowParts=parts(after), localDay=Date.UTC(nowParts.year,nowParts.month-1,nowParts.day);
 for (let day=0;day<15;day++) {
  const date=new Date(localDay+day*86400000);
  if (date.getUTCDay()!==weekday) continue;
  const target=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour,minute);
  let guess=target;
  for (let n=0;n<4;n++) {
   const p=parts(guess), represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);
   const delta=target-represented;
   if (!delta) break;
   guess+=delta;
  }
  // Check both sides of a clock rollback, choosing the first matching instant.
  const matches=[];
  for (let offset=-180;offset<=180;offset++) {
   const instant=guess+offset*60000,p=parts(instant);
   if (Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)===target) matches.push(instant);
  }
  if (matches.length && Math.min(...matches)>after) return new Date(Math.min(...matches)).toISOString();
 }
 throw error('No valid occurrence in the next two weeks',409,'RESPONSIBILITY_TRIGGER_UNSUPPORTED');
}

function comparisonSchema(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS responsibility_report_comparisons (
  work_item_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL, responsibility_id TEXT NOT NULL,
  comparison_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(work_item_id,execution_epoch));
  CREATE TRIGGER IF NOT EXISTS responsibility_report_comparison_no_update
   BEFORE UPDATE ON responsibility_report_comparisons BEGIN SELECT RAISE(ABORT,'immutable report comparison'); END;
  CREATE TRIGGER IF NOT EXISTS responsibility_report_comparison_no_delete
   BEFORE DELETE ON responsibility_report_comparisons BEGIN SELECT RAISE(ABORT,'immutable report comparison'); END;`);
}

async function pinnedDecisionStillValid(responsibilityId,baseline) {
 return read(db=>{
  const responsibility=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(responsibilityId);
  if (!responsibility) return false;
  const current=latestAcceptedReport(db,responsibility,{onlyWorkItemId:baseline.workItemId});
  return !!current && current.projectId===baseline.projectId && current.candidateDigest===baseline.candidateDigest
   && current.packetId===baseline.packetId && current.packetDigest===baseline.packetDigest
   && current.contractRevision===baseline.contractRevision && current.executionEpoch===baseline.executionEpoch
   && current.policyRevision===baseline.policyRevision && current.organizationRevision===baseline.organizationRevision
   && current.objective===baseline.objective && digest(current.resource)===digest(baseline.resource);
 });
}

async function verifyPinnedBaseline(baseline) {
 if (!baseline) return false;
 try {
  const [packet,run]=await Promise.all([getResultPacket(baseline.packetId),getRunAcceptanceEvidence(baseline.runId)]);
  return !!packet && packet.kind==='execution' && packet.state==='succeeded'
   && packet.packetId===baseline.packetId && packet.digest===baseline.packetDigest
   && computeResultPacketDigest(packet)===packet.digest && packet.producer?.projectId===baseline.projectId
   && packet.producer?.runId===baseline.runId && packet.producer?.attemptId===baseline.attemptId
   && packet.producer?.taskId===baseline.taskId && packet.producer?.sessionId===baseline.sessionId
   && run?.state==='completed' && !!run.finalizedAt && run.sessionId===baseline.sessionId
   && projectFactoryReport(packet).readable;
 } catch { return false; }
}

// Freeze the comparison input before dispatch; a later accepted report cannot
// replace the baseline for an already-started execution.
export async function pinReportComparison({organizationId,workItemId,executionEpoch}) {
 const identity=await read(db=>{
  const item=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(workItemId,organizationId);
  if (!item) return null;
  let link=db.prepare(`SELECT r.* FROM responsibility_work_links l JOIN responsibilities r ON r.id=l.responsibility_id
    WHERE l.goal_id=? AND r.organization_id=? AND r.project_id=?`).get(item.goal_id,organizationId,item.project_id);
  const hasPlans=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
  if (!link && hasPlans) link=db.prepare(`SELECT r.* FROM responsibility_plan_executions e
    JOIN responsibility_plans p ON p.id=e.plan_id JOIN responsibilities r ON r.id=p.responsibility_id
    WHERE e.goal_id=? AND r.organization_id=? AND r.project_id=?`).get(item.goal_id,organizationId,item.project_id);
  if (!link) return null;
  const policy=db.prepare('SELECT policy_json FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?')
    .get(link.id,link.policy_revision);
  return parse(policy?.policy_json,{})?.providerId==='project-report'
    ? {id:link.id,owner:link.owner_principal_id} : null;
 });
 if (!identity) return null;
 const saved=await read(db=>{
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_report_comparisons'").get()) return null;
  const row=db.prepare('SELECT comparison_json FROM responsibility_report_comparisons WHERE work_item_id=? AND execution_epoch=?').get(workItemId,executionEpoch);
  return row ? parse(row.comparison_json) : null;
 });
 const status=await weeklyReportStatus(identity.id,{kind:'user',role:'owner',principalId:identity.owner},{excludeWorkItemId:workItemId});
 if (saved) {
  if (saved.status==='available' && (!status.eligible
      || saved.baseline.policyRevision!==status.policyRevision
      || saved.baseline.organizationRevision!==status.organizationRevision
      || saved.baseline.projectId!==status.baseline.projectId
      || digest(saved.baseline.resource)!==digest(status.baseline.resource)
      || saved.baseline.objective!==status.baseline.objective
      || !await pinnedDecisionStillValid(identity.id,saved.baseline)
      || !await verifyPinnedBaseline(saved.baseline))) {
    throw error('Pinned baseline is no longer authorized',409,'RESPONSIBILITY_CONFLICT');
  }
  return saved;
 }
 const source=status.eligible?status.baseline:null;
 const comparison=source?{status:'available',basis:'last_owner_accepted',baseline:source}
  :{status:'unavailable',reason:status.reason || 'no_accepted_baseline'};
 const pinned=await transaction(db=>{
  comparisonSchema(db);
  const existing=db.prepare('SELECT comparison_json FROM responsibility_report_comparisons WHERE work_item_id=? AND execution_epoch=?').get(workItemId,executionEpoch);
  if (existing) return parse(existing.comparison_json);
  const item=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(workItemId,organizationId);
  const responsibility=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(identity.id);
  const org=db.prepare('SELECT current_revision FROM organizations WHERE id=?').get(organizationId);
  if (!item || item.execution_epoch!==executionEpoch || !responsibility
      || responsibility.policy_revision!==status.policyRevision || org?.current_revision!==status.organizationRevision) throw error('Report comparison scope changed',409,'RESPONSIBILITY_CONFLICT');
  if (source) {
   const current=latestAcceptedReport(db,responsibility,{excludeWorkItemId:workItemId});
   if (!current || current.workItemId!==source.workItemId || current.candidateDigest!==source.candidateDigest) {
    throw error('Accepted baseline changed before dispatch',409,'RESPONSIBILITY_CONFLICT');
   }
  }
  db.prepare('INSERT INTO responsibility_report_comparisons VALUES(?,?,?,?,?)')
    .run(workItemId,executionEpoch,identity.id,JSON.stringify(comparison),new Date().toISOString());
  return comparison;
 });
 if (pinned.status==='available' && (!status.eligible
     || pinned.baseline.policyRevision!==status.policyRevision
     || pinned.baseline.organizationRevision!==status.organizationRevision
     || pinned.baseline.projectId!==status.baseline.projectId
     || digest(pinned.baseline.resource)!==digest(status.baseline.resource)
     || pinned.baseline.objective!==status.baseline.objective
     || !await pinnedDecisionStillValid(identity.id,pinned.baseline)
     || !await verifyPinnedBaseline(pinned.baseline))) {
  throw error('Pinned baseline is no longer authorized',409,'RESPONSIBILITY_CONFLICT');
 }
 return pinned;
}

export async function getPinnedReportComparison(organizationId,workItemId,executionEpoch,actor) {
 if (actor?.kind!=='user' || actor.role!=='owner' || !actor.principalId) throw error('Owner required',403);
 const row=await read(db=>{
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_report_comparisons'").get()) return null;
  return db.prepare(`SELECT c.* FROM responsibility_report_comparisons c
   JOIN responsibilities r ON r.id=c.responsibility_id AND r.owner_principal_id=? AND r.organization_id=?
   JOIN factory_work_items w ON w.id=c.work_item_id AND w.organization_id=r.organization_id AND w.project_id=r.project_id
   WHERE c.work_item_id=? AND c.execution_epoch=?`).get(actor.principalId,organizationId,workItemId,executionEpoch);
 });
 if (!row) return null;
 const comparison=parse(row.comparison_json,{});
 if (comparison.status!=='available') return comparison;
 const current=await weeklyReportStatus(row.responsibility_id,actor,{excludeWorkItemId:workItemId});
 if (!current.eligible || comparison.baseline.policyRevision!==current.policyRevision
     || comparison.baseline.organizationRevision!==current.organizationRevision
     || comparison.baseline.projectId!==current.baseline.projectId
     || digest(comparison.baseline.resource)!==digest(current.baseline.resource)
     || comparison.baseline.objective!==current.baseline.objective) {
  return {status:'unavailable',reason:current.reason || 'scope_changed'};
 }
 if (!await pinnedDecisionStillValid(row.responsibility_id,comparison.baseline)
     || !await verifyPinnedBaseline(comparison.baseline)) {
  return {status:'unavailable',reason:'baseline_evidence_unavailable'};
 }
 return comparison;
}
