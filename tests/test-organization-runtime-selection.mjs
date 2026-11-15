#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-runtime-selection-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const selection = await import('../chat/organization-runtime-selection.mjs');
const planner = await import('../chat/organization-planner.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');

const catalogs = {
  codex: { models: [{ id: 'gpt-test@provider-root', effortLevels: ['low', 'high'] }], effortLevels: ['low', 'high'] },
  claude: { models: [{ id: 'sonnet@provider-child', effortLevels: ['low', 'medium', 'high'] }], effortLevels: ['low', 'medium', 'high'] },
  agy: { models: [{ id: 'agy-test', effortLevels: ['low', 'medium', 'high'] }], effortLevels: ['low', 'medium', 'high'] },
};
const getModels = async (tool) => catalogs[tool] || { models: [] };
const getProviders = async (tool) => tool === 'codex' ? ['provider-root'] : tool === 'claude' ? ['provider-child'] : ['agy-official'];
const getTool = async (tool) => ({ id: tool, runtimeFamily: `${tool}-test-runtime` });

const child = await selection.resolveRuntimeSelection({
  requested: { tool: 'claude', provider: 'provider-child', model: 'sonnet@provider-child', effort: 'high' },
  profile: {
    agentId: 'child',
    toolId: 'claude',
    runtimeProfile: { toolId: 'claude' },
    runtimePolicy: {
      allowedTools: ['claude'],
      allowedProviders: ['provider-child'],
      allowedModels: ['sonnet@provider-child'],
      allowedEfforts: ['high'],
    },
  },
  parentGrant: {
    runtimePolicy: {
      allowedTools: ['claude'],
      allowedProviders: ['provider-child'],
      allowedModels: ['sonnet@provider-child'],
      allowedEfforts: ['high'],
    },
  },
  getModels,
  getProviders,
  getTool,
});
assert.deepEqual(child, {
  schemaVersion: 1,
  tool: 'claude',
  provider: 'provider-child',
  model: 'sonnet@provider-child',
  effort: 'high',
  runtimeFamily: 'claude-test-runtime',
});

const scopedCatalogSelection = await selection.resolveRuntimeSelection({
  requested: { tool: 'claude', provider: 'catalog-provider', model: 'plain-model', effort: 'medium' },
  profile: {
    toolId: 'claude',
    runtimePolicy: {
      allowedTools: ['claude'],
      allowedProvidersByTool: { claude: ['catalog-provider'] },
      allowedModelsByTool: { claude: ['plain-model'] },
      allowedEffortsByTool: { claude: ['medium'] },
    },
  },
  parentGrant: {
    runtimePolicy: {
      allowedTools: ['claude'],
      allowedProvidersByTool: { claude: ['catalog-provider'] },
      allowedModelsByTool: { claude: ['plain-model'] },
      allowedEffortsByTool: { claude: ['medium'] },
    },
  },
  getModels: async () => ({
    providers: ['catalog-provider'],
    models: [{ id: 'plain-model', effortLevels: ['medium'] }],
    effortLevels: ['medium'],
  }),
  getProviders: async () => [],
  getTool,
});
assert.deepEqual(scopedCatalogSelection, {
  schemaVersion: 1,
  tool: 'claude',
  provider: 'catalog-provider',
  model: 'plain-model',
  effort: 'medium',
  runtimeFamily: 'claude-test-runtime',
});

await assert.rejects(
  () => selection.resolveRuntimeSelection({
    requested: { tool: 'claude', provider: 'provider-root', model: 'sonnet@provider-root' },
    profile: { toolId: 'claude', runtimeProfile: { toolId: 'claude' }, runtimePolicy: { allowedTools: ['claude'], allowedProviders: ['provider-child'] } },
    parentGrant: { runtimePolicy: { allowedTools: ['claude'], allowedProviders: ['provider-child'] } },
    getModels,
    getProviders,
  }),
  (error) => error.code === 'ORG_RUNTIME_PROVIDER_DENIED',
);

await assert.rejects(
  () => selection.resolveRuntimeSelection({
    requested: { tool: 'codex', provider: 'provider-root', model: 'gpt-test@provider-root', effort: 'medium' },
    profile: { toolId: 'codex', runtimeProfile: { toolId: 'codex' } },
    getModels,
    getProviders,
  }),
  (error) => error.code === 'ORG_RUNTIME_EFFORT_UNAVAILABLE',
);

const proposal = {
  schemaVersion: 1,
  proposalId: 'runtime-organization',
  idempotencyKey: 'runtime-organization',
  objective: 'runtime selection organization',
  nodes: [
    {
      stableKey: 'lead',
      role: 'manager',
      agentId: 'lead',
      capabilities: ['read', 'manage'],
      phaseId: 'work',
      runtime: { tool: 'codex', provider: 'provider-root', model: 'gpt-test@provider-root', effort: 'high' },
      runtimePolicy: {
        allowedTools: ['claude'],
        allowedProviders: ['provider-child'],
        allowedModels: ['sonnet@provider-child'],
        allowedEfforts: ['high'],
      },
      acceptance: [{ criterion: 'lead' }],
    },
    {
      stableKey: 'worker',
      role: 'specialist',
      agentId: 'worker',
      capabilities: ['read'],
      phaseId: 'work',
      parentKey: 'lead',
      runtime: { tool: 'claude', provider: 'provider-child', model: 'sonnet@provider-child', effort: 'high' },
      acceptance: [{ criterion: 'worker' }],
    },
  ],
  phases: [{ phaseId: 'work', objective: 'work', acceptance: [{ criterion: 'done' }], reviewRequired: false }],
  manages: [{ parentKey: 'lead', childKey: 'worker' }],
  reviewPolicy: { required: false, minReviewers: 0, independent: false },
  acceptance: [{ criterion: 'done' }],
};
const compiled = await planner.compileOrganizationProposal(proposal, {
  profiles: [
    {
      agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage'], maxDepth: 3,
      runtimeProfile: { toolId: 'codex' },
      runtimePolicy: { allowedTools: ['codex'], allowedProviders: ['provider-root'], allowedModels: ['gpt-test@provider-root'], allowedEfforts: ['high'] },
    },
    {
      agentId: 'worker', role: 'specialist', canDelegate: false, capabilities: ['read'], maxDepth: 2,
      runtimeProfile: { toolId: 'claude' },
      runtimePolicy: { allowedTools: ['claude'], allowedProviders: ['provider-child'], allowedModels: ['sonnet@provider-child'], allowedEfforts: ['high'] },
    },
  ],
  getModels,
  getProviders,
  getTool,
});
assert.equal(compiled.compiled.nodes.find((node) => node.stableKey === 'worker').runtime.provider, 'provider-child');
assert.equal(compiled.compiled.nodes.find((node) => node.stableKey === 'worker').runtime.tool, 'claude');
assert.equal(compiled.compiled.resolver.find((entry) => entry.stableKey === 'worker').runtime.effort, 'high');

const root = {
  id: 'runtime-root', folder: configDir, tool: 'codex', templateId: 'runtime-manager', delegationDepth: 0,
};
const apps = new Map([
  ['runtime-manager', {
    id: 'runtime-manager', name: 'Runtime Manager', tool: 'codex',
    collaborationPolicy: {
      role: 'manager', canDelegate: true, allowedAgentIds: ['runtime-worker'], maxChildren: 2, maxConcurrent: 1, maxDepth: 2,
      runtimePolicy: { allowedTools: ['claude'], allowedProviders: ['provider-child'], allowedModels: ['sonnet@provider-child'], allowedEfforts: ['high'] },
    },
  }],
  ['runtime-worker', {
    id: 'runtime-worker', name: 'Runtime Worker', tool: 'claude',
    collaborationPolicy: {
      role: 'specialist', canDelegate: false,
      runtimePolicy: { allowedTools: ['claude'], allowedProviders: ['provider-child'], allowedModels: ['sonnet@provider-child'], allowedEfforts: ['high'] },
    },
  }],
]);
const sessions = new Map([[root.id, root]]);
const runs = new Map();
let childId = 0;
let runId = 0;
let createdExtra = null;
let sentOptions = null;
const orchestrator = createCollaborationOrchestrator({
  dependencies: {
    getSession: async (id) => sessions.get(id) || null,
    getApp: async (id) => apps.get(id) || null,
    getModels,
    getProviders,
    createSession: async (_folder, tool, name, extra) => {
      createdExtra = { tool, name, ...extra };
      const session = { id: `runtime-child-${++childId}`, folder: configDir, tool, ...extra };
      sessions.set(session.id, session);
      return session;
    },
    sendMessage: async (sessionId, _text, _images, options) => {
      sentOptions = options;
      const run = { id: `runtime-run-${++runId}`, sessionId, state: 'running', requestId: options.requestId };
      runs.set(run.id, run);
      return { session: sessions.get(sessionId), run };
    },
    getRunState: async (id) => runs.get(id) || null,
    getRun: async (id) => runs.get(id) || null,
    getRunResult: async (id) => runs.get(id)?.result || null,
    getRunManifest: async () => ({ folder: configDir }),
    listRunIds: async () => [...runs.keys()],
    loadHistory: async () => [],
    requestRunCancel: async () => null,
  },
});
const collaboration = await orchestrator.dispatch({
  rootSessionId: root.id,
  title: 'runtime collaboration',
  idempotencyKey: 'runtime-collaboration',
  plan: {
    tasks: [{
      id: 'runtime-task', objective: 'run with selected runtime', agentId: 'runtime-worker',
      runtime: { tool: 'claude', provider: 'provider-child', model: 'sonnet@provider-child', effort: 'high' },
    }],
  },
});
assert.deepEqual(collaboration.tasks[0].runtime, {
  schemaVersion: 1,
  tool: 'claude',
  provider: 'provider-child',
  model: 'sonnet@provider-child',
  effort: 'high',
  runtimeFamily: 'claude-stream-json',
});
assert.equal(createdExtra.providerProfile, 'provider-child');
assert.equal(createdExtra.model, 'sonnet@provider-child');
assert.equal(createdExtra.effort, 'high');
assert.equal(sentOptions.providerProfile, 'provider-child');
assert.equal(sentOptions.model, 'sonnet@provider-child');
assert.equal(sentOptions.effort, 'high');
assert.equal(sentOptions.tool, 'claude');

orchestrator.stop();
await rm(configDir, { recursive: true, force: true });
console.log('test-organization-runtime-selection: ok');
