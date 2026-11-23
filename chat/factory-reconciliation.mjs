import { createHash } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode, event, digest, itemRow } from './work-graph-store.mjs';
import { authorize, selectItem, required, checkVersion, update } from './work-graph.mjs';
import { findRunByRequest, getRun, getRunAcceptanceEvidence, requestRunCancel } from './runs.mjs';
import { claimPendingDispatchCommands, completeAttemptDispatch, deferAttemptDispatch } from './collaboration-store.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';
import { profileAllows } from './factory-execution-adapter.mjs';
import { releaseOrganizationBudgetReservation, settleFactoryBudget } from './organization-governor.mjs';
import { forEachStoredEvent } from './history.mjs';

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_reconciliation_failures (
    organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL,
    failures INTEGER NOT NULL, state TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
    error_code TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(organization_id,work_item_id,execution_epoch));
    CREATE TABLE IF NOT EXISTS factory_reconciliation_resume_receipts (
    command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_reconciliation_receipts (
    command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
}

// Written only in the fresh caller's terminal transition transaction, before it
// has entered any local or remote dispatch. It proves no Run was dispatched,
// not that workspace preparation left no filesystem artifacts.
function unstartedSchema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_unstarted_receipts (
 binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 contract_revision INTEGER NOT NULL, execution_epoch INTEGER NOT NULL, binding_generation INTEGER NOT NULL,
 dispatch_key TEXT NOT NULL, budget_key TEXT NOT NULL, budget_revision INTEGER NOT NULL,
 lease_owner_hash TEXT NOT NULL, lease_generation INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS factory_unstarted_no_update BEFORE UPDATE ON factory_unstarted_receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
 CREATE TRIGGER IF NOT EXISTS factory_unstarted_no_delete BEFORE DELETE ON factory_unstarted_receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;`); }
export function recordFreshUnstartedReceipt(db,info) {
 unstartedSchema(db);
 const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(info.bindingId,info.workItemId);
 const item=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(info.workItemId,info.organizationId);
 const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(info.organizationId);
 const lease=db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(info.organizationId);
 if(!binding || !item || !org || binding.status!=='intent' || binding.run_id || binding.collaboration_id || binding.attempt_id || binding.task_id
   || binding.dispatch_key!==info.dispatchKey || binding.contract_revision!==info.contractRevision || binding.execution_epoch!==info.executionEpoch
   || binding.binding_generation!==info.bindingGeneration || item.state!=='claimed' || item.contract_revision!==info.contractRevision
   || item.execution_epoch!==info.executionEpoch || item.binding_generation!==info.bindingGeneration || org.current_revision!==info.budgetRevision
   || !lease || lease.owner_token!==info.leaseOwner || lease.generation!==info.leaseGeneration
   || !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at)<=Date.now()) return false;
 if(db.prepare('SELECT 1 FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,info.dispatchKey)) return false;
 const remoteTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_factory_source_operations'").get();
 if(remoteTable && db.prepare('SELECT 1 FROM remote_factory_source_operations WHERE source_factory_binding_id=?').get(binding.id)) return false;
 let reservation;try { const row=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(info.organizationId,info.budgetRevision); reservation=JSON.parse(row?.reservations_json || '{}')[info.budgetKey]; } catch { return false; }
 if(info.budgetKey!==`factory:${binding.id}` || reservation?.state!=='reserved' || reservation.reservationId!==info.budgetKey || reservation.idempotencyKey!==info.budgetKey || reservation.factoryWorkItemId!==info.workItemId) return false;
 db.prepare(`INSERT INTO factory_unstarted_receipts (binding_id,organization_id,work_item_id,contract_revision,execution_epoch,binding_generation,dispatch_key,budget_key,budget_revision,lease_owner_hash,lease_generation,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(binding.id,info.organizationId,info.workItemId,info.contractRevision,info.executionEpoch,info.bindingGeneration,info.dispatchKey,info.budgetKey,info.budgetRevision,createHash('sha256').update(info.leaseOwner).digest('hex'),info.leaseGeneration,'fresh_local_pre_dispatch',now());
 return true;
}
export async function releaseFreshUnstartedReservation(organizationId,workItemId,executionEpoch,actor) {
 const proof=await factoryRead(db=>{
  authorize(db,organizationId,actor,'factory.read');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_unstarted_receipts'").get()) return null;
  const receipts=db.prepare('SELECT * FROM factory_unstarted_receipts WHERE organization_id=? AND work_item_id=? AND execution_epoch=? LIMIT 2').all(organizationId,workItemId,executionEpoch);
  if(receipts.length!==1) return null;
  const receipt=receipts[0];
  const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(receipt.binding_id,workItemId);
  let details;try { details=JSON.parse(binding?.details_json || '{}'); } catch { return null; }
  if(!binding || binding.status!=='failed' || binding.run_id || binding.collaboration_id || binding.attempt_id || binding.task_id
   || binding.dispatch_key!==receipt.dispatch_key || binding.contract_revision!==receipt.contract_revision || binding.execution_epoch!==receipt.execution_epoch
   || binding.binding_generation!==receipt.binding_generation || receipt.source!=='fresh_local_pre_dispatch' || receipt.budget_key!==`factory:${binding.id}`
   || details.terminalEvidenceRef!==`unstarted-receipt:${binding.id}`) return null;
  let entry;try {entry=JSON.parse(db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(organizationId,receipt.budget_revision)?.reservations_json || '{}')[receipt.budget_key];}catch{return null;}
  if(!entry || entry.factoryWorkItemId!==workItemId || entry.reservationId!==receipt.budget_key || entry.idempotencyKey!==receipt.budget_key || !['reserved','released'].includes(entry.state)) return null;
  return receipt;
 });
 if(!proof) return {state:'unavailable'};
 const result=await releaseOrganizationBudgetReservation({organizationId,revision:proof.budget_revision,reservationId:proof.budget_key,idempotencyKey:proof.budget_key,reason:'verified_fresh_local_pre_dispatch'});
 return {state:result.reservation?.state || 'unknown',replayed:result.replay===true};
}

export async function factoryReconciliationDue(organizationId,item,actor) {
  return factoryRead(db => { schema(db); authorize(db,organizationId,actor,'factory.read');
    const row=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.executionEpoch);
    return !row || row.next_attempt_at<=now(); });
}
export async function factoryReconciliationState(organizationId,item,actor) {
  return factoryRead(db => { schema(db); authorize(db,organizationId,actor,'factory.read');
    const row=db.prepare('SELECT state,next_attempt_at FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.executionEpoch);
    return { state: row?.state || 'observing', due: !row || row.next_attempt_at<=now() }; });
}
export async function recordFactoryReconciliationFailure(organizationId,item,error,actor) {
  return factoryTransaction(db => { schema(db); authorize(db,organizationId,actor,'factory.execution');
    const current=selectItem(db,organizationId,item.id); if(current.execution_epoch!==item.executionEpoch) return null;
    const previous=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.executionEpoch);
    const configured=Number(process.env.RAGENT_FACTORY_RECONCILIATION_MAX_FAILURES);
    const maxFailures=Number.isInteger(configured)&&configured>=1&&configured<=32?configured:8;
    const failures=Math.min((previous?.failures||0)+1,maxFailures), state=previous?.state==='dead_letter'||failures>=maxFailures?'dead_letter':'retry';
    const next=new Date(Date.now()+Math.min(60000,1000*2**failures)).toISOString(), ts=now();
    const code=String(error?.code||'RECONCILIATION_ERROR').slice(0,100);
    db.prepare(`INSERT INTO factory_reconciliation_failures VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,work_item_id,execution_epoch)
      DO UPDATE SET failures=excluded.failures,state=excluded.state,next_attempt_at=excluded.next_attempt_at,error_code=excluded.error_code,updated_at=excluded.updated_at`)
      .run(organizationId,item.id,item.executionEpoch,failures,state,next,code,ts);
    if(state==='dead_letter' && previous?.state!=='dead_letter') event(db,organizationId,item.id,'ReconciliationDeadLetter',{executionEpoch:item.executionEpoch,errorCode:code});
    return {failures,state,nextAttemptAt:next,errorCode:code}; });
}
export async function clearFactoryReconciliationFailure(organizationId,item,actor) {
  return factoryTransaction(db => { schema(db); authorize(db,organizationId,actor,'factory.execution');
    db.prepare("DELETE FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=? AND state<>'dead_letter'").run(organizationId,item.id,item.executionEpoch); });
}
export async function scheduleFactoryDeadLetterObservation(organizationId,item,actor) {
  return factoryTransaction(db => { schema(db); authorize(db,organizationId,actor,'factory.execution');
    db.prepare("UPDATE factory_reconciliation_failures SET next_attempt_at=?,updated_at=? WHERE organization_id=? AND work_item_id=? AND execution_epoch=? AND state='dead_letter'")
      .run(new Date(Date.now()+60000).toISOString(),now(),organizationId,item.id,item.executionEpoch); });
}
function dayInTimeZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function resolveLinkedDispatch(db, org, item, binding) {
  let collaboration = null, command = null, attempt = null, reason = 'unbound_dispatch_unavailable';
  if (!binding) return { collaboration, command, attempt, reason };
  if (binding.collaboration_id) {
    collaboration = db.prepare('SELECT * FROM collaborations WHERE id=? AND root_session_id=?').get(binding.collaboration_id, org.root_session_id);
  }
  if (!collaboration) {
    collaboration = db.prepare('SELECT * FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id, binding.dispatch_key);
  }
  const context = decode(collaboration?.policy_json, null)?.factoryExecution || null;
  if (!collaboration || !context || context.organizationId !== org.id || context.workItemId !== item.id
      || context.contractRevision !== item.contract_revision || context.executionEpoch !== item.execution_epoch
      || context.bindingGeneration !== item.binding_generation || context.dispatchKey !== binding.dispatch_key) {
    return { collaboration: null, command: null, attempt: null, reason: 'collaboration_identity_unavailable' };
  }
  const commands = db.prepare('SELECT d.*,a.state AS attempt_state,a.lifecycle_phase,a.run_id AS attempt_run,a.failure_kind AS attempt_failure_kind,a.failure_reason AS attempt_failure_reason,a.session_id AS attempt_session_id,a.attempt_number FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id JOIN collaboration_tasks t ON t.id=d.task_id AND t.collaboration_id=d.collaboration_id WHERE d.collaboration_id=? AND d.task_id=? AND a.task_id=d.task_id').all(collaboration.id, item.id);
  if (commands.length === 1 && commands[0].session_id && commands[0].request_id) {
    command = commands[0];
    reason = null;
  } else {
    reason = 'dispatch_identity_unavailable';
  }
  if (binding.attempt_id) {
    attempt = db.prepare('SELECT * FROM collaboration_attempts WHERE id=? AND task_id=?').get(binding.attempt_id, item.id);
  } else if (command) {
    attempt = db.prepare('SELECT * FROM collaboration_attempts WHERE id=? AND task_id=?').get(command.attempt_id, item.id);
  } else {
    attempt = db.prepare('SELECT * FROM collaboration_attempts WHERE task_id=? ORDER BY attempt_number DESC LIMIT 1').get(item.id);
  }
  return { collaboration, command, attempt, reason };
}

export async function getFactoryReconciliation({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const {getFactoryRuntimeStatus}=await import('./factory-runtime.mjs');
  const observing=getFactoryRuntimeStatus(organizationId).observing;
  const snapshot=await factoryRead(db => { schema(db); const org=authorize(db,organizationId,actor,'factory.read'); const item=selectItem(db,organizationId,workItemId);
    const row=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.execution_epoch);
    const lease=db.prepare('SELECT generation,expires_at FROM factory_scheduler_leases WHERE organization_id=?').get(organizationId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    const { collaboration, command, attempt, reason: dispatchReason } = resolveLinkedDispatch(db, org, item, binding);
    const reason = binding && !binding.run_id ? dispatchReason : (binding?.run_id ? null : 'unbound_dispatch_unavailable');
    const blockedReason = decode(item.blocked_json, null);
    return {
      result: {
        workItemId: item.id, executionEpoch: item.execution_epoch, rowVersion: item.row_version,
        workState: item.state, controlState: item.control_state, blockedReason,
        state: row?.state || 'observing', failures: row?.failures || 0, nextAttemptAt: row?.next_attempt_at || null, errorCode: row?.error_code || null,
        schedulerLease: lease ? { generation: lease.generation, expiresAt: lease.expires_at } : null,
        observationContinues: observing,
        binding: binding ? {
          id: binding.id, status: binding.status, runId: binding.run_id || null,
          attemptId: binding.attempt_id || null, collaborationId: binding.collaboration_id || null,
          contractRevision: binding.contract_revision, executionEpoch: binding.execution_epoch, bindingGeneration: binding.binding_generation,
        } : null,
        attempt: attempt ? {
          id: attempt.id, state: attempt.state, failureKind: attempt.failure_kind || null,
          failureReason: attempt.failure_reason || null, runId: attempt.run_id || null,
        } : null,
      },
      binding, collaboration, command, attempt, reason,
    };
  });
  let observation={state:'unknown',reason:snapshot.reason || 'run_evidence_unavailable',observedAt:now()};
  let observedRun = null;
  if(snapshot.binding && ['intent','unknown'].includes(snapshot.binding.status) && !snapshot.binding.run_id && snapshot.command) {
    try {
      const command=snapshot.command, run=await findRunByRequest(command.session_id,command.request_id);
      if(run && run.sessionId===command.session_id && run.requestId===command.request_id
          && (!command.run_id || command.run_id===run.id) && (!command.attempt_run || command.attempt_run===run.id)) {
        observedRun = run;
        observation={state:'found',expectedRunId:run.id,runState:run.state,cancelRequested:run.cancelRequested===true,finalizedAt:run.finalizedAt||null,publicationAvailable:Boolean(run.runPublication),dispatchState:command.state,attemptState:command.attempt_state,attemptFailureKind:command.attempt_failure_kind||null,observedAt:now()};
      }
    } catch { observation.reason='run_evidence_unavailable'; }
  } else {
    const knownRunId = snapshot.binding?.run_id || snapshot.attempt?.run_id || snapshot.command?.run_id || null;
    if (knownRunId) {
      try {
        observedRun = await getRunAcceptanceEvidence(knownRunId).catch(() => null) || await getRun(knownRunId);
        if (observedRun && observedRun.id === knownRunId) {
          observation = {
            state: 'bound_run_observed', expectedRunId: observedRun.id, runState: observedRun.state,
            cancelRequested: observedRun.cancelRequested === true, finalizedAt: observedRun.finalizedAt || null,
            publicationAvailable: Boolean(observedRun.runPublication),
            dispatchState: snapshot.command?.state || null, attemptState: snapshot.attempt?.state || null,
            attemptFailureKind: snapshot.attempt?.failure_kind || null, observedAt: now(),
          };
        } else {
          observation = { state: 'bound_run_unavailable', expectedRunId: knownRunId, reason: 'run_evidence_unavailable', observedAt: now() };
        }
      } catch {
        observation = { state: 'bound_run_unavailable', expectedRunId: knownRunId, reason: 'run_evidence_unavailable', observedAt: now() };
      }
    }
  }
  const r = snapshot.result;
  let stopStatus = 'none';
  if (observedRun?.state === 'completed') stopStatus = 'completed_before_stop';
  else if (r.blockedReason?.code === 'completed_pending_review' || r.binding?.status === 'finished') stopStatus = 'completed_pending_review';
  else if (r.binding?.status === 'stopped' || (r.workState === 'cancelled' && r.binding?.status !== 'unknown')) stopStatus = 'stopped';
  else if (r.controlState === 'cancel_requested') stopStatus = 'cancel_requested_pending';
  else if (r.controlState === 'pause_requested') stopStatus = 'pause_requested_pending';
  else if (r.controlState === 'paused') stopStatus = 'paused';
  const isUnknown = r.binding?.status === 'unknown'
    || r.attempt?.failureKind === 'unknown_outcome'
    || (r.binding?.status === 'intent' && !r.binding?.runId && (r.workState === 'blocked' || r.state === 'dead_letter' || r.failures > 0 || ['cancelled','blocked'].includes(snapshot.command?.state)))
    || String(r.blockedReason?.code || '').endsWith('_unknown');
  const canVerifyAcceptedRun = Boolean(snapshot.binding && ['intent','unknown'].includes(snapshot.binding.status) && !snapshot.binding.run_id && observation.state === 'found');
  const activeBinding = Boolean(snapshot.binding && ['intent','running','unknown'].includes(snapshot.binding.status));
  const canResolveExplicitly = Boolean(activeBinding && (isUnknown || (r.binding?.status === 'running' && ['cancel_requested','pause_requested'].includes(r.controlState))));
  // Only Run-bound completion deliveries are associated here. Connector ledger
  // entries without a durable Run link cannot be attributed to this work item.
  let externalOutcomes={state:'unavailable',entries:[]};
  if (observedRun?.runPublication && snapshot.binding?.run_id===observedRun.id
      && snapshot.attempt?.session_id===observedRun.sessionId) {
    const targets=observedRun.completionTargets;
    const entries=targets && typeof targets==='object' && !Array.isArray(targets)
      ? Object.entries(targets).slice(0,20).map(([targetId,value])=>({
        targetId,state:value?.state || 'unknown',safeToRetry:value?.state==='failed' && value?.safeToRetry===true && !value?.providerInvokedAt,
        providerInvokedAt:value?.providerInvokedAt || null,deliveredAt:value?.deliveredAt || null,
        providerReceipt:value?.state==='sent' && value.delivery
          && (value.delivery.responseId || Number.isInteger(value.delivery.statusCode)) ? {
          provider:value.delivery.provider || null,statusCode:value.delivery.statusCode ?? null,
          responseId:value.delivery.responseId || null,
        }:null,
        manualReviews:Array.isArray(value?.manualReviews) ? value.manualReviews.slice(-20).map(review=>({
          observation:review.observation,source:'human',actorId:review.actorId,
          evidence:review.evidence,reviewedAt:review.reviewedAt,
        })) : [],
      })) : [];
    externalOutcomes={state:'observed',entries,truncated:targets && typeof targets==='object' && Object.keys(targets).length>20};
  }
  return {
    ...r,
    externalOutcomes,
    stopConfirmed: stopStatus === 'stopped',
    stopStatus,
    unknownOutcome: {
      isUnknown,
      reason: isUnknown ? (r.blockedReason?.code || r.attempt?.failureKind || r.errorCode || observation.reason || 'unknown_outcome') : null,
      autoRedispatchForbidden: true,
      resolutionRequired: isUnknown,
      canVerifyAcceptedRun,
      canResolveExplicitly,
    },
    acceptedRunObservation: {
      ...observation,
      requiresVerification: Boolean(canVerifyAcceptedRun || (snapshot.binding && ['intent','unknown'].includes(snapshot.binding.status))),
      crossStoreAtomic: false,
      requestIndexMayRepair: true,
    },
  };
}

export async function getFactoryBudgetObservation({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  return factoryRead(db=>{
    authorize(db,organizationId,actor,'factory.read');
    const row=selectItem(db,organizationId,workItemId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(row.id,row.contract_revision,row.execution_epoch,row.binding_generation);
    const empty={state:'not_found',reserved:null,actualUsage:null,createdAt:null,settledAt:null,releasedAt:null,releaseReason:null,window:null};
    let reservation=empty, scopeMeta=null;
    if(binding) {
      const contract=db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(row.id,row.contract_revision);
      let body;try {body=JSON.parse(contract?.contract_json||'null');} catch {body=null;}
      const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_budget_counters'").get();
      if(!body || !Number.isSafeInteger(body.organizationRevision) || !exists) reservation={...empty,state:'unavailable'};
      else {
        const counter=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(organizationId,body.organizationRevision);
        try {
          const records=counter?JSON.parse(counter.reservations_json):null, entry=records?.[`factory:${binding.id}`];
          if(entry) {
            if(!['reserved','settled','released'].includes(entry.state) || entry.factoryWorkItemId!==row.id) reservation={...empty,state:'unavailable'};
            else {
              scopeMeta = entry.responsibilityScope || null;
              reservation={
                state:entry.state, reserved:entry.delta||null,
                actualUsage:entry.state==='settled'?(entry.usage||null):null,
                createdAt:entry.createdAt||null, settledAt:entry.settledAt||null,
                releasedAt:entry.state==='released'?(entry.releasedAt||null):null,
                releaseReason:entry.state==='released'?(entry.releaseReason||null):null,
                unknownDimensions:Array.isArray(entry.unknownDimensions)?entry.unknownDimensions:undefined,
                window:entry.responsibilityScope?{responsibilityId:entry.responsibilityScope.responsibilityId,day:entry.responsibilityScope.day,timeZone:entry.responsibilityScope.timeZone}:null,
              };
            }
          }
        } catch {reservation={...empty,state:'unavailable'};}
      }
    }
    let responsibilityId = scopeMeta?.responsibilityId || null;
    if (!responsibilityId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_work_links'").get()) {
      const direct = db.prepare('SELECT responsibility_id FROM responsibility_work_links WHERE goal_id=?').get(row.goal_id);
      responsibilityId = direct?.responsibility_id || null;
    }
    if (!responsibilityId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_plan_executions'").get()) {
      const planned = db.prepare('SELECT p.responsibility_id FROM responsibility_plan_executions e JOIN responsibility_plans p ON p.id=e.plan_id WHERE e.goal_id=?').get(row.goal_id);
      responsibilityId = planned?.responsibility_id || null;
    }
    let windowDetail = null;
    if (responsibilityId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibilities'").get()) {
      const resp = db.prepare('SELECT policy_revision FROM responsibilities WHERE id=?').get(responsibilityId);
      const polRow = resp && db.prepare('SELECT policy_json FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(responsibilityId, resp.policy_revision);
      const dailyBudget = decode(polRow?.policy_json, null)?.dailyBudget || null;
      const hasZones = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_responsibility_budget_zones'").get();
      const zone = hasZones ? db.prepare('SELECT time_zone FROM organization_responsibility_budget_zones WHERE responsibility_id=?').get(responsibilityId) : null;
      const timeZone = scopeMeta?.timeZone || zone?.time_zone || dailyBudget?.timeZone || null;
      let currentDay = null;
      if (timeZone) { try { currentDay = dayInTimeZone(timeZone); } catch { currentDay = null; } }
      const windowDay = scopeMeta?.day || currentDay;
      const hasWindows = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_responsibility_budget_windows'").get();
      const wRow = (hasWindows && windowDay)
        ? db.prepare('SELECT totals_json,reserved_json FROM organization_responsibility_budget_windows WHERE responsibility_id=? AND day=?').get(responsibilityId, windowDay)
        : null;
      windowDetail = {
        responsibilityId,
        timeZone,
        windowDay,
        currentDay,
        rolledOver: Boolean(windowDay && currentDay && windowDay !== currentDay),
        limits: dailyBudget ? {
          ...(dailyBudget.maxRuns !== undefined ? { runs: dailyBudget.maxRuns } : {}),
          ...(dailyBudget.maxTokens !== undefined ? { tokens: dailyBudget.maxTokens } : {}),
          ...(dailyBudget.maxCost !== undefined ? { cost: dailyBudget.maxCost } : {}),
        } : null,
        totals: decode(wRow?.totals_json, { runs: 0, tokens: 0, cost: 0 }),
        reserved: decode(wRow?.reserved_json, { runs: 0, tokens: 0, cost: 0 }),
      };
    }
    return {
      schemaVersion:1, workItemId:row.id, executionEpoch:row.execution_epoch, bindingId:binding?.id||null, reservation,
      usageState:reservation.state==='settled' && reservation.actualUsage?'actual':'unknown',
      reservationRetained: reservation.state==='reserved',
      windowDetail,
      costEnforcement:'admission_estimate_only', hardCapAvailable:false,
      budgetBoundary: {
        mode: 'admission_estimate_only',
        hardCapAvailable: false,
        unknownUsageRetainsReservation: true,
        note: 'Admission estimates reserve budget before dispatch; they do not enforce a provider spending hard cap. Reservations without authoritative provider usage remain retained.',
      },
      asOf:now(),
    };
  });
}

// Positive Run evidence only. An index miss or an unavailable/expired outbox
// claim remains unknown and never triggers a send or a new dispatch identity.
export async function verifyFactoryAcceptedRun(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  required(input?.expectedRunId,'expectedRunId');
  return reconcileAcceptedRun(input,actor,false);
}

// Scheduler may adopt positive acceptance evidence only; this function never
// sends a message and cannot turn an index miss into permission to retry.
export async function reconcileFactoryAcceptedRunAutomatically(input,actor) {
  if(actor?.kind!=='service'||actor.role!=='factory_scheduler') throw factoryError('FACTORY_FORBIDDEN','Scheduler service required',403);
  return reconcileAcceptedRun(input,actor,true);
}
async function reconcileAcceptedRun(input,actor,automatic) {
  const organizationId=required(input?.organizationId,'organizationId'), workItemId=required(input?.workItemId,'workItemId');
  const expectedRunId=automatic?null:input.expectedRunId;
  function snapshot(db) {
    const org=authorize(db,organizationId,actor,'factory.execution'), item=selectItem(db,organizationId,workItemId);
    checkVersion(item,input.expectedVersion);
    if(item.execution_epoch!==input.executionEpoch) throw factoryError('FACTORY_CONFLICT','Execution epoch changed');
    const lease=db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(organizationId);
    if(automatic && (!lease || !Number.isSafeInteger(input.leaseGeneration) || lease.generation!==input.leaseGeneration || lease.expires_at<=now() || lease.owner_token!==input.leaseOwnerToken)) throw factoryError('FACTORY_CONFLICT','Scheduler lease expired or changed');
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    if(!binding || !['intent','unknown'].includes(binding.status) || binding.run_id) throw factoryError('FACTORY_CONFLICT','Unbound dispatch intent required');
    const collaboration=db.prepare('SELECT * FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,binding.dispatch_key);
    let context; try { context=JSON.parse(collaboration?.policy_json || '{}').factoryExecution; } catch { context=null; }
    if(!collaboration || !context || context.organizationId!==organizationId || context.workItemId!==item.id || context.contractRevision!==item.contract_revision || context.executionEpoch!==item.execution_epoch || context.bindingGeneration!==item.binding_generation || context.dispatchKey!==binding.dispatch_key) throw factoryError('FACTORY_CONFLICT','Persisted dispatch identity differs');
    const commands=db.prepare('SELECT d.*,a.state AS attempt_state,a.lifecycle_phase,a.run_id AS attempt_run,a.failure_kind AS attempt_failure_kind,a.attempt_number,t.current_attempt FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id JOIN collaboration_tasks t ON t.id=d.task_id AND t.collaboration_id=d.collaboration_id WHERE d.collaboration_id=? AND d.task_id=? AND a.task_id=d.task_id').all(collaboration.id,item.id);
    if(commands.length!==1) throw factoryError('FACTORY_CONFLICT','Exactly one durable dispatch command required');
    const command=commands[0];
    if(!command.session_id || !command.request_id || (expectedRunId && ((command.run_id && command.run_id!==expectedRunId) || (command.attempt_run && command.attempt_run!==expectedRunId)))) throw factoryError('FACTORY_CONFLICT','Dispatch command identity changed');
    if(automatic) {
      if(item.ownership!=='active'||item.control_state!=='none'||!['claimed','blocked'].includes(item.state)||['archived','lifecycle_pending'].includes(org.state)) throw factoryError('FACTORY_CONFLICT','Recovery is not authorized');
      const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assignee_node_id,organizationId);
      const contract=db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision);
      const body=JSON.parse(contract?.contract_json||'{}'), grant=JSON.parse(node?.grant_json||'{}');
      if(!node||node.retired_revision!==null||node.binding_generation!==item.binding_generation||node.current_session_id!==context.managedSessionId||body.organizationRevision!==org.current_revision||!profileAllows(db,org,node)) throw factoryError('FACTORY_CONFLICT','Recovery node or contract changed');
      const paths=body.accessMode==='read'?[]:(Array.isArray(body.allowedPaths)?body.allowedPaths:[]), within=(path,root)=>path===root||path.startsWith(`${root}/`);
      if(paths.length&&(grant.canWrite!==true||!Array.isArray(grant.writablePaths)||paths.some(path=>!grant.writablePaths.some(root=>within(path,root))))) throw factoryError('FACTORY_CONFLICT','Recovery write grant changed');
      for(const capability of paths.length?['run','write']:['run']) {const g=db.prepare('SELECT allow,scope_json FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(organizationId,node.id,capability,org.current_revision),scope=JSON.parse(g?.scope_json||'{}');if(!g?.allow||(scope.projectId&&scope.projectId!==item.project_id)||Object.keys(scope).some(key=>!['projectId','writablePaths'].includes(key))||(capability==='write'&&Array.isArray(scope.writablePaths)&&paths.some(path=>!scope.writablePaths.some(root=>within(path,root))))) throw factoryError('FACTORY_CONFLICT','Recovery grant changed');}
      const identity=db.prepare('SELECT session_id,tool FROM factory_binding_runtime_identity WHERE binding_id=?').get(binding.id);
      const counter=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(organizationId,body.organizationRevision);
      const reservation=JSON.parse(counter?.reservations_json||'{}')[context.budgetKey];
      if(!identity||identity.session_id!==node.current_session_id||identity.tool!==context.runtimeTool||context.budgetKey!==`factory:${binding.id}`||reservation?.state!=='reserved'||reservation.factoryWorkItemId!==item.id) throw factoryError('FACTORY_CONFLICT','Recovery runtime or budget changed');
      verifyFactoryResponsibilityFence(db,item);
    }
    return {item,binding,collaboration,command,leaseOwner:lease?.owner_token||null};
  }
  const observed=await factoryRead(snapshot);
  const run=await findRunByRequest(observed.command.session_id,observed.command.request_id);
  if(!run || (expectedRunId && run.id!==expectedRunId) || run.sessionId!==observed.command.session_id || run.requestId!==observed.command.request_id) return {state:'unknown',reason:'run_evidence_unavailable'};
  if(observed.command.state==='completed') {
    const current=await factoryRead(snapshot);
    if((automatic && current.leaseOwner!==observed.leaseOwner) || current.binding.id!==observed.binding.id
        || current.collaboration.id!==observed.collaboration.id || current.command.id!==observed.command.id
        || current.command.session_id!==run.sessionId || current.command.request_id!==run.requestId || current.command.attempt_id!==observed.command.attempt_id
        || current.command.state!=='completed' || current.command.run_id!==run.id || current.command.attempt_run!==run.id) throw factoryError('FACTORY_CONFLICT','Recovery identity or lease changed');
    return {state:'accepted',runId:run.id,replayed:true};
  }
  let claimed=await claimPendingDispatchCommands({collaborationId:observed.collaboration.id,commandId:observed.command.id,limit:1});
  if(claimed.length===0 && observed.command.state==='pending' && !observed.command.claim_token
      && observed.command.attempt_state==='running' && observed.command.lifecycle_phase==='dispatching') {
    const cleared=await factoryTransaction(db=>{
      const current=snapshot(db);
      if((automatic && current.leaseOwner!==observed.leaseOwner) || current.binding.id!==observed.binding.id
          || current.collaboration.id!==observed.collaboration.id || current.command.id!==observed.command.id
          || current.command.state!=='pending' || current.command.claim_token
          || current.command.attempt_state!=='running' || current.command.lifecycle_phase!=='dispatching'
          || current.command.run_id || current.command.attempt_run) return false;
      const ts=now();
      return db.prepare("UPDATE collaboration_dispatch_commands SET available_at=?,updated_at=? WHERE id=? AND state='pending' AND claim_token IS NULL AND available_at>?").run(ts,ts,current.command.id,ts).changes===1;
    });
    if(cleared) claimed=await claimPendingDispatchCommands({collaborationId:observed.collaboration.id,commandId:observed.command.id,limit:1});
  }
  if(claimed.length===1) {
    const claim=claimed[0];
    const bound=await completeAttemptDispatch(claim.id,{claimToken:claim.claimToken,runId:run.id,verify:({db,command,attempt})=>{
      try { const current=snapshot(db); return (!automatic || current.leaseOwner===observed.leaseOwner) && current.binding.id===observed.binding.id
        && current.collaboration.id===observed.collaboration.id && command.id===observed.command.id
        && command.state==='claimed' && command.claim_token===claim.claimToken && command.lease_until && command.lease_until>now()
        && command.session_id===run.sessionId && command.request_id===run.requestId && attempt.id===command.attempt_id && attempt.task_id===workItemId; }
      catch { return false; }
    }});
    if(!bound) { if(!automatic) await deferAttemptDispatch(claim.id,{claimToken:claim.claimToken,reason:'Owner verification fenced'}); return {state:'unknown',reason:'recovery_fenced'}; }
    await factoryTransaction(db=>{authorize(db,organizationId,actor,'factory.read');event(db,organizationId,workItemId,'AcceptedRunVerified',{executionEpoch:input.executionEpoch,runId:run.id,actorId:actor.principalId});});
    return {state:'accepted',runId:run.id,replayed:false};
  }
  if(['cancelled','blocked'].includes(observed.command.state) && observed.command.attempt_state==='failed'
      && observed.command.attempt_failure_kind==='unknown_outcome' && !observed.command.run_id && !observed.command.attempt_run) {
    const linked=await factoryTransaction(db=>{
      const current=snapshot(db);
      if((automatic && current.leaseOwner!==observed.leaseOwner) || current.binding.id!==observed.binding.id
          || current.collaboration.id!==observed.collaboration.id || current.command.id!==observed.command.id
          || current.command.state!==observed.command.state || current.command.run_id || current.command.attempt_run
          || current.command.attempt_state!=='failed' || current.command.attempt_failure_kind!=='unknown_outcome'
          || Number(current.command.current_attempt)!==Number(current.command.attempt_number)) return false;
      const ts=now();
      const cmdChanges=db.prepare("UPDATE collaboration_dispatch_commands SET run_id=?,updated_at=? WHERE id=? AND (run_id IS NULL OR run_id='')").run(run.id,ts,current.command.id).changes;
      const attChanges=db.prepare("UPDATE collaboration_attempts SET session_id=COALESCE(NULLIF(?,''),session_id),run_id=?,updated_at=? WHERE id=? AND state='failed' AND failure_kind='unknown_outcome' AND (run_id IS NULL OR run_id='')").run(run.sessionId,run.id,ts,current.command.attempt_id).changes;
      if(cmdChanges!==1 || attChanges!==1) throw factoryError('FACTORY_CONFLICT','Dispatch recovery raced');
      db.prepare("UPDATE collaboration_tasks SET session_id=COALESCE(NULLIF(?,''),session_id),run_id=?,updated_at=? WHERE id=? AND (run_id IS NULL OR run_id='')").run(run.sessionId,run.id,ts,workItemId);
      db.prepare('INSERT INTO collaboration_events (collaboration_id,type,task_id,attempt_id,payload_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(current.collaboration.id,'attempt_run_reconciled',workItemId,current.command.attempt_id,encode({commandId:current.command.id,runId:run.id,sessionId:run.sessionId,actorId:actor.principalId}),ts);
      event(db,organizationId,workItemId,'AcceptedRunVerified',{executionEpoch:input.executionEpoch,runId:run.id,actorId:actor.principalId,recoveredUnknownOutcomeRunLink:true});
      return true;
    });
    if(!linked) return {state:'unknown',reason:'recovery_fenced'};
    return {state:'accepted',runId:run.id,replayed:false,recoveredUnknownOutcomeRunLink:true};
  }
  return {state:'unknown',reason:'dispatch_claim_unavailable'};
}
// This command only requests another observation; it cannot assert a Run state,
// release a budget reservation, or adopt an old dispatch intent.
export async function requestFactoryReconciliation(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const outcome=await factoryTransaction(db => { schema(db); const org=required(input?.organizationId,'organizationId'); authorize(db,org,actor,'factory.read');
    const item=selectItem(db,org,required(input.workItemId,'workItemId')), commandId=required(input.commandId,'commandId');
    const prior=db.prepare('SELECT * FROM factory_reconciliation_receipts WHERE command_id=?').get(commandId);
    if(prior) { if(prior.organization_id!==org||prior.work_item_id!==item.id||prior.execution_epoch!==input.executionEpoch||prior.actor_id!==actor.principalId) throw factoryError('FACTORY_CONFLICT','Command identity conflicts'); return {requested:true,replayed:true}; }
    checkVersion(item,input.expectedVersion); if(item.execution_epoch!==input.executionEpoch) throw factoryError('FACTORY_CONFLICT','Execution epoch changed');
    db.prepare('UPDATE factory_reconciliation_failures SET next_attempt_at=?,updated_at=? WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').run(now(),now(),org,item.id,item.execution_epoch);
    db.prepare('INSERT INTO factory_reconciliation_receipts VALUES(?,?,?,?,?,?)').run(commandId,org,item.id,item.execution_epoch,actor.principalId,now());
    event(db,org,item.id,'ReconciliationRequested',{executionEpoch:item.execution_epoch,actorId:actor.principalId,commandId}); return {requested:true,replayed:false}; });
  let unstartedBudget; try { unstartedBudget=await releaseFreshUnstartedReservation(input.organizationId,input.workItemId,input.executionEpoch,actor); }
  catch { unstartedBudget={state:'pending',reason:'release_unavailable'}; }
  return {...outcome,unstartedBudget};
}

// Recovery is separate from an observation request and requires an owner.
export async function resumeFactoryReconciliation(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  return factoryTransaction(db => { schema(db); const org=required(input?.organizationId,'organizationId'); authorize(db,org,actor,'factory.execution');
    const item=selectItem(db,org,required(input.workItemId,'workItemId')), commandId=required(input.commandId,'commandId');
    const prior=db.prepare('SELECT * FROM factory_reconciliation_resume_receipts WHERE command_id=?').get(commandId);
    if(prior) { if(prior.organization_id!==org||prior.work_item_id!==item.id||prior.execution_epoch!==input.executionEpoch||prior.actor_id!==actor.principalId) throw factoryError('FACTORY_CONFLICT','Command identity conflicts'); return {resumed:true,replayed:true}; }
    checkVersion(item,input.expectedVersion); if(item.execution_epoch!==input.executionEpoch) throw factoryError('FACTORY_CONFLICT','Execution epoch changed');
    const removed=db.prepare("DELETE FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=? AND state='dead_letter'").run(org,item.id,item.execution_epoch);
    if(!removed.changes) throw factoryError('FACTORY_CONFLICT','Work is not dead-lettered');
    db.prepare('INSERT INTO factory_reconciliation_resume_receipts VALUES(?,?,?,?,?,?)').run(commandId,org,item.id,item.execution_epoch,actor.principalId,now());
    event(db,org,item.id,'ReconciliationResumed',{executionEpoch:item.execution_epoch,actorId:actor.principalId,commandId}); return {resumed:true}; });
}

// Explicit owner-only resolution for unknown_outcome / unverified execution
// bindings. Never auto-redispatches, preserves audit trail & unknown-usage
// budget reservations, and never mislabels cancel_requested as stopped or a
// completed Run as cancelled.
export async function resolveFactoryUnknownOutcome(input, actor) {
  if (actor?.kind !== 'user' || actor.role !== 'owner' || !actor.principalId) {
    throw factoryError('FACTORY_FORBIDDEN', 'Owner access required', 403);
  }
  const organizationId = required(input?.organizationId, 'organizationId');
  const workItemId = required(input?.workItemId, 'workItemId');
  const commandId = required(input?.commandId, 'commandId');
  const key = required(input?.idempotencyKey || commandId, 'idempotencyKey');
  const resolution = required(input?.resolution, 'resolution');
  if (!['adopt_run_outcome', 'confirm_finished', 'confirm_stopped', 'confirm_failed'].includes(resolution)) {
    throw factoryError('FACTORY_INVALID', 'Unsupported reconciliation resolution', 400);
  }
  if (input?.confirmed !== true) {
    throw factoryError('FACTORY_CONFIRMATION_REQUIRED', 'Explicit owner confirmation is required', 400);
  }
  const rationale = typeof input?.rationale === 'string' ? input.rationale.trim() : '';
  if (!rationale || rationale.length > 2000) {
    throw factoryError('FACTORY_INVALID', 'Resolution rationale is required (max 2000 characters)', 400);
  }
  if (!Number.isInteger(input?.expectedVersion) || !Number.isInteger(input?.executionEpoch)) {
    throw factoryError('FACTORY_INVALID', 'expectedVersion and executionEpoch are required', 400);
  }
  const payloadDigest = digest({
    organizationId, workItemId, expectedVersion: input.expectedVersion,
    executionEpoch: input.executionEpoch, resolution, rationale,
  });

  const preflight = await factoryRead(db => {
    schema(db);
    const org = authorize(db, organizationId, actor, 'factory.execution');
    const prior = db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?')
      .get(actor.principalId, 'ResolveUnknownOutcome', workItemId, key);
    if (prior) {
      if (prior.payload_digest !== payloadDigest) throw factoryError('FACTORY_CONFLICT', 'Resolution idempotency key reused with different inputs');
      return { replayResult: { ...decode(prior.result_json, {}), replayed: true } };
    }
    if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) {
      throw factoryError('FACTORY_CONFLICT', 'Command ID already used');
    }
    const item = selectItem(db, organizationId, workItemId);
    checkVersion(item, input.expectedVersion);
    if (item.execution_epoch !== input.executionEpoch) throw factoryError('FACTORY_CONFLICT', 'Execution epoch changed');
    if (item.ownership !== 'active') throw factoryError('FACTORY_CONFLICT', 'Legacy and shadow items are read-only projections');
    const binding = db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?')
      .get(item.id, item.contract_revision, item.execution_epoch, item.binding_generation);
    if (!binding || !['intent', 'running', 'unknown'].includes(binding.status)) {
      throw factoryError('FACTORY_CONFLICT', 'Active or unknown execution binding is required');
    }
    if (db.prepare("SELECT 1 FROM factory_execution_bindings WHERE work_item_id=? AND id<>? AND status IN ('intent','running','unknown') LIMIT 1").get(item.id, binding.id)) {
      throw factoryError('FACTORY_CONFLICT', 'Another execution binding remains unresolved');
    }
    const { collaboration, command, attempt } = resolveLinkedDispatch(db, org, item, binding);
    const isUnknownOrPending = binding.status === 'unknown'
      || attempt?.failure_kind === 'unknown_outcome'
      || (binding.status === 'intent' && !binding.run_id)
      || ['cancel_requested', 'pause_requested'].includes(item.control_state)
      || item.state === 'blocked';
    if (!isUnknownOrPending) {
      throw factoryError('FACTORY_CONFLICT', 'Work item is not in an unknown or reconcilable state');
    }
    const contractRow = db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?')
      .get(item.id, item.contract_revision);
    const contract = decode(contractRow?.contract_json, {});
    return { org, item, binding, collaboration, command, attempt, contract };
  });
  if (preflight.replayResult) return preflight.replayResult;

  const { binding, collaboration, command, attempt, contract, item } = preflight;
  const knownRunId = binding.run_id || attempt?.run_id || command?.run_id || null;
  let run = null;
  if (knownRunId) {
    run = await getRunAcceptanceEvidence(knownRunId).catch(() => null) || await getRun(knownRunId).catch(() => null);
  } else if (command?.session_id && command?.request_id) {
    const found = await findRunByRequest(command.session_id, command.request_id).catch(() => null);
    if (found && found.sessionId === command.session_id && found.requestId === command.request_id) run = found;
  }

  let bindingStatus, itemState, controlState, blockedObj = null;
  if (run) {
    if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
      if (item.control_state === 'cancel_requested' && !run.cancelRequested) {
        await requestRunCancel(run.id).catch(() => {});
      }
      throw factoryError('FACTORY_CONFLICT', 'Run is still active on disk; cancellation requested where applicable, cannot mark stopped or terminal yet');
    }
    if (run.state === 'completed') {
      if (resolution === 'confirm_stopped' || resolution === 'confirm_failed') {
        throw factoryError('FACTORY_CONFLICT', 'Run completed before stopping; a completed Run cannot be resolved as cancelled or failed');
      }
      if (!run.runPublication || !run.finalizedAt) {
        throw factoryError('FACTORY_EVIDENCE_UNVERIFIED', 'Completed Run publication or finalization is incomplete');
      }
      const evidence = await getRunAcceptanceEvidence(run.id).catch(() => null);
      if (!evidence || evidence.state !== 'completed' || !evidence.finalizedAt || !evidence.runPublication) {
        throw factoryError('FACTORY_EVIDENCE_UNVERIFIED', 'Canonical completed Run acceptance evidence is unavailable');
      }
      bindingStatus = 'finished';
      itemState = 'blocked';
      controlState = 'none';
      blockedObj = { code: 'completed_pending_review', evidenceRef: `run:${run.id}`, resolvedByOwner: actor.principalId, rationale };
    } else if (run.state === 'cancelled') {
      if (resolution === 'confirm_finished' || resolution === 'confirm_failed') {
        throw factoryError('FACTORY_CONFLICT', 'Cancelled Run cannot be marked finished or failed');
      }
      bindingStatus = 'stopped';
      if (item.control_state === 'cancel_requested') {
        itemState = 'cancelled';
        controlState = 'none';
        blockedObj = null;
      } else if (item.control_state === 'pause_requested') {
        itemState = 'blocked';
        controlState = 'paused';
        blockedObj = { code: 'stopped_for_pause', evidenceRef: `run:${run.id}`, resolvedByOwner: actor.principalId, rationale };
      } else {
        itemState = 'blocked';
        controlState = item.control_state;
        blockedObj = { code: 'stopped', evidenceRef: `run:${run.id}`, resolvedByOwner: actor.principalId, rationale };
      }
    } else {
      if (resolution === 'confirm_finished' || resolution === 'confirm_stopped') {
        throw factoryError('FACTORY_CONFLICT', 'Failed Run cannot be marked finished or stopped');
      }
      bindingStatus = 'failed';
      itemState = 'failed';
      controlState = 'none';
      blockedObj = { code: 'execution_failed', evidenceRef: `run:${run.id}`, resolvedByOwner: actor.principalId, rationale };
    }

    if (Number.isSafeInteger(contract?.organizationRevision)) {
      const budgetKey = `factory:${binding.id}`;
      let usage = null;
      await forEachStoredEvent(run.sessionId, evt => {
        if (evt.runId === run.id && evt.type === 'usage' && evt.usageScope === 'provider_turn_total'
            && evt.costSource === 'provider_reported' && Number.isFinite(evt.costUsd) && evt.costUsd >= 0
            && Number.isInteger(evt.usageAccountingTokens) && evt.usageAccountingTokens >= 0
            && Number.isInteger(evt.seq) && (!usage || evt.seq > usage.seq)) usage = evt;
      }, { strict: true }).catch(() => { usage = null; });
      if (usage) {
        await settleFactoryBudget({
          organizationId, revision: contract.organizationRevision,
          reservationId: budgetKey, idempotencyKey: budgetKey,
          backendUsage: { runs: 1, tokens: usage.usageAccountingTokens, cost: usage.costUsd },
        }).catch(() => {});
      }
    }
  } else {
    if (resolution === 'adopt_run_outcome' || resolution === 'confirm_finished') {
      throw factoryError('FACTORY_CONFLICT', 'No Run receipt was found on disk; cannot adopt completion or mark finished');
    }
    if (knownRunId && resolution === 'confirm_stopped') {
      throw factoryError('FACTORY_CONFLICT', 'A Run ID was recorded but its disk state is missing; resolve explicitly as confirm_failed');
    }
    if (resolution === 'confirm_stopped') {
      if (!['cancel_requested', 'pause_requested'].includes(item.control_state)) {
        throw factoryError('FACTORY_CONFLICT', 'confirm_stopped without a cancelled Run requires cancel_requested or pause_requested state');
      }
      bindingStatus = 'stopped';
      if (item.control_state === 'cancel_requested') {
        itemState = 'cancelled';
        controlState = 'none';
        blockedObj = null;
      } else {
        itemState = 'blocked';
        controlState = 'paused';
        blockedObj = { code: 'unknown_outcome_resolved_paused', ownerConfirmed: true, rationale };
      }
    } else {
      bindingStatus = 'failed';
      itemState = 'failed';
      controlState = 'none';
      blockedObj = { code: 'unknown_outcome_resolved_failed', ownerConfirmed: true, rationale };
    }
  }

  let unstartedBudget = null;
  if (!run && !knownRunId) {
    try { unstartedBudget = await releaseFreshUnstartedReservation(organizationId, workItemId, input.executionEpoch, actor); }
    catch { unstartedBudget = null; }
  }

  return factoryTransaction(db => {
    schema(db);
    const currentOrg = authorize(db, organizationId, actor, 'factory.execution');
    const prior = db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?')
      .get(actor.principalId, 'ResolveUnknownOutcome', workItemId, key);
    if (prior) {
      if (prior.payload_digest !== payloadDigest) throw factoryError('FACTORY_CONFLICT', 'Resolution idempotency key reused with different inputs');
      return { ...decode(prior.result_json, {}), replayed: true };
    }
    if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) {
      throw factoryError('FACTORY_CONFLICT', 'Command ID already used');
    }
    const row = selectItem(db, organizationId, workItemId);
    checkVersion(row, input.expectedVersion);
    if (row.execution_epoch !== input.executionEpoch) throw factoryError('FACTORY_CONFLICT', 'Execution epoch changed');
    if (row.state !== item.state || row.control_state !== item.control_state) {
      throw factoryError('FACTORY_CONFLICT', 'Work item state changed concurrently');
    }
    const currentBinding = db.prepare('SELECT * FROM factory_execution_bindings WHERE id=?').get(binding.id);
    if (!currentBinding || !['intent', 'running', 'unknown'].includes(currentBinding.status)
        || currentBinding.status !== binding.status
        || (currentBinding.run_id || null) !== (binding.run_id || null)
        || (currentBinding.attempt_id || null) !== (binding.attempt_id || null)
        || (currentBinding.collaboration_id || null) !== (binding.collaboration_id || null)) {
      throw factoryError('FACTORY_CONFLICT', 'Binding changed concurrently');
    }
    const currentLinked = resolveLinkedDispatch(db, currentOrg, row, currentBinding);
    if ((currentLinked.collaboration?.id || null) !== (collaboration?.id || null)
        || (currentLinked.command?.id || null) !== (command?.id || null)
        || (currentLinked.command?.state || null) !== (command?.state || null)
        || (currentLinked.command?.run_id || null) !== (command?.run_id || null)
        || (currentLinked.attempt?.id || null) !== (attempt?.id || null)
        || (currentLinked.attempt?.state || null) !== (attempt?.state || null)
        || (currentLinked.attempt?.failure_kind || null) !== (attempt?.failure_kind || null)
        || (currentLinked.attempt?.run_id || null) !== (attempt?.run_id || null)) {
      throw factoryError('FACTORY_CONFLICT', 'Linked execution state changed concurrently');
    }
    const ts = now();
    const nextDetails = {
      ...decode(currentBinding.details_json, {}),
      unknownOutcomeResolved: {
        resolution,
        priorBindingStatus: currentBinding.status,
        priorAttemptFailureKind: attempt?.failure_kind || null,
        runId: run?.id || knownRunId || null,
        runState: run?.state || null,
        rationale,
        actorId: actor.principalId,
        resolvedAt: ts,
      },
      ...(run ? { terminalEvidenceRef: `run:${run.id}` } : {}),
    };
    db.prepare(`UPDATE factory_execution_bindings SET status=?,collaboration_id=COALESCE(collaboration_id,?),
      task_id=COALESCE(task_id,?),attempt_id=COALESCE(attempt_id,?),run_id=COALESCE(run_id,?),details_json=?,updated_at=? WHERE id=?`)
      .run(bindingStatus, collaboration?.id || null, command?.task_id || null, attempt?.id || command?.attempt_id || null,
        run?.id || null, encode(nextDetails), ts, currentBinding.id);
    const updatedRow = update(db, row, { state: itemState, control_state: controlState, blocked_json: blockedObj ? encode(blockedObj) : null });
    db.prepare('DELETE FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?')
      .run(organizationId, row.id, row.execution_epoch);
    let budgetRetained = false;
    if (Number.isSafeInteger(contract?.organizationRevision) && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_budget_counters'").get()) {
      const counter = db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?')
        .get(organizationId, contract.organizationRevision);
      const entry = decode(counter?.reservations_json, {})?.[`factory:${currentBinding.id}`];
      budgetRetained = entry?.state === 'reserved';
    }
    event(db, organizationId, row.id, 'UnknownOutcomeResolved', {
      commandId, executionEpoch: row.execution_epoch, bindingId: currentBinding.id,
      priorBindingStatus: currentBinding.status, priorAttemptFailureKind: attempt?.failure_kind || null,
      resolution, resolvedBindingStatus: bindingStatus, resolvedState: itemState, resolvedControlState: controlState,
      runId: run?.id || knownRunId || null, runState: run?.state || null, rationale,
      budgetRetained, actorId: actor.principalId,
    });
    const result = {
      schemaVersion: 1,
      operation: { commandId, state: 'completed' },
      item: itemRow(db, updatedRow),
      binding: {
        id: currentBinding.id, status: bindingStatus, runId: currentBinding.run_id || run?.id || null,
        contractRevision: currentBinding.contract_revision, executionEpoch: currentBinding.execution_epoch, bindingGeneration: currentBinding.binding_generation,
      },
      resolvedRunId: run?.id || knownRunId || null,
      resolution,
      budgetRetained,
      ...(unstartedBudget ? { unstartedBudget } : {}),
    };
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)')
      .run(commandId, organizationId, actor.principalId, 'ResolveUnknownOutcome', workItemId, key, payloadDigest, encode(result), ts);
    return result;
  });
}
