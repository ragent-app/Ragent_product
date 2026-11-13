import { factoryRead, factoryTransaction, factoryError, now, event } from './work-graph-store.mjs';
import { authorize, selectItem, required, checkVersion } from './work-graph.mjs';

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_reconciliation_failures (
    organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL,
    failures INTEGER NOT NULL, state TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
    error_code TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(organization_id,work_item_id,execution_epoch));
    CREATE TABLE IF NOT EXISTS factory_reconciliation_receipts (
    command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
}

export async function factoryReconciliationDue(organizationId,item,actor) {
  return factoryRead(db => { schema(db); authorize(db,organizationId,actor,'factory.read');
    const row=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.executionEpoch);
    return !row || row.next_attempt_at<=now(); });
}
export async function recordFactoryReconciliationFailure(organizationId,item,error,actor) {
  return factoryTransaction(db => { schema(db); authorize(db,organizationId,actor,'factory.execution');
    const current=selectItem(db,organizationId,item.id); if(current.execution_epoch!==item.executionEpoch) return null;
    const previous=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.executionEpoch);
    const configured=Number(process.env.AGENTOC_FACTORY_RECONCILIATION_MAX_FAILURES);
    const maxFailures=Number.isInteger(configured)&&configured>=1&&configured<=32?configured:8;
    const failures=Math.min((previous?.failures||0)+1,maxFailures), state=failures>=maxFailures?'dead_letter':'retry';
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
    db.prepare('DELETE FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').run(organizationId,item.id,item.executionEpoch); });
}
export async function getFactoryReconciliation({organizationId,workItemId},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const {getFactoryRuntimeStatus}=await import('./factory-runtime.mjs');
  const observing=getFactoryRuntimeStatus(organizationId).observing;
  return factoryRead(db => { schema(db); authorize(db,organizationId,actor,'factory.read'); const item=selectItem(db,organizationId,workItemId);
    const row=db.prepare('SELECT * FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').get(organizationId,item.id,item.execution_epoch);
    return {workItemId:item.id,executionEpoch:item.execution_epoch,rowVersion:item.row_version,
      state:row?.state||'observing',failures:row?.failures||0,nextAttemptAt:row?.next_attempt_at||null,errorCode:row?.error_code||null,
      observationContinues:observing}; });
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
    db.prepare('DELETE FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? AND execution_epoch=?').run(org,item.id,item.execution_epoch);
    db.prepare('INSERT INTO factory_reconciliation_receipts VALUES(?,?,?,?,?,?)').run(commandId,org,item.id,item.execution_epoch,actor.principalId,now());
    event(db,org,item.id,'ReconciliationRequested',{executionEpoch:item.execution_epoch,actorId:actor.principalId,commandId}); return {requested:true,replayed:false}; });
}
