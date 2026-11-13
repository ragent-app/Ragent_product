import { transaction, row, activity, receipt, newId, now, error } from './responsibility-store.mjs';

// Durable acceptance does not imply a decision or Run.
export async function wakeResponsibility(id,input,actor) {
  if(actor?.kind!=='user'||actor?.role!=='owner'||!actor.principalId) throw error('Owner access required',403,'RESPONSIBILITY_FORBIDDEN');
  if(typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>1024) throw error('idempotencyKey is required');
  return transaction(db=>receipt(db,actor.principalId,'wake',id,input.idempotencyKey,input,()=>{const r=db.prepare('SELECT r.* FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=? AND r.owner_principal_id=?').get(id,actor.principalId); if(!r) throw error('Responsibility not found',404,'RESPONSIBILITY_NOT_FOUND'); if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==r.row_version) throw error('Responsibility version changed',409,'RESPONSIBILITY_CONFLICT'); if(r.lifecycle!=='active') throw error('Responsibility is not active',409,'RESPONSIBILITY_CONFLICT'); const ts=now(), wakeId=newId('wake'); db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(wakeId,id,r.revision,r.policy_revision,ts,'pending',0,null,ts,ts); activity(db,id,'wake_received',{wakeId,actorId:actor.principalId}); return {schemaVersion:1,wake:{id:wakeId,responsibilityId:id,state:'pending',dueAt:ts,responsibilityRevision:r.revision,policyRevision:r.policy_revision},responsibility:row(r)}; }));
}
