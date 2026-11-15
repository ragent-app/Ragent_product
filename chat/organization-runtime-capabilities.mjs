// One semantic capability snapshot for prompt shaping, proposal compilation
// and public Projection. Raw environment variable names never leave this
// module.
import {
  COLLABORATION_LEADER_ENABLED,
  MANAGED_INPUT_ENFORCEMENT,
  MANAGED_WRITER_ENABLED,
  ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED,
  ORG_AUTONOMOUS_LEADER_ENABLED,
  ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  ORG_DYNAMIC_REPLAN_ENABLED,
  ORG_HIERARCHICAL_DELEGATION_ENABLED,
  ORG_INTERNAL_ENVELOPE_ENABLED,
  ORG_PROJECTION_V1_ENABLED,
  ORG_PROJECTION_V2_ENABLED,
  ORG_RECOVERY_V1_ENABLED,
  ORG_SCHEMA_ENABLED,
  ORG_SESSION_ADDRESSABILITY_ENABLED,
  ORG_STALL_GOVERNOR_ENABLED,
  REVIEWER_ENABLED,
} from '../lib/config.mjs';
import { ORGANIZATION_RUNTIME_TOOLS } from './organization-runtime-selection.mjs';

const FLAG_ENV_NAMES = Object.freeze({
  organizationSchema: 'RAGENT_ORG_SCHEMA_ENABLED',
  organizationLeader: 'RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED',
  durableCollaboration: 'RAGENT_COLLABORATION_LEADER_ENABLED',
  automaticProvisioning: 'RAGENT_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED',
  provisioning: 'RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED',
  internalEnvelopes: 'RAGENT_ORG_INTERNAL_ENVELOPE_ENABLED',
  hierarchicalDelegation: 'RAGENT_ORG_HIERARCHICAL_DELEGATION_ENABLED',
  dynamicReplan: 'RAGENT_ORG_DYNAMIC_REPLAN_ENABLED',
  stallGovernor: 'RAGENT_ORG_STALL_GOVERNOR_ENABLED',
  projectionV1: 'RAGENT_ORG_PROJECTION_V1_ENABLED',
  projectionV2: 'RAGENT_ORG_PROJECTION_V2_ENABLED',
  recovery: 'RAGENT_ORG_RECOVERY_V1_ENABLED',
  managedInput: 'RAGENT_MANAGED_INPUT_ENFORCEMENT',
  managedWriter: 'RAGENT_MANAGED_WRITER_ENABLED',
  reviewerRuntime: 'RAGENT_REVIEWER_ENABLED',
  sessionAddressability: 'RAGENT_ORG_SESSION_ADDRESSABILITY_ENABLED',
});

const FLAG_VALUES = Object.freeze({
  organizationSchema: ORG_SCHEMA_ENABLED,
  organizationLeader: ORG_AUTONOMOUS_LEADER_ENABLED,
  durableCollaboration: COLLABORATION_LEADER_ENABLED,
  automaticProvisioning: ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED,
  provisioning: ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  internalEnvelopes: ORG_INTERNAL_ENVELOPE_ENABLED,
  hierarchicalDelegation: ORG_HIERARCHICAL_DELEGATION_ENABLED,
  dynamicReplan: ORG_DYNAMIC_REPLAN_ENABLED,
  stallGovernor: ORG_STALL_GOVERNOR_ENABLED,
  projectionV1: ORG_PROJECTION_V1_ENABLED,
  projectionV2: ORG_PROJECTION_V2_ENABLED,
  recovery: ORG_RECOVERY_V1_ENABLED,
  managedInput: MANAGED_INPUT_ENFORCEMENT,
  managedWriter: MANAGED_WRITER_ENABLED,
  reviewerRuntime: REVIEWER_ENABLED,
  sessionAddressability: ORG_SESSION_ADDRESSABILITY_ENABLED,
});

function explicitlyConfigured(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

export function organizationFeatureEnabled(name, configuredValue) {
  // Preserve the pre-flag source-tree behavior for isolated scenario tests and
  // development processes. Once an operator explicitly sets `=0`, the slice
  // is genuinely disabled and every consumer observes that decision.
  return configuredValue === true || !explicitlyConfigured(FLAG_ENV_NAMES[name] || name);
}

function effectiveValue(name) {
  return organizationFeatureEnabled(name, FLAG_VALUES[name]);
}

export function getOrganizationRuntimeCapabilities({ publicOnly = false } = {}) {
  const capabilities = {
    schemaVersion: 1,
    organizationProposal: ORG_AUTONOMOUS_LEADER_ENABLED && ORG_SCHEMA_ENABLED,
    durableCollaboration: COLLABORATION_LEADER_ENABLED,
    managedSessions: ORG_AUTONOMOUS_PROVISIONING_ENABLED && ORG_SCHEMA_ENABLED,
    managedInput: effectiveValue('managedInput'),
    managedWriter: effectiveValue('managedWriter'),
    reviewerRuntime: effectiveValue('reviewerRuntime'),
    internalEnvelopes: effectiveValue('internalEnvelopes'),
    hierarchicalDelegation: effectiveValue('hierarchicalDelegation'),
    dynamicReplan: effectiveValue('dynamicReplan'),
    stallGovernor: effectiveValue('stallGovernor'),
    projectionV1: effectiveValue('projectionV1'),
    projectionV2: effectiveValue('projectionV2'),
    recovery: effectiveValue('recovery'),
    sessionAddressability: effectiveValue('sessionAddressability'),
    automaticProvisioning: ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED && ORG_AUTONOMOUS_PROVISIONING_ENABLED,
    supportedModes: [],
    runtimeSelection: {
      schemaVersion: 1,
      fields: ['tool', 'provider', 'model', 'effort'],
      providerField: 'providerProfile',
      supportedTools: [...ORGANIZATION_RUNTIME_TOOLS],
      policyFields: [
        'allowedTools',
        'allowedProviders',
        'allowedProvidersByTool',
        'allowedModels',
        'allowedModelsByTool',
        'allowedEfforts',
        'allowedEffortsByTool',
      ],
    },
    limits: {
      maxNodes: 64,
      maxDepth: 16,
      maxCapabilitiesPerRole: 32,
      maxAgentChildren: 32,
      maxAgentConcurrent: 4,
    },
  };
  if (capabilities.organizationProposal) capabilities.supportedModes.push('organization');
  if (capabilities.durableCollaboration) capabilities.supportedModes.push('collaboration');
  if (publicOnly) return capabilities;
  return {
    ...capabilities,
    configuredFlags: Object.fromEntries(Object.keys(FLAG_ENV_NAMES).map((key) => [key, explicitlyConfigured(FLAG_ENV_NAMES[key])])),
  };
}

export function buildOrganizationCapabilityPrompt({ capabilities = null } = {}) {
  const snapshot = capabilities && typeof capabilities === 'object'
    ? capabilities
    : getOrganizationRuntimeCapabilities({ publicOnly: true });
  return [
    '## Runtime Organization Capabilities',
    'The following semantic capability snapshot is authoritative for this turn. A capability set to false must not be planned, claimed, or simulated; continue with a smaller plan that stays within the enabled capabilities. Limits are ceilings, not grants. Runtime state and permissions still win over this prompt.',
    JSON.stringify(snapshot, null, 2),
  ].join('\\n\\n');
}

export function assertOrganizationCapability(name, message = '') {
  const capabilities = getOrganizationRuntimeCapabilities();
  if (capabilities[name] === true) return true;
  const error = new Error(message || `organization capability ${name} is disabled`);
  error.code = 'ORG_CAPABILITY_DISABLED';
  error.statusCode = 503;
  error.capability = name;
  throw error;
}

export { FLAG_ENV_NAMES };
