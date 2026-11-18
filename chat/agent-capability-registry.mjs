// S16: the only normalization boundary between an AgentTemplate (apps.json)
// and organization delegation. The returned profile is a capability fact
// snapshot; it is deliberately independent of Session and Runner state.
import { getApp } from './apps.mjs';
import { defaultSpecialistPolicy, normalizeCollaborationPolicy } from './collaboration-policy.mjs';
import { runtimePolicyForProfile } from './organization-runtime-selection.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';

export const DEFAULT_CAPABILITIES = Object.freeze(['read']);
// Legacy Agent templates predate collaborationPolicy. They remain globally
// discoverable through a bounded, non-delegating specialist projection until
// an owner assigns an explicit policy.
export const DEFAULT_AGENT_ROLE = 'specialist';
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CHILDREN = 16;
export const DEFAULT_MAX_CONCURRENT = 4;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].sort();
}

function bounded(value, fallback, max = 1_000_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clone(value, fallback = {}) {
  try { return JSON.parse(JSON.stringify(value ?? fallback)); } catch { return fallback; }
}

function normalizeAccessMode(value, fallback = 'read_only') {
  const raw = text(value).toLowerCase();
  const mode = raw === 'read' ? 'read_only' : raw === 'write' ? 'writer' : raw;
  return ['none', 'read_only', 'writer'].includes(mode) ? mode : fallback;
}

function normalizeIsolation(value, fallback = 'shared') {
  const mode = text(value).toLowerCase();
  return ['shared', 'worktree', 'container'].includes(mode) ? mode : fallback;
}

function normalizeCapabilities(policy, template) {
  const raw = policy.allowedCapabilities || policy.capabilities || template.allowedCapabilities || template.capabilities;
  const values = list(raw).map((value) => value.toLowerCase());
  return values.length > 0 ? values : [...DEFAULT_CAPABILITIES];
}

function normalizeToolProfiles(policy, template, tool, toolId) {
  const values = list(policy.toolProfiles || template.toolProfiles);
  if (values.length > 0) return values;
  return list([toolId, tool?.id, tool?.runtimeFamily].filter(Boolean));
}

function normalizeRuntimeProfile(template, tool, toolId) {
  const supplied = object(template.runtimeProfile || template.runtime_profile);
  return {
    toolId: text(supplied.toolId || toolId || tool?.id),
    runtimeFamily: text(supplied.runtimeFamily || tool?.runtimeFamily),
    runtimeId: text(supplied.runtimeId || tool?.runtimeId),
    toolProfile: text(supplied.toolProfile || tool?.toolProfile),
  };
}

export function normalizeCapabilityProfile(profile = {}) {
  const policy = normalizeCollaborationPolicy(profile.policy || profile.collaborationPolicy || {}) || {};
  const role = text(profile.role || policy.role).toLowerCase();
  const canDelegate = role === 'manager'
    && (profile.canDelegate === true || policy.canDelegate === true)
    && policy.canDelegate !== false;
  const capabilities = list(profile.capabilities || policy.allowedCapabilities || DEFAULT_CAPABILITIES).map((value) => value.toLowerCase());
  return {
    agentId: text(profile.agentId || profile.id),
    role,
    capabilities: capabilities.length > 0 ? capabilities : [...DEFAULT_CAPABILITIES],
    allowedAgentIds: list(profile.allowedAgentIds || policy.allowedAgentIds),
    allowedRoles: list(profile.allowedRoles || policy.allowedRoles).map((value) => value.toLowerCase()),
    toolProfiles: list(profile.toolProfiles || policy.toolProfiles),
    skillProfiles: list(profile.skillProfiles || policy.skillProfiles),
    writablePaths: list(profile.writablePaths || policy.writablePaths),
    workspaceScope: text(profile.workspaceScope || policy.workspaceScope),
    projectId: text(profile.projectId || policy.projectId),
    accessMode: profile.accessMode === 'none' || policy.accessMode === 'none' ? 'none'
      : profile.canWrite === false || policy.canWrite === false ? 'read_only'
        : normalizeAccessMode(profile.accessMode || policy.accessMode, role === 'reviewer' ? 'read_only' : 'writer'),
    executionIsolation: normalizeIsolation(profile.executionIsolation || policy.executionIsolation),
    canDelegate,
    maxDepth: bounded(profile.maxDepth ?? profile.policy?.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    maxChildren: bounded(profile.maxChildren ?? profile.policy?.maxChildren ?? DEFAULT_MAX_CHILDREN, DEFAULT_MAX_CHILDREN),
    maxConcurrent: bounded(profile.maxConcurrent ?? profile.policy?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
    runtimeProfile: clone(profile.runtimeProfile || profile.runtime_profile || {}, {}),
    runtimePolicy: runtimePolicyForProfile({
      ...profile,
      policy,
      runtimeProfile: profile.runtimeProfile || profile.runtime_profile,
    }),
    policyRevision: text(profile.policyRevision || policy.revision) || '1',
  };
}

export async function buildAgentCapabilityProfile(agentTemplate, { toolDefinition = null } = {}) {
  const template = object(agentTemplate);
  const configuredPolicy = normalizeCollaborationPolicy(template.collaborationPolicy);
  const configuredRole = text(configuredPolicy?.role || template.role).toLowerCase();
  const policy = configuredPolicy || (configuredRole ? {} : defaultSpecialistPolicy());
  const toolId = text(template.tool);
  const tool = toolDefinition || (toolId ? await getToolDefinitionAsync(toolId) : null);
  const role = configuredRole || DEFAULT_AGENT_ROLE;
  const profile = normalizeCapabilityProfile({
    id: template.id,
    role,
    policy,
    capabilities: template.capabilities || policy.allowedCapabilities || policy.capabilities,
    allowedAgentIds: policy.allowedAgentIds,
    allowedRoles: policy.allowedRoles,
    toolProfiles: normalizeToolProfiles(policy, template, tool, toolId),
    skillProfiles: template.skillProfiles || policy.skillProfiles || template.skills,
    writablePaths: template.writablePaths || policy.writablePaths,
    workspaceScope: template.workspaceScope || policy.workspaceScope,
    projectId: template.projectId || policy.projectId,
    accessMode: template.accessMode || policy.accessMode,
    canWrite: template.canWrite === false || policy.canWrite === false ? false : undefined,
    executionIsolation: template.executionIsolation || policy.executionIsolation,
    canDelegate: role === 'manager' && policy.canDelegate === true,
    maxDepth: policy.maxDepth,
    maxChildren: policy.maxChildren,
    maxConcurrent: policy.maxConcurrent,
    runtimeProfile: normalizeRuntimeProfile(template, tool, toolId),
    runtimePolicy: runtimePolicyForProfile({
      ...template,
      policy,
      toolId,
      runtimeProfile: normalizeRuntimeProfile(template, tool, toolId),
    }),
    policyRevision: policy.revision,
  });
  return {
    schemaVersion: 1,
    ...profile,
    agentName: text(template.name),
    roleSource: configuredPolicy ? 'collaborationPolicy' : (configuredRole ? 'legacy-role' : 'default'),
    toolId,
    runtimeProfile: normalizeRuntimeProfile(template, tool, toolId),
    runtimePolicy: runtimePolicyForProfile({
      ...template,
      policy,
      toolId,
      runtimeProfile: normalizeRuntimeProfile(template, tool, toolId),
    }),
  };
}

export async function getAgentCapabilityProfile(agentId, { getAgent = getApp, getTool = getToolDefinitionAsync } = {}) {
  const normalizedId = text(agentId);
  if (!normalizedId) return null;
  const template = await getAgent(normalizedId);
  if (!template) return null;
  const toolId = text(template.tool);
  const tool = toolId && getTool ? await getTool(toolId) : null;
  return buildAgentCapabilityProfile(template, { toolDefinition: tool });
}

export function profileAllowsAgent(profile, agentId, role = '') {
  const candidateId = text(agentId);
  const candidateRole = text(role).toLowerCase();
  if (!profile || (profile.allowedAgentIds.length > 0 && !profile.allowedAgentIds.includes(candidateId))) return false;
  return profile.allowedRoles.length === 0 || profile.allowedRoles.includes(candidateRole);
}
