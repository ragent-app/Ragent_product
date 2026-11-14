import { read, transaction, newId, now, activity, recordObservation } from './responsibility-store.mjs';
import { randomUUID } from 'node:crypto';

// Only schedules observations. Factory remains the sole Work Item dispatcher.
export function createResponsibilityRuntime({intervalMs=60000,onError=error=>console.error('[responsibility]',error?.message||String(error))}={}) {
  let timer=null, running=false, stopped=true, pending=null;
  const ownerToken=randomUUID();
  async function claim(wakeId) { return transaction(db=>{const w=db.prepare('SELECT * FROM responsibility_wakes WHERE id=?').get(wakeId), old=db.prepare('SELECT * FROM responsibility_wake_leases WHERE wake_id=?').get(wakeId), ts=now(); if(!w||!['pending','deciding'].includes(w.state)||(old&&old.expires_at>ts)) return null; const generation=w.lease_generation+1,expiresAt=new Date(Date.now()+300000).toISOString(); db.prepare('INSERT INTO responsibility_wake_leases VALUES(?,?,?,?) ON CONFLICT(wake_id) DO UPDATE SET owner_token=excluded.owner_token,generation=excluded.generation,expires_at=excluded.expires_at').run(wakeId,ownerToken,generation,expiresAt); db.prepare('UPDATE responsibility_wakes SET lease_generation=?,updated_at=? WHERE id=?').run(generation,ts,wakeId); return {ownerToken,generation};}); }
  async function release(wakeId,lease) { await transaction(db=>{db.prepare('DELETE FROM responsibility_wake_leases WHERE wake_id=? AND owner_token=? AND generation=?').run(wakeId,lease.ownerToken,lease.generation);}); }
  async function tick() {
    if(stopped||running) return; running=true;
    try { await transaction(db=>{const ts=now(); const due=db.prepare(`SELECT s.*,r.revision,r.policy_revision FROM responsibility_subscriptions s JOIN responsibilities r ON r.id=s.responsibility_id WHERE s.enabled=1 AND s.next_due_at<=? AND r.lifecycle='active' ORDER BY s.next_due_at,s.id LIMIT 100`).all(ts);
      for(const s of due) { const next=new Date(Date.now()+s.interval_ms).toISOString(); db.prepare('UPDATE responsibility_subscriptions SET next_due_at=? WHERE id=?').run(next,s.id);
        const existing=db.prepare("SELECT id FROM responsibility_wakes WHERE responsibility_id=? AND responsibility_revision=? AND policy_revision=? AND state IN ('pending','waiting','deciding') LIMIT 1").get(s.responsibility_id,s.revision,s.policy_revision); if(existing) {const prior=db.prepare('SELECT count FROM responsibility_subscription_coalescing WHERE subscription_id=?').get(s.id); db.prepare('INSERT INTO responsibility_subscription_coalescing VALUES(?,1,?,?) ON CONFLICT(subscription_id) DO UPDATE SET count=count+1,last_due_at=excluded.last_due_at').run(s.id,s.next_due_at,s.next_due_at); if(!prior) activity(db,s.responsibility_id,'wake_coalesced',{wakeId:existing.id,subscriptionId:s.id,firstScheduledAt:s.next_due_at}); continue;}
        const id=newId('wake'); db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,s.responsibility_id,s.revision,s.policy_revision,ts,'pending',0,null,ts,ts); recordObservation(db,id,'interval',{subscriptionId:s.id,scheduledAt:s.next_due_at}); activity(db,s.responsibility_id,'wake_received',{wakeId:id,source:'interval',scheduledAt:s.next_due_at});
      }
    });
      const due=await read(db=>db.prepare("SELECT id FROM responsibility_wakes WHERE state IN ('pending','deciding') AND due_at<=? ORDER BY due_at,id LIMIT 10").all(now()));
      const {processResponsibilityWake,holdResponsibilityWake}=await import('./responsibility-decision.mjs');
      for(const wake of due) {if(stopped) break; const lease=await claim(wake.id); if(!lease) continue; try {await processResponsibilityWake(wake.id,lease);} catch(error) {onError(error); await holdResponsibilityWake(wake.id,'decision_or_admission_error',lease);} finally {await release(wake.id,lease);}}
      if(!stopped) { const {collectResponsibilityPlans,dispatchApprovedResponsibilityPlans}=await import('./responsibility-plans.mjs'); await collectResponsibilityPlans(); await dispatchApprovedResponsibilityPlans(); }
      if(!stopped && process.env.AGENTOC_RESPONSIBILITY_PUSH_ENABLED==='1') {const {processResponsibilityNotifications}=await import('./responsibility-notifications.mjs');await processResponsibilityNotifications();}
    } catch(error) {onError(error);} finally {running=false;}
  }
  function scheduleTick() { if(pending) return pending; pending=tick().finally(()=>{pending=null;}); return pending; }
  return { start() {if(!stopped)return; stopped=false; timer=setInterval(scheduleTick,Math.max(60000,intervalMs)); timer.unref?.(); void scheduleTick();}, async stop() {stopped=true; if(timer)clearInterval(timer); timer=null; if(pending) await pending;}, tick:scheduleTick };
}
