import { randomUUID } from 'node:crypto';
import { getNode } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { factoryReconciliationState, recordFactoryReconciliationFailure, clearFactoryReconciliationFailure, scheduleFactoryDeadLetterObservation } from './factory-reconciliation.mjs';
import { reconcileFactoryDependencies } from './work-graph.mjs';
import {
  acquireFactorySchedulerLease, renewFactorySchedulerLease, releaseFactorySchedulerLease,
  claimFactoryWork, listFactoryWorkItems, listFactoryReadyWork,
} from './factory-control.mjs';

// The lease fences claim authority, not the lifetime of an already launched Run.
// An adapter is required to establish the runtime, budget and isolation facts.
export function createFactoryScheduler({ organizationId, actor, adapter, observe = null, admissionEnabled = true, pollMs = 2000, batchSize = 20, onError = () => {} } = {}) {
  if (!organizationId || !actor || !adapter || typeof adapter.admit !== 'function'
      || typeof adapter.dispatch !== 'function' || typeof adapter.reconcile !== 'function') {
    throw new Error('Factory scheduler requires organization, trusted actor, and execution adapter');
  }
  const ownerToken = `scheduler_${randomUUID()}`;
  const interval = Math.max(500, Number(pollMs) || 2000);
  const limit = Math.max(1, Math.min(100, Number(batchSize) || 20));
  let lease = null, timer = null, pending = null, cursor = null, stopped = true;

  async function tick() {
    if (stopped || pending) return pending;
    pending = (async () => {
      if (typeof observe === 'function') await observe().catch(onError);
      try {
        if (!admissionEnabled) throw Object.assign(new Error('Factory admission is disabled'), { code: 'FACTORY_ADMISSION_DISABLED' });
        lease = lease
          ? await renewFactorySchedulerLease({ organizationId, ownerToken, generation: lease.generation }, actor)
          : await acquireFactorySchedulerLease({ organizationId, ownerToken }, actor);
      } catch (error) {
        lease = null;
        if (error?.code !== 'FACTORY_ADMISSION_DISABLED') onError(error);
      }
      const page = await listFactoryWorkItems(organizationId, { cursor, limit }, actor);
      cursor = page.nextCursor || null;
      // Reconciliation never relies on a lease expiring as proof of termination.
      for (const item of page.items.filter((entry) => ['claimed', 'running', 'blocked', 'review', 'completed', 'failed', 'cancelled'].includes(entry.state))) {
        if (stopped) break;
        try {
          const reconciliation = await factoryReconciliationState(organizationId,item,actor);
          if (!['cancel_requested','pause_requested'].includes(item.controlState) && !reconciliation.due) continue;
          const observationOnly = reconciliation.state === 'dead_letter';
          if (!observationOnly && lease && item.state === 'blocked' && item.blockedReason?.code === 'dependencies') {
            await reconcileFactoryDependencies({ organizationId, workItemId: item.id, expectedVersion: item.rowVersion,
              leaseOwnerToken: ownerToken, leaseGeneration: lease.generation }, actor);
          }
          await adapter.reconcile(item, null, lease ? { ownerToken, generation: lease.generation } : null, { observationOnly });
          if (observationOnly) await scheduleFactoryDeadLetterObservation(organizationId,item,actor);
          else await clearFactoryReconciliationFailure(organizationId,item,actor);
        } catch (error) {
          await recordFactoryReconciliationFailure(organizationId,item,error,actor).catch(onError);
          onError(error);
        }
      }
      if (!lease) return;
      const ready = (await listFactoryReadyWork(organizationId, { limit }, actor)).items;
      for (const item of ready) {
        if (stopped) break;
        try {
          const admission = await adapter.admit(item);
          if (!admission?.allowed) continue;
          lease = await renewFactorySchedulerLease({ organizationId, ownerToken, generation: lease.generation }, actor);
          const node = await getNode(item.assigneeNodeId);
          if (!node || node.organizationId !== organizationId) continue;
          const session = await getSession(node.currentSessionId);
          if (!session?.tool) continue;
          const dispatchKey = `factory:${item.id}:${item.contractRevision}:${item.executionEpoch + 1}:${node.bindingGeneration}`;
          const claim = await claimFactoryWork({ organizationId, workItemId: item.id, expectedVersion: item.rowVersion,
            bindingGeneration: node.bindingGeneration, dispatchKey, leaseOwnerToken: ownerToken, leaseGeneration: lease.generation,
            managedSessionId: node.currentSessionId, runtimeTool: session.tool }, actor);
          await adapter.dispatch(claim, { ownerToken, generation: lease.generation }, { freshClaim: !claim.replayed });
        } catch (error) { onError(error); }
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  async function start() {
    if (!stopped) return;
    stopped = false;
    timer = setInterval(() => { void tick().catch(onError); }, interval);
    timer.unref?.();
    await tick();
  }
  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (pending) await pending.catch(onError);
    if (lease) await releaseFactorySchedulerLease({ organizationId, ownerToken, generation: lease.generation }, actor).catch(onError);
    lease = null;
  }
  return { start, stop, tick, status: () => ({ observing: !stopped,
    automaticAdmission: !stopped && admissionEnabled && Boolean(lease && Date.parse(lease.expiresAt) > Date.now()) }) };
}
