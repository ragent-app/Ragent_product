import { getResponsibility, listResponsibilityActivity, listResponsibilityWorkLinks } from './responsibility-service.mjs';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { getFactoryWorkItem } from './factory-control.mjs';

// This projection supplies references and evidence, never authorization or
// an independent progress state. The responsibility service authenticates the
// actor and owns the project/organization scope.
export async function assembleResponsibilityContext(id, actor) {
  const first = await getResponsibility(id, actor);
  const responsibility = first.responsibility;
  const memory = await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId);
  const [activity, workLinks, currentFacts] = await Promise.all([
    listResponsibilityActivity(id, { after: 0, limit: 100 }, actor),
    listResponsibilityWorkLinks(id, actor),
    defaultProjectMemoryStore.listCurrentFacts(responsibility.projectId),
  ]);
  const workIds = [...new Set(workLinks.links.flatMap(link => link.workItemIds || []))];
  const work = await Promise.all(workIds.slice(0, 50).map(workId => getFactoryWorkItem(responsibility.organizationId, workId, actor)));
  const provenance = memory?.currentVersion
    ? await defaultProjectMemoryStore.getFactProvenance(responsibility.projectId, memory.currentVersion) : [];
  const latest = await getResponsibility(id, actor);
  const latestMemory = await defaultProjectMemoryStore.getProjectMemory(responsibility.projectId);
  if (latest.responsibility.rowVersion !== responsibility.rowVersion || latest.responsibility.policyRevision !== responsibility.policyRevision) {
    throw Object.assign(new Error('Responsibility changed while assembling context; retry.'), { code: 'RESPONSIBILITY_CONTEXT_STALE', statusCode: 409 });
  }
  if ((latestMemory?.currentVersion || 0) !== (memory?.currentVersion || 0)) {
    throw Object.assign(new Error('Project memory changed while assembling context; retry.'), { code: 'RESPONSIBILITY_CONTEXT_STALE', statusCode: 409 });
  }
  return {
    schemaVersion: 1,
    asOf: new Date().toISOString(),
    responsibility: { id: responsibility.id, projectId: responsibility.projectId, organizationId: responsibility.organizationId,
      objective: responsibility.objective, successCriteria: responsibility.successCriteria, lifecycle: responsibility.lifecycle,
      rowVersion: responsibility.rowVersion, policyRevision: responsibility.policyRevision },
    policy: first.policy ? { digest: first.policy.digest, validUntil: first.policy.validUntil } : null,
    activity: activity.activity,
    activityNextCursor: activity.nextCursor,
    memory: memory ? { version: memory.currentVersion, digest: memory.digest, updatedAt: memory.updatedAt,
      currentFacts: currentFacts.slice(0, 100).map(({ factId, factVersion, currentVersion, factValue, state, contestedBy }) =>
        ({ factId, factVersion: factVersion || currentVersion, factValue, state, contestedBy,
          sourceKind: provenance.some(source => source.factId===factId && source.provider==='user') ? 'user' : 'unknown' })),
      facts: provenance.slice(0, 100).map(({ factId, fact, factVersion, state, sessionId, runId, provider, sourceEventStart, sourceEventEnd }) =>
        ({ factId, fact, factVersion, state, sessionId, runId, sourceKind:provider==='user'?'user':'unknown', sourceEventStart, sourceEventEnd })),
      truncated: provenance.length > 100 || currentFacts.length > 100 } : null,
    workGraph: { links: workLinks.links, items: work.map(result => result.item), truncated: workIds.length > 50 },
  };
}
