import { getOrganization } from './organization-store.mjs';
import { read, transaction, row, activity, receipt, newId, now, digest, error } from './responsibility-store.mjs';
import { responsibilityProvider, validateProjectReportPolicy, normalizePlanCatalog } from './responsibility-providers.mjs';
import { requestResponsibilityWorkCancellation } from './work-graph.mjs';

const required = (v,name) => { if(typeof v!=='string'||!v.trim()||v.length>1024) throw error(`${name} is required`); return v.trim(); };
const parseJson = (v, fallback = null) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
function dayInTimeZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function owner(actor) { if(actor?.kind!=='user'||actor?.role!=='owner') throw error('Owner access required',403,'RESPONSIBILITY_FORBIDDEN'); return required(actor.principalId,'principalId'); }
function find(db,id,actor) { const principal=owner(actor); const r=db.prepare('SELECT r.* FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=? AND r.owner_principal_id=?').get(required(id,'id'),principal); if(!r) throw error('Responsibility not found',404,'RESPONSIBILITY_NOT_FOUND'); return r; }
function policyInput(policy) { if(!policy || typeof policy!=='object' || Array.isArray(policy)) throw error('policy is required'); if(policy.committedGitChangesOnly!==undefined&&typeof policy.committedGitChangesOnly!=='boolean') throw error('committedGitChangesOnly must be a boolean'); if(policy.committedGitChangesOnly===true&&!['generic-planner','project-report'].includes(policy.providerId)) throw error('Committed Git condition requires a project provider'); const validUntil=required(policy.validUntil,'policy.validUntil'); if(!Number.isFinite(Date.parse(validUntil))) throw error('Invalid policy expiry'); if(policy.dailyBudget!==undefined) { const b=policy.dailyBudget; if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.timeZone!=='string'||!b.timeZone.trim()||b.timeZone!==b.timeZone.trim()||Object.keys(b).some(k=>!['timeZone','maxRuns','maxTokens','maxCost'].includes(k))) throw error('Invalid dailyBudget'); try {new Intl.DateTimeFormat('en-US',{timeZone:b.timeZone}).format();} catch {throw error('Invalid dailyBudget timeZone');} const values=['maxRuns','maxTokens','maxCost'].filter(k=>b[k]!==undefined); if(!values.length || values.some(k=>!Number.isFinite(b[k])||b[k]<0||(k!=='maxCost'&&!Number.isSafeInteger(b[k])))) throw error('Invalid dailyBudget limits'); } return {policy:normalizePlanCatalog(policy),validUntil:new Date(validUntil).toISOString()}; }
function version(input,r) { if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==r.row_version) throw error('Responsibility version changed',409,'RESPONSIBILITY_CONFLICT'); }
function policyRow(db,r) { const p=db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,r.policy_revision); return p ? {...JSON.parse(p.policy_json),digest:p.policy_digest,validUntil:p.valid_until} : null; }
function responsibilityBudgetStatus(db, r, policy, workItems = []) {
  const configured = policy?.dailyBudget || null;
  const hasZones = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_responsibility_budget_zones'").get();
  const hasWindows = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_responsibility_budget_windows'").get();
  const hasCounters = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_budget_counters'").get();
  const zone = hasZones ? db.prepare('SELECT time_zone FROM organization_responsibility_budget_zones WHERE responsibility_id=?').get(r.id) : null;
  const timeZone = zone?.time_zone || configured?.timeZone || null;
  let currentDay = null;
  if (timeZone) { try { currentDay = dayInTimeZone(timeZone); } catch { currentDay = null; } }
  const windows = hasWindows
    ? db.prepare('SELECT day,time_zone,totals_json,reserved_json FROM organization_responsibility_budget_windows WHERE responsibility_id=? ORDER BY day DESC LIMIT 14').all(r.id).map(w => ({
      day: w.day,
      timeZone: w.time_zone,
      totals: parseJson(w.totals_json, { runs: 0, tokens: 0, cost: 0 }),
      reserved: parseJson(w.reserved_json, { runs: 0, tokens: 0, cost: 0 }),
    }))
    : [];
  const limits = configured ? {
    ...(configured.maxRuns !== undefined ? { runs: configured.maxRuns } : {}),
    ...(configured.maxTokens !== undefined ? { tokens: configured.maxTokens } : {}),
    ...(configured.maxCost !== undefined ? { cost: configured.maxCost } : {}),
  } : null;
  const currentRow = currentDay ? windows.find(w => w.day === currentDay) : null;
  const emptyDim = { runs: 0, tokens: 0, cost: 0 };
  const currentTotals = currentRow?.totals || emptyDim;
  const currentReserved = currentRow?.reserved || emptyDim;
  const remaining = limits ? {
    ...(limits.runs !== undefined ? { runs: Math.max(0, limits.runs - (currentTotals.runs || 0) - (currentReserved.runs || 0)) } : {}),
    ...(limits.tokens !== undefined ? { tokens: Math.max(0, limits.tokens - (currentTotals.tokens || 0) - (currentReserved.tokens || 0)) } : {}),
    ...(limits.cost !== undefined ? { cost: Math.max(0, limits.cost - (currentTotals.cost || 0) - (currentReserved.cost || 0)) } : {}),
  } : null;
  const workIds = new Set(workItems.map(w => w.id || w.workItemId));
  const unresolvedReservations = [];
  if (hasCounters) {
    const counters = db.prepare('SELECT revision,reservations_json FROM organization_budget_counters WHERE organization_id=? ORDER BY revision DESC').all(r.organization_id);
    for (const c of counters) {
      const records = parseJson(c.reservations_json, {});
      for (const entry of Object.values(records || {})) {
        if (!entry || entry.state !== 'reserved') continue;
        if (entry.responsibilityScope?.responsibilityId !== r.id && !workIds.has(entry.factoryWorkItemId)) continue;
        unresolvedReservations.push({
          reservationId: entry.reservationId,
          workItemId: entry.factoryWorkItemId || null,
          organizationRevision: c.revision,
          day: entry.responsibilityScope?.day || null,
          timeZone: entry.responsibilityScope?.timeZone || null,
          delta: entry.delta || null,
          unknownDimensions: Array.isArray(entry.unknownDimensions) ? entry.unknownDimensions : [],
          usageState: 'unknown',
          reservationRetained: true,
          createdAt: entry.createdAt || null,
        });
      }
    }
  }
  const previousDayWindow = windows.find(w => currentDay && w.day < currentDay) || null;
  return {
    schemaVersion: 1,
    configured,
    timeZone,
    currentDay,
    rolloverRule: timeZone ? `Daily window resets at 00:00 in ${timeZone}` : null,
    rolledOverFromDay: previousDayWindow?.day || null,
    limits,
    currentWindow: currentDay ? {
      day: currentDay,
      timeZone,
      totals: currentTotals,
      reserved: currentReserved,
      remaining,
      hasRecordedActivity: Boolean(currentRow),
    } : null,
    recentWindows: windows,
    unresolvedReservations,
    unknownUsageReservationCount: unresolvedReservations.length,
    costEnforcement: 'admission_estimate_only',
    hardCapAvailable: false,
    budgetBoundaryNote: 'Admission estimates reserve capacity against daily and organization windows before dispatch; they do not enforce a provider spending hard cap. Reservations without authoritative provider usage remain retained.',
  };
}
export async function createResponsibility(input,actor) {
  const principal=owner(actor), organizationId=required(input.organizationId,'organizationId'), projectId=required(input.projectId,'projectId'), objective=required(input.objective,'objective'), key=required(input.idempotencyKey,'idempotencyKey');
  if(!Array.isArray(input.successCriteria)||!input.successCriteria.every(v=>typeof v==='string'&&v.trim())) throw error('successCriteria must be an array of strings');
  const {policy,validUntil}=policyInput(input.policy); const provider=responsibilityProvider(policy);if(['project-report','generic-planner'].includes(provider.id)) validateProjectReportPolicy(policy,projectId); const intervalMs=input.intervalMs; if(intervalMs!==undefined && (!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>365*86400000)) throw error('intervalMs must be between one minute and one year'); const org=await getOrganization(organizationId); if(!org || org.projectId!==projectId || ['archived','lifecycle_pending'].includes(org.state)) throw error('Organization or project unavailable',409,'RESPONSIBILITY_CONFLICT');
  return transaction(db=>receipt(db,principal,'create',organizationId,key,input,()=>{ const current=db.prepare('SELECT project_id,state FROM organizations WHERE id=?').get(organizationId); if(!current||current.project_id!==projectId||['archived','lifecycle_pending'].includes(current.state)||owner(actor)!==principal) throw error('Organization or project changed',409,'RESPONSIBILITY_CONFLICT'); const id=newId('responsibility'), ts=now(); db.prepare('INSERT INTO responsibilities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,principal,projectId,organizationId,objective,JSON.stringify(input.successCriteria),'draft',1,1,1,null,ts,ts); db.prepare('INSERT INTO responsibility_policy_revisions VALUES(?,?,?,?,?,?)').run(id,1,JSON.stringify(policy),digest(policy),validUntil,ts); if(intervalMs!==undefined) db.prepare('INSERT INTO responsibility_subscriptions VALUES(?,?,?,?,?,1)').run(newId('subscription'),id,'interval',intervalMs,new Date(Date.now()+intervalMs).toISOString()); activity(db,id,'created',{actorId:principal}); return {responsibility:row(db.prepare('SELECT * FROM responsibilities WHERE id=?').get(id)),policy:policyRow(db,{id,policy_revision:1})}; }));
}
export async function listResponsibilities({organizationId='',projectId='',limit=100}={},actor) { const principal=owner(actor); const n=Math.max(1,Math.min(Number(limit)||100,200)); return read(db=>({schemaVersion:1,responsibilities:db.prepare('SELECT r.* FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.owner_principal_id=? AND (?=\'\' OR r.organization_id=?) AND (?=\'\' OR r.project_id=?) ORDER BY r.created_at DESC,r.id LIMIT ?').all(principal,organizationId,organizationId,projectId,projectId,n).map(row)})); }
export async function getResponsibility(id,actor) {
  return read(db=>{
    const r=find(db,id,actor), policy=policyRow(db,r), work=linkedWork(db,r);
    const workSummary=work.map(w=>{
      const blockedReason=parseJson(w.blocked_json,null);
      let stopStatus='none';
      if(blockedReason?.code==='completed_pending_review'||w.binding_status==='finished') stopStatus='completed_pending_review';
      else if(w.binding_status==='stopped'||(w.state==='cancelled'&&!w.active_binding)) stopStatus='stopped';
      else if(w.control_state==='cancel_requested') stopStatus='cancel_requested_pending';
      else if(w.control_state==='pause_requested') stopStatus='pause_requested_pending';
      else if(w.control_state==='paused') stopStatus='paused';
      const isUnknownOutcome=w.binding_status==='unknown'||w.attempt_failure_kind==='unknown_outcome'||(w.binding_status==='intent'&&!w.binding_run_id&&w.state==='blocked');
      return {workItemId:w.id,goalId:w.goal_id,kind:w.kind,state:w.state,controlState:w.control_state,blockedReason,rowVersion:w.row_version,executionEpoch:w.execution_epoch,bindingStatus:w.binding_status||null,runId:w.binding_run_id||null,attemptState:w.attempt_state||null,attemptFailureKind:w.attempt_failure_kind||null,stopStatus,isUnknownOutcome};
    });
    return {schemaVersion:1,responsibility:row(r),policy,budgetStatus:responsibilityBudgetStatus(db,r,policy,work),workSummary};
  });
}
export async function listResponsibilityWorkLinks(id,actor) {
  return read(db=>{
    const r=find(db,id,actor);
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_goals'").get()) return {schemaVersion:1,links:[]};
    const direct=db.prepare('SELECT l.*,w.mapping_json FROM responsibility_work_links l JOIN factory_goals g ON g.id=l.goal_id AND g.organization_id=? AND g.project_id=? JOIN factory_workflow_instances w ON w.id=l.workflow_instance_id AND w.goal_id=g.id AND w.organization_id=g.organization_id WHERE l.responsibility_id=? ORDER BY l.rowid').all(r.organization_id,r.project_id,id).map(l=>({wakeId:l.wake_id,decisionId:l.decision_id,goalId:l.goal_id,workflowInstanceId:l.workflow_instance_id,workItemIds:Object.values(JSON.parse(l.mapping_json)),responsibilityRevision:l.responsibility_revision,policyRevision:l.policy_revision}));
    const hasPlans=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
    if(!hasPlans) return {schemaVersion:1,links:direct};
    const planned=db.prepare('SELECT e.wake_id,e.decision_id,e.goal_id,e.workflow_instance_id,e.plan_id,e.step_id,e.approval_id,p.responsibility_revision,p.policy_revision,w.mapping_json FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id JOIN factory_goals g ON g.id=e.goal_id AND g.organization_id=? AND g.project_id=? JOIN factory_workflow_instances w ON w.id=e.workflow_instance_id AND w.goal_id=g.id AND w.organization_id=g.organization_id WHERE p.responsibility_id=? ORDER BY e.rowid').all(r.organization_id,r.project_id,id).map(e=>({wakeId:e.wake_id,decisionId:e.decision_id,planId:e.plan_id,stepId:e.step_id,approvalId:e.approval_id,goalId:e.goal_id,workflowInstanceId:e.workflow_instance_id,workItemIds:Object.values(JSON.parse(e.mapping_json)),responsibilityRevision:e.responsibility_revision,policyRevision:e.policy_revision}));
    return {schemaVersion:1,links:[...direct,...planned]};
  });
}
export async function listResponsibilityActivity(id,{after=0,limit=100}={},actor) { if(!Number.isSafeInteger(after)||after<0) throw error('Invalid activity cursor'); const n=Math.max(1,Math.min(Number(limit)||100,200)); return read(db=>{find(db,id,actor); const items=db.prepare('SELECT * FROM responsibility_activity WHERE responsibility_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id,after,n); const coalescing=db.prepare('SELECT c.subscription_id,c.count,c.first_due_at,c.last_due_at FROM responsibility_subscription_coalescing c JOIN responsibility_subscriptions s ON s.id=c.subscription_id WHERE s.responsibility_id=? ORDER BY c.subscription_id').all(id).map(x=>({subscriptionId:x.subscription_id,count:x.count,firstDueAt:x.first_due_at,lastDueAt:x.last_due_at})); return {schemaVersion:1,activity:items.map(x=>({sequence:x.sequence,responsibilityId:x.responsibility_id,type:x.type,details:JSON.parse(x.details_json),createdAt:x.created_at})),coalescing,nextCursor:items.length?items.at(-1).sequence:after};}); }
export async function updateResponsibility(id,input,actor) { const principal=owner(actor),key=required(input.idempotencyKey,'idempotencyKey'); return transaction(db=>receipt(db,principal,'update',id,key,input,()=>{const r=find(db,id,actor);version(input,r); if(!['draft','active','paused'].includes(r.lifecycle)) throw error('Responsibility is closed',409,'RESPONSIBILITY_CONFLICT'); const objective=input.objective===undefined?r.objective:required(input.objective,'objective'); const criteria=input.successCriteria===undefined?JSON.parse(r.success_criteria_json):input.successCriteria; if(!Array.isArray(criteria)||!criteria.every(v=>typeof v==='string'&&v.trim())) throw error('Invalid successCriteria'); let pr=r.policy_revision; if(input.policy!==undefined) { const p=policyInput(input.policy),provider=responsibilityProvider(p.policy);if(['project-report','generic-planner'].includes(provider.id)) validateProjectReportPolicy(p.policy,r.project_id); if(p.policy.dailyBudget?.timeZone && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_responsibility_budget_zones'").get()) { const zone=db.prepare('SELECT time_zone FROM organization_responsibility_budget_zones WHERE responsibility_id=?').get(id); if(zone && zone.time_zone!==p.policy.dailyBudget.timeZone) throw error('Changing a responsibility budget time zone requires migration',409,'RESPONSIBILITY_CONFLICT'); } pr++; db.prepare('INSERT INTO responsibility_policy_revisions VALUES(?,?,?,?,?,?)').run(id,pr,JSON.stringify(p.policy),digest(p.policy),p.validUntil,now()); } const updated=db.prepare('UPDATE responsibilities SET objective=?,success_criteria_json=?,revision=revision+1,row_version=row_version+1,policy_revision=?,updated_at=? WHERE id=? AND row_version=?').run(objective,JSON.stringify(criteria),pr,now(),id,r.row_version); if(!updated.changes) throw error('Responsibility version changed',409,'RESPONSIBILITY_CONFLICT'); activity(db,id,'updated',{actorId:principal,policyRevision:pr}); const nextRow=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(id); return {responsibility:row(nextRow),policy:policyRow(db,nextRow)};})); }
function linkedWork(db,r) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get()) return [];
  const hasPlans=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
  const goals=hasPlans?'SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=? UNION SELECT e.goal_id FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=?':'SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=?';
  const items=db.prepare(`SELECT w.id,w.goal_id,w.kind,w.state,w.control_state,w.blocked_json,w.row_version,w.contract_revision,w.execution_epoch,w.binding_generation,EXISTS(SELECT 1 FROM factory_execution_bindings b WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown')) AS active_binding FROM factory_work_items w WHERE w.organization_id=? AND w.project_id=? AND w.goal_id IN (${goals}) ORDER BY w.id`).all(...(hasPlans?[r.organization_id,r.project_id,r.id,r.id]:[r.organization_id,r.project_id,r.id]));
  return items.map(w=>{
    const b=db.prepare('SELECT status,run_id,attempt_id FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(w.id,w.contract_revision,w.execution_epoch,w.binding_generation);
    const a=b?.attempt_id?db.prepare('SELECT state,failure_kind FROM collaboration_attempts WHERE id=?').get(b.attempt_id):null;
    const link=db.prepare('SELECT wake_id,workflow_instance_id FROM responsibility_work_links WHERE responsibility_id=? AND goal_id=?').get(r.id,w.goal_id);
    const wf=link?db.prepare('SELECT template_id FROM factory_workflow_instances WHERE id=?').get(link.workflow_instance_id):null;
    const outcome=link?db.prepare('SELECT kind FROM responsibility_planning_outcomes WHERE wake_id=?').get(link.wake_id):null;
    const plan=link?db.prepare('SELECT id FROM responsibility_plans WHERE wake_id=?').get(link.wake_id):null;
    const planExecuted=plan&&hasPlans?!!db.prepare('SELECT 1 FROM responsibility_plan_executions WHERE plan_id=? LIMIT 1').get(plan.id):false;
    return {...w,binding_status:b?.status||null,binding_run_id:b?.run_id||null,attempt_state:a?.state||null,attempt_failure_kind:a?.failure_kind||null,template_id:wf?.template_id||null,planner_consumed:wf?.template_id==='ragent-responsibility-planner' && (Boolean(outcome) || planExecuted)};
  });
}
export async function setResponsibilityLifecycle(id,action,input,actor) {
  const principal=owner(actor),key=required(input.idempotencyKey,'idempotencyKey');
  if(input.stopExisting!==undefined && typeof input.stopExisting!=='boolean') throw error('stopExisting must be a boolean');
  if(input.stopExisting===true && !['pause','cancel'].includes(action)) throw error('Only pause or cancel can request stopping work');
  if(['complete','cancel','archive'].includes(action) && input.confirmed!==true) throw error('Explicit owner confirmation is required',400,'RESPONSIBILITY_CONFIRMATION_REQUIRED');
  return transaction(db=>receipt(db,principal,action,id,key,input,()=>{
    const r=find(db,id,actor);version(input,r);
    const transitions={pause:{active:'paused'},resume:{draft:'active',paused:'active'},complete:{active:'completed',paused:'completed'},cancel:{draft:'cancelled',active:'cancelled',paused:'cancelled'},archive:{draft:'archived',paused:'archived',completed:'archived',cancelled:'archived'}};
    const next=transitions[action]?.[r.lifecycle];if(!next) throw error('Invalid lifecycle transition',409,'RESPONSIBILITY_CONFLICT');
    if(action==='resume') {const p=policyRow(db,r);if(!p||!Number.isFinite(Date.parse(p.validUntil))||Date.parse(p.validUntil)<=Date.now()) throw error('Policy expired',409,'RESPONSIBILITY_CONFLICT');}
    const work=linkedWork(db,r);
    if(action==='complete'||action==='archive') {
      const blockers=work.filter(w=>{
        if(w.active_binding || ['claimed','running'].includes(w.state) || ['cancel_requested','pause_requested'].includes(w.control_state)) return true;
        if(action==='complete') {
          if(w.state==='review' && w.planner_consumed) return false;
          return !['completed','cancelled','failed'].includes(w.state);
        }
        return false;
      });
      if(blockers.length) throw Object.assign(error('Linked work must be resolved before this transition',409,'RESPONSIBILITY_WORK_PENDING'),{blockers:blockers.map(w=>({workItemId:w.id,state:w.state,controlState:w.control_state,activeBinding:!!w.active_binding}))});
    }
    const items=input.stopExisting===true?work.map(w=>{const result=requestResponsibilityWorkCancellation(db,{responsibilityId:r.id,organizationId:r.organization_id,workItemId:w.id},actor);return {...result,requestState:result.stopRequested?(w.control_state==='cancel_requested'?'already_requested':'requested'):['completed','cancelled','failed','review'].includes(w.state)?'terminal_or_review':'not_running'};}):[];
    const ts=now();
    db.prepare('UPDATE responsibilities SET lifecycle=?,revision=revision+1,row_version=row_version+1,updated_at=? WHERE id=?').run(next,ts,id);
    if(['cancel','archive','complete'].includes(action)) db.prepare("UPDATE responsibility_wakes SET state='superseded',updated_at=? WHERE responsibility_id=? AND state IN ('pending','waiting','deciding')").run(ts,id);
    const stop={requested:input.stopExisting===true,items};activity(db,id,action,{actorId:principal,stop,existingWorkStopped:false});
    return {responsibility:row(db.prepare('SELECT * FROM responsibilities WHERE id=?').get(id)),stop,existingWorkStopped:false};
  }));
}
