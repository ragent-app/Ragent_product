// Root Leadership ingress for the S21 v2 proposal loop.
//
// The provider still owns natural-language reasoning. It may emit one marked
// JSON proposal; this module is the server-side trust boundary that parses,
// resolves capabilities, persists a revision, and freezes it. It never creates
// managed Sessions: the configured automatic provisioning path may materialize
// them after the revision is frozen.
import { buildAgentCapabilityCatalog, catalogProfiles } from './agent-capability-catalog.mjs';
import { getOrganizationByRootSession } from './organization-store.mjs';
import {
  compileOrganizationProposal,
  createOrganization,
  freezeRevision,
  reviseOrganizationProposal,
} from './organization-runtime.mjs';
import {
  ORGANIZATION_PROPOSAL_END,
  ORGANIZATION_PROPOSAL_START,
} from './orchestration-markers.mjs';
export { ORGANIZATION_PROPOSAL_END, ORGANIZATION_PROPOSAL_START };
import {
  buildOrganizationCapabilityPrompt,
  getOrganizationRuntimeCapabilities,
} from './organization-runtime-capabilities.mjs';
import { buildOrganizationRuntimeCatalog } from './organization-runtime-selection.mjs';
import { queryRuntimeCandidates } from './organization-runtime-decision.mjs';

export const ORGANIZATION_LEADER_DISABLED = 'ORG_LEADER_DISABLED';
export const ORGANIZATION_PROPOSAL_NOT_FOUND = 'ORG_PROPOSAL_NOT_FOUND';
export const ORGANIZATION_PROPOSAL_REJECTED = 'ORG_PROPOSAL_REJECTED';

const MAX_PROPOSAL_BYTES = 256 * 1024;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function leaderEnabled() {
  return getOrganizationRuntimeCapabilities().organizationProposal === true;
}

function isRootLeadershipSession(session) {
  return session?.sessionClass === 'ROOT_LEADERSHIP'
    && session?.sessionPlane === 'user'
    && session?.userAddressable !== false;
}

function stripJsonFence(value) {
  const source = text(value);
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  return match ? match[1].trim() : source;
}

export function extractOrganizationProposal(assistantText) {
  const source = typeof assistantText === 'string' ? assistantText : '';
  const lower = source.toLowerCase();
  const start = lower.indexOf(ORGANIZATION_PROPOSAL_START);
  if (start === -1) return null;
  const second = lower.indexOf(ORGANIZATION_PROPOSAL_START, start + ORGANIZATION_PROPOSAL_START.length);
  if (second >= 0) {
    const error = new Error('multiple organization proposal blocks are not allowed');
    error.code = ORGANIZATION_PROPOSAL_REJECTED;
    error.reason = 'multiple_blocks';
    throw error;
  }
  const payloadStart = start + ORGANIZATION_PROPOSAL_START.length;
  const end = lower.indexOf(ORGANIZATION_PROPOSAL_END, payloadStart);
  if (end === -1) {
    const error = new Error('organization proposal end marker is missing');
    error.code = ORGANIZATION_PROPOSAL_REJECTED;
    error.reason = 'missing_end_marker';
    throw error;
  }
  const raw = source.slice(payloadStart, end).trim();
  if (!raw) {
    const error = new Error('organization proposal payload is empty');
    error.code = ORGANIZATION_PROPOSAL_REJECTED;
    error.reason = 'empty_payload';
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_PROPOSAL_BYTES) {
    const error = new Error('organization proposal payload is too large');
    error.code = ORGANIZATION_PROPOSAL_REJECTED;
    error.reason = 'payload_too_large';
    throw error;
  }
  try {
    return JSON.parse(stripJsonFence(raw));
  } catch (cause) {
    const error = new Error('organization proposal payload is not valid JSON');
    error.code = ORGANIZATION_PROPOSAL_REJECTED;
    error.reason = 'invalid_json';
    error.cause = cause;
    throw error;
  }
}

export async function buildOrganizationAgentCatalog({
  apps = null,
  getApps = null,
  getTool = undefined,
} = {}) {
  return buildAgentCapabilityCatalog({
    apps,
    ...(typeof getApps === 'function' ? { getApps } : {}),
    ...(typeof getTool === 'function' ? { getTool } : {}),
  });
}

export async function buildOrganizationAgentProfiles(options = {}) {
  return catalogProfiles(await buildOrganizationAgentCatalog(options));
}

function promptProfile(profile) {
  const role = profile.role || '';
  return {
    agentId: profile.agentId,
    name: profile.agentName || profile.agentId,
    role,
    roleSource: profile.roleSource || 'explicit',
    selectable: profile.selectable !== false,
    unavailableReasons: Array.isArray(profile.unavailableReasons) ? profile.unavailableReasons : [],
    capabilities: profile.capabilities,
    runtime: {
      default: profile.runtimePolicy?.default || {},
      allowedTools: profile.runtimePolicy?.allowedTools || [],
      allowedProviders: profile.runtimePolicy?.allowedProviders || [],
      allowedProvidersByTool: profile.runtimePolicy?.allowedProvidersByTool || {},
      allowedModels: profile.runtimePolicy?.allowedModels || [],
      allowedModelsByTool: profile.runtimePolicy?.allowedModelsByTool || {},
      allowedEfforts: profile.runtimePolicy?.allowedEfforts || [],
      allowedEffortsByTool: profile.runtimePolicy?.allowedEffortsByTool || {},
    },
  };
}

export async function buildRootLeadershipTurnContext(session, options = {}) {
  if (!leaderEnabled() || !isRootLeadershipSession(session)) return '';
  const capabilities = getOrganizationRuntimeCapabilities({ publicOnly: true });
  const catalog = options.catalog || await buildOrganizationAgentCatalog(options);
  const visibleProfiles = catalogProfiles(catalog).map(promptProfile);
  const ownerConstraints = await import('./session-collaboration-settings.mjs')
    .then(({ readSessionRuntimeConstraints }) => readSessionRuntimeConstraints(session.id)).catch(() => null);
  const runtimeCatalog = await buildOrganizationRuntimeCatalog().catch(() => null);
  const catalogInstruction = visibleProfiles.length > 0
    ? 'Use only the selectable Agent ids listed below. A profile role is an Agent fact; the Proposal role is an Organization assignment.'
    : 'No selectable Agent is currently available. Continue in the current Session and do not emit an Organization Proposal until the Runtime reports a selectable Agent.';
  const proposalContract = visibleProfiles.length > 0
    ? `${ORGANIZATION_PROPOSAL_START}\n{ "schemaVersion": 1, "proposalId": "stable-id", "idempotencyKey": "stable-key", "objective": "...", "nodes": [], "phases": [], "manages": [], "reviewPolicy": { "required": true, "minReviewers": 1, "independent": true }, "acceptance": [] }\n${ORGANIZATION_PROPOSAL_END}`
    : 'No Organization Proposal block is permitted while the Agent Catalog has no selectable Agent.';
  return `## Root Leadership Organization Proposal

Autonomous organization planning is enabled for this Root Leadership Session. First clarify the objective, acceptance criteria, constraints and evidence required. Then choose exactly one orchestration mode: Organization Proposal for a staged hierarchy with phase gates, or Durable Collaboration for a persistent task graph. You may reason in natural language, but you must not claim that internal Sessions, Runs, Reviewers or results exist until the Runtime confirms them. When the objective is concrete enough for a bounded team plan, use plan.submit if that tool is available and authorized; use plan.status to inspect an uncertain submission. If the tool is unavailable, emit one machine-readable block for the selected mode in addition to your normal explanation. Do not submit the same plan through both paths. Availability does not itself grant authority; follow the tool response:

${proposalContract}

Owner-authored runtime constraints (scope and revision are authoritative; absent fields are not locked): ${JSON.stringify(ownerConstraints?.constraints || {})}

For each task assess its quality floor, whether advanced capability is actually needed, context size, tools, environment, availability and total completion cost. Use task-specific candidate queries when available; unknown quality, price or health is not proof. Select within user locks and server grants without a separate routing model. A node may specify runtimeRequirements with tools, environment, minimumContextTokens, advancedRequired and qualityFloor; these are task needs, not grants. Unknown evidence cannot satisfy a hard requirement. Add runtimeRationale describing the task-specific choice and its uncertainty. A node may include displayName (a readable name in any language, up to 160 characters) and responsibility (its assigned responsibility in any language, up to 1000 characters). These are descriptive facts, not identity credentials or grants; stableKey remains the machine identity.

The block must contain valid JSON and must satisfy the OrganizationProposal contract: every node needs stableKey, role, agentId, phaseId, and acceptance where applicable; every phase needs objective, non-empty acceptance, and an independent reviewer; dependencies and MANAGES edges must be acyclic; include a bounded budget and writable boundary when useful. A node may optionally include domain (a free-form specialty name in any language, at most 160 characters) and iconKey (a display icon key, at most 64 characters). For iconKey choose the closest visual category for the assigned work: backend, mobile, web, runtime, architecture, database, data, ai, cloud, network, hardware, security, testing, design, product, research, writing, translation, education, business, finance, legal, health, marketing, sales, people, operations, logistics, media, environment, engineering, general. For interdisciplinary work choose the primary direction; use a broader category when needed. Do not rename or reject a specialty because it is absent from this icon list. These fields are presentation metadata, not capabilities or grants; an unknown iconKey falls back to the structural role icon. A node may declare runtime: { "tool": "codex|codex-cli|claude|claude-bidi|agy", "provider": "provider-profile-id", "model": "model-id", "effort": "a supported level from the selected model catalog" }. The provider selects a non-secret provider profile/account id and is persisted as providerProfile; it is not a credential. The Runtime derives the Organization Grant from the node role and intersects it with Agent capabilities and parent Grant. Never invent an Agent id, provider, model or effort absent from the catalog or declared Agent facts. ${catalogInstruction} The Runtime validates, compiles and freezes the revision, then automatically provisions Managed Sessions when the enabled automatic provisioning capability is true. Do not report any of those facts before the Runtime response.

roleSource="default" means this is a legacy Agent without an explicit collaborationPolicy. It remains selectable as an Agent fact; Organization manager/reviewer authority comes from the frozen Organization Grant, not from this legacy field.

${buildOrganizationCapabilityPrompt({ capabilities })}

Agent Catalog state: ${catalog.state}
Agent Catalog revision: ${catalog.revision}
Agent Catalog diagnostics:
${JSON.stringify(catalog.errors || [], null, 2)}

Available Agent capability facts:
${JSON.stringify(visibleProfiles, null, 2)}

Runtime catalog (provider ids are non-secret profile identifiers; catalog presence does not establish account health or available quota). Missing or failed discovery is unknown, never proof of availability. Select effort only from the selected model's listed levels; do not assume levels are equivalent across providers:
${runtimeCatalog === null ? 'Unknown: runtime catalog discovery failed.' : JSON.stringify(queryRuntimeCandidates(runtimeCatalog), null, 2)}`;
}

function errorResult(error, attempted = true) {
  return {
    attempted,
    state: 'rejected',
    code: text(error?.code) || ORGANIZATION_PROPOSAL_REJECTED,
    reason: text(error?.reason) || 'compile_failed',
    message: text(error?.message) || 'organization proposal was rejected',
  };
}

export async function processRootLeadershipProposal({
  session,
  assistantText,
  profiles = null,
  projectId = '',
  provisionRevision = null,
  createManagedSession = null,
  turnId = '',
  apps = null,
  getApps = null,
  getTool = undefined,
  afterValidation = null,
} = {}) {
  if (!leaderEnabled()) return { attempted: false, skipped: ORGANIZATION_LEADER_DISABLED };
  if (!isRootLeadershipSession(session)) return { attempted: false, skipped: 'not_root_leadership' };

  let proposal;
  try {
    proposal = extractOrganizationProposal(assistantText);
  } catch (error) {
    return errorResult(error);
  }
  if (!proposal) return { attempted: false, skipped: ORGANIZATION_PROPOSAL_NOT_FOUND };

  let catalog;
  try {
    catalog = Array.isArray(profiles)
      ? { schemaVersion: 1, state: profiles.length > 0 ? 'ready' : 'empty', revision: '', agents: profiles, errors: [] }
      : await buildOrganizationAgentCatalog({ apps, getApps, getTool });
  } catch (error) {
    return errorResult(error);
  }
  const agentProfiles = catalogProfiles(catalog);
  if (agentProfiles.length === 0) {
    return {
      ...errorResult(Object.assign(new Error('no selectable Agent is available for Organization planning'), {
        code: 'ORG_AGENT_CATALOG_EMPTY',
        reason: catalog.state === 'degraded' ? 'catalog_degraded' : 'no_selectable_agents',
      })),
      catalogState: catalog.state,
      catalogRevision: catalog.revision,
      catalogErrors: catalog.errors,
    };
  }
  let planned;
  try {
    const { readSessionRuntimeConstraints } = await import('./session-collaboration-settings.mjs');
    const { selectRuntimeConstraints } = await import('./organization-runtime-decision.mjs');
    const saved = await readSessionRuntimeConstraints(session.id);
    const runtimeCatalog = await buildOrganizationRuntimeCatalog().catch(() => null);
    const runtimeDecisionByNode = Object.fromEntries((Array.isArray(proposal.nodes) ? proposal.nodes : []).map((node) => {
      const stableKey = text(node?.stableKey);
      const constraints = selectRuntimeConstraints(saved.constraints, ['organization', `node:${stableKey}`]);
      return [stableKey, { constraints, ...(runtimeCatalog ? { catalog: runtimeCatalog } : {}) }];
    }));
    planned = await compileOrganizationProposal(proposal, {
      profiles: agentProfiles,
      runtimeDecisionByNode,
      ...(typeof getTool === 'function' ? { getTool } : {}),
    });
  } catch (error) {
    return { ...errorResult(error), sideEffects: 'none' };
  }

  if (afterValidation) await afterValidation();

  const rootSessionId = text(session.id);
  const organizationKey = `root-leadership:${rootSessionId}`;
  let organization = await getOrganizationByRootSession(rootSessionId);
  try {
    organization ||= await createOrganization({
      rootSessionId,
      projectId: text(projectId || session.projectId),
      policy: { source: 'root_leadership', proposalOnly: true },
      budget: object(proposal.budget),
      idempotencyKey: organizationKey,
    });
  } catch (error) {
    organization = await getOrganizationByRootSession(rootSessionId);
    if (!organization) return errorResult(error);
  }

  // Explicit owner-authored organizations are revised only through owner
  // controls; a concurrently completing leadership Run cannot amend them.
  if (organization?.policy?.source === 'owner') {
    return errorResult(Object.assign(new Error('Owner-authored organization requires an explicit owner revision'), {
      code: 'ORG_OWNER_REVISION_REQUIRED',
    }));
  }

  try {
    const proposalKey = text(proposal.idempotencyKey || proposal.proposalId);
    const revisionIdempotencyKey = turnId
      ? `leader:${rootSessionId}:turn:${text(turnId)}:${proposalKey}`
      : proposalKey;
    const revision = await reviseOrganizationProposal({
      organizationId: organization.id,
      proposal,
      compiledPlan: planned,
      idempotencyKey: revisionIdempotencyKey,
      expectedCurrentRevision: organization.currentRevision,
    });
    const frozen = await freezeRevision(organization.id, revision.revision);
    let provisioning = { attempted: false, skipped: 'auto_provisioning_disabled' };
    const capabilities = getOrganizationRuntimeCapabilities({ publicOnly: true });
    if (capabilities.automaticProvisioning && capabilities.managedSessions) {
      try {
        const provisioner = provisionRevision || (await import('./organization-provisioning.mjs')).provisionRootLeadershipRevision;
        const factory = createManagedSession || (await import('./organization-managed-session-factory.mjs')).createManagedSessionForNode;
        provisioning = await provisioner({
          organizationId: organization.id,
          revision: revision.revision,
          createManagedSession: factory,
          idempotencyKey: `leader:${rootSessionId}:${text(turnId) || 'legacy'}:${proposalKey}`,
        });
      } catch (error) {
        provisioning = {
          attempted: true,
          state: 'failed',
          code: text(error?.code) || 'ORG_PROVISIONING_FAILED',
          reason: 'provisioning_failed',
          message: text(error?.message) || 'automatic provisioning failed after the revision was frozen',
        };
      }
    }
    return {
      attempted: true,
      state: frozen?.state || 'frozen',
      organizationId: organization.id,
      revision: revision.revision,
      digest: revision.digest,
      proposalId: planned.proposal.proposalId,
      idempotencyKey: revisionIdempotencyKey,
      provisioning,
      ...(provisioning?.state === 'provisioned'
        ? { createdManagedSessions: Number(provisioning.createdManagedSessions) || 0 }
        : {}),
      replay: revision.revision <= organization.currentRevision,
    };
  } catch (error) {
    return errorResult(error);
  }
}
