import { getOrganization } from './organization-store.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';
import { createFactoryExecutionAdapter } from './factory-execution-adapter.mjs';
import { createFactoryScheduler } from './factory-scheduler.mjs';

const activeSchedulers = new Map();
export function getFactoryRuntimeStatus(organizationId) {
  return activeSchedulers.get(organizationId)?.status() || { observing: false, automaticAdmission: false };
}

// Configuration is read only from the server environment. It cannot be
// supplied by a Work Contract or a client request. Disabled means no new
// claims; graph reads and existing Run reconciliation remain available.
export function createFactoryRuntime({ env = process.env, onError = (error) => console.error('[factory]', error?.message || String(error)) } = {}) {
  const enabled = env.AGENTOC_FACTORY_SCHEDULER_ENABLED === '1';
  const organizationIds = [...new Set(String(env.AGENTOC_FACTORY_ORGANIZATIONS || '').split(',').map((id) => id.trim()).filter(Boolean))];
  const ownerId = String(env.AGENTOC_FACTORY_SCHEDULER_OWNER_ID || '').trim();
  const schedulers = [];
  let running = false;
  async function start() {
    if (running) return { enabled, running, organizations: [...organizationIds] };
    if (!organizationIds.length && !enabled) return { enabled: false, running: false, organizations: [] };
    if (!ownerId || !organizationIds.length || organizationIds.length > 100
        || organizationIds.some((id) => !/^[A-Za-z0-9:_-]{1,160}$/.test(id))) {
      throw Object.assign(new Error('Factory scheduling requires a server-configured owner identity and organization allowlist'), { code: 'FACTORY_CONFIGURATION_INVALID' });
    }
    if (enabled) assertOrganizationCapability('stallGovernor', 'Factory scheduling requires budget governance');
    for (const id of organizationIds) {
      const org = await getOrganization(id);
      const budget = org?.budget || {};
      if (!org || (enabled && !['archived', 'lifecycle_pending'].includes(org.state)
          && (!Number.isInteger(org.policy?.factoryMaxConcurrent) || org.policy.factoryMaxConcurrent < 1
          || !['maxTotalRuns', 'maxTokens', 'maxCost'].some((key) => Number.isFinite(budget[key]) && budget[key] >= 0)))) {
        throw Object.assign(new Error(`Factory organization ${id} requires active status, explicit concurrency and budget limits`), { code: 'FACTORY_CONFIGURATION_INVALID' });
      }
    }
    const actor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${ownerId}`,
      authorizingPrincipalId: ownerId };
    try {
      for (const organizationId of organizationIds) {
        const adapter = createFactoryExecutionAdapter({ organizationId, actor });
        const scheduler = createFactoryScheduler({ organizationId, actor, adapter, admissionEnabled: enabled, onError });
        schedulers.push(scheduler);
        await scheduler.start();
        activeSchedulers.set(organizationId, scheduler);
      }
      running = true;
      return { enabled, running: true, organizations: organizationIds };
    } catch (error) {
      await Promise.allSettled(schedulers.splice(0).map((scheduler) => scheduler.stop()));
      for (const id of organizationIds) activeSchedulers.delete(id);
      throw error;
    }
  }
  async function stop() {
    await Promise.allSettled(schedulers.splice(0).map((scheduler) => scheduler.stop()));
    for (const id of organizationIds) activeSchedulers.delete(id);
    running = false;
  }
  return { start, stop, status: () => ({ enabled, running, organizations: running ? [...organizationIds] : [] }) };
}
