import { createHash } from 'node:crypto';

export const CROSS_PROVIDER_CONTINUITY_SCHEMA_VERSION = 1;
export const CONTINUITY_FACT_CLASSES = Object.freeze([
  'durable',
  'workspace',
  'ephemeral',
  'historical',
]);
export const CONTINUITY_FACT_LIFECYCLES = Object.freeze([
  'durable',
  'current',
  'refresh-needed',
  'invalid',
  'superseded',
]);

const MAX_FACTS = 64;
const MAX_REFS = 32;
const MAX_TEXT = 2400;
const METADATA_KEYS = new Set([
  'sourceRefs', 'evidenceRefs', 'recordedBy', 'recordedAt', 'lastVerifiedAt',
]);

function text(value, maxChars = MAX_TEXT) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maxChars) : '';
}

function iso(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function boundedValue(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.slice(0, MAX_FACTS).map((entry) => boundedValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (METADATA_KEYS.has(key)) continue;
    const next = boundedValue(value[key], depth + 1);
    if (next !== null && next !== undefined && next !== '') result[key] = next;
  }
  return result;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function normalizeRefs(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const refs = [];
  const seen = new Set();
  for (const entry of values.slice(0, MAX_REFS)) {
    const ref = typeof entry === 'string'
      ? { ref: text(entry, 300) }
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? {
            ...(positiveInt(entry.seq) ? { seq: entry.seq } : {}),
            ...(text(entry.runId, 180) ? { runId: text(entry.runId, 180) } : {}),
            ...(text(entry.eventId, 180) ? { eventId: text(entry.eventId, 180) } : {}),
            ...(text(entry.toolExecutionId, 180) ? { toolExecutionId: text(entry.toolExecutionId, 180) } : {}),
            ...(text(entry.ref, 300) ? { ref: text(entry.ref, 300) } : {}),
          }
        : {};
    if (Object.keys(ref).length === 0) continue;
    const key = canonicalJson(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function eventIndex(events) {
  const index = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (positiveInt(event?.seq)) index.set(event.seq, event);
  }
  return index;
}

function refsTimestamp(refs, eventsBySeq) {
  for (const ref of [...refs].reverse()) {
    const event = eventsBySeq.get(ref.seq);
    const timestamp = iso(event?.timestamp || event?.createdAt || event?.updatedAt);
    if (timestamp) return timestamp;
  }
  return null;
}

function sourceFor(value, fallback = 'derived') {
  const recordedBy = text(value?.recordedBy, 80).toLowerCase();
  if (recordedBy === 'user') return 'user_message';
  if (recordedBy === 'agent') return 'agent_conclusion';
  if (recordedBy === 'system') return 'system_projection';
  return fallback;
}

function normalizeConfidence(value, fallback = 'medium') {
  const normalized = text(value, 40).toLowerCase();
  return ['high', 'medium', 'low'].includes(normalized) ? normalized : fallback;
}

function makeProvenance(value, {
  refs = [],
  eventsBySeq,
  source = null,
  recordedAt = null,
  lastVerifiedAt = null,
  confidence = 'medium',
  trust = 'derived',
} = {}) {
  const normalizedRefs = normalizeRefs(refs.length > 0 ? refs : value?.sourceRefs);
  return {
    source: source || sourceFor(value),
    ...(iso(recordedAt || value?.decidedAt || value?.attemptedAt || refsTimestamp(normalizedRefs, eventsBySeq))
      ? { recordedAt: iso(recordedAt || value?.decidedAt || value?.attemptedAt || refsTimestamp(normalizedRefs, eventsBySeq)) }
      : {}),
    ...(iso(lastVerifiedAt) ? { lastVerifiedAt: iso(lastVerifiedAt) } : {}),
    confidence: normalizeConfidence(confidence),
    trust: text(trust, 40) || 'derived',
    evidenceRefs: normalizedRefs,
  };
}

function makeFact({
  id,
  kind,
  classification,
  lifecycle,
  value,
  provenance,
}) {
  const normalizedId = text(id, 180);
  if (!normalizedId || !CONTINUITY_FACT_CLASSES.includes(classification)) return null;
  const normalizedLifecycle = CONTINUITY_FACT_LIFECYCLES.includes(lifecycle) ? lifecycle : 'current';
  return {
    id: normalizedId,
    kind: text(kind, 100) || 'fact',
    classification,
    lifecycle: normalizedLifecycle,
    value: boundedValue(value),
    provenance: {
      source: text(provenance?.source, 80) || 'derived',
      ...(iso(provenance?.recordedAt) ? { recordedAt: iso(provenance.recordedAt) } : {}),
      ...(iso(provenance?.lastVerifiedAt) ? { lastVerifiedAt: iso(provenance.lastVerifiedAt) } : {}),
      confidence: normalizeConfidence(provenance?.confidence),
      trust: text(provenance?.trust, 40) || 'derived',
      evidenceRefs: normalizeRefs(provenance?.evidenceRefs),
    },
  };
}

function factFromEntry(entry, {
  id,
  kind,
  classification,
  lifecycle = 'current',
  eventsBySeq,
  source = null,
  confidence = 'medium',
  trust = 'derived',
  lastVerifiedAt = null,
} = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const refs = normalizeRefs(entry.sourceRefs);
  return makeFact({
    id: id || entry.id || `${kind}:${digest(entry).slice(-12)}`,
    kind,
    classification,
    lifecycle,
    value: entry,
    provenance: makeProvenance(entry, {
      refs,
      eventsBySeq,
      source,
      confidence,
      trust,
      lastVerifiedAt,
    }),
  });
}

function normalizeInputFacts(value) {
  const values = Array.isArray(value) ? value : [];
  return values.slice(0, MAX_FACTS).map((entry, index) => {
    if (typeof entry === 'string') return { id: `constraint:${index + 1}`, text: text(entry) };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const normalized = boundedValue(entry);
    return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? { id: text(entry.id, 180) || `constraint:${index + 1}`, ...normalized }
      : null;
  }).filter(Boolean);
}

function workspaceLifecycle(workspace) {
  return workspace?.stale === true || !workspaceLastVerifiedAt(workspace)
    ? 'refresh-needed'
    : 'current';
}

function workspaceLastVerifiedAt(workspace) {
  return iso(workspace?.observedAt || workspace?.lastVerifiedAt);
}

function normalizeRuntimeBinding(binding, eventsBySeq, target = {}) {
  if (!binding || typeof binding !== 'object') return null;
  const provider = text(binding.provider || binding.providerKey || binding.bindingId, 120) || 'unknown';
  const runtimeFamily = text(binding.runtimeFamily || binding.runtime, 160) || 'unknown';
  const nativeSessionKnown = Boolean(text(binding.nativeSessionId || binding.resumeId, 500));
  const refs = normalizeRefs(binding.sourceRefs);
  return {
    id: text(binding.bindingId || binding.providerKey, 180) || provider,
    provider,
    runtimeFamily,
    ...(text(binding.providerProfile, 180) ? { providerProfile: text(binding.providerProfile, 180) } : {}),
    ...(text(binding.model, 240) ? { model: text(binding.model, 240) } : {}),
    nativeResume: {
      available: nativeSessionKnown,
      transferable: false,
      reason: text(target.provider) && target.provider !== provider
        ? 'CROSS_PROVIDER_TRANSFER'
        : 'NATIVE_BINDING_REMAINS_PROVIDER_SCOPED',
      ...(positiveInt(binding.coveredThroughSeq) ? { coveredThroughSeq: binding.coveredThroughSeq } : {}),
    },
    semanticResume: {
      available: true,
      mode: 'new-provider-session',
      targetProvider: text(target.provider, 120) || provider,
      targetRuntimeFamily: text(target.runtimeFamily, 160) || runtimeFamily,
    },
    lifecycle: 'ephemeral',
    provenance: makeProvenance(binding, {
      refs,
      eventsBySeq,
      source: 'runtime_event',
      confidence: 'high',
      trust: 'observed',
    }),
  };
}

export function buildCrossProviderContinuityBundle({
  sessionId = '',
  projectId = '',
  rootSessionId = '',
  sessionName = '',
  checkpoint = null,
  events = [],
  constraints = [],
  targetProvider = '',
  targetRuntimeFamily = '',
  targetProviderProfile = '',
  targetModel = '',
  generatedAt = null,
} = {}) {
  const state = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const task = state.task && typeof state.task === 'object' ? state.task : {};
  const execution = state.execution && typeof state.execution === 'object' ? state.execution : {};
  const eventsBySeq = eventIndex(events);
  const generated = iso(generatedAt, new Date().toISOString());
  const workspace = execution.workspace && typeof execution.workspace === 'object' ? execution.workspace : null;
  const workspaceLifecycleState = workspace ? workspaceLifecycle(workspace) : 'refresh-needed';
  const workspaceVerifiedAt = workspaceLastVerifiedAt(workspace);
  const gitVerifiedAt = iso(execution.git?.observedAt || execution.git?.lastVerifiedAt);
  const gitLifecycleState = execution.git
    ? (execution.git.stale === true || !gitVerifiedAt ? 'refresh-needed' : 'current')
    : workspaceLifecycleState;
  const target = {
    provider: text(targetProvider, 120),
    runtimeFamily: text(targetRuntimeFamily, 160),
  };

  const goal = factFromEntry(task.goal, {
    id: 'task-goal', kind: 'goal', classification: 'durable', lifecycle: 'durable',
    eventsBySeq, confidence: 'high', trust: 'recorded',
  });
  const status = factFromEntry({ status: text(task.status, 80) || 'idle' }, {
    id: 'task-status', kind: 'status', classification: 'durable', lifecycle: 'current',
    eventsBySeq, source: 'system_projection', confidence: 'high', trust: 'derived',
  });
  const completedWork = (Array.isArray(task.completedWork) ? task.completedWork : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'completed_work', classification: 'historical', lifecycle: 'durable', eventsBySeq,
      confidence: 'high', trust: 'recorded',
    })).filter(Boolean).slice(-MAX_FACTS);
  const decisions = (Array.isArray(task.decisions) ? task.decisions : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'decision', classification: 'durable', lifecycle: entry.status === 'superseded' ? 'superseded' : 'durable', eventsBySeq,
      confidence: 'high', trust: 'recorded',
    })).filter(Boolean).slice(-MAX_FACTS);
  const failedAttempts = (Array.isArray(task.failedAttempts) ? task.failedAttempts : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'failed_attempt', classification: 'historical', lifecycle: entry.status === 'superseded' ? 'superseded' : 'durable', eventsBySeq,
      confidence: 'high', trust: 'recorded',
    })).filter(Boolean).slice(-MAX_FACTS);
  const planSteps = Array.isArray(task.plan?.steps) ? task.plan.steps : [];
  const pendingWork = planSteps
    .filter((step) => !['completed', 'resolved', 'superseded'].includes(text(step.status, 80).toLowerCase()))
    .map((step) => factFromEntry(step, {
      kind: 'pending_work', classification: 'durable', lifecycle: 'current', eventsBySeq,
      confidence: 'medium', trust: 'recorded',
    })).filter(Boolean).slice(-MAX_FACTS);
  const nextActions = task.nextAction
    ? [factFromEntry(task.nextAction, {
        id: 'next-action', kind: 'next_action', classification: 'durable', lifecycle: 'current', eventsBySeq,
        confidence: 'high', trust: 'recorded',
      })].filter(Boolean)
    : [];
  const openQuestions = (Array.isArray(task.unresolved) ? task.unresolved : [])
    .filter((entry) => entry?.status !== 'resolved' && entry?.status !== 'superseded')
    .map((entry) => factFromEntry(entry, {
      kind: 'open_question', classification: 'durable', lifecycle: 'current', eventsBySeq,
      confidence: 'medium', trust: 'recorded',
    })).filter(Boolean).slice(-MAX_FACTS);
  const normalizedConstraints = normalizeInputFacts(constraints)
    .map((entry) => factFromEntry(entry, {
      kind: 'constraint', classification: 'durable', lifecycle: 'durable', eventsBySeq,
      source: 'user_message', confidence: 'high', trust: 'recorded',
    })).filter(Boolean);

  const workspaceFact = workspace
    ? factFromEntry(workspace, {
        id: 'workspace-snapshot', kind: 'workspace_snapshot', classification: 'workspace',
        lifecycle: workspaceLifecycleState, eventsBySeq, source: 'filesystem', confidence: workspace.stale ? 'medium' : 'high',
        trust: 'observed', lastVerifiedAt: workspaceVerifiedAt,
      })
    : null;
  const gitFact = execution.git
    ? factFromEntry(execution.git, {
        id: 'git-snapshot', kind: 'git_snapshot', classification: 'workspace',
        lifecycle: gitLifecycleState, eventsBySeq, source: 'git', confidence: gitLifecycleState === 'refresh-needed' ? 'medium' : 'high',
        trust: 'observed', lastVerifiedAt: gitVerifiedAt,
      })
    : null;
  const files = (Array.isArray(execution.files) ? execution.files : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'file_state', classification: 'workspace', lifecycle: workspaceLifecycleState, eventsBySeq,
      source: 'filesystem', confidence: workspace?.stale ? 'medium' : 'high', trust: 'observed', lastVerifiedAt: workspaceVerifiedAt,
    })).filter(Boolean).slice(-MAX_FACTS);
  const validations = (Array.isArray(execution.validations) ? execution.validations : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'validation', classification: 'workspace', lifecycle: workspaceLifecycleState, eventsBySeq,
      source: 'test', confidence: workspace?.stale ? 'medium' : 'high', trust: 'observed', lastVerifiedAt: workspaceVerifiedAt,
    })).filter(Boolean).slice(-MAX_FACTS);
  const importantArtifacts = (Array.isArray(execution.artifacts) ? execution.artifacts : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'artifact', classification: 'historical', lifecycle: 'current', eventsBySeq,
      source: 'filesystem', confidence: 'high', trust: 'observed',
    })).filter(Boolean).slice(-MAX_FACTS);
  const activeRun = execution.activeRunId
    ? factFromEntry({ id: execution.activeRunId, state: 'active' }, {
        id: 'active-run', kind: 'active_run', classification: 'ephemeral', lifecycle: 'current', eventsBySeq,
        source: 'runtime_event', confidence: 'high', trust: 'observed',
      })
    : null;
  const processes = (Array.isArray(execution.processes) ? execution.processes : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'process', classification: 'ephemeral', lifecycle: 'current', eventsBySeq,
      source: 'runtime_event', confidence: 'high', trust: 'observed',
    })).filter(Boolean).slice(-MAX_FACTS);
  const approvals = (Array.isArray(execution.approvals) ? execution.approvals : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'approval', classification: 'ephemeral', lifecycle: 'current', eventsBySeq,
      source: 'runtime_event', confidence: 'high', trust: 'observed',
    })).filter(Boolean).slice(-MAX_FACTS);
  const tools = (Array.isArray(execution.tools) ? execution.tools : [])
    .map((entry) => factFromEntry(entry, {
      kind: 'runtime_tool', classification: 'ephemeral', lifecycle: 'current', eventsBySeq,
      source: 'runtime_event', confidence: 'high', trust: 'observed',
    })).filter(Boolean).slice(-MAX_FACTS);
  const runtimeBindings = (Array.isArray(state.bindings) ? state.bindings : [])
    .map((entry) => normalizeRuntimeBinding(entry, eventsBySeq, target)).filter(Boolean).slice(-MAX_FACTS);

  const allRefs = [
    ...[goal, status, ...completedWork, ...decisions, ...failedAttempts, ...pendingWork, ...nextActions, ...openQuestions, ...normalizedConstraints],
    ...[workspaceFact, gitFact, ...files, ...validations, ...importantArtifacts, activeRun, ...processes, ...approvals, ...tools],
  ].flatMap((entry) => entry?.provenance?.evidenceRefs || []);
  const bundle = {
    schemaVersion: CROSS_PROVIDER_CONTINUITY_SCHEMA_VERSION,
    identity: {
      sessionId: text(sessionId, 240),
      ...(text(projectId, 240) ? { projectId: text(projectId, 240) } : {}),
      ...(text(rootSessionId, 240) ? { rootSessionId: text(rootSessionId, 240) } : {}),
      ...(text(sessionName, 300) ? { sessionName: text(sessionName, 300) } : {}),
    },
    task: {
      goal,
      status,
    },
    currentState: {
      taskStatus: text(task.status, 80) || 'idle',
      plan: task.plan ? boundedValue(task.plan) : null,
      completion: boundedValue(state.completion || null),
      requiredUserInput: Boolean(state.requiredUserInput),
    },
    completedWork,
    pendingWork,
    decisions,
    constraints: normalizedConstraints,
    failedAttempts,
    workspaceState: {
      snapshot: workspaceFact,
      git: gitFact,
      files,
      validations,
    },
    importantArtifacts,
    runtimeBindings,
    ephemeralExecution: {
      transferability: 'do-not-inherit',
      activeRun,
      processes,
      approvals,
      tools,
    },
    openQuestions,
    nextActions,
    provenance: {
      source: 'agentoc-continuity-state',
      checkpointRevision: Number.isInteger(state.revision) ? state.revision : 0,
      eventDigest: text(state.coverage?.eventDigest, 240),
      generatedAt: generated,
      evidenceRefs: normalizeRefs(allRefs),
    },
    freshness: {
      state: workspaceLifecycleState === 'refresh-needed' ? 'refresh-needed' : 'current',
      generatedAt: generated,
      workspace: {
        state: workspaceLifecycleState,
        ...(workspaceVerifiedAt ? { lastVerifiedAt: workspaceVerifiedAt } : {}),
        ...(text(workspace?.staleReason, 500) ? { reason: text(workspace.staleReason, 500) } : {}),
      },
      nativeResume: 'provider-scoped; never inherit across providers',
    },
    target: {
      provider: target.provider,
      runtimeFamily: target.runtimeFamily,
      ...(text(targetProviderProfile, 180) ? { providerProfile: text(targetProviderProfile, 180) } : {}),
      ...(text(targetModel, 240) ? { model: text(targetModel, 240) } : {}),
    },
  };
  const digestInput = structuredClone(bundle);
  delete digestInput.generatedAt;
  delete digestInput.provenance.generatedAt;
  delete digestInput.freshness.generatedAt;
  bundle.bundleDigest = digest(digestInput);
  validateCrossProviderContinuityBundle(bundle);
  return bundle;
}

export function validateCrossProviderContinuityBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== CROSS_PROVIDER_CONTINUITY_SCHEMA_VERSION) {
    throw new Error('unsupported cross-provider continuity schemaVersion');
  }
  for (const key of ['identity', 'task', 'currentState', 'completedWork', 'pendingWork', 'decisions', 'constraints', 'failedAttempts', 'workspaceState', 'importantArtifacts', 'runtimeBindings', 'ephemeralExecution', 'openQuestions', 'nextActions', 'provenance', 'freshness']) {
    if (!(key in bundle)) throw new Error(`continuity bundle is missing ${key}`);
  }
  const facts = [
    bundle.task.goal, bundle.task.status,
    ...bundle.completedWork, ...bundle.pendingWork, ...bundle.decisions,
    ...bundle.constraints, ...bundle.failedAttempts,
    bundle.workspaceState.snapshot, bundle.workspaceState.git,
    ...bundle.workspaceState.files, ...bundle.workspaceState.validations,
    ...bundle.importantArtifacts, bundle.ephemeralExecution.activeRun,
    ...bundle.ephemeralExecution.processes, ...bundle.ephemeralExecution.approvals,
    ...bundle.ephemeralExecution.tools, ...bundle.openQuestions, ...bundle.nextActions,
  ].filter(Boolean);
  for (const fact of facts) {
    if (!text(fact.id, 180) || !CONTINUITY_FACT_CLASSES.includes(fact.classification)) {
      throw new Error('continuity bundle fact identity/classification is invalid');
    }
    if (!CONTINUITY_FACT_LIFECYCLES.includes(fact.lifecycle)) throw new Error('continuity bundle fact lifecycle is invalid');
    if (!fact.provenance || !Array.isArray(fact.provenance.evidenceRefs)) throw new Error('continuity bundle fact provenance is missing');
  }
  if (bundle.ephemeralExecution.transferability !== 'do-not-inherit') {
    throw new Error('ephemeral execution must be explicitly non-transferable');
  }
  if (!Array.isArray(bundle.provenance.evidenceRefs)) throw new Error('continuity bundle provenance is invalid');
  return true;
}

export function renderCrossProviderContinuityBundle(bundle, { maxChars = 32_000 } = {}) {
  validateCrossProviderContinuityBundle(bundle);
  const rendered = [
    '[Ragent cross-provider semantic continuity bundle]',
    'This bundle is the provider-neutral semantic state. Do not resume or inherit provider-native sessions from it.',
    'Workspace facts with lifecycle "refresh-needed" must be revalidated before relying on them.',
    JSON.stringify(bundle, null, 2),
  ].join('\n');
  if (rendered.length > maxChars) {
    const error = new Error(`continuity bundle exceeds ${maxChars} characters`);
    error.code = 'CONTINUITY_BUNDLE_TOO_LARGE';
    throw error;
  }
  return rendered;
}
