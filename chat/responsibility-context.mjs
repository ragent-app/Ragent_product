import { getResponsibility, listResponsibilityActivity, listResponsibilityWorkLinks } from './responsibility-service.mjs';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { getFactoryWorkItem } from './factory-control.mjs';
import {
  defaultUserMemoryStore,
  USER_MEMORY_SOURCE_PRIORITY,
  validateUserMemoryWrite,
} from './user-memory-store.mjs';
import { defaultEpisodicMemoryStore } from './episodic-memory-store.mjs';
import * as responsibilityMemory from './responsibility-memory.mjs';

export const CONTEXT_MEMORY_LAYERS = Object.freeze([
  'user',
  'project',
  'responsibility',
  'episodic',
  'working',
]);

export const SOURCE_QUALITY_RANK = USER_MEMORY_SOURCE_PRIORITY;

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_MAX_BYTES = 16_384;
const DEFAULT_MAX_ITEMS = 200;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'have', 'will',
  'are', 'was', 'were', 'not', 'but', 'can', 'use', 'using',
]);

const UNTRUSTED_CHANNELS = new Set([
  'external_untrusted',
  'external',
  'web',
  'email',
  'repo',
  'repository',
  'webhook',
  'ci_log',
  'untrusted',
  'prompt_injection',
]);

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function normalizeKey(value) {
  return text(value, 160).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function parseMs(isoString) {
  if (!isoString || typeof isoString !== 'string') return null;
  const ms = Date.parse(isoString);
  return Number.isFinite(ms) ? ms : null;
}

function tokenizeKeywords(values) {
  const rawList = Array.isArray(values) ? values : [values];
  const tokens = [];
  for (const val of rawList) {
    if (typeof val !== 'string') continue;
    const parts = val
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
    for (const part of parts) {
      tokens.push(part);
      if (/\p{Script=Han}/u.test(part) && part.length > 3) {
        const chars = Array.from(part);
        for (let i = 0; i < chars.length - 1 && i < 24; i += 1) {
          const gram = `${chars[i]}${chars[i + 1]}`;
          if (/\p{Script=Han}{2}/u.test(gram)) tokens.push(gram);
        }
      }
    }
  }
  return [...new Set(tokens)].slice(0, 64);
}

function resolveQueryKeywords({ query, keywords, responsibility }) {
  const explicit = tokenizeKeywords([
    ...(typeof query === 'string' ? [query] : []),
    ...(Array.isArray(keywords) ? keywords : typeof keywords === 'string' ? [keywords] : []),
  ]);
  if (explicit.length) return explicit;
  return tokenizeKeywords([
    responsibility?.objective || '',
    ...(Array.isArray(responsibility?.successCriteria) ? responsibility.successCriteria : []),
  ]);
}

function computeKeywordRelevance(item, queryKeywords) {
  if (!queryKeywords.length) return 0;
  const corpus = [
    item.factKey || '',
    item.text || '',
    ...(Array.isArray(item.meta?.keywords) ? item.meta.keywords : []),
    item.meta?.failureRootCause || '',
    item.meta?.repairAttempt || '',
    item.meta?.category || '',
  ].join(' ').toLowerCase();
  if (!corpus) return 0;
  let hits = 0;
  for (const kw of queryKeywords) {
    if (corpus.includes(kw)) hits += 1;
  }
  return hits / queryKeywords.length;
}

function estimateSerializedEntry(entry) {
  const json = JSON.stringify(entry);
  const bytes = Buffer.byteLength(json, 'utf8');
  const tokens = Math.max(1, Math.ceil(bytes / 4));
  return { bytes, tokens };
}

function resolveProjectFactProvenance(projectId, fact, provenance = []) {
  const version = fact.factVersion || fact.currentVersion || 0;
  const matching = provenance.filter(
    (entry) => entry.factId === fact.factId && Number(entry.factVersion || 0) === Number(version),
  );
  const userProv = matching.find((entry) => entry.provider === 'user');
  if (userProv) {
    return {
      sourceKind: 'user',
      sourceType: 'user_rule',
      sourceRef: `project-memory:${projectId}:fact:${fact.factId}@v${version}:${userProv.stage1Id || 'user'}`,
    };
  }
  const toolProv = matching.find((entry) => ['tool', 'system'].includes(entry.provider));
  if (toolProv) {
    return {
      sourceKind: toolProv.provider,
      sourceType: 'tool_verified',
      sourceRef: `project-memory:${projectId}:fact:${fact.factId}@v${version}:${toolProv.stage1Id || toolProv.provider}`,
    };
  }
  const untrustedProv = matching.find((entry) => entry.provider === 'external_untrusted');
  if (untrustedProv) {
    return {
      sourceKind: 'external_untrusted',
      sourceType: 'external_untrusted',
      sourceRef: `project-memory:${projectId}:fact:${fact.factId}@v${version}:external_untrusted`,
    };
  }
  const firstProv = matching[0] || null;
  if (firstProv) {
    const runPart = firstProv.runId ? `run:${firstProv.runId}` : `stage:${firstProv.stage1Id || 'model'}`;
    const sessPart = firstProv.sessionId ? `:session:${firstProv.sessionId}` : '';
    const rangePart = `#events:${Number(firstProv.sourceEventStart || 0)}-${Number(firstProv.sourceEventEnd || 0)}`;
    return {
      sourceKind: 'unknown',
      sourceType: 'model_inferred',
      sourceRef: `${runPart}${sessPart}${rangePart}`,
    };
  }
  return {
    sourceKind: 'unknown',
    sourceType: 'model_inferred',
    sourceRef: `project-memory:${projectId}:fact:${fact.factId}@v${version}`,
  };
}

/**
 * Stage 1 (Extract): normalize raw user/execution inputs into explicitly
 * source-tagged candidates without trusting unverified role/rule claims.
 */
export function extractMemoryCandidates(input = {}) {
  const ownerPrincipalId = text(input.ownerPrincipalId, 160);
  const projectId = text(input.projectId, 160);
  const responsibilityId = text(input.responsibilityId, 160);
  const rawSources = Array.isArray(input.sources)
    ? input.sources
    : [
        ...(Array.isArray(input.userInputs) ? input.userInputs.map((entry) => ({ ...entry, layer: 'user' })) : []),
        ...(Array.isArray(input.executionInputs) ? input.executionInputs.map((entry) => ({ ...entry, layer: 'episodic' })) : []),
      ];

  const candidates = [];
  for (const raw of rawSources) {
    if (!raw || typeof raw !== 'object') continue;
    const layer = raw.layer === 'episodic' || raw.outcome !== undefined ? 'episodic' : 'user';
    const channel = text(raw.channel || raw.originType || raw.sourceKind || '', 80).toLowerCase();
    const isUntrustedChannel = UNTRUSTED_CHANNELS.has(channel) || raw.untrusted === true;
    const targetPolicy = Boolean(
      raw.target === 'responsibility_policy'
      || raw.category === 'responsibility_policy'
      || raw.altersPolicy === true,
    );

    if (layer === 'episodic') {
      const sourceType = text(raw.sourceType || (isUntrustedChannel ? 'external_untrusted' : 'tool_verified'), 60);
      candidates.push({
        layer: 'episodic',
        targetPolicy,
        ownerPrincipalId: text(raw.ownerPrincipalId || ownerPrincipalId, 160),
        organizationId: text(raw.organizationId, 160),
        projectId: text(raw.projectId || projectId, 160),
        responsibilityId: text(raw.responsibilityId || responsibilityId, 160),
        wakeId: text(raw.wakeId, 160),
        goalId: text(raw.goalId, 160),
        workItemId: text(raw.workItemId || raw.workItem?.id, 160),
        runId: text(raw.runId || raw.run?.id || raw.packet?.runId, 160),
        packetId: text(raw.packetId || raw.packet?.packetId, 160),
        episodeKey: text(raw.episodeKey, 200),
        outcome: text(raw.outcome || (raw.packet?.state) || 'partial', 40),
        summary: text(raw.summary || raw.packet?.summary || '', 2000),
        failureRootCause: text(raw.failureRootCause || '', 2000),
        repairAttempt: text(raw.repairAttempt || '', 2000),
        repairStatus: text(raw.repairStatus || (raw.repairAttempt ? 'attempted' : 'none'), 40),
        artifactLinks: Array.isArray(raw.artifactLinks) ? raw.artifactLinks : [],
        keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
        sourceType,
        sourceRef: text(raw.sourceRef || (raw.packetId ? `packet:${raw.packetId}` : raw.runId ? `run:${raw.runId}` : ''), 500),
        originType: channel || (isUntrustedChannel ? 'external_untrusted' : ''),
        untrusted: isUntrustedChannel,
        confidence: raw.confidence,
        validUntil: raw.validUntil ?? null,
        ttlMs: raw.ttlMs,
        idempotencyKey: text(raw.idempotencyKey, 160),
        packet: raw.packet || null,
        run: raw.run || null,
        workItem: raw.workItem || null,
        attempt: raw.attempt || null,
      });
      continue;
    }

    const declaredSource = text(raw.sourceType || (isUntrustedChannel ? 'external_untrusted' : 'model_inferred'), 60);
    candidates.push({
      layer: 'user',
      targetPolicy,
      mode: text(raw.mode || 'upsert', 20),
      ownerPrincipalId: text(raw.ownerPrincipalId || ownerPrincipalId, 160),
      category: text(raw.category || (declaredSource === 'user_rule' ? 'user_rule' : 'preference'), 60),
      factKey: text(raw.factKey ?? raw.key, 160),
      factValue: text(raw.factValue ?? raw.value ?? raw.statement ?? raw.content, 2000),
      sourceType: declaredSource,
      sourceRef: text(raw.sourceRef, 500),
      originType: channel || (isUntrustedChannel ? 'external_untrusted' : ''),
      untrusted: isUntrustedChannel,
      scope: raw.scope ?? (raw.responsibilityId ? { type: 'responsibility', projectId: raw.projectId || projectId, responsibilityId: raw.responsibilityId } : raw.projectId ? { type: 'project', projectId: raw.projectId } : 'global'),
      confidence: raw.confidence,
      validUntil: raw.validUntil ?? null,
      supersedesFactId: text(raw.supersedesFactId, 120),
      idempotencyKey: text(raw.idempotencyKey, 160),
      reason: text(raw.reason, 500),
      metadata: raw.metadata,
    });
  }

  return {
    schemaVersion: 1,
    ownerPrincipalId,
    projectId,
    responsibilityId,
    candidates,
  };
}

/**
 * Stage 2 (Validate / Consolidate): enforce strict source isolation before
 * persisting into User Memory or Episodic Memory.
 * - Untrusted external text can never create `user_rule` or alter Responsibility policy.
 * - `model_inferred` can never overwrite or supersede an active `user_rule`.
 */
export async function validateAndConsolidateMemory(input = {}, options = {}) {
  const userMemoryStore = options.userMemoryStore || defaultUserMemoryStore;
  const episodicMemoryStore = options.episodicMemoryStore || defaultEpisodicMemoryStore;
  const actor = options.actor || input.actor || null;
  const throwOnBlocked = options.throwOnBlocked === true;
  const extracted = Array.isArray(input.candidates) ? input : extractMemoryCandidates(input);

  const accepted = [];
  const rejected = [];

  for (let i = 0; i < extracted.candidates.length; i += 1) {
    const candidate = extracted.candidates[i];
    const fallbackKey = `${text(input.idempotencyKeyPrefix || 'pipeline', 100)}:${i}`;
    const idempotencyKey = text(candidate.idempotencyKey || fallbackKey, 160);

    try {
      if (candidate.targetPolicy) {
        throw Object.assign(
          new Error('Memory candidates cannot alter Responsibility policy'),
          { statusCode: 403, code: 'RESPONSIBILITY_POLICY_ISOLATION' },
        );
      }

      if (candidate.layer === 'episodic') {
        if (candidate.packet || candidate.run || candidate.workItem) {
          const rec = await episodicMemoryStore.extractEpisodeFromExecution({
            ...candidate,
            idempotencyKey,
          }, { actor, now: options.now });
          accepted.push({ layer: 'episodic', episode: rec.episode, replayed: rec.replayed });
        } else {
          const rec = await episodicMemoryStore.recordEpisode({
            ...candidate,
            idempotencyKey,
          }, { actor, now: options.now });
          accepted.push({ layer: 'episodic', episode: rec.episode, replayed: rec.replayed });
        }
        continue;
      }

      validateUserMemoryWrite({ ...candidate, operation: candidate.mode === 'create' ? 'create' : 'upsert' }, null, actor);
      const res = candidate.mode === 'create'
        ? await userMemoryStore.createUserMemoryFact({ ...candidate, idempotencyKey }, { actor, now: options.now })
        : await userMemoryStore.upsertUserMemoryFact({ ...candidate, idempotencyKey }, { actor, now: options.now });
      accepted.push({
        layer: 'user',
        action: res.action || 'created',
        fact: res.fact,
        ...(res.supersededFact ? { supersededFact: res.supersededFact } : {}),
        replayed: res.replayed,
      });
    } catch (err) {
      if (throwOnBlocked) throw err;
      rejected.push({
        status: 'rejected',
        blocked: true,
        code: err?.code || 'MEMORY_VALIDATION_REJECTED',
        statusCode: err?.statusCode || 400,
        reason: err?.message || 'Memory candidate rejected',
        candidate,
      });
    }
  }

  return {
    schemaVersion: 1,
    accepted,
    rejected,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
  };
}

/**
 * Stage 3 (Retrieve): unify all 5 memory layers, filter strictly by
 * owner / project / responsibility, exclude retracted/expired/untrusted items,
 * rank by evidence quality (`user_rule > tool_verified > model_inferred`) +
 * keyword relevance, and trim deterministically to token/byte budget while
 * preserving `sourceType` & `sourceRef` provenance on every included item.
 */
export async function retrieveFiveLayerMemoryContext(input = {}) {
  const ownerPrincipalId = text(input.ownerPrincipalId, 160);
  const projectId = text(input.projectId, 160);
  const responsibilityId = text(input.responsibilityId, 160);
  const asOfDate = input.now ? new Date(input.now) : new Date();
  const asOfMs = Number.isFinite(asOfDate.getTime()) ? asOfDate.getTime() : Date.now();
  const asOfIso = new Date(asOfMs).toISOString();

  const maxTokens = Number.isSafeInteger(input.maxTokens) && input.maxTokens > 0
    ? input.maxTokens
    : DEFAULT_MAX_TOKENS;
  const maxBytes = Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0
    ? input.maxBytes
    : DEFAULT_MAX_BYTES;
  const maxItems = Number.isSafeInteger(input.maxItems) && input.maxItems > 0
    ? input.maxItems
    : DEFAULT_MAX_ITEMS;

  const userMemoryStore = input.userMemoryStore || defaultUserMemoryStore;
  const episodicMemoryStore = input.episodicMemoryStore || defaultEpisodicMemoryStore;
  const projectMemoryStore = input.projectMemoryStore || defaultProjectMemoryStore;

  const responsibility = input.responsibility || null;
  const policy = input.policy || null;
  const activityList = Array.isArray(input.activity) ? input.activity : [];
  const workItems = Array.isArray(input.workItems) ? input.workItems : [];
  const workingNotes = Array.isArray(input.workingItems) ? input.workingItems : [];

  const loadProjectGovernance = () => (
    input.projectFactGovernance !== undefined
      ? Promise.resolve(input.projectFactGovernance)
      : (projectId && typeof responsibilityMemory.listProjectMemoryFactGovernance === 'function'
          ? responsibilityMemory.listProjectMemoryFactGovernance(projectId).catch(() => ({ byFactId: {} }))
          : Promise.resolve({ byFactId: {} }))
  );

  const [rawUserResult, rawEpisodicResult, projectMemory, projectFacts, projectFactGovernance] = await Promise.all([
    Array.isArray(input.userFacts)
      ? Promise.resolve({ facts: input.userFacts })
      : (ownerPrincipalId
          ? userMemoryStore.listUserMemoryFacts({
              ownerPrincipalId,
              projectId,
              responsibilityId,
              includeExpired: true,
              includeUntrusted: true,
              limit: 500,
              now: asOfIso,
            })
          : Promise.resolve({ facts: [] })),
    Array.isArray(input.episodes)
      ? Promise.resolve({ episodes: input.episodes })
      : (ownerPrincipalId
          ? episodicMemoryStore.listEpisodicMemories({
              ownerPrincipalId,
              projectId,
              ...(input.includeProjectEpisodes === true ? {} : { responsibilityId }),
              includeExpired: true,
              includeRetracted: true,
              includeUntrusted: true,
              limit: 200,
              now: asOfIso,
            })
          : Promise.resolve({ episodes: [] })),
    input.projectMemory !== undefined
      ? Promise.resolve(input.projectMemory)
      : (projectId ? projectMemoryStore.getProjectMemory(projectId) : Promise.resolve(null)),
    Array.isArray(input.projectFacts)
      ? Promise.resolve(input.projectFacts)
      : (projectId ? projectMemoryStore.listCurrentFacts(projectId) : Promise.resolve([])),
    loadProjectGovernance(),
  ]);

  const projectProvenance = Array.isArray(input.projectProvenance)
    ? input.projectProvenance
    : (projectId && projectMemory?.currentVersion
        ? await projectMemoryStore.getFactProvenance(projectId, projectMemory.currentVersion)
        : []);

  const candidates = [];

  // Layer 1: User Memory
  for (const fact of rawUserResult?.facts || []) {
    candidates.push({
      id: fact.id,
      layer: 'user',
      ownerPrincipalId: fact.ownerPrincipalId,
      projectId: fact.scope?.projectId || null,
      responsibilityId: fact.scope?.responsibilityId || null,
      factKey: fact.factKey,
      normalizedKey: fact.normalizedKey || normalizeKey(fact.factKey),
      text: fact.factValue,
      sourceType: fact.sourceType,
      sourceRef: fact.sourceRef,
      scope: fact.scope || { type: 'global', projectId: null, responsibilityId: null },
      confidence: Number.isFinite(fact.confidence) ? fact.confidence : 0.5,
      validUntil: fact.validUntil || null,
      status: fact.status || 'active',
      updatedAt: fact.updatedAt || fact.createdAt || '',
      meta: {
        category: fact.category,
        version: fact.version,
      },
    });
  }

  // Layer 2: Project Memory
  const govByFactId = projectFactGovernance?.byFactId || {};
  for (const fact of projectFacts || []) {
    const prov = resolveProjectFactProvenance(projectId, fact, projectProvenance);
    const effectiveFactVersion = Number(fact.factVersion || fact.currentVersion || 0);
    const gov = govByFactId[fact.factId] || null;
    const govApplies = Boolean(gov && (!gov.factVersion || Number(gov.factVersion) === effectiveFactVersion));
    const effectiveSourceType = govApplies && gov.sourceType && SOURCE_QUALITY_RANK[gov.sourceType] !== undefined
      ? gov.sourceType
      : prov.sourceType;
    const effectiveSourceRef = (govApplies && gov.sourceRef) || prov.sourceRef;
    const status = (govApplies && gov.supersededByFactId)
      ? 'superseded'
      : fact.state === 'invalidated'
        ? 'retracted'
        : fact.state === 'superseded'
          ? 'superseded'
          : 'active';
    const isContested = fact.state === 'contested';
    const defaultConfidence = effectiveSourceType === 'user_rule'
      ? 1.0
      : effectiveSourceType === 'tool_verified'
        ? 0.9
        : 0.65;
    const baseConfidence = govApplies && Number.isFinite(gov.confidence) ? gov.confidence : defaultConfidence;
    candidates.push({
      id: fact.factId,
      layer: 'project',
      ownerPrincipalId,
      projectId,
      responsibilityId: null,
      factKey: fact.factKey || fact.factId,
      normalizedKey: normalizeKey(fact.factKey || fact.factId),
      text: fact.factValue || '',
      sourceType: effectiveSourceType,
      sourceRef: effectiveSourceRef,
      scope: { type: 'project', projectId, responsibilityId: null },
      confidence: isContested ? Math.min(baseConfidence, 0.45) : baseConfidence,
      validUntil: (govApplies ? gov.validUntil : null) || fact.validUntil || null,
      status,
      updatedAt: (govApplies ? gov.updatedAt : null) || fact.updatedAt || projectMemory?.updatedAt || '',
      meta: {
        factVersion: effectiveFactVersion,
        state: fact.state,
        contestedBy: fact.contestedBy || '',
        sourceKind: prov.sourceKind,
        ...(govApplies && gov.supersededByFactId ? {
          supersededByFactId: gov.supersededByFactId,
          supersededByLayer: gov.supersededByLayer || null,
        } : {}),
      },
    });
  }

  // Layer 3: Responsibility Memory
  if (responsibility) {
    const criteria = Array.isArray(responsibility.successCriteria) ? responsibility.successCriteria : [];
    const objectiveText = criteria.length
      ? `${responsibility.objective} | Success criteria: ${criteria.join('; ')}`
      : responsibility.objective;
    const isInactiveResp = ['cancelled', 'archived'].includes(responsibility.lifecycle);
    candidates.push({
      id: `resp:objective:${responsibility.id}@rev${responsibility.revision}`,
      layer: 'responsibility',
      ownerPrincipalId: responsibility.ownerPrincipalId || ownerPrincipalId,
      projectId: responsibility.projectId || projectId,
      responsibilityId: responsibility.id,
      factKey: 'responsibility.objective',
      normalizedKey: 'responsibility.objective',
      text: objectiveText,
      sourceType: 'user_rule',
      sourceRef: `responsibility:${responsibility.id}@rev${responsibility.revision}`,
      scope: { type: 'responsibility', projectId: responsibility.projectId || projectId, responsibilityId: responsibility.id },
      confidence: 1.0,
      validUntil: null,
      status: isInactiveResp ? 'retracted' : 'active',
      updatedAt: responsibility.updatedAt || '',
      meta: {
        lifecycle: responsibility.lifecycle,
        revision: responsibility.revision,
        rowVersion: responsibility.rowVersion,
      },
    });
    if (policy) {
      const policySummary = [
        `provider=${policy.providerId || 'default'}`,
        ...(policy.resource?.readScope ? [`readScope=${policy.resource.readScope}`] : []),
        ...(policy.resource?.networkPolicy ? [`network=${policy.resource.networkPolicy}`] : []),
        ...(policy.dailyBudget ? [`dailyBudget=${JSON.stringify(policy.dailyBudget)}`] : []),
      ].join(' ');
      candidates.push({
        id: `resp:policy:${responsibility.id}@rev${responsibility.policyRevision}`,
        layer: 'responsibility',
        ownerPrincipalId: responsibility.ownerPrincipalId || ownerPrincipalId,
        projectId: responsibility.projectId || projectId,
        responsibilityId: responsibility.id,
        factKey: 'responsibility.policy',
        normalizedKey: 'responsibility.policy',
        text: `Responsibility policy: ${policySummary}`,
        sourceType: 'user_rule',
        sourceRef: `responsibility-policy:${responsibility.id}@rev${responsibility.policyRevision}`,
        scope: { type: 'responsibility', projectId: responsibility.projectId || projectId, responsibilityId: responsibility.id },
        confidence: 1.0,
        validUntil: policy.validUntil || null,
        status: isInactiveResp ? 'retracted' : 'active',
        updatedAt: responsibility.updatedAt || '',
        meta: {
          policyRevision: responsibility.policyRevision,
          digest: policy.digest || null,
        },
      });
    }
    for (const act of activityList.slice(-20)) {
      candidates.push({
        id: `resp:activity:${responsibility.id}:${act.sequence}`,
        layer: 'responsibility',
        ownerPrincipalId: responsibility.ownerPrincipalId || ownerPrincipalId,
        projectId: responsibility.projectId || projectId,
        responsibilityId: responsibility.id,
        factKey: `responsibility.activity.${act.type}`,
        normalizedKey: normalizeKey(`responsibility.activity.${act.type}`),
        text: `${act.type}: ${JSON.stringify(act.details || {})}`,
        sourceType: 'tool_verified',
        sourceRef: `responsibility-activity:${responsibility.id}#${act.sequence}`,
        scope: { type: 'responsibility', projectId: responsibility.projectId || projectId, responsibilityId: responsibility.id },
        confidence: 0.9,
        validUntil: null,
        status: 'active',
        updatedAt: act.createdAt || '',
        meta: { sequence: act.sequence, type: act.type },
      });
    }
  }

  // Layer 4: Episodic Memory
  for (const ep of rawEpisodicResult?.episodes || []) {
    const parts = [`[${ep.outcome}] ${ep.summary}`];
    if (ep.failureRootCause) parts.push(`Root cause: ${ep.failureRootCause}`);
    if (ep.repairAttempt) parts.push(`Repair (${ep.repairStatus || 'attempted'}): ${ep.repairAttempt}`);
    if (Array.isArray(ep.artifactLinks) && ep.artifactLinks.length) {
      parts.push(`Artifacts: ${ep.artifactLinks.map((l) => l.ref).join(', ')}`);
    }
    candidates.push({
      id: ep.id,
      layer: 'episodic',
      ownerPrincipalId: ep.ownerPrincipalId,
      projectId: ep.projectId,
      responsibilityId: ep.responsibilityId,
      factKey: `episodic.${ep.outcome}`,
      normalizedKey: normalizeKey(`episodic.${ep.episodeKey || ep.id}`),
      text: parts.join(' | '),
      sourceType: ep.sourceType || 'tool_verified',
      sourceRef: ep.sourceRef,
      scope: { type: 'responsibility', projectId: ep.projectId, responsibilityId: ep.responsibilityId },
      confidence: Number.isFinite(ep.confidence) ? ep.confidence : 0.95,
      validUntil: ep.validUntil || null,
      status: ep.status || 'active',
      updatedAt: ep.occurredAt || ep.updatedAt || ep.createdAt || '',
      meta: {
        outcome: ep.outcome,
        failureRootCause: ep.failureRootCause,
        repairAttempt: ep.repairAttempt,
        repairStatus: ep.repairStatus,
        artifactLinks: ep.artifactLinks || [],
        keywords: ep.keywords || [],
        packetId: ep.packetId || null,
        runId: ep.runId || null,
        workItemId: ep.workItemId || null,
      },
    });
  }

  // Layer 5: Working Context
  for (const item of workItems) {
    if (!item || typeof item !== 'object') continue;
    const objective = item.contract?.objective || item.title || item.id;
    const blocked = item.blockedReason?.code ? ` (blocked: ${item.blockedReason.code})` : '';
    const ctrl = item.controlState && item.controlState !== 'none' ? `/${item.controlState}` : '';
    candidates.push({
      id: `work:${item.id}@rev${item.rowVersion || 1}`,
      layer: 'working',
      ownerPrincipalId,
      projectId: item.projectId || projectId,
      responsibilityId,
      factKey: `working.work_item.${item.kind || 'task'}`,
      normalizedKey: normalizeKey(`working.work_item.${item.id}`),
      text: `[${item.state || 'unknown'}${ctrl}] ${objective}${blocked}`,
      sourceType: 'tool_verified',
      sourceRef: `work-item:${item.id}@rev${item.rowVersion || 1}`,
      scope: { type: 'responsibility', projectId: item.projectId || projectId, responsibilityId },
      confidence: 0.95,
      validUntil: null,
      status: item.state === 'cancelled' ? 'retracted' : 'active',
      updatedAt: item.updatedAt || item.createdAt || '',
      meta: {
        workItemId: item.id,
        state: item.state,
        controlState: item.controlState,
        candidateDigest: item.candidateDigest || null,
      },
    });
  }

  for (const note of workingNotes) {
    if (!note || typeof note !== 'object') continue;
    const noteText = text(note.text || note.factValue || note.content, 2000);
    candidates.push({
      id: text(note.id, 120) || `working:${candidates.length + 1}`,
      layer: 'working',
      ownerPrincipalId: text(note.ownerPrincipalId || ownerPrincipalId, 160),
      projectId: text(note.projectId || projectId, 160),
      responsibilityId: text(note.responsibilityId || responsibilityId, 160),
      factKey: text(note.factKey || 'working.note', 160),
      normalizedKey: normalizeKey(note.factKey || 'working.note'),
      text: noteText,
      sourceType: text(note.sourceType || 'tool_verified', 60),
      sourceRef: text(note.sourceRef || 'working-context', 500),
      scope: note.scope || { type: 'responsibility', projectId, responsibilityId },
      confidence: Number.isFinite(note.confidence) ? note.confidence : 0.85,
      validUntil: note.validUntil || null,
      status: note.status || 'active',
      updatedAt: note.updatedAt || asOfIso,
      meta: note.meta || {},
    });
  }

  const excludedCounts = {
    retractedOrInactive: 0,
    expired: 0,
    untrusted: 0,
    shadowedByUserRule: 0,
    outOfScope: 0,
  };

  // Step 1: Scoped filter & source isolation
  const activeScoped = [];
  for (const item of candidates) {
    if (ownerPrincipalId && item.ownerPrincipalId && item.ownerPrincipalId !== ownerPrincipalId) {
      excludedCounts.outOfScope += 1;
      continue;
    }
    const scopeType = item.scope?.type || 'global';
    if (scopeType === 'project' && projectId && item.scope?.projectId !== projectId) {
      excludedCounts.outOfScope += 1;
      continue;
    }
    if (scopeType === 'responsibility') {
      if (responsibilityId && item.scope?.responsibilityId !== responsibilityId) {
        excludedCounts.outOfScope += 1;
        continue;
      }
      if (projectId && item.scope?.projectId && item.scope.projectId !== projectId) {
        excludedCounts.outOfScope += 1;
        continue;
      }
    }
    if (item.sourceType === 'external_untrusted') {
      excludedCounts.untrusted += 1;
      continue;
    }
    if (!['user_rule', 'tool_verified', 'model_inferred'].includes(item.sourceType)) {
      excludedCounts.untrusted += 1;
      continue;
    }
    if (item.status !== 'active' || !text(item.text)) {
      excludedCounts.retractedOrInactive += 1;
      continue;
    }
    const validMs = parseMs(item.validUntil);
    if (validMs !== null && validMs <= asOfMs) {
      excludedCounts.expired += 1;
      continue;
    }
    if (!text(item.sourceRef)) {
      excludedCounts.untrusted += 1;
      continue;
    }
    activeScoped.push(item);
  }

  // Prevent model_inferred facts from shadowing or competing with an active user_rule key.
  const activeUserRuleKeys = new Set(
    activeScoped
      .filter((item) => item.sourceType === 'user_rule' && item.normalizedKey)
      .map((item) => item.normalizedKey),
  );
  const isolated = [];
  for (const item of activeScoped) {
    if (item.sourceType === 'model_inferred' && item.normalizedKey && activeUserRuleKeys.has(item.normalizedKey)) {
      excludedCounts.shadowedByUserRule += 1;
      continue;
    }
    isolated.push(item);
  }

  // Step 2: Deterministic ranking (evidence quality > keyword relevance > confidence > specificity > recency)
  const queryKeywords = resolveQueryKeywords({
    query: input.query,
    keywords: input.keywords,
    responsibility,
  });
  const layerOrder = { user: 5, responsibility: 4, project: 3, episodic: 2, working: 1 };
  const scopeOrder = { responsibility: 3, project: 2, global: 1 };

  const scored = isolated.map((item) => {
    const sourceRank = SOURCE_QUALITY_RANK[item.sourceType] ?? 0;
    const keywordRelevance = computeKeywordRelevance(item, queryKeywords);
    const scopeSpecificity = scopeOrder[item.scope?.type || 'global'] || 1;
    const score = Number((
      sourceRank * 1000
      + keywordRelevance * 100
      + (Number.isFinite(item.confidence) ? item.confidence : 0) * 10
      + scopeSpecificity
    ).toFixed(4));
    return {
      item,
      sourceRank,
      keywordRelevance,
      scopeSpecificity,
      score,
    };
  });

  scored.sort((a, b) => {
    if (b.sourceRank !== a.sourceRank) return b.sourceRank - a.sourceRank;
    if (b.keywordRelevance !== a.keywordRelevance) return b.keywordRelevance - a.keywordRelevance;
    if (b.item.confidence !== a.item.confidence) return b.item.confidence - a.item.confidence;
    if (b.scopeSpecificity !== a.scopeSpecificity) return b.scopeSpecificity - a.scopeSpecificity;
    if (a.item.updatedAt !== b.item.updatedAt) return a.item.updatedAt < b.item.updatedAt ? 1 : -1;
    const layerDiff = (layerOrder[b.item.layer] || 0) - (layerOrder[a.item.layer] || 0);
    if (layerDiff !== 0) return layerDiff;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

  // Step 3: Deterministic token/byte budget trimming with full provenance preserved
  const included = [];
  let usedTokens = 0;
  let usedBytes = 0;
  let droppedCount = 0;

  for (const entry of scored) {
    const candidateEntry = {
      id: entry.item.id,
      layer: entry.item.layer,
      factKey: entry.item.factKey,
      text: entry.item.text,
      sourceType: entry.item.sourceType,
      sourceRef: entry.item.sourceRef,
      scope: entry.item.scope,
      confidence: entry.item.confidence,
      validUntil: entry.item.validUntil,
      score: entry.score,
      keywordRelevance: Number(entry.keywordRelevance.toFixed(4)),
      updatedAt: entry.item.updatedAt,
      meta: entry.item.meta,
    };
    const { bytes, tokens } = estimateSerializedEntry(candidateEntry);
    if (
      included.length >= maxItems
      || usedTokens + tokens > maxTokens
      || usedBytes + bytes > maxBytes
    ) {
      droppedCount += 1;
      continue;
    }
    included.push({
      ...candidateEntry,
      estimatedTokens: tokens,
      estimatedBytes: bytes,
    });
    usedTokens += tokens;
    usedBytes += bytes;
  }

  const layers = {};
  for (const layerName of CONTEXT_MEMORY_LAYERS) {
    const layerCandidates = isolated.filter((item) => item.layer === layerName);
    const layerIncluded = included.filter((item) => item.layer === layerName);
    layers[layerName] = {
      layer: layerName,
      ...(layerName === 'project' ? {
        version: projectMemory?.currentVersion || 0,
        digest: projectMemory?.digest || null,
      } : {}),
      items: layerIncluded,
      totalActive: layerCandidates.length,
      includedCount: layerIncluded.length,
      excludedCount: layerCandidates.length - layerIncluded.length,
      truncated: layerIncluded.length < layerCandidates.length,
    };
  }

  return {
    layers,
    retrievedMemory: included,
    retrieval: {
      schemaVersion: 1,
      asOf: asOfIso,
      pipeline: ['extract', 'validate_consolidate', 'retrieve'],
      queryKeywords,
      sourceRanking: ['user_rule', 'tool_verified', 'model_inferred'],
      budget: {
        maxTokens,
        maxBytes,
        maxItems,
        usedTokens,
        usedBytes,
        trimmed: droppedCount > 0,
        droppedCount,
      },
      excludedCounts,
    },
  };
}

// This projection supplies references and evidence, never authorization or
// an independent progress state. The responsibility service authenticates the
// actor and owns the project/organization scope.
export async function assembleResponsibilityContext(id, actor, options = {}) {
  const projectMemoryStore = options.projectMemoryStore || defaultProjectMemoryStore;
  const userMemoryStore = options.userMemoryStore || defaultUserMemoryStore;
  const episodicMemoryStore = options.episodicMemoryStore || defaultEpisodicMemoryStore;

  const first = await getResponsibility(id, actor);
  const responsibility = first.responsibility;
  const memory = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  const [activity, workLinks, currentFacts, projectFactGovernance] = await Promise.all([
    listResponsibilityActivity(id, { after: 0, limit: 100 }, actor),
    listResponsibilityWorkLinks(id, actor),
    projectMemoryStore.listCurrentFacts(responsibility.projectId),
    options.projectFactGovernance !== undefined
      ? Promise.resolve(options.projectFactGovernance)
      : (typeof responsibilityMemory.listProjectMemoryFactGovernance === 'function'
          ? responsibilityMemory.listProjectMemoryFactGovernance(responsibility.projectId).catch(() => ({ byFactId: {} }))
          : Promise.resolve({ byFactId: {} })),
  ]);
  const workIds = [...new Set(workLinks.links.flatMap((link) => link.workItemIds || []))];
  const work = await Promise.all(
    workIds.slice(0, 50).map((workId) => getFactoryWorkItem(responsibility.organizationId, workId, actor)),
  );
  const provenance = memory?.currentVersion
    ? await projectMemoryStore.getFactProvenance(responsibility.projectId, memory.currentVersion)
    : [];

  const workItems = work.map((result) => result.item);
  const unified = await retrieveFiveLayerMemoryContext({
    ownerPrincipalId: responsibility.ownerPrincipalId,
    projectId: responsibility.projectId,
    responsibilityId: responsibility.id,
    responsibility,
    policy: first.policy || null,
    activity: activity.activity,
    workItems,
    projectMemory: memory,
    projectFacts: currentFacts,
    projectProvenance: provenance,
    projectFactGovernance,
    workingItems: options.workingItems,
    query: options.query,
    keywords: options.keywords,
    maxTokens: options.maxTokens,
    maxBytes: options.maxBytes,
    maxItems: options.maxItems,
    includeProjectEpisodes: options.includeProjectEpisodes,
    now: options.now,
    userMemoryStore,
    episodicMemoryStore,
    projectMemoryStore,
  });

  const latest = await getResponsibility(id, actor);
  const latestMemory = await projectMemoryStore.getProjectMemory(responsibility.projectId);
  if (latest.responsibility.rowVersion !== responsibility.rowVersion || latest.responsibility.policyRevision !== responsibility.policyRevision) {
    throw Object.assign(new Error('Responsibility changed while assembling context; retry.'), { code: 'RESPONSIBILITY_CONTEXT_STALE', statusCode: 409 });
  }
  if ((latestMemory?.currentVersion || 0) !== (memory?.currentVersion || 0)) {
    throw Object.assign(new Error('Project memory changed while assembling context; retry.'), { code: 'RESPONSIBILITY_CONTEXT_STALE', statusCode: 409 });
  }

  const govByFactId = projectFactGovernance?.byFactId || {};
  return {
    schemaVersion: 1,
    asOf: unified.retrieval.asOf,
    responsibility: {
      id: responsibility.id,
      projectId: responsibility.projectId,
      organizationId: responsibility.organizationId,
      objective: responsibility.objective,
      successCriteria: responsibility.successCriteria,
      lifecycle: responsibility.lifecycle,
      rowVersion: responsibility.rowVersion,
      policyRevision: responsibility.policyRevision,
    },
    // Policy is descriptive context, not a grant to any consumer. Keep the
    // adapter and resource alongside its version without assuming a CI source.
    policy: first.policy ? {
      digest: first.policy.digest,
      validUntil: first.policy.validUntil,
      providerId: first.policy.providerId || null,
      providerVersion: first.policy.providerVersion || null,
      resource: first.policy.resource || null,
      dailyBudget: first.policy.dailyBudget || null,
    } : null,
    activity: activity.activity,
    activityNextCursor: activity.nextCursor,
    memory: memory ? {
      version: memory.currentVersion,
      digest: memory.digest,
      updatedAt: memory.updatedAt,
      currentFacts: currentFacts.slice(0, 100).map(({ factId, factKey, factVersion, currentVersion, factValue, state, contestedBy, validUntil }) => {
        const effectiveVersion = factVersion || currentVersion;
        const prov = resolveProjectFactProvenance(responsibility.projectId, { factId, factVersion, currentVersion }, provenance);
        const gov = govByFactId[factId] || null;
        const govApplies = Boolean(gov && (!gov.factVersion || Number(gov.factVersion) === Number(effectiveVersion || 0)));
        const effectiveSourceType = govApplies && gov.sourceType && SOURCE_QUALITY_RANK[gov.sourceType] !== undefined
          ? gov.sourceType
          : prov.sourceType;
        const effectiveSourceRef = (govApplies && gov.sourceRef) || prov.sourceRef;
        return {
          factId,
          factKey,
          factVersion: effectiveVersion,
          factValue,
          state,
          contestedBy,
          sourceKind: prov.sourceKind,
          sourceType: effectiveSourceType,
          sourceRef: effectiveSourceRef,
          ...(govApplies && Number.isFinite(gov.confidence) ? { confidence: gov.confidence } : {}),
          validUntil: (govApplies ? gov.validUntil : null) || validUntil || null,
          ...(govApplies && gov.supersededByFactId ? {
            supersededByFactId: gov.supersededByFactId,
            supersededByLayer: gov.supersededByLayer || null,
          } : {}),
          layer: 'project',
        };
      }),
      facts: provenance.slice(0, 100).map(({ factId, fact, factVersion, state, sessionId, runId, provider, sourceEventStart, sourceEventEnd }) => {
        const sourceType = provider === 'user'
          ? 'user_rule'
          : ['tool', 'system'].includes(provider)
            ? 'tool_verified'
            : provider === 'external_untrusted'
              ? 'external_untrusted'
              : 'model_inferred';
        const sourceRef = provider === 'user'
          ? `project-memory:${responsibility.projectId}:fact:${factId}@v${factVersion}`
          : `${runId ? `run:${runId}` : 'project-memory'}${sessionId ? `:session:${sessionId}` : ''}#events:${Number(sourceEventStart || 0)}-${Number(sourceEventEnd || 0)}`;
        return {
          factId,
          fact,
          factVersion,
          state,
          sessionId,
          runId,
          sourceKind: provider === 'user' ? 'user' : 'unknown',
          sourceType,
          sourceRef,
          layer: 'project',
          sourceEventStart,
          sourceEventEnd,
        };
      }),
      truncated: provenance.length > 100 || currentFacts.length > 100,
    } : null,
    workGraph: {
      links: workLinks.links,
      items: workItems,
      truncated: workIds.length > 50,
    },
    layers: unified.layers,
    retrievedMemory: unified.retrievedMemory,
    retrieval: unified.retrieval,
  };
}
