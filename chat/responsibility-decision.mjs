import { read, transaction, activity, activityOnce, newId, now, digest } from './responsibility-store.mjs';
import { captureResponsibilityRepository, verifyCurrentResponsibilityRepository } from './responsibility-repository.mjs';
import { isGithubFailureCurrent } from './github-ci-observer.mjs';
import { admitResponsibilityWorkflow } from './factory-responsibility-admission.mjs';
import { ensureFactorySchema } from './work-graph-store.mjs';
import { captureResponsibilityProject, verifyCurrentResponsibilityProject } from './responsibility-project.mjs';
import { responsibilityProvider, validateProjectReportPolicy } from './responsibility-providers.mjs';
import { isResponsibilityTriggerObservationCurrent } from './responsibility-trigger-bridge.mjs';
import {
  observeResponsibilityCommittedGitHead,
  observeResponsibilityWorkspaceFingerprint,
  observeExternalResourceWatermarksInTx,
  normalizeChangeObservationPolicy,
  computeCompositeObservationDigest,
} from './responsibility-git-observation.mjs';

// A deterministic CI decision is derived only from server-fetched facts and
// the immutable owner policy. Manual and interval wakes remain observations.
function assertLease(db,wakeId,lease) { const current=db.prepare('SELECT l.*,w.lease_generation FROM responsibility_wake_leases l JOIN responsibility_wakes w ON w.id=l.wake_id WHERE l.wake_id=?').get(wakeId); if(!current||current.owner_token!==lease?.ownerToken||current.generation!==lease?.generation||current.lease_generation!==lease.generation||current.expires_at<=now()) throw Object.assign(new Error('Wake lease expired or fenced'),{code:'RESPONSIBILITY_LEASE_FENCED'}); }
function hasActiveResponsibilityWork(db,id,currentWakeId) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get()) return false;
  const hasExecutions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
  const linked=db.prepare("SELECT l.wake_id,l.responsibility_revision,w.state,EXISTS(SELECT 1 FROM factory_execution_bindings b WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown')) AS active_binding FROM responsibility_work_links l JOIN factory_work_items w ON w.goal_id=l.goal_id WHERE l.responsibility_id=? AND (w.state NOT IN ('completed','cancelled','failed') OR EXISTS(SELECT 1 FROM factory_execution_bindings b WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown')))").all(id);
  const current=db.prepare('SELECT responsibility_revision FROM responsibility_wakes WHERE id=?').get(currentWakeId), observation=db.prepare('SELECT kind FROM responsibility_observations WHERE wake_id=?').get(currentWakeId);
  for(const item of linked) {
    if(item.active_binding) return true;
    if(item.state==='review') {
      if(hasExecutions && db.prepare('SELECT 1 FROM responsibility_plans p JOIN responsibility_plan_executions e ON e.plan_id=p.id WHERE p.wake_id=? LIMIT 1').get(item.wake_id)) continue;
      const outcome=db.prepare('SELECT kind,next_check_at FROM responsibility_planning_outcomes WHERE wake_id=?').get(item.wake_id);
      if(outcome?.kind==='wait' && ((Number.isFinite(Date.parse(outcome.next_check_at)) && Date.parse(outcome.next_check_at)<=Date.now())||['manual','event'].includes(observation?.kind)||current?.responsibility_revision!==item.responsibility_revision)) continue;
      if(['needs_input','invalid_output'].includes(outcome?.kind) && (['manual','event'].includes(observation?.kind)||current?.responsibility_revision!==item.responsibility_revision)) continue;
    }
    return true;
  }
  return !!(hasExecutions && db.prepare("SELECT 1 FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id JOIN factory_work_items w ON w.goal_id=e.goal_id WHERE p.responsibility_id=? AND (w.state NOT IN ('completed','cancelled','failed') OR EXISTS(SELECT 1 FROM factory_execution_bindings b WHERE b.work_item_id=w.id AND b.status IN ('intent','running','unknown'))) LIMIT 1").get(id));
}
function responsibilityHistory(db,id) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get()) return [];
  const hasExecutions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get();
  const goals=hasExecutions?"SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=? UNION SELECT e.goal_id FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id WHERE p.responsibility_id=?":"SELECT goal_id FROM responsibility_work_links WHERE responsibility_id=?";
  const sql=`SELECT id,state,control_state,blocked_json,candidate_digest FROM factory_work_items WHERE goal_id IN (${goals}) ORDER BY updated_at DESC,id LIMIT 30`;
  return db.prepare(sql).all(...(hasExecutions?[id,id]:[id])).map(row=>({workItemId:row.id,state:row.state,controlState:row.control_state,blockedCode:row.blocked_json?String(JSON.parse(row.blocked_json)?.code||'').slice(0,100):'',candidateDigest:row.candidate_digest}));
}
export async function processResponsibilityWake(wakeId,lease) {
  const snapshot=await read(db=>{assertLease(db,wakeId,lease);const wake=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId); if(!wake||!['pending','deciding'].includes(wake.state)) return null; const r=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(wake.responsibility_id); const p=r&&db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,wake.policy_revision); const e=db.prepare('SELECT e.* FROM responsibility_wake_events we JOIN responsibility_events e ON e.id=we.event_id WHERE we.wake_id=?').get(wakeId); const d=wake.decision_id&&db.prepare('SELECT * FROM responsibility_decisions WHERE id=?').get(wake.decision_id); return {wake,r,p,e,d}; });
  if(!snapshot) return;
  const {wake,r,p,e,d}=snapshot;
  const linked=await transaction(db=>{assertLease(db,wakeId,lease); const link=db.prepare('SELECT * FROM responsibility_work_links WHERE wake_id=? AND responsibility_id=?').get(wakeId,wake.responsibility_id); if(link) {db.prepare("UPDATE responsibility_wakes SET state='admitted',updated_at=? WHERE id=? AND state='deciding'").run(now(),wakeId); if(db.prepare('SELECT changes() AS count').get().count) activity(db,wake.responsibility_id,'workflow_admitted',{wakeId,decisionId:link.decision_id,goalId:link.goal_id,workflowInstanceId:link.workflow_instance_id,recovered:true});} return !!link;});
  if(linked) return;
  if(!r||r.lifecycle!=='active'||r.revision!==wake.responsibility_revision||r.policy_revision!==wake.policy_revision||!p||Date.parse(p.valid_until)<=Date.now()) return wait(wakeId,'authority_changed',lease);
  const selected=responsibilityProvider(JSON.parse(p.policy_json));
  if(['project-report','generic-planner'].includes(selected.id)) return processProjectReport(snapshot,lease);
  if(!e||e.source!=='github'||e.verification!=='github_api') return wait(wakeId,'awaiting_verified_ci_event',lease);
  if(process.env.RAGENT_FACTORY_CONTROL_ENABLED!=='true') return wait(wakeId,'factory_control_disabled',lease);
  if(process.env.RAGENT_FACTORY_SCHEDULER_ENABLED!=='1') return wait(wakeId,'factory_scheduler_disabled',lease);
  if(!String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim()) return wait(wakeId,'admission_service_unconfigured',lease);
  const active=await read(db=>{assertLease(db,wakeId,lease);return hasActiveResponsibilityWork(db,r.id,wakeId);});
  if(active) return wait(wakeId,'existing_work',lease);
  const event=JSON.parse(e.payload_json); if(!await isGithubFailureCurrent(event)) return wait(wakeId,'ci_failure_stale',lease);
  let proposal;
  if(d) {proposal=JSON.parse(d.proposal_json); await verifyCurrentResponsibilityRepository(proposal.repositoryFactId);}
  else {
    const fact=await captureResponsibilityRepository(r.project_id); const policy=JSON.parse(p.policy_json); if(fact.repository!==event.repository||policy.repository!==fact.repository||policy.targetBranch!==event.branch) return wait(wakeId,'repository_or_branch_mismatch',lease);
    if(policy.templateId!=='ragent-reviewed-change'||policy.templateVersion!==3||typeof policy.checkActionId!=='string'||!policy.checkActionId) return wait(wakeId,'verified_check_template_required',lease);
    const keys=['repository','templateId','templateVersion','templateDigest','targetBranch','allowedPaths','candidateScope','maxAttempts','maxCost','nodeBindings',...(policy.templateVersion===3?['checkActionId']:[])]; proposal=Object.fromEntries(keys.map(key=>[key,policy[key]])); proposal.repositoryFactId=fact.id;
    if(keys.some(key=>proposal[key]===undefined)) return wait(wakeId,'policy_incomplete',lease);
    const created=await transaction(db=>{assertLease(db,wakeId,lease);const current=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(r.id),w=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId); if(!current||current.lifecycle!=='active'||current.revision!==wake.responsibility_revision||current.policy_revision!==wake.policy_revision||w.state!=='pending'||w.decision_id) return null;
      ensureFactorySchema(db); if(hasActiveResponsibilityWork(db,r.id,wakeId)) return 'existing_work';
      const decisionId=newId('decision'); db.prepare('INSERT INTO responsibility_decisions VALUES(?,?,?,?,?,?,?,?,?)').run(decisionId,r.id,wakeId,r.revision,r.policy_revision,'approved',digest({event,policyRevision:r.policy_revision}),JSON.stringify(proposal),now()); db.prepare("UPDATE responsibility_wakes SET state='deciding',decision_id=?,updated_at=? WHERE id=?").run(decisionId,now(),wakeId); activity(db,r.id,'decision_approved',{wakeId,decisionId,eventId:e.id}); return decisionId; }); if(created==='existing_work') return wait(wakeId,'existing_work',lease); if(!created) return; snapshot.wake.decision_id=created;
  }
  if(process.env.RAGENT_FACTORY_CONTROL_ENABLED!=='true') return wait(wakeId,'factory_control_disabled',lease);
  const owner=String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim(); if(!owner) return wait(wakeId,'admission_service_unconfigured',lease);
  const decisionId=snapshot.wake.decision_id; const actor={kind:'service',role:'responsibility_admission',principalId:`responsibility-admission:${owner}`};
  const result=await admitResponsibilityWorkflow({...proposal,organizationId:r.organization_id,projectId:r.project_id,responsibilityId:r.id,responsibilityRevision:r.revision,policyRevision:r.policy_revision,wakeId,decisionId,wakeLeaseOwnerToken:lease.ownerToken,wakeLeaseGeneration:lease.generation,commandId:`responsibility:${decisionId}`,idempotencyKey:`responsibility:${decisionId}`},actor);
  await transaction(db=>{assertLease(db,wakeId,lease);const current=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId); if(current?.state==='deciding'&&current.decision_id===decisionId) {db.prepare("UPDATE responsibility_wakes SET state='admitted',updated_at=? WHERE id=?").run(now(),wakeId);activity(db,r.id,'workflow_admitted',{wakeId,decisionId,goalId:result.goal.id,workflowInstanceId:result.instance.id});}});
}
function findBaselineObservation(db, { responsibility, policy, catalogDigest, projectFactId, gitOnly }) {
  const candidates = db.prepare(`
    SELECT c.wake_id, c.fingerprint_digest, c.created_at
    FROM responsibility_change_observations c
    JOIN responsibility_work_links l ON l.wake_id=c.wake_id AND l.decision_id=c.decision_id
    WHERE c.responsibility_id=? AND c.responsibility_revision=? AND c.policy_revision=?
      AND c.catalog_digest=? AND c.project_fact_id=? AND c.outcome IN ('evaluated','bypassed')
      AND (
        EXISTS(SELECT 1 FROM responsibility_plans p WHERE p.wake_id=c.wake_id)
        OR EXISTS(SELECT 1 FROM responsibility_planning_outcomes o WHERE o.wake_id=c.wake_id AND o.kind IN ('wait','needs_input'))
        OR (?='project-report' AND EXISTS(SELECT 1 FROM factory_work_items w WHERE w.goal_id=l.goal_id AND w.state='completed'))
      )
      AND NOT EXISTS(SELECT 1 FROM responsibility_planning_outcomes o WHERE o.wake_id=c.wake_id AND o.kind='invalid_output')
      AND NOT EXISTS(SELECT 1 FROM factory_work_items w WHERE w.goal_id=l.goal_id AND w.state IN ('failed','cancelled'))
    ORDER BY l.rowid DESC LIMIT 1
  `).get(responsibility.id, responsibility.revision, responsibility.policy_revision, catalogDigest, projectFactId, policy.providerId);
  if (candidates) return { wakeId: candidates.wake_id, fingerprintDigest: candidates.fingerprint_digest, createdAt: candidates.created_at };
  if (gitOnly) {
    const legacy = db.prepare(`
      SELECT g.wake_id, g.observation_digest, g.created_at
      FROM responsibility_git_observations g
      JOIN responsibility_work_links l ON l.wake_id=g.wake_id AND l.decision_id=g.decision_id
      WHERE g.responsibility_id=? AND g.responsibility_revision=? AND g.policy_revision=? AND g.project_fact_id=?
        AND (
          EXISTS(SELECT 1 FROM responsibility_plans p WHERE p.wake_id=g.wake_id)
          OR EXISTS(SELECT 1 FROM responsibility_planning_outcomes o WHERE o.wake_id=g.wake_id AND o.kind IN ('wait','needs_input'))
          OR (?='project-report' AND EXISTS(SELECT 1 FROM factory_work_items w WHERE w.goal_id=l.goal_id AND w.state='completed'))
        )
      ORDER BY l.rowid DESC LIMIT 1
    `).get(responsibility.id, responsibility.revision, responsibility.policy_revision, projectFactId, policy.providerId);
    if (legacy) return { wakeId: legacy.wake_id, legacyGitDigest: legacy.observation_digest, createdAt: legacy.created_at };
  }
  return null;
}
function failureOrTerminalBypassReason(db, responsibility, baseline, currentWakeId) {
  if (!baseline) return null;
  const failedAct = db.prepare(`
    SELECT type FROM responsibility_activity
    WHERE responsibility_id=? AND created_at>? AND type IN ('execution_attempt_failed','planning_invalid_output','budget_blocked')
    LIMIT 1
  `).get(responsibility.id, baseline.createdAt);
  if (failedAct) return `recent_activity:${failedAct.type}`;
  const eventWake = db.prepare(`
    SELECT w.id FROM responsibility_wakes w
    JOIN responsibility_observations o ON o.wake_id=w.id
    WHERE w.responsibility_id=? AND w.id<>? AND w.created_at>? AND o.kind='event' AND w.state<>'superseded'
    LIMIT 1
  `).get(responsibility.id, currentWakeId, baseline.createdAt);
  if (eventWake) return 'recent_event_wake';
  const org = db.prepare('SELECT root_session_id FROM organizations WHERE id=?').get(responsibility.organization_id);
  const failedProducer = db.prepare(`
    SELECT event_key, event_type, state FROM responsibility_producer_events
    WHERE occurred_at>? AND (
      (session_id=? AND event_type='run_terminal' AND state IN ('failed','cancelled'))
      OR (organization_id=? AND (state IN ('failed','cancelled') OR event_type IN ('execution_attempt_failed','phase.gate_failed','organization.cancelled')))
    )
    LIMIT 1
  `).get(baseline.createdAt, org?.root_session_id || '', responsibility.organization_id);
  if (failedProducer) return `recent_producer_event:${failedProducer.event_type}`;
  const failedPlanExec = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get()
    ? db.prepare(`
      SELECT w.id FROM responsibility_plan_executions e
      JOIN responsibility_plans p ON p.id=e.plan_id
      JOIN factory_work_items w ON w.goal_id=e.goal_id
      WHERE p.responsibility_id=? AND p.created_at>=? AND w.state IN ('failed','cancelled')
      LIMIT 1
    `).get(responsibility.id, baseline.createdAt)
    : null;
  if (failedPlanExec) return 'recent_failed_plan_execution';
  return null;
}
async function processProjectReport(snapshot,lease) {
  const {wake,r,p,d}=snapshot, policy=JSON.parse(p.policy_json), wakeId=wake.id;
  validateProjectReportPolicy(policy,r.project_id);
  if(process.env.RAGENT_FACTORY_CONTROL_ENABLED!=='true') return wait(wakeId,'factory_control_disabled',lease);
  if(process.env.RAGENT_FACTORY_SCHEDULER_ENABLED!=='1') return wait(wakeId,'factory_scheduler_disabled',lease);
  const owner=String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim(); if(!owner) return wait(wakeId,'admission_service_unconfigured',lease);
  const observation=await read(db=>{assertLease(db,wakeId,lease);return db.prepare('SELECT * FROM responsibility_observations WHERE wake_id=?').get(wakeId);});
  if(!observation||!['manual','interval','event'].includes(observation.kind)) return wait(wakeId,'unsupported_observation',lease);
  const active=await read(db=>{assertLease(db,wakeId,lease);return hasActiveResponsibilityWork(db,r.id,wakeId);});
  if(active) return wait(wakeId,'existing_work',lease);
  let obsConfig;
  try { obsConfig = normalizeChangeObservationPolicy(policy); }
  catch (err) {
    const reason = err?.reason || 'workspace_observation_unavailable';
    await transaction(db => { assertLease(db, wakeId, lease); activityOnce(db, r.id, `workspace_obs_blocked:${wakeId}:${reason}`, 'workspace_observation_blocked', { wakeId, reason, message: err?.message || 'Invalid observation config' }); });
    return wait(wakeId, reason, lease);
  }
  const catalogDigest = digest(policy.planCatalog || null);
  const gitCondition=obsConfig.committedGitHead&&observation.kind==='interval';
  let proposal,decisionId=wake.decision_id,gitObservation=null,workspaceObservation=null;
  if(d) {proposal=JSON.parse(d.proposal_json);await verifyCurrentResponsibilityProject(proposal.projectFactId);}
  else {
    const fact=await captureResponsibilityProject(r.organization_id,r.project_id);
    if(gitCondition) {try {gitObservation=await observeResponsibilityCommittedGitHead(fact.id);}catch {return wait(wakeId,'committed_git_observation_unavailable',lease);}}
    if(obsConfig.workspaceEnabled) {
      try { workspaceObservation=await observeResponsibilityWorkspaceFingerprint(fact.id, obsConfig.workspaceOptions); }
      catch (err) {
        const reason = err?.reason === 'symlink_escape' ? 'workspace_symlink_escape' : (err?.reason || 'workspace_observation_unavailable');
        await transaction(db => { assertLease(db, wakeId, lease); activityOnce(db, r.id, `workspace_obs_blocked:${wakeId}:${reason}`, 'workspace_observation_blocked', { wakeId, reason, code: err?.code || null, message: err?.message || 'Workspace observation blocked' }); });
        return wait(wakeId, reason, lease);
      }
    }
    const keys=['providerId','providerVersion','providerDigest','templateId','templateVersion','templateDigest','resource','nodeBindings','maxAttempts','maxCost'];
    proposal=Object.fromEntries(keys.map(key=>[key,policy[key]]));Object.assign(proposal,{projectFactId:fact.id,observationId:wakeId,observationDigest:observation.payload_digest});
    if(gitObservation) proposal.gitObservationDigest=gitObservation.digest;
    if(workspaceObservation) proposal.workspaceObservationDigest=workspaceObservation.digest;
    if(policy.providerId==='generic-planner') {proposal.history=await read(db=>{assertLease(db,wakeId,lease);return responsibilityHistory(db,r.id);});proposal.historyDigest=digest(proposal.history);}
    const txOutcome=await transaction(db=>{assertLease(db,wakeId,lease);const current=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(r.id),w=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId),o=db.prepare('SELECT * FROM responsibility_observations WHERE wake_id=?').get(wakeId);if(!current||current.lifecycle!=='active'||current.revision!==wake.responsibility_revision||current.policy_revision!==wake.policy_revision||w?.state!=='pending'||w.decision_id||o?.payload_digest!==observation.payload_digest||!isResponsibilityTriggerObservationCurrent(db,current,o)) return {status:null};
      ensureFactorySchema(db);if(hasActiveResponsibilityWork(db,r.id,wakeId)) return {status:'existing_work'};if(proposal.history && digest(responsibilityHistory(db,r.id))!==proposal.historyDigest) return {status:null};
      let externalObservation=null, composite=null, bypassReason=null;
      if(obsConfig.enabled) {
        const project=db.prepare('SELECT * FROM responsibility_project_facts WHERE id=?').get(fact.id);
        if(!project||project.organization_id!==r.organization_id||project.project_id!==r.project_id) return {status:null};
        if(gitObservation && project.digest!==gitObservation.projectFactDigest) return {status:null};
        if(workspaceObservation && project.digest!==workspaceObservation.projectFactDigest) return {status:null};
        if(obsConfig.externalEnabled) {
          externalObservation=observeExternalResourceWatermarksInTx(db,r.id,obsConfig.externalOptions);
          if(!externalObservation.available) {
            activityOnce(db,r.id,`external_obs_blocked:${wakeId}:${externalObservation.reason}`,'external_observation_blocked',{wakeId,reason:externalObservation.reason,missingKeys:externalObservation.missingKeys||[]});
            return {status:'wait',reason:externalObservation.reason};
          }
          proposal.externalWatermarkDigest=externalObservation.digest;
        }
        composite=computeCompositeObservationDigest({projectFactId:fact.id,catalogDigest,gitObservation,workspaceObservation,externalObservation});
        proposal.compositeFingerprintDigest=composite.fingerprintDigest;
        if(observation.kind!=='interval') {
          bypassReason=`wake_kind_${observation.kind}`;
        } else {
          const gitOnly=obsConfig.committedGitHead&&!obsConfig.workspaceEnabled&&!obsConfig.externalEnabled;
          const baseline=findBaselineObservation(db,{responsibility:r,policy,catalogDigest,projectFactId:fact.id,gitOnly});
          if(baseline) {
            bypassReason=failureOrTerminalBypassReason(db,r,baseline,wakeId);
            const matched = baseline.fingerprintDigest
              ? baseline.fingerprintDigest===composite.fingerprintDigest
              : (gitOnly && gitObservation && baseline.legacyGitDigest===gitObservation.digest);
            if(!bypassReason && matched) {
              const ts=now();
              db.prepare("UPDATE responsibility_wakes SET state='unchanged',updated_at=? WHERE id=? AND state='pending'").run(ts,wakeId);
              db.prepare('INSERT INTO responsibility_change_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
                wakeId,r.id,r.revision,r.policy_revision,catalogDigest,null,fact.id,observation.kind,'no_change_skipped',baseline.wakeId,
                composite.fingerprintDigest,gitObservation?.digest||null,workspaceObservation?.digest||null,externalObservation?.digest||null,
                JSON.stringify({reason:'fingerprint_unchanged',wakeKind:observation.kind,baselineWakeId:baseline.wakeId,components:composite.components}),ts
              );
              activityOnce(db,r.id,`no_change_skipped:${wakeId}`,'no_change_skipped',{wakeId,baselineWakeId:baseline.wakeId,fingerprintDigest:composite.fingerprintDigest,components:composite.components});
              if(gitCondition&&gitObservation) activityOnce(db,r.id,`committed_git_unchanged:${r.revision}:${r.policy_revision}:${gitObservation.digest}`,'committed_git_unchanged',{wakeId});
              return {status:'unchanged'};
            }
          }
        }
      }
      const id=newId('decision'), ts=now();
      db.prepare('INSERT INTO responsibility_decisions VALUES(?,?,?,?,?,?,?,?,?)').run(id,r.id,wakeId,r.revision,r.policy_revision,'approved',digest({observation:observation.payload_digest,policyRevision:r.policy_revision,gitObservationDigest:gitObservation?.digest||null,compositeFingerprintDigest:composite?.fingerprintDigest||null}),JSON.stringify(proposal),ts);
      if(gitObservation) db.prepare('INSERT INTO responsibility_git_observations VALUES(?,?,?,?,?,?,?,?,?)').run(wakeId,r.id,r.revision,r.policy_revision,id,fact.id,JSON.stringify(gitObservation),gitObservation.digest,ts);
      if(composite) {
        const obsOutcome=observation.kind==='interval'&&!bypassReason?'evaluated':'bypassed';
        db.prepare('INSERT INTO responsibility_change_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          wakeId,r.id,r.revision,r.policy_revision,catalogDigest,id,fact.id,observation.kind,obsOutcome,null,
          composite.fingerprintDigest,gitObservation?.digest||null,workspaceObservation?.digest||null,externalObservation?.digest||null,
          JSON.stringify({wakeKind:observation.kind,bypassReason,components:composite.components}),ts
        );
      }
      db.prepare("UPDATE responsibility_wakes SET state='deciding',decision_id=?,updated_at=? WHERE id=?").run(id,ts,wakeId);
      activity(db,r.id,'decision_approved',{wakeId,decisionId:id,providerId:policy.providerId,...(composite?{fingerprintDigest:composite.fingerprintDigest}:{})});
      return {status:'ok',decisionId:id};
    });
    if(txOutcome.status==='unchanged') return;
    if(txOutcome.status==='wait') return wait(wakeId,txOutcome.reason,lease);
    if(txOutcome.status==='existing_work') return wait(wakeId,'existing_work',lease);
    if(txOutcome.status!=='ok') return;
    decisionId=txOutcome.decisionId;
  }
  if(gitCondition || obsConfig.workspaceEnabled) {
    let gitChanged=false, workspaceChanged=false;
    if(gitCondition) {
      let latestGit;
      try {latestGit=await observeResponsibilityCommittedGitHead(proposal.projectFactId);}catch {return wait(wakeId,'committed_git_observation_unavailable',lease);}
      if(latestGit.digest!==proposal.gitObservationDigest) gitChanged=true;
    }
    if(!gitChanged && obsConfig.workspaceEnabled) {
      let latestWs;
      try {latestWs=await observeResponsibilityWorkspaceFingerprint(proposal.projectFactId, obsConfig.workspaceOptions);}
      catch (err) {
        const reason = err?.reason === 'symlink_escape' ? 'workspace_symlink_escape' : (err?.reason || 'workspace_observation_unavailable');
        return wait(wakeId, reason, lease);
      }
      if(proposal.workspaceObservationDigest && latestWs.digest!==proposal.workspaceObservationDigest) workspaceChanged=true;
    }
    if(gitChanged || workspaceChanged) {
      await transaction(db=>{assertLease(db,wakeId,lease);const current=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId);if(current?.state==='deciding'&&current.decision_id===decisionId) {db.prepare("UPDATE responsibility_wakes SET state='superseded',updated_at=? WHERE id=?").run(now(),wakeId);if(gitChanged) activity(db,r.id,'committed_git_changed_before_admission',{wakeId,decisionId});activity(db,r.id,'observation_changed_before_admission',{wakeId,decisionId,gitChanged,workspaceChanged});}});
      return;
    }
  }
  const actor={kind:'service',role:'responsibility_admission',principalId:`responsibility-admission:${owner}`};
  const result=await admitResponsibilityWorkflow({...proposal,organizationId:r.organization_id,projectId:r.project_id,responsibilityId:r.id,responsibilityRevision:r.revision,policyRevision:r.policy_revision,wakeId,decisionId,wakeLeaseOwnerToken:lease.ownerToken,wakeLeaseGeneration:lease.generation,commandId:`responsibility:${decisionId}`,idempotencyKey:`responsibility:${decisionId}`},actor);
  await transaction(db=>{assertLease(db,wakeId,lease);const current=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId);if(current?.state==='deciding'&&current.decision_id===decisionId){db.prepare("UPDATE responsibility_wakes SET state='admitted',updated_at=? WHERE id=?").run(now(),wakeId);activity(db,r.id,'workflow_admitted',{wakeId,decisionId,goalId:result.goal.id,workflowInstanceId:result.instance.id});}});
}
async function wait(wakeId,reason,lease) { await transaction(db=>{assertLease(db,wakeId,lease);const wake=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId); if(wake&&['pending','deciding'].includes(wake.state)) {const prior=db.prepare('SELECT last_reason FROM responsibility_wake_retry WHERE wake_id=?').get(wakeId); const next=new Date(Date.now()+15*60000).toISOString(); db.prepare('INSERT INTO responsibility_wake_retry VALUES(?,?,?) ON CONFLICT(wake_id) DO UPDATE SET last_reason=excluded.last_reason,next_retry_at=excluded.next_retry_at').run(wakeId,reason,next); db.prepare("UPDATE responsibility_wakes SET state='waiting',updated_at=? WHERE id=?").run(now(),wakeId);if(prior?.last_reason!==reason) activity(db,wake.responsibility_id,'decision_waiting',{wakeId,reason,nextRetryAt:next});}}); }
export async function holdResponsibilityWake(wakeId,reason,lease) { return wait(wakeId,reason,lease); }
