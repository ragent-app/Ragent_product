import { factoryRead, factoryTransaction, factoryError, now, event } from './work-graph-store.mjs';
import { authorize, selectItem, required, checkVersion } from './work-graph.mjs';
import { findRunByRequest } from './runs.mjs';
import { claimPendingDispatchCommands, completeAttemptDispatch, deferAttemptDispatch } from './collaboration-store.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';
import { profileAllows } from './factory-execution-adapter.mjs';

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
    const configured=Number(process.env.AGENTOC_FACTORY_RECONCILIATION_MAX_FAILURES);
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
export async function getFactoryReconciliation({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const {getFactoryRuntimeStatus}=await import('./factory-runtime.mjs');
  const observing=getFactoryRuntimeStatus(organizationId).observing;
  const snapshot=await factoryRead(db => { schema(db); const org=authorize(db,organizationId,actor,'factory.read'); const item=selectItem(db,organizationId,workItemId);
    const row=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.execution_epoch);
    const lease=db.prepare('SELECT generation,expires_at FROM factory_scheduler_leases WHERE organization_id=?').get(organizationId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    let command=null, reason='unbound_dispatch_unavailable';
    if(binding && ['intent','unknown'].includes(binding.status) && !binding.run_id) {
      const collaboration=db.prepare('SELECT * FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,binding.dispatch_key);
      let context; try { context=JSON.parse(collaboration?.policy_json || '{}').factoryExecution; } catch { context=null; }
      if(collaboration && context?.organizationId===organizationId && context.workItemId===item.id
          && context.contractRevision===item.contract_revision && context.executionEpoch===item.execution_epoch
          && context.bindingGeneration===item.binding_generation && context.dispatchKey===binding.dispatch_key) {
        const commands=db.prepare('SELECT d.*,a.run_id AS attempt_run FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id JOIN collaboration_tasks t ON t.id=d.task_id AND t.collaboration_id=d.collaboration_id WHERE d.collaboration_id=? AND d.task_id=? AND a.task_id=d.task_id').all(collaboration.id,item.id);
        if(commands.length===1 && commands[0].session_id && commands[0].request_id) {command=commands[0];reason=null;}
        else reason='dispatch_identity_unavailable';
      } else reason='collaboration_identity_unavailable';
    }
    return {result:{workItemId:item.id,executionEpoch:item.execution_epoch,rowVersion:item.row_version,
      state:row?.state||'observing',failures:row?.failures||0,nextAttemptAt:row?.next_attempt_at||null,errorCode:row?.error_code||null,
      schedulerLease:lease ? {generation:lease.generation,expiresAt:lease.expires_at} : null,observationContinues:observing},command,reason}; });
  let observation={state:'unknown',reason:snapshot.reason || 'run_evidence_unavailable',observedAt:now()};
  if(snapshot.command) {
    try {
      const command=snapshot.command, run=await findRunByRequest(command.session_id,command.request_id);
      if(run && run.sessionId===command.session_id && run.requestId===command.request_id
          && (!command.run_id || command.run_id===run.id) && (!command.attempt_run || command.attempt_run===run.id)) {
        observation={state:'found',expectedRunId:run.id,runState:run.state,dispatchState:command.state,observedAt:now()};
      }
    } catch { observation.reason='run_evidence_unavailable'; }
  }
  return {...snapshot.result,acceptedRunObservation:{...observation,requiresVerification:true,
    crossStoreAtomic:false,requestIndexMayRepair:true}};
}

export async function getFactoryBudgetObservation({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  return factoryRead(db=>{
    authorize(db,organizationId,actor,'factory.read');
    const row=selectItem(db,organizationId,workItemId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(row.id,row.contract_revision,row.execution_epoch,row.binding_generation);
    const empty={state:'not_found',reserved:null,actualUsage:null,createdAt:null,settledAt:null,window:null};
    let reservation=empty;
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
            else reservation={state:entry.state,reserved:entry.delta||null,actualUsage:entry.state==='settled'?(entry.usage||null):null,
              createdAt:entry.createdAt||null,settledAt:entry.settledAt||null,window:entry.responsibilityScope?{responsibilityId:entry.responsibilityScope.responsibilityId,day:entry.responsibilityScope.day,timeZone:entry.responsibilityScope.timeZone}:null};
          }
        } catch {reservation={...empty,state:'unavailable'};}
      }
    }
    return {schemaVersion:1,workItemId:row.id,executionEpoch:row.execution_epoch,bindingId:binding?.id||null,reservation,
      usageState:reservation.state==='settled' && reservation.actualUsage?'actual':'unknown',costEnforcement:'admission_estimate_only',hardCapAvailable:false,asOf:now()};
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
    if(!lease || !Number.isSafeInteger(input.leaseGeneration) || lease.generation!==input.leaseGeneration || lease.expires_at<=now() || (automatic && lease.owner_token!==input.leaseOwnerToken)) throw factoryError('FACTORY_CONFLICT','Scheduler lease expired or changed');
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    if(!binding || !['intent','unknown'].includes(binding.status) || binding.run_id) throw factoryError('FACTORY_CONFLICT','Unbound dispatch intent required');
    const collaboration=db.prepare('SELECT * FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,binding.dispatch_key);
    let context; try { context=JSON.parse(collaboration?.policy_json || '{}').factoryExecution; } catch { context=null; }
    if(!collaboration || !context || context.organizationId!==organizationId || context.workItemId!==item.id || context.contractRevision!==item.contract_revision || context.executionEpoch!==item.execution_epoch || context.bindingGeneration!==item.binding_generation || context.dispatchKey!==binding.dispatch_key) throw factoryError('FACTORY_CONFLICT','Persisted dispatch identity differs');
    const commands=db.prepare('SELECT d.*,a.state AS attempt_state,a.lifecycle_phase,a.run_id AS attempt_run FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id JOIN collaboration_tasks t ON t.id=d.task_id AND t.collaboration_id=d.collaboration_id WHERE d.collaboration_id=? AND d.task_id=? AND a.task_id=d.task_id').all(collaboration.id,item.id);
    if(commands.length!==1) throw factoryError('FACTORY_CONFLICT','Exactly one durable dispatch command required');
    const command=commands[0];
    if(!command.session_id || !command.request_id || (expectedRunId && command.state==='completed' && (command.run_id!==expectedRunId || command.attempt_run!==expectedRunId))) throw factoryError('FACTORY_CONFLICT','Dispatch command identity changed');
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
    return {item,binding,collaboration,command,leaseOwner:lease.owner_token};
  }
  const observed=await factoryRead(snapshot);
  const run=await findRunByRequest(observed.command.session_id,observed.command.request_id);
  if(!run || (expectedRunId && run.id!==expectedRunId) || run.sessionId!==observed.command.session_id || run.requestId!==observed.command.request_id) return {state:'unknown',reason:'run_evidence_unavailable'};
  if(observed.command.state==='completed') {
    const current=await factoryRead(snapshot);
    if(current.leaseOwner!==observed.leaseOwner || current.binding.id!==observed.binding.id
        || current.collaboration.id!==observed.collaboration.id || current.command.id!==observed.command.id
        || current.command.session_id!==run.sessionId || current.command.request_id!==run.requestId || current.command.attempt_id!==observed.command.attempt_id
        || current.command.state!=='completed' || current.command.run_id!==run.id || current.command.attempt_run!==run.id) throw factoryError('FACTORY_CONFLICT','Recovery identity or lease changed');
    return {state:'accepted',runId:run.id,replayed:true};
  }
  const claimed=await claimPendingDispatchCommands({collaborationId:observed.collaboration.id,commandId:observed.command.id,limit:1});
  if(claimed.length!==1) return {state:'unknown',reason:'dispatch_claim_unavailable'};
  const claim=claimed[0];
  const bound=await completeAttemptDispatch(claim.id,{claimToken:claim.claimToken,runId:run.id,verify:({db,command,attempt})=>{
    try { const current=snapshot(db); return current.leaseOwner===observed.leaseOwner && current.binding.id===observed.binding.id
      && current.collaboration.id===observed.collaboration.id && command.id===observed.command.id
      && command.state==='claimed' && command.claim_token===claim.claimToken && command.lease_until && command.lease_until>now()
      && command.session_id===run.sessionId && command.request_id===run.requestId && attempt.id===command.attempt_id && attempt.task_id===workItemId; }
    catch { return false; }
  }});
  if(!bound) { if(!automatic) await deferAttemptDispatch(claim.id,{claimToken:claim.claimToken,reason:'Owner verification fenced'}); return {state:'unknown',reason:'recovery_fenced'}; }
  await factoryTransaction(db=>{authorize(db,organizationId,actor,'factory.read');event(db,organizationId,workItemId,'AcceptedRunVerified',{executionEpoch:input.executionEpoch,runId:run.id,actorId:actor.principalId});});
  return {state:'accepted',runId:run.id,replayed:false};
}
// This command only requests another observation; it cannot assert a Run state,
// release a budget reservation, or adopt an old dispatch intent.
export async function requestFactoryReconciliation(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  return factoryTransaction(db => { schema(db); const org=required(input?.organizationId,'organizationId'); authorize(db,org,actor,'factory.read');
    const item=selectItem(db,org,required(input.workItemId,'workItemId')), commandId=required(input.commandId,'commandId');
    const prior=db.prepare('SELECT * FROM factory_reconciliation_receipts WHERE command_id=?').get(commandId);
    if(prior) { if(prior.organization_id!==org||prior.work_item_id!==item.id||prior.execution_epoch!==input.executionEpoch||prior.actor_id!==actor.principalId) throw factoryError('FACTORY_CONFLICT','Command identity conflicts'); return {requested:true,replayed:true}; }
    checkVersion(item,input.expectedVersion); if(item.execution_epoch!==input.executionEpoch) throw factoryError('FACTORY_CONFLICT','Execution epoch changed');
    db.prepare('UPDATE factory_reconciliation_failures SET next_attempt_at=?,updated_at=? WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').run(now(),now(),org,item.id,item.execution_epoch);
    db.prepare('INSERT INTO factory_reconciliation_receipts VALUES(?,?,?,?,?,?)').run(commandId,org,item.id,item.execution_epoch,actor.principalId,now());
    event(db,org,item.id,'ReconciliationRequested',{executionEpoch:item.execution_epoch,actorId:actor.principalId,commandId}); return {requested:true,replayed:false}; });
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
