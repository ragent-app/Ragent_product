/**
 * Provider-neutral Project Memory worker and Context Engine adapter.
 *
 * Extraction/consolidation is scheduled through the low-priority queue. The
 * foreground prompt path reads only the last committed project version; it
 * never waits for an LLM memory job.
 */
import { createHash } from 'node:crypto';

import { backgroundAiQueue } from './background-ai-queue.mjs';
import { readEventsAfter } from './history.mjs';
import { getProject } from './projects.mjs';
import {
  buildProjectMemoryConsolidationPrompt,
  buildProjectMemoryExtractionPrompt,
  parseProjectMemoryConsolidation,
  parseProjectMemoryExtraction,
  renderProjectMemoryMarkdown,
} from './project-memory-prompts.mjs';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { runDetachedAssistantPrompt } from './session-detached-assistant.mjs';
import { getWorkspaceById } from './workspaces.mjs';

const PROJECT_MEMORY_MODE_ENV = 'AGENTOC_PROJECT_MEMORY_MODE';
const MAX_SOURCE_EVENT_CHARS = 80_000;
const MAX_SUMMARY_CONTEXT_CHARS = 8_000;
const MAX_FULL_CONTEXT_CHARS = 20_000;

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function clip(value, maxChars) {
  const source = text(value);
  if (source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(0, maxChars - 54)).trimEnd()}\n[... bounded by Project Memory context budget ...]`;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isInternalMemorySource(session, manifest) {
  return !!(manifest?.internalOperation || session?.internalRole || session?.compactsSessionId || session?.visitorId);
}

function providerForRun(run, manifest = {}) {
  return text(run?.provider || manifest?.provider || manifest?.options?.providerProfile || run?.tool || '', 160);
}

function eventText(event) {
  if (typeof event?.content === 'string') return event.content;
  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.message === 'string') return event.message;
  return '';
}

/**
 * Explicit parser so invalid values do not silently enable a context-changing
 * feature. `shadow` writes no prompt context; `summary` and `full` read only
 * successful committed versions.
 */
export function readProjectMemoryMode(env = process.env) {
  const mode = text(env?.[PROJECT_MEMORY_MODE_ENV]).toLowerCase();
  return ['shadow', 'summary', 'full'].includes(mode) ? mode : 'off';
}

export function isProjectMemoryEnabled(env = process.env) {
  return readProjectMemoryMode(env) !== 'off';
}

export function filterProjectMemorySourceEvents(events = [], run = {}) {
  const relevant = [];
  let chars = 0;
  for (const event of Array.isArray(events) ? events : []) {
    // Persisted prompt/system/skill material is intentionally not stage-one
    // evidence. Messages are enough to recover the human request and agent
    // result while avoiding a second route for hidden instruction injection.
    if (event?.type !== 'message' || !['user', 'assistant'].includes(event?.role)) continue;
    if (run?.id && event?.runId !== run.id && (!run?.requestId || event?.requestId !== run.requestId)) continue;
    const content = text(eventText(event), Math.max(0, MAX_SOURCE_EVENT_CHARS - chars));
    if (!content) continue;
    const record = {
      seq: Number.isInteger(event.seq) ? event.seq : 0,
      role: event.role,
      content,
      ...(text(event.createdAt || event.ts) ? { timestamp: text(event.createdAt || event.ts, 80) } : {}),
    };
    relevant.push(record);
    chars += content.length;
    if (chars >= MAX_SOURCE_EVENT_CHARS) break;
  }
  return relevant;
}

export async function buildProjectMemoryWorkspaceSnapshot(projectId, options = {}) {
  const getProjectFn = options.getProject || getProject;
  const getWorkspaceFn = options.getWorkspace || getWorkspaceById;
  const project = options.project || await getProjectFn(projectId);
  if (!project) return null;
  const workspace = project.workspaceId ? await getWorkspaceFn(project.workspaceId).catch(() => null) : null;
  return {
    projectId: project.id,
    projectName: text(project.name, 160),
    rootPath: text(project.rootPath, 2_000),
    projectRevision: Number(project.revision || 0),
    workspaceId: text(project.workspaceId, 160),
    workspace: workspace ? {
      id: text(workspace.id, 160),
      rootPath: text(workspace.rootPath, 2_000),
      realRootPath: text(workspace.realRootPath, 2_000),
      revision: Number(workspace.revision || 0),
      resolutionState: text(workspace.resolutionState, 80),
      hostId: text(workspace.hostId, 160),
    } : null,
  };
}

function runtimeFromPayload(payload = {}) {
  const runtime = payload.runtime && typeof payload.runtime === 'object' ? payload.runtime : {};
  return {
    id: text(runtime.sessionId || runtime.id, 160) || 'project-memory',
    folder: text(runtime.folder, 2_000),
    tool: text(runtime.tool, 160),
    model: text(runtime.model, 160),
    effort: text(runtime.effort, 40) || 'low',
    providerProfile: text(runtime.providerProfile, 160),
  };
}

async function defaultRunPrompt({ prompt, job }) {
  const runtime = runtimeFromPayload(job.payload);
  if (!runtime.tool) throw new Error('Project memory job has no provider runtime');
  return runDetachedAssistantPrompt(runtime, prompt, {
    effort: runtime.effort,
    thinking: false,
    dangerouslySkipPermissions: false,
    interactionMode: 'plan',
    maxTurns: 1,
    allowedTools: [],
    ...(runtime.providerProfile ? { providerProfile: runtime.providerProfile } : {}),
    resolveProviderBinding: true,
    usageTracking: {
      operation: job.kind === 'extract' ? 'project_memory_extract' : 'project_memory_consolidate',
    },
  });
}

async function processClaimedExtraction(job, { store, runPrompt }) {
  const payload = job.payload || {};
  const raw = await runPrompt({
    phase: 'extract',
    job,
    prompt: buildProjectMemoryExtractionPrompt({
      scope: payload.scope,
      workspaceSnapshot: payload.workspaceSnapshot,
      events: payload.events,
    }),
  });
  const parsed = parseProjectMemoryExtraction(raw);
  const scope = job.payload?.scope || {};
  for (const candidate of parsed.candidates) {
    if (candidate.sourceEventStart < scope.sourceEventStart
      || candidate.sourceEventEnd > scope.sourceEventEnd
      || candidate.sourceEventStart > candidate.sourceEventEnd) {
      throw new Error('Project memory extractor returned a candidate outside its source event range');
    }
  }
  return store.completeExtraction(job.id, job.ownershipToken, parsed);
}

async function processClaimedConsolidation(job, { store, runPrompt }) {
  if (job.committedVersion > 0) {
    const committed = await store.getMemoryVersion(job.projectId, job.committedVersion);
    if (!committed) throw new Error('Committed Project Memory version is missing');
    await store.writeProjection(committed);
    await store.finishCommittedJob(job.id, job.ownershipToken);
    return { reconciled: true, version: committed };
  }
  const input = await store.getConsolidationInput(job.projectId);
  if (!input.stages.length) {
    await store.finishNoopJob(job.id, job.ownershipToken);
    return { reconciled: false, noOp: true, version: input.head };
  }
  const workspaceSnapshot = job.payload?.workspaceSnapshot || input.head?.workspaceSnapshot || {};
  const raw = await runPrompt({
    phase: 'consolidate',
    job,
    prompt: buildProjectMemoryConsolidationPrompt({
      previous: input.head,
      workspaceSnapshot,
      stages: input.stages,
      candidates: input.candidates,
      priorCandidates: input.priorCandidates,
      nextWatermark: input.nextWatermark,
      extractionWatermark: input.extractionWatermark,
      consolidationWatermark: input.consolidationWatermark,
    }),
  });
  const parsed = parseProjectMemoryConsolidation(raw, {
    candidateIds: [...input.candidates, ...input.priorCandidates].map((candidate) => candidate.id),
  });
  const version = await store.commitConsolidation(job.id, job.ownershipToken, {
    content: renderProjectMemoryMarkdown(parsed.sections),
    summary: parsed.summary,
    extractionWatermark: input.extractionWatermark,
    consolidationWatermark: input.nextWatermark,
    workspaceSnapshot,
    candidateIds: parsed.candidateIds,
    resolutions: parsed.resolutions,
    factResolutions: parsed.factResolutions,
    facts: parsed.facts,
  });
  await store.writeProjection(version);
  await store.finishCommittedJob(job.id, job.ownershipToken);
  return { reconciled: false, version };
}

/**
 * Drain a bounded batch of extraction jobs, then consolidate once. Durable DB
 * claims make a crashed queue harmless: a later trigger will reclaim an
 * expired job. The bounded drain also prevents a burst of terminal sessions
 * from leaving persisted jobs behind solely because their queue key deduped.
 */
export async function processProjectMemoryJobs(options = {}) {
  const store = options.store || defaultProjectMemoryStore;
  const runPrompt = options.runPrompt || defaultRunPrompt;
  const projectId = text(options.projectId, 160);
  const maxExtractJobs = Number.isInteger(options.maxExtractJobs) && options.maxExtractJobs > 0
    ? Math.min(options.maxExtractJobs, 16)
    : 8;
  await store.initialize();
  const results = [];
  for (let index = 0; index < maxExtractJobs; index += 1) {
    const job = await store.claimNextJob({ kind: 'extract', projectId });
    if (!job) break;
    try {
      const result = await processClaimedExtraction(job, { store, runPrompt });
      results.push({ kind: 'extract', jobId: job.id, ok: true, result });
    } catch (error) {
      await store.failJob(job.id, job.ownershipToken, error?.message || String(error));
      results.push({ kind: 'extract', jobId: job.id, ok: false, error: error?.message || String(error) });
    }
  }
  {
    const kind = 'consolidate';
    const job = await store.claimNextJob({ kind, projectId });
    if (job) {
      try {
        const result = await processClaimedConsolidation(job, { store, runPrompt });
        results.push({ kind, jobId: job.id, ok: true, result });
      } catch (error) {
        await store.failJob(job.id, job.ownershipToken, error?.message || String(error));
        results.push({ kind, jobId: job.id, ok: false, error: error?.message || String(error) });
      }
    }
  }
  return results;
}

function enqueueProjectMemoryWorker({ job, sessionId, provider, store, runPrompt, queue = backgroundAiQueue }) {
  return queue.enqueue(
    `project-memory:${job.projectId}`,
    () => processProjectMemoryJobs({ store, projectId: job.projectId, runPrompt }),
    {
      sessionId,
      provider,
      operation: 'project_memory',
      deadlineMs: 30 * 60_000,
      // The durable worker owns finite per-provider timeouts and leases. A
      // queue wrapper timeout must not start a second still-running worker.
      timeoutMs: 0,
    },
  );
}

export async function recoverProjectMemoryJobs(options = {}) {
  if (readProjectMemoryMode(options.env) === 'off') return { scheduled: 0, reason: 'disabled' };
  const store = options.store || defaultProjectMemoryStore;
  if (!options.initialized) await store.initialize();
  const projects = await store.listRunnableProjects({ now: options.now, limit: options.limit });
  for (const { projectId } of projects) {
    void enqueueProjectMemoryWorker({
      job: { projectId }, store, runPrompt: options.runPrompt, queue: options.queue,
    }).catch((error) => console.warn(`[project-memory] recovery failed for ${projectId}: ${error.message}`));
  }
  return { scheduled: projects.length };
}

export function startProjectMemoryRecovery(options = {}) {
  if (readProjectMemoryMode(options.env) === 'off') return () => {};
  let stopped = false;
  let running = false;
  let initialized = false;
  const scan = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await recoverProjectMemoryJobs({ ...options, initialized });
      initialized = true;
    }
    catch (error) { console.warn(`[project-memory] recovery scan failed: ${error.message}`); }
    finally { running = false; }
  };
  void scan();
  const timer = setInterval(() => { void scan(); }, options.intervalMs || 30_000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/**
 * Terminal-run trigger. It only persists/schedules a Stage 1 job and always
 * returns before the foreground run's response path can be affected.
 */
export async function scheduleProjectMemoryForFinalizedRun(input = {}) {
  if (readProjectMemoryMode(input.env) === 'off') return { scheduled: false, reason: 'disabled' };
  const session = input.session || {};
  const run = input.run || {};
  if (!text(session.projectId) || run?.state !== 'completed' || isInternalMemorySource(session, input.manifest)) {
    return { scheduled: false, reason: 'out_of_scope' };
  }
  const store = input.store || defaultProjectMemoryStore;
  const readEvents = input.readEvents || readEventsAfter;
  const workspaceSnapshot = await buildProjectMemoryWorkspaceSnapshot(session.projectId, input);
  if (!workspaceSnapshot) return { scheduled: false, reason: 'project_missing' };
  const events = filterProjectMemorySourceEvents(
    await readEvents(session.id, 0, { includeBodies: true }),
    run,
  );
  if (!events.length) return { scheduled: false, reason: 'no_source_events' };
  const sourceDigest = hash({ projectId: session.projectId, runId: run.id, events });
  const job = await store.enqueueExtraction({
    projectId: session.projectId,
    workspaceId: workspaceSnapshot.workspaceId,
    taskId: text(run.taskId || session.taskId, 160),
    sessionId: session.id,
    runId: run.id,
    provider: providerForRun(run, input.manifest),
    sourceEventStart: events[0]?.seq || 0,
    sourceEventEnd: events.at(-1)?.seq || 0,
    sourceDigest,
    payload: {
      trigger: input.trigger || 'TASK_COMPLETE',
      events,
      workspaceSnapshot,
      runtime: {
        sessionId: session.id,
        folder: session.folder,
        tool: run.tool || session.tool,
        model: run.model || session.model,
        effort: 'low',
        providerProfile: text(input.manifest?.options?.providerProfile || run?.providerProfile || session.providerProfile, 160),
      },
    },
  });
  void enqueueProjectMemoryWorker({
    job,
    sessionId: session.id,
    provider: providerForRun(run, input.manifest),
    store,
    runPrompt: input.runPrompt,
  }).catch((error) => console.warn(`[project-memory] unable to schedule ${session.projectId}: ${error.message}`));
  return { scheduled: true, jobId: job.id, trigger: input.trigger || 'TASK_COMPLETE' };
}

/**
 * NEW_SESSION_PREPARE, PROVIDER_SWITCH, and CONTEXT_PRESSURE do not create a
 * new raw source. They request a non-blocking pass over already durable stage
 * outputs, which is enough to recover a dropped in-memory queue after restart.
 */
export async function scheduleProjectMemoryRefresh(input = {}) {
  if (readProjectMemoryMode(input.env) === 'off') return { scheduled: false, reason: 'disabled' };
  const session = input.session || {};
  if (!text(session.projectId) || isInternalMemorySource(session, input.manifest)) {
    return { scheduled: false, reason: 'out_of_scope' };
  }
  const store = input.store || defaultProjectMemoryStore;
  const workspaceSnapshot = await buildProjectMemoryWorkspaceSnapshot(session.projectId, input);
  if (!workspaceSnapshot) return { scheduled: false, reason: 'project_missing' };
  const inputState = await store.getConsolidationInput(session.projectId);
  const hasRecoverableWork = await store.hasRecoverableWork(session.projectId);
  if (!inputState.stages.length && !hasRecoverableWork) return { scheduled: false, reason: 'clean' };
  const job = await store.enqueueConsolidation(session.projectId, {
    trigger: input.trigger || 'NEW_SESSION_PREPARE',
    workspaceSnapshot,
    runtime: {
      sessionId: session.id,
      folder: session.folder,
      tool: input.tool || session.tool,
      model: input.model || session.model,
      effort: 'low',
      providerProfile: text(input.providerProfile || session.providerProfile, 160),
    },
  });
  void enqueueProjectMemoryWorker({
    job,
    sessionId: session.id,
    provider: text(input.provider || input.tool || session.tool, 160),
    store,
    runPrompt: input.runPrompt,
  }).catch((error) => console.warn(`[project-memory] unable to refresh ${session.projectId}: ${error.message}`));
  return { scheduled: true, jobId: job.id, trigger: input.trigger || 'NEW_SESSION_PREPARE' };
}

/**
 * Reads a committed version only. It intentionally returns no data in shadow
 * mode, which makes shadow extraction observational rather than behavioral.
 */
export async function buildProjectMemoryContext(session, options = {}) {
  const mode = readProjectMemoryMode(options.env);
  if (!session?.projectId || mode === 'off') return '';
  const store = options.store || defaultProjectMemoryStore;
  const memory = await store.getProjectMemory(session.projectId);
  const freshDelta = await buildProjectFreshDelta(
    session.projectId,
    memory?.currentVersion || 0,
    { ...options, store, record: true },
  ).catch(() => '');
  if (mode === 'shadow') return '';
  if (!memory?.summary && !freshDelta) return '';
  const workspaceSnapshot = options.workspaceSnapshot
    || await buildProjectMemoryWorkspaceSnapshot(session.projectId, options).catch(() => null);
  const parts = [
    ...(workspaceSnapshot ? [
      'Deterministic current project/workspace reality (this overrides conflicting conversational memory):',
      JSON.stringify(workspaceSnapshot),
    ] : []),
    ...(memory?.summary ? [
      'Project Memory (Ragent-owned current project understanding; verify against current workspace/repository reality when they differ):',
      clip(memory.summary, MAX_SUMMARY_CONTEXT_CHARS),
    ] : []),
  ];
  if (freshDelta) {
    parts.push(
      'Recent verified changes not yet consolidated (temporary Fresh Delta; cite its source before relying on it):',
      freshDelta,
    );
  }
  if (mode === 'full' && memory?.content) {
    parts.push('Relevant current Project Memory:', clip(memory.content, MAX_FULL_CONTEXT_CHARS));
  }
  return parts.join('\n\n');
}

/**
 * Build the short-lived continuity bridge from verified Stage 1 candidates
 * after the current Project head. It never promotes data to the head and it
 * deliberately excludes tentative/rejected candidates and raw event bodies.
 */
export async function buildProjectFreshDelta(projectId, headVersion = 0, options = {}) {
  const normalizedProjectId = text(projectId, 160);
  if (!normalizedProjectId) return '';
  const store = options.store || defaultProjectMemoryStore;
  const input = await store.getConsolidationInput(normalizedProjectId);
  if (headVersion && input.head && input.head.currentVersion !== headVersion) return '';
  const maxItems = Number.isInteger(options.maxItems) ? Math.max(1, Math.min(options.maxItems, 8)) : 8;
  const candidates = input.candidates
    .filter((candidate) => candidate.confidence === 'verified'
      && !['superseded', 'invalidated'].includes(candidate.state))
    .slice(0, maxItems);
  const content = candidates.map((candidate) => {
    const source = `${candidate.stage1Id}/${candidate.sessionId || 'session'}:${candidate.sourceEventStart}-${candidate.sourceEventEnd}`;
    return `- ${clip(candidate.statement, 900)} (source: ${source})`;
  }).join('\n');
  if (options.record !== false && typeof store.recordFreshDelta === 'function') {
    await store.recordFreshDelta(normalizedProjectId, {
      baseVersion: input.head?.currentVersion || 0,
      consolidationWatermark: input.consolidationWatermark,
      content,
      candidateIds: candidates.map((candidate) => candidate.id),
    });
  }
  return content;
}

// Kept explicit for feature probes and deterministic tests; it is not a
// second toggle for the engine itself.
export function isProjectMemoryShadowMode(env = process.env) {
  return readProjectMemoryMode(env) === 'shadow';
}
