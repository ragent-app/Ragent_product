import { ok, equal, rejects, throws } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = process.env.RAGENT_TEST_TMPDIR || tmpdir();
mkdirSync(tempRoot, { recursive: true });
const tempHome = mkdtempSync(join(tempRoot, 'ragent-stage2-swarm-bridge-'));

const OWNER_ID = 'stage2-owner-1';
const configDir = join(tempHome, 'config');
const dataDir = join(tempHome, 'data');
const workRootDir = join(tempHome, 'work-root');
const memoryDir = join(tempHome, 'memory');
const repoDir = join(tempHome, 'repo');
const remoteRepoDir = join(tempHome, 'remote.git');

mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(workRootDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(repoDir, { recursive: true });
mkdirSync(remoteRepoDir, { recursive: true });

process.env.ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_DATA_DIR = dataDir;
process.env.RAGENT_WORK_ROOT_DIR = workRootDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';
process.env.RAGENT_MANAGED_WRITER_ENABLED = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = OWNER_ID;
process.env.RAGENT_RESPONSIBILITY_RUNTIME_ENABLED = '1';
process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = '0';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
git(remoteRepoDir, 'init', '--bare');
git(repoDir, 'init', '-b', 'main');
git(repoDir, 'config', 'user.email', 'stage2-owner@example.test');
git(repoDir, 'config', 'user.name', 'Stage 2 Owner');
mkdirSync(join(repoDir, 'src', 'module-a'), { recursive: true });
mkdirSync(join(repoDir, 'src', 'module-b'), { recursive: true });
writeFileSync(join(repoDir, 'README.md'), '# Stage 2 Swarm Bridge Test Repo\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'module-a', 'feature.js'), 'export const value = 1;\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'module-b', 'helper.js'), 'export const helper = () => 1;\n', 'utf8');
git(repoDir, 'add', '.');
git(repoDir, 'commit', '-m', 'Initial Stage 2 baseline');
git(repoDir, 'remote', 'add', 'origin', remoteRepoDir);
git(repoDir, 'push', '-u', 'origin', 'main');

const runs = await import('../chat/runs.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const projects = await import('../chat/projects.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const workGraphStore = await import('../chat/work-graph-store.mjs');
const workGraph = await import('../chat/work-graph.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryWorkflow = await import('../chat/factory-workflow.mjs');
const factoryHandoff = await import('../chat/factory-task-handoff.mjs');
const reportEvidence = await import('../chat/factory-report-evidence.mjs');
const respCapabilities = await import('../chat/responsibility-capabilities.mjs');
const respService = await import('../chat/responsibility-service.mjs');
const respProject = await import('../chat/responsibility-project.mjs');
const respTrigger = await import('../chat/responsibility-trigger-bridge.mjs');
const respRuntimeMod = await import('../chat/responsibility-runtime.mjs');
const respPlans = await import('../chat/responsibility-plans.mjs');
const factoryAdmission = await import('../chat/factory-responsibility-admission.mjs');
const swarmBridge = await import('../chat/organization-swarm-factory-bridge.mjs');
const { createAgentInterruptionIncidentTable } = await (async () => {
  // Ensure optional interruption table exists for worker failure handoff evidence scenario
  const interruptions = await import('../chat/agent-interruption-notifications.mjs');
  return { createAgentInterruptionIncidentTable: interruptions };
})();

const OWNER_ACTOR = { kind: 'user', role: 'owner', principalId: OWNER_ID };

async function createTestRun({
  runId,
  session,
  projectId,
  state = 'completed',
  summary = 'Completed cleanly',
  usage = { inputTokens: 80, outputTokens: 40, totalTokens: 120, costUsd: 0.001 },
}) {
  const requestId = `req_${runId}`;
  await runs.createRun({
    status: {
      id: runId,
      sessionId: session.id,
      requestId,
      tool: 'codex',
      state: 'running',
    },
    manifest: {
      sessionId: session.id,
      requestId,
      projectId,
      executionScope: { projectId },
      summary,
    },
  }, { admissionSession: session });
  await runs.writeRunResult(runId, { summary });
  await runs.updateRun(runId, {
    state,
    finalizedAt: new Date().toISOString(),
    usage,
  });
  return runs.getRun(runId);
}

async function runTests() {
  const project = await projects.createProject({ name: 'Stage 2 Swarm Bridge Project', rootPath: repoDir });
  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage2 Root', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    model: 'gpt-5.4',
    effort: 'medium',
  });
  const org = await orgStore.createOrganization({
    projectId: project.id,
    rootSessionId: rootSession.id,
    state: 'active',
    currentRevision: 1,
    policy: {
      projectRoot: repoDir,
      factoryMaxConcurrent: 4,
      allowModelSwitch: true,
      allowedHarnesses: ['codex', 'claude'],
      budgetLimits: { maxCost: 5.0, maxRuns: 20 },
    },
    budget: { maxCost: 5.0, maxRuns: 20 },
    idempotencyKey: 'stage2-org-init',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;

  async function createBoundNode({
    stableKey,
    nodeRole = 'specialist',
    sessionClass = 'WORKER',
    role,
    agentId,
    grant,
    capabilities = ['run'],
    writeScope = [],
  }) {
    const fullCaps = [...new Set(['read', ...capabilities])];
    const fullGrant = {
      ...grant,
      allowedCapabilities: fullCaps,
    };
    const roleInst = await orgStore.createRoleInstance({
      organizationId: org.id,
      organizationRevision: 1,
      stableKey: `${stableKey}-role`,
      role,
      agentId,
    });
    const node = await orgStore.createNode({
      organizationId: org.id,
      stableKey,
      nodeRole,
      sessionClass,
      createdRevision: 1,
      lifecycleMode: 'formal_org',
      lifecycleState: 'active',
      bindingGeneration: 1,
      roleInstanceId: roleInst.id,
      grant: fullGrant,
    });
    await orgStore.bindRoleInstanceNode(roleInst.id, node.id);
    const sess = await sessionManager.createSession(repoDir, 'codex', `Stage2 ${stableKey}`, {
      projectId: project.id,
      sessionPlane: 'organization',
      sessionClass,
      lifecycleMode: 'formal_org',
      managedScope: 'organization',
      organizationRootSessionId: rootSession.id,
      controllerSessionId: rootSession.id,
      parentSessionId: rootSession.id,
      delegatedFromSessionId: rootSession.id,
      organizationId: org.id,
      organizationNodeId: node.id,
      roleInstanceId: roleInst.id,
      organizationRevision: 1,
    });
    await orgStore.bindNodeSession(node.id, { sessionId: sess.id, bindingGeneration: 1 });
    for (const cap of fullCaps) {
      await orgStore.createGrant({
        organizationId: org.id,
        nodeId: node.id,
        revision: 1,
        capability: cap,
        allow: true,
        scope: cap === 'write'
          ? { projectId: project.id, writablePaths: writeScope }
          : { projectId: project.id },
      });
    }
    return { node: await orgStore.getNode(node.id), session: sess, roleInst };
  }

  const plannerBound = await createBoundNode({
    stableKey: 'planner-node',
    role: 'planner',
    agentId: 'agent-planner',
    grant: { canRead: true, canRun: true, canWrite: false, canReview: false, writablePaths: [] },
  });
  const readerBound = await createBoundNode({
    stableKey: 'reader-node',
    role: 'researcher',
    agentId: 'agent-reader',
    grant: { canRead: true, canRun: true, canWrite: false, canReview: false, writablePaths: [] },
  });
  const coordBound = await createBoundNode({
    stableKey: 'coord-node',
    nodeRole: 'root_leadership',
    role: 'coordinator',
    agentId: 'agent-coord',
    grant: {
      canRead: true,
      canRun: true,
      canWrite: true,
      canDelegate: true,
      maxDepth: 2,
      writablePaths: ['src/module-a', 'src/module-b'],
      workspaceScope: repoDir,
    },
    capabilities: ['run', 'write'],
    writeScope: ['src/module-a', 'src/module-b'],
  });
  const reviewerBound = await createBoundNode({
    stableKey: 'reviewer-node',
    sessionClass: 'REVIEWER',
    role: 'reviewer',
    agentId: 'agent-reviewer',
    grant: { canRead: true, canRun: true, canReview: true, canWrite: false, writablePaths: [] },
    capabilities: ['run', 'review'],
  });

  const plannerNode = plannerBound.node;
  const plannerSession = plannerBound.session;
  const readerNode = readerBound.node;
  const readerSession = readerBound.session;
  const coordNode = coordBound.node;
  const coordSession = coordBound.session;
  const reviewerNode = reviewerBound.node;
  const reviewerSession = reviewerBound.session;

  const projectFact = await respProject.captureResponsibilityProject(org.id, project.id);

  // =========================================================================
  // 1. Capabilities catalog & deterministic cost-aware model tiering
  // =========================================================================
  const caps = await respCapabilities.getResponsibilityCapabilities({ organizationId: org.id, projectId: project.id }, OWNER_ACTOR);
  equal(caps.planCatalogDescriptors[0].capability, 'project-report', 'Preserves Stage 1 project-report descriptor first');
  equal(caps.planCatalogDescriptors[1].capability, 'project-code', 'Preserves Stage 1 project-code descriptor second');
  const fanoutDesc = caps.planCatalogDescriptors.find((d) => d.capability === 'fanout');
  const swarmDesc = caps.planCatalogDescriptors.find((d) => d.capability === 'swarm-collaboration');
  ok(fanoutDesc && fanoutDesc.defaultOptIn === false && fanoutDesc.autoEligible === false, 'fanout descriptor defaults conservative opt-in');
  ok(swarmDesc && swarmDesc.defaultOptIn === false && swarmDesc.autoEligible === false, 'swarm descriptor defaults conservative opt-in');
  equal(caps.features.defaultCapabilityGates.allowWrite, false, 'allowWrite defaults false');
  equal(caps.features.defaultCapabilityGates.allowFanout, false, 'allowFanout defaults false');
  equal(caps.features.defaultCapabilityGates.allowSwarm, false, 'allowSwarm defaults false');
  equal(caps.features.defaultCapabilityGates.allowModelSwitch, false, 'allowModelSwitch defaults false');

  const obsTier = respCapabilities.resolveCostAwareModelTiering({
    capability: 'fanout',
    stepKind: 'investigation',
    accessMode: 'read',
    requiredRole: 'researcher',
  });
  equal(obsTier.resolvedTier, 'lightweight', 'Read investigation resolves to lightweight tier');
  equal(obsTier.selectedModel, 'gpt-5.4-nano', 'Lightweight tier selects cost-efficient pricing-backed model');
  ok(obsTier.pricing && obsTier.estimatedCostPer1MTokens > 0, 'Real pricing metadata attached');

  const writeTier = respCapabilities.resolveCostAwareModelTiering({
    capability: 'swarm-collaboration',
    stepKind: 'implementation',
    accessMode: 'write',
    requiredRole: 'engineer',
  });
  equal(writeTier.resolvedTier, 'strong', 'Write implementation resolves to strong tier');
  equal(writeTier.selectedModel, 'gpt-5.4', 'Strong tier selects strong model');

  const lockedTier = respCapabilities.resolveCostAwareModelTiering({
    capability: 'swarm-collaboration',
    stepKind: 'investigation',
    accessMode: 'read',
    ownerRuntimeLocks: { locked: true, tool: 'claude', model: 'claude-sonnet-4.6' },
  });
  equal(lockedTier.lockedByOwner, true, 'Owner runtime lock preserved');
  equal(lockedTier.selectedTool, 'claude');
  equal(lockedTier.selectedModel, 'claude-sonnet-4.6');
  equal(lockedTier.reason, 'owner_lock_preserved');

  const writePressureTier = respCapabilities.resolveCostAwareModelTiering({
    capability: 'swarm-collaboration',
    stepKind: 'implementation',
    accessMode: 'write',
    budgetContext: { maxCost: 1.0, remainingCost: 0.1 },
  });
  equal(writePressureTier.resolvedTier, 'strong', 'Write tier refuses silent budget downgrade by default');
  equal(writePressureTier.downgradedForBudget, false);

  const readPressureDowngrade = respCapabilities.resolveCostAwareModelTiering({
    capability: 'fanout',
    stepKind: 'report',
    accessMode: 'read',
    modelTierHint: 'strong',
    tieringPolicy: { allowBudgetDowngrade: true },
    budgetContext: { maxCost: 1.0, remainingCost: 0.1 },
  });
  equal(readPressureDowngrade.resolvedTier, 'standard', 'Read step with explicit allowBudgetDowngrade steps down cleanly');
  equal(readPressureDowngrade.downgradedForBudget, true);

  const exhaustedTier = respCapabilities.resolveCostAwareModelTiering({
    capability: 'fanout',
    stepKind: 'investigation',
    accessMode: 'read',
    budgetContext: { maxCost: 1.0, remainingCost: 0 },
  });
  equal(exhaustedTier.budgetOk, false);
  equal(exhaustedTier.budgetExceeded, true);

  // =========================================================================
  // 2. Default-conservative gates & permission intersection rejection checks
  // =========================================================================
  const fanoutReadTemplateDigest = workGraphStore.digest(respCapabilities.STAGE2_FANOUT_READ_FORMULA);
  const fanoutWriteTemplateDigest = workGraphStore.digest(respCapabilities.STAGE2_FANOUT_WRITE_FORMULA);
  const swarmTemplateDigest = workGraphStore.digest(respCapabilities.STAGE2_SWARM_TEMPLATE);

  const fanoutParallelSpec = factoryWorkflow.parallel(
    ['a', 'b'],
    (slice) => ({
      key: `slice_${slice}`,
      title: `Audit module ${slice.toUpperCase()}`,
      requiredRole: 'researcher',
      stepKind: 'execution',
      accessMode: 'read',
      objective: `Audit module ${slice}`,
      prompt: `Audit module ${slice}`,
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    }),
    { name: 'audit-slices', maxConcurrency: 2 },
  );

  const readFanoutEntry = {
    entryId: 'entry-fanout-read',
    capability: 'fanout',
    templateId: 'ragent-fanout-workflow',
    templateVersion: 1,
    templateDigest: fanoutReadTemplateDigest,
    objective: 'Run parallel read audit across modules',
    accessMode: 'read',
    maxAttempts: 1,
    maxCost: 0.4,
    maxRuns: 4,
    maxConcurrency: 2,
    spec: fanoutParallelSpec,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: {
      read: { nodeId: readerNode.id, bindingGeneration: readerNode.bindingGeneration },
    },
  };

  const writeSwarmEntry = {
    entryId: 'entry-swarm-write',
    capability: 'swarm-collaboration',
    templateId: 'ragent-swarm-collaboration',
    templateVersion: 1,
    templateDigest: swarmTemplateDigest,
    objective: 'Implement feature via isolated write Swarm and independent review',
    accessMode: 'write',
    allowedPaths: ['src/module-a'],
    targetBranch: 'main',
    candidateScope: 'branch_diff',
    maxAttempts: 2,
    maxCost: 0.8,
    maxTotalAgents: 4,
    maxDepth: 1,
    allowModelSwitch: true,
    requireReview: true,
    members: [
      {
        name: 'investigator',
        role: 'researcher',
        taskKind: 'investigation',
        accessMode: 'read',
        workspace: 'inherit',
        modelTierHint: 'lightweight',
        brief: 'Inspect interfaces before edits',
      },
      {
        name: 'implementer',
        role: 'engineer',
        taskKind: 'implementation',
        accessMode: 'write',
        writablePaths: ['src/module-a'],
        workspace: 'worktree',
        modelTierHint: 'strong',
        brief: 'Implement src/module-a/feature.js changes cleanly',
      },
    ],
    nodeBindings: {
      coordinator: { nodeId: coordNode.id, bindingGeneration: coordNode.bindingGeneration },
      review: { nodeId: reviewerNode.id, bindingGeneration: reviewerNode.bindingGeneration },
    },
  };

  const plannerProvider = caps.providers.find((p) => p.id === 'generic-planner');
  const plannerTemplate = plannerProvider.templates[0];
  const basePlannerPolicy = {
    schemaVersion: 1,
    providerId: 'generic-planner',
    providerVersion: plannerProvider.version,
    providerDigest: plannerProvider.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    networkPermissionConfirmed: true,
    projectFactId: projectFact.id,
    templateId: plannerTemplate.id,
    templateVersion: plannerTemplate.version,
    templateDigest: plannerTemplate.digest,
    nodeBindings: { planning: { nodeId: plannerNode.id, bindingGeneration: plannerNode.bindingGeneration } },
    maxAttempts: 2,
    maxCost: 0.4,
    validUntil: new Date(Date.now() + 86400_000).toISOString(),
    dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxCost: 1.5 },
    planApproval: 'within_policy',
    planAutoAdmissionConfirmed: true,
    planExecutionMaxAttempts: 6,
    planExecutionMaxCost: 1.5,
    allowedPaths: ['src/module-a'],
    planCatalog: [readFanoutEntry, writeSwarmEntry],
  };

  const plannerCatalogResp = await respService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Execute controlled Fan-out audit followed by Swarm implementation',
    successCriteria: ['Parallel read audit completed', 'Swarm feature promoted and reviewed'],
    idempotencyKey: 'stage2-resp-gates-test',
    policy: basePlannerPolicy,
  }, OWNER_ACTOR);

  const savedCatalogDisabled = plannerCatalogResp.policy.planCatalog;
  const fanoutStepCandidate = {
    id: 'step-fanout',
    entryId: savedCatalogDisabled[0].entryId,
    entryDigest: savedCatalogDisabled[0].entryDigest,
    templateId: savedCatalogDisabled[0].templateId,
    templateVersion: savedCatalogDisabled[0].templateVersion,
    templateDigest: savedCatalogDisabled[0].templateDigest,
    nodeBindings: savedCatalogDisabled[0].nodeBindings,
    dependsOn: [],
  };
  const swarmStepCandidate = {
    id: 'step-swarm',
    entryId: savedCatalogDisabled[1].entryId,
    entryDigest: savedCatalogDisabled[1].entryDigest,
    templateId: savedCatalogDisabled[1].templateId,
    templateVersion: savedCatalogDisabled[1].templateVersion,
    templateDigest: savedCatalogDisabled[1].templateDigest,
    nodeBindings: savedCatalogDisabled[1].nodeBindings,
    dependsOn: ['step-fanout'],
  };

  throws(
    () => respPlans.compileResponsibilityPlanSteps({
      plan: { schemaVersion: 1, steps: [fanoutStepCandidate] },
      policy: plannerCatalogResp.policy,
      organizationId: org.id,
      projectId: project.id,
      objective: plannerCatalogResp.responsibility.objective,
    }),
    /allowFanout=true/,
    'Default policy rejects fanout without explicit capabilityGates.allowFanout=true',
  );

  throws(
    () => respPlans.compileResponsibilityPlanSteps({
      plan: { schemaVersion: 1, steps: [{ ...swarmStepCandidate, dependsOn: [] }] },
      policy: { ...plannerCatalogResp.policy, capabilityGates: { allowSwarm: true } },
      organizationId: org.id,
      projectId: project.id,
      objective: plannerCatalogResp.responsibility.objective,
    }),
    /allowWrite=true/,
    'Swarm opt-in without allowWrite=true rejects write members/contract',
  );

  throws(
    () => respPlans.compileResponsibilityPlanSteps({
      plan: { schemaVersion: 1, steps: [{ ...swarmStepCandidate, dependsOn: [] }] },
      policy: {
        ...plannerCatalogResp.policy,
        allowedPaths: ['src/other'],
        capabilityGates: { allowSwarm: true, allowWrite: true, allowModelSwitch: true },
      },
      organizationId: org.id,
      projectId: project.id,
      objective: plannerCatalogResp.responsibility.objective,
    }),
    /exceeds policy allowedPaths/,
    'Catalog allowedPaths escaping policy.allowedPaths fails strict permission intersection',
  );

  throws(
    () => respPlans.compileResponsibilityPlanSteps({
      plan: {
        schemaVersion: 1,
        steps: [{ ...fanoutStepCandidate, modelTierHints: { slice_a: 'strong' } }],
      },
      policy: {
        ...plannerCatalogResp.policy,
        capabilityGates: { allowFanout: true },
        modelTiering: { maxTier: 'standard' },
      },
      organizationId: org.id,
      projectId: project.id,
      objective: plannerCatalogResp.responsibility.objective,
    }),
    /exceeds policy ceiling/,
    'Planner cannot escalate modelTierHints beyond policy maxTier ceiling',
  );

  // =========================================================================
  // 3. Full E2E: Controlled Planner -> Collect -> Approve -> Admit -> Fanout + Swarm
  // =========================================================================
  const validUntil = new Date(Date.now() + 86400_000).toISOString();
  const updatedResp = await respService.updateResponsibility(plannerCatalogResp.responsibility.id, {
    expectedVersion: plannerCatalogResp.responsibility.rowVersion,
    idempotencyKey: 'stage2-enable-gates',
    policy: {
      ...basePlannerPolicy,
      validUntil,
      capabilityGates: {
        allowFanout: true,
        allowSwarm: true,
        allowWrite: true,
        allowModelSwitch: true,
      },
      modelTiering: {
        enabled: true,
        observationTier: 'lightweight',
        executionTier: 'strong',
        reviewTier: 'strong',
        maxTier: 'strong',
      },
    },
  }, OWNER_ACTOR);

  await respService.setResponsibilityLifecycle(updatedResp.responsibility.id, 'resume', {
    confirmed: true,
    expectedVersion: updatedResp.responsibility.rowVersion,
    idempotencyKey: 'stage2-activate',
  }, OWNER_ACTOR);
  const activeDetail = await respService.getResponsibility(updatedResp.responsibility.id, OWNER_ACTOR);

  const trigRes = await respTrigger.createResponsibilityTrigger(updatedResp.responsibility.id, {
    type: 'at_time',
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
    confirmed: true,
    expectedVersion: activeDetail.responsibility.rowVersion,
    idempotencyKey: 'stage2-trig-1',
  }, OWNER_ACTOR);
  ok(trigRes.binding?.id, 'Time trigger registered');

  await respTrigger.reconcileResponsibilityTriggerBindings();
  await respTrigger.deliverResponsibilityTrigger({
    id: trigRes.binding.triggerId,
    sessionId: rootSession.id,
    triggerType: 'at_time',
    occurrence: 0,
    scheduledAt: trigRes.binding.config.scheduledAt,
  });
  const respErrors = [];
  const respRuntime = respRuntimeMod.createResponsibilityRuntime({
    intervalMs: 60000,
    onError: (err) => respErrors.push(err),
  });
  respRuntime.start();
  await respRuntime.tick();
  await respRuntime.stop();
  equal(respErrors.length, 0, `Responsibility runtime errors: ${respErrors.map((e) => e?.message).join('; ')}`);

  // Simulate planner completing with mixed Fan-out + Swarm proposal JSON
  const allItemsBeforePlan = (await factoryControl.listFactoryWorkItems(org.id, {}, OWNER_ACTOR)).items;
  const planningItem = allItemsBeforePlan.find((w) => w.source?.templateKey === 'planning');
  ok(planningItem, 'Planning work item admitted from generic-planner wake');

  const schedActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}` };
  const lease = await factoryControl.acquireFactorySchedulerLease({
    organizationId: org.id,
    ownerToken: 'stage2-sched-token',
    ttlMs: 60000,
  }, schedActor);

  const claimedPlan = await factoryControl.claimFactoryWork({
    organizationId: org.id,
    workItemId: planningItem.id,
    expectedVersion: planningItem.rowVersion,
    dispatchKey: `plan-dispatch-${planningItem.id}`,
    leaseOwnerToken: lease.ownerToken,
    leaseGeneration: lease.generation,
    bindingGeneration: plannerNode.bindingGeneration,
    managedSessionId: plannerSession.id,
    runtimeTool: 'codex',
  }, schedActor);

  const planCollab = await collabStore.createCollaborationRecord({
    rootSessionId: rootSession.id,
    title: 'Planning Collaboration',
    plan: {
      version: 1,
      tasks: [{
        id: planningItem.id,
        title: 'Generate bounded Stage 2 DAG',
        agentId: 'agent-planner',
        role: 'planner',
        projectId: project.id,
        objective: planningItem.contract.objective,
        dependsOn: [],
        acceptance: [],
        writablePaths: [],
        retry: { maxAttempts: 1, retryOn: [] },
        runtime: {},
        timeoutMs: 60000,
      }],
    },
    idempotencyKey: `plan-collab-${planningItem.id}`,
  });
  await collabStore.markReadyTasks(planCollab.id);
  const planAttempt = await collabStore.claimTaskAttempt(planningItem.id, { sessionId: plannerSession.id });
  const savedCatalogEnabled = activeDetail.policy.planCatalog;
  const planProposalPayload = {
    schemaVersion: 1,
    decision: 'plan',
    steps: [
      {
        id: 'step-fanout',
        entryId: savedCatalogEnabled[0].entryId,
        entryDigest: savedCatalogEnabled[0].entryDigest,
        templateId: savedCatalogEnabled[0].templateId,
        templateVersion: savedCatalogEnabled[0].templateVersion,
        templateDigest: savedCatalogEnabled[0].templateDigest,
        nodeBindings: savedCatalogEnabled[0].nodeBindings,
        modelTierHints: { slice_a: 'lightweight', slice_b: 'lightweight' },
        dependsOn: [],
      },
      {
        id: 'step-swarm',
        entryId: savedCatalogEnabled[1].entryId,
        entryDigest: savedCatalogEnabled[1].entryDigest,
        templateId: savedCatalogEnabled[1].templateId,
        templateVersion: savedCatalogEnabled[1].templateVersion,
        templateDigest: savedCatalogEnabled[1].templateDigest,
        nodeBindings: savedCatalogEnabled[1].nodeBindings,
        modelTierHints: { investigator: 'lightweight', implementer: 'strong', review: 'strong' },
        dependsOn: ['step-fanout'],
      },
    ],
  };
  const planRun = await createTestRun({
    runId: `run_plan_${planningItem.id}`,
    session: plannerSession,
    projectId: project.id,
    state: 'completed',
    summary: JSON.stringify(planProposalPayload),
    usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, costUsd: 0.001 },
  });
  await collabStore.bindAttemptRun(planAttempt.id, { sessionId: plannerSession.id, runId: planRun.id });
  const planPacket = await resultPackets.createExecutionPacket({
    runId: planRun.id,
    projectId: project.id,
    sessionId: plannerSession.id,
    taskId: planningItem.id,
    attemptId: planAttempt.id,
    organizationId: org.id,
    nodeId: plannerNode.id,
    revision: 1,
  });
  await collabStore.completeAttempt(planAttempt.id, { state: 'succeeded', resultPacketId: planPacket.packetId });

  const boundPlan = await factoryControl.updateFactoryBinding({
    organizationId: org.id,
    workItemId: planningItem.id,
    expectedVersion: claimedPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: claimedPlan.item.executionEpoch,
    bindingGeneration: plannerNode.bindingGeneration,
    action: 'bind_run',
    payload: {
      collaborationId: planCollab.id,
      taskId: planningItem.id,
      attemptId: planAttempt.id,
      runId: planRun.id,
    },
  }, schedActor);

  await factoryControl.updateFactoryBinding({
    organizationId: org.id,
    workItemId: planningItem.id,
    expectedVersion: boundPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: boundPlan.item.executionEpoch,
    bindingGeneration: plannerNode.bindingGeneration,
    action: 'submit_candidate',
    payload: {
      digest: planPacket.digest.slice(7),
      packetId: planPacket.packetId,
      packetDigest: planPacket.digest,
      terminalEvidenceRef: `run:${planRun.id}`,
    },
  }, schedActor, {
    verifyCandidate: ({ db, binding, item }) => reportEvidence.verifyFactoryReportEvidence(db, item, binding, planPacket),
  });

  await respPlans.collectResponsibilityPlans();
  const plansListed = await respPlans.listResponsibilityPlans(updatedResp.responsibility.id, OWNER_ACTOR);
  equal(plansListed.plans.length, 1, 'Collected 1 controlled Stage 2 plan');
  const collectedPlan = plansListed.plans[0];
  equal(collectedPlan.state, 'pending_review', 'Stage 2 fanout+swarm plan is NEVER auto-approved even when planApproval=within_policy');

  const detailBeforeApprove = await respService.getResponsibility(updatedResp.responsibility.id, OWNER_ACTOR);
  const approval = await respPlans.approveResponsibilityPlan(updatedResp.responsibility.id, collectedPlan.id, {
    expectedVersion: detailBeforeApprove.responsibility.rowVersion,
    proposalDigest: collectedPlan.proposalDigest,
    confirmed: true,
    idempotencyKey: 'stage2-approve-plan-1',
  }, OWNER_ACTOR);
  equal(approval.state, 'approved');

  const admissionActor = { kind: 'service', role: 'responsibility_admission', principalId: `responsibility-admission:${OWNER_ID}` };
  const admitted = await factoryAdmission.admitResponsibilityPlan({
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    planDigest: collectedPlan.proposalDigest,
    approvalId: approval.approvalId,
    commandId: `admit-cmd-${collectedPlan.id}`,
    idempotencyKey: `admit-idem-${collectedPlan.id}`,
  }, admissionActor);
  equal(admitted.steps.length, 2, 'Admitted both Fan-out and Swarm plan steps');

  const admittedReplay = await factoryAdmission.admitResponsibilityPlan({
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    planDigest: collectedPlan.proposalDigest,
    approvalId: approval.approvalId,
    commandId: `admit-cmd-replay-${collectedPlan.id}`,
    idempotencyKey: `admit-idem-${collectedPlan.id}`,
  }, admissionActor);
  equal(admittedReplay.replayed, true, 'Repeated admission is idempotent');

  const fanoutCtx = await factoryAdmission.getAdmittedPlanStepExecution({
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    stepId: 'step-fanout',
  });
  const swarmCtx = await factoryAdmission.getAdmittedPlanStepExecution({
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    stepId: 'step-swarm',
  });
  equal(fanoutCtx.items.length, 2, 'Fan-out instantiated 2 parallel Work Items');
  equal(swarmCtx.items.length, 2, 'Swarm instantiated coordinator + independent review Work Items');
  const swarmCoordWorkId = swarmCtx.mapping.coordinator;
  const swarmReviewWorkId = swarmCtx.mapping.review;
  const initialSwarmCoordItem = (await factoryControl.getFactoryWorkItem(org.id, swarmCoordWorkId, OWNER_ACTOR)).item;
  equal(initialSwarmCoordItem.state, 'blocked', 'Swarm coordinator blocks until predecessor Fan-out step completes');
  equal(fanoutCtx.fences[fanoutCtx.mapping.slice_a].providerId, 'project-report', 'Read-only fanout keeps adapter-compatible providerId');
  equal(fanoutCtx.fences[fanoutCtx.mapping.slice_a].capability, 'fanout');
  equal(fanoutCtx.fences[fanoutCtx.mapping.slice_a].modelTierHint, 'lightweight');
  equal(swarmCtx.fences[swarmCoordWorkId].capability, 'swarm-collaboration');
  equal(swarmCtx.fences[swarmCoordWorkId].modelTierHint, 'strong');

  // Execute Fan-out step with real governor budget reservation + settlement
  const observedSliceTiering = {};
  const fanoutRun = await factoryAdmission.executeAdmittedPlanFanout({
    runStep: async ({ step, tiering, workItemId }) => {
      ok(workItemId, `Mapped persisted workItemId for fanout step ${step.key}`);
      observedSliceTiering[step.key] = tiering;
      return {
        output: { summary: `audited:${step.key}:${tiering.selectedModel}` },
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.05 },
      };
    },
  }, {
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    stepId: 'step-fanout',
  });

  equal(fanoutRun.status, 'completed');
  equal(observedSliceTiering.slice_a.resolvedTier, 'lightweight', 'Slice A uses lightweight tier');
  equal(observedSliceTiering.slice_b.resolvedTier, 'lightweight', 'Slice B uses lightweight tier');
  ok(fanoutRun.governorCounter.totals.cost >= 0.09, 'Governor settled Fan-out execution cost');
  ok(fanoutRun.aggregatedPacketId, 'Fan-out produced aggregated ResultPacket');

  // Governor tight limit enforcement inside executeAdmittedPlanFanout
  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'should not run' }, usage: { costUsd: 0.01 } }),
    }, {
      organizationId: org.id,
      projectId: project.id,
      planId: collectedPlan.id,
      stepId: 'step-fanout',
      workflowId: 'fanout_budget_tight_check',
      budgetLimits: { maxCost: 0.05 },
    }),
    (err) => err?.code === governor.ORG_BUDGET_EXCEEDED && err?.statusCode === 409,
    'Governor rejects Fan-out execution exceeding maxCost',
  );

  // Mark fanout items accepted via real candidate + manual acceptance so step-swarm unblocks via factory_dependencies
  for (const sliceKey of ['slice_a', 'slice_b']) {
    const sliceId = fanoutCtx.mapping[sliceKey];
    const sliceItemBefore = (await factoryControl.getFactoryWorkItem(org.id, sliceId, OWNER_ACTOR)).item;
    const claimedSlice = await factoryControl.claimFactoryWork({
      organizationId: org.id,
      workItemId: sliceId,
      expectedVersion: sliceItemBefore.rowVersion,
      dispatchKey: `fanout-slice-${sliceId}`,
      leaseOwnerToken: lease.ownerToken,
      leaseGeneration: lease.generation,
      bindingGeneration: readerNode.bindingGeneration,
      managedSessionId: readerSession.id,
      runtimeTool: 'codex',
    }, schedActor);
    const sCollab = await collabStore.createCollaborationRecord({
      rootSessionId: rootSession.id,
      title: `Slice ${sliceKey}`,
      plan: {
        version: 1,
        tasks: [{ id: sliceId, title: sliceKey, agentId: 'agent-reader', role: 'researcher', projectId: project.id, objective: sliceKey, dependsOn: [], acceptance: [], writablePaths: [], retry: { maxAttempts: 1, retryOn: [] }, runtime: {}, timeoutMs: 60000 }],
      },
      idempotencyKey: `slice-collab-${sliceId}`,
    });
    await collabStore.markReadyTasks(sCollab.id);
    const sAtt = await collabStore.claimTaskAttempt(sliceId, { sessionId: readerSession.id });
    const sliceOutcome = fanoutRun.steps.find((s) => s.key === sliceKey);
    const sRun = await createTestRun({
      runId: `run_slice_${sliceId}`,
      session: readerSession,
      projectId: project.id,
      state: 'completed',
      summary: JSON.stringify(sliceOutcome?.output || { summary: sliceKey }),
      usage: { costUsd: 0.01 },
    });
    await collabStore.bindAttemptRun(sAtt.id, { sessionId: readerSession.id, runId: sRun.id });
    const sPkt = await resultPackets.createExecutionPacket({
      runId: sRun.id,
      projectId: project.id,
      sessionId: readerSession.id,
      taskId: sliceId,
      attemptId: sAtt.id,
      organizationId: org.id,
      nodeId: readerNode.id,
      revision: 1,
    });
    await collabStore.completeAttempt(sAtt.id, { state: 'succeeded', resultPacketId: sPkt.packetId });
    const sBound = await factoryControl.updateFactoryBinding({
      organizationId: org.id,
      workItemId: sliceId,
      expectedVersion: claimedSlice.item.rowVersion,
      contractRevision: 1,
      executionEpoch: claimedSlice.item.executionEpoch,
      bindingGeneration: readerNode.bindingGeneration,
      action: 'bind_run',
      payload: { collaborationId: sCollab.id, taskId: sliceId, attemptId: sAtt.id, runId: sRun.id },
    }, schedActor);
    const sCand = await factoryControl.updateFactoryBinding({
      organizationId: org.id,
      workItemId: sliceId,
      expectedVersion: sBound.item.rowVersion,
      contractRevision: 1,
      executionEpoch: sBound.item.executionEpoch,
      bindingGeneration: readerNode.bindingGeneration,
      action: 'submit_candidate',
      payload: { digest: sPkt.digest.slice(7), packetId: sPkt.packetId, packetDigest: sPkt.digest, terminalEvidenceRef: `run:${sRun.id}` },
    }, schedActor, {
      verifyCandidate: ({ db, binding, item }) => reportEvidence.verifyFactoryReportEvidence(db, item, binding, sPkt),
    });
    const sCrit = sCand.item.contract.acceptanceCriteria[0].id;
    await factoryAcceptance.decideFactoryManualAcceptance({
      organizationId: org.id,
      workItemId: sliceId,
      criterionId: sCrit,
      decision: 'passed',
      rationale: `Verified parallel fanout slice ${sliceKey}`,
      commandId: `accept-${sliceId}`,
      idempotencyKey: `accept-${sliceId}`,
      expectedVersion: sCand.item.rowVersion,
      contractRevision: sCand.item.contractRevision,
      gateGeneration: sCand.item.gateGeneration,
      candidateDigest: sCand.item.candidateDigest,
    }, OWNER_ACTOR);
  }

  await workGraph.reconcileFactoryDependencies({
    organizationId: org.id,
    workItemId: swarmCoordWorkId,
    expectedVersion: initialSwarmCoordItem.rowVersion,
    leaseOwnerToken: lease.ownerToken,
    leaseGeneration: lease.generation,
  }, schedActor);
  const unblockedSwarmCoord = (await factoryControl.getFactoryWorkItem(org.id, swarmCoordWorkId, OWNER_ACTOR)).item;
  equal(unblockedSwarmCoord.state, 'ready', 'Swarm coordinator unblocks once Fan-out predecessors accept');

  // Verify read-only Work Item refuses child swarm requesting write privileges
  const roStandalone = await workGraphStore.factoryTransaction((db) => {
    const wfProposal = factoryWorkflow.compileFactoryWorkflow({
      templateId: 'ragent-project-report',
      templateVersion: 1,
      organizationId: org.id,
      projectId: project.id,
      objective: 'Read-only report item',
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      maxAttempts: 1,
      maxCost: 0.2,
    });
    const orgRow = db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id);
    return factoryWorkflow.instantiateFactoryWorkflowInTransaction(db, wfProposal, orgRow, 'ro-bridge-guard-check', {
      assignments: { report: { nodeId: coordNode.id, bindingGeneration: coordNode.bindingGeneration } },
    });
  });
  const roWorkItemId = roStandalone.instance.mapping.report;

  const sessionStoreMap = new Map();
  const runtimeRebinds = [];
  const bridgeDeps = {
    getSession: sessionManager.getSession,
    createSession: async (cwd, tool, title, meta) => {
      const s = await sessionManager.createSession(cwd, tool, title, meta);
      sessionStoreMap.set(s.id, { ...s });
      return s;
    },
    getRunState: async () => ({ running: false }),
    deliverSessionMessage: async (sessionId, text) => ({ delivered: true, sessionId, preview: text.slice(0, 60) }),
    updateSessionRuntime: async (sessionId, patch) => {
      const cur = sessionStoreMap.get(sessionId) || await sessionManager.getSession(sessionId);
      runtimeRebinds.push({ sessionId, patch: { ...patch } });
      if (cur) {
        Object.assign(cur, { tool: patch.tool, model: patch.model });
        sessionStoreMap.set(sessionId, cur);
      }
    },
    runtimeCatalog: [
      { tool: 'codex', models: [{ id: 'gpt-5.4-nano' }, { id: 'gpt-5.4-mini' }, { id: 'gpt-5.4' }] },
      { tool: 'claude', models: [{ id: 'claude-haiku-4.5' }, { id: 'claude-sonnet-4.6' }, { id: 'claude-opus-4.6' }] },
    ],
  };

  await rejects(
    () => swarmBridge.startWorkItemSwarm(bridgeDeps, {
      organizationId: org.id,
      workItemId: roWorkItemId,
      actorNodeId: coordNode.id,
      members: [{ name: 'sneaky-writer', role: 'engineer', accessMode: 'write', writablePaths: ['src/module-a'], workspace: 'worktree' }],
      projectRoot: repoDir,
    }),
    (err) => err?.code === swarmBridge.SWARM_WORK_ITEM_SCOPE_EXCEEDED && err?.statusCode === 403,
    'Read-only Work Item blocks child swarm write escalation',
  );

  // Also test starting admitted Swarm via startAdmittedPlanSwarm
  await rejects(
    () => factoryAdmission.startAdmittedPlanSwarm(bridgeDeps, {
      organizationId: org.id,
      projectId: project.id,
      planId: collectedPlan.id,
      stepId: 'step-swarm',
      members: [{ name: 'unauthorized-extra', brief: 'not in catalog' }],
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    /outside admitted plan catalog/,
    'startAdmittedPlanSwarm rejects members outside admitted plan catalog',
  );

  const startedSwarm = await factoryAdmission.startAdmittedPlanSwarm(bridgeDeps, {
    organizationId: org.id,
    projectId: project.id,
    planId: collectedPlan.id,
    stepId: 'step-swarm',
    projectRoot: repoDir,
    idempotencyKey: 'stage2-start-admitted-swarm',
    actor: OWNER_ACTOR,
  });
  equal(startedSwarm.members.length, 2, 'Spawned both read investigator and write implementer');
  const invMember = startedSwarm.members.find((m) => m.name === 'investigator');
  const implMember = startedSwarm.members.find((m) => m.name === 'implementer');
  equal(invMember.workspaceMode, 'inherit', 'Read investigator stays inherit workspace');
  equal(implMember.workspaceMode, 'worktree', 'Write implementer uses isolated worktree');

  const invNodeAfterSpawn = await orgStore.getNode(invMember.nodeId);
  const implNodeAfterSpawn = await orgStore.getNode(implMember.nodeId);
  equal(invNodeAfterSpawn.bindingGeneration, 1);

  // Verify switching while member is still working fails cleanly with SWARM_MEMBER_BUSY
  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
      organizationId: org.id,
      workItemId: swarmCoordWorkId,
      actorNodeId: coordNode.id,
      targetNameOrNodeId: 'investigator',
      targetTier: 'standard',
      expectedBindingGeneration: invNodeAfterSpawn.bindingGeneration,
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === 'SWARM_MEMBER_BUSY' && err?.statusCode === 409,
    'Model tier switch rejects while worker is still working',
  );

  // Settle investigator & implementer to waiting before controlled switch and workspace promotion
  const swarmMod = await import('../chat/organization-swarm.mjs');
  await swarmMod.markSwarmMemberState({ organizationId: org.id, nodeId: invMember.nodeId, swarmState: 'waiting' });
  await swarmMod.markSwarmMemberState({ organizationId: org.id, nodeId: implMember.nodeId, swarmState: 'waiting' });

  // Switch investigator tier from lightweight -> standard via switchWorkItemSwarmMemberTier
  const switchedInv = await swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
    organizationId: org.id,
    workItemId: swarmCoordWorkId,
    actorNodeId: coordNode.id,
    targetNameOrNodeId: 'investigator',
    targetTier: 'standard',
    expectedBindingGeneration: invNodeAfterSpawn.bindingGeneration,
    reason: 'Escalate investigator to standard tier for dependency analysis',
    handoffNotes: 'Inspect cross-module contract before final edit',
    projectRoot: repoDir,
    actor: OWNER_ACTOR,
  });
  equal(switchedInv.tiering.resolvedTier, 'standard');
  equal(switchedInv.tiering.selectedModel, 'gpt-5.4-mini');
  const invNodeAfterSwitch = await orgStore.getNode(invMember.nodeId);
  equal(invNodeAfterSwitch.bindingGeneration, 2, 'Controlled model switch increments node bindingGeneration');
  ok(runtimeRebinds.some((r) => r.patch.model === 'gpt-5.4-mini'), 'Session runtime updated to tier model');

  // Verify budget exhaustion blocks further tier switch
  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier({
      ...bridgeDeps,
      checkModelBudget: async () => {
        throw Object.assign(new Error('budget exhausted'), { code: 'ORG_BUDGET_EXCEEDED', statusCode: 409 });
      },
    }, {
      organizationId: org.id,
      workItemId: swarmCoordWorkId,
      actorNodeId: coordNode.id,
      targetNameOrNodeId: 'investigator',
      targetTier: 'strong',
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === 'ORG_BUDGET_EXCEEDED' && err?.statusCode === 409,
    'Budget check blocks disallowed model tier upgrade',
  );

  // Implementer writes inside allowed path `src/module-a/feature.js` and completes a canonical Run
  writeFileSync(join(implMember.workspacePath, 'src', 'module-a', 'feature.js'), 'export const value = 42;\n', 'utf8');
  const implNodeLatest = await orgStore.getNode(implMember.nodeId);
  const implSid = implNodeLatest.currentSessionId;
  const implSessionObj = (await sessionManager.getSession(implSid)) || sessionStoreMap.get(implSid);
  ok(implSessionObj, 'Implementer session exists');
  const implRun = await createTestRun({
    runId: `run_impl_${implMember.nodeId}`,
    session: implSessionObj,
    projectId: project.id,
    state: 'completed',
    summary: 'Updated src/module-a/feature.js to 42',
    usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, costUsd: 0.02 },
  });

  const promotedCoord = await swarmBridge.promoteSwarmWorkspaceToCandidate(bridgeDeps, {
    organizationId: org.id,
    targetNameOrNodeId: implMember.nodeId,
    workItemId: swarmCoordWorkId,
    runId: implRun.id,
    title: 'Swarm feature candidate',
    objective: 'Deliver value=42 in src/module-a/feature.js',
    actor: OWNER_ACTOR,
  });
  equal(promotedCoord.workItem.state, 'review', 'Promoted isolated swarm deliverable moves coordinator Work Item into review');

  const coordCriterion = promotedCoord.workItem.contract.acceptanceCriteria[0].id;
  await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: org.id,
    workItemId: swarmCoordWorkId,
    criterionId: coordCriterion,
    decision: 'passed',
    rationale: 'Verified isolated swarm candidate diff',
    commandId: 'accept-swarm-coord',
    idempotencyKey: 'accept-swarm-coord',
    expectedVersion: promotedCoord.workItem.rowVersion,
    contractRevision: promotedCoord.workItem.contractRevision,
    gateGeneration: promotedCoord.workItem.gateGeneration,
    candidateDigest: promotedCoord.workItem.candidateDigest,
  }, OWNER_ACTOR);

  const reviewItemBeforeUnblock = (await factoryControl.getFactoryWorkItem(org.id, swarmReviewWorkId, OWNER_ACTOR)).item;
  await workGraph.reconcileFactoryDependencies({
    organizationId: org.id,
    workItemId: swarmReviewWorkId,
    expectedVersion: reviewItemBeforeUnblock.rowVersion,
    leaseOwnerToken: lease.ownerToken,
    leaseGeneration: lease.generation,
  }, schedActor);
  const reviewItemAfterCoord = (await factoryControl.getFactoryWorkItem(org.id, swarmReviewWorkId, OWNER_ACTOR)).item;
  equal(reviewItemAfterCoord.state, 'ready', 'Independent review Work Item unblocks upon coordinator candidate acceptance');

  // Complete swarm synthesis on coordinator Work Item
  const synthesisRes = await swarmBridge.completeWorkItemSwarm(bridgeDeps, {
    organizationId: org.id,
    workItemId: swarmCoordWorkId,
    actorNodeId: coordNode.id,
    summary: 'Swarm workers investigated and promoted verified feature diff',
    markDone: false,
    actor: OWNER_ACTOR,
  });
  ok(synthesisRes.resultPacket?.packetId, 'completeWorkItemSwarm emits immutable ResultPacket');

  // =========================================================================
  // 4. Worker failure handoff evidence enrichment & unknown_outcome safety
  // =========================================================================
  const failGoalProposal = factoryWorkflow.compileFactoryWorkflow({
    templateId: 'ragent-project-report',
    templateVersion: 1,
    organizationId: org.id,
    projectId: project.id,
    objective: 'Failure handoff evidence verification',
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    maxAttempts: 2,
    maxCost: 0.4,
  });
  const failWf = await workGraphStore.factoryTransaction((db) => {
    const orgRow = db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id);
    return factoryWorkflow.instantiateFactoryWorkflowInTransaction(db, failGoalProposal, orgRow, 'fail-handoff-wf', {
      assignments: { report: { nodeId: readerNode.id, bindingGeneration: 1 } },
    });
  });
  const failItemId = failWf.instance.mapping.report;
  const failRun = await createTestRun({
    runId: `run_fail_${failItemId}`,
    session: readerSession,
    projectId: project.id,
    state: 'failed',
    summary: 'Aborted mid-run',
    usage: { costUsd: 0.01 },
  });
  const failCollab = await collabStore.createCollaborationRecord({
    rootSessionId: rootSession.id,
    title: 'Failure Handoff Collab',
    plan: {
      version: 1,
      tasks: [{ id: failItemId, title: 'Fail task', agentId: 'agent-reader', role: 'researcher', projectId: project.id, objective: 'Fail handoff', dependsOn: [], acceptance: [], writablePaths: [], retry: { maxAttempts: 1, retryOn: [] }, runtime: {}, timeoutMs: 60000 }],
    },
    idempotencyKey: 'fail-collab-1',
  });
  await collabStore.markReadyTasks(failCollab.id);
  const failAttempt = await collabStore.claimTaskAttempt(failItemId, { sessionId: readerSession.id });
  await collabStore.bindAttemptRun(failAttempt.id, { sessionId: readerSession.id, runId: failRun.id });
  const partialPkt = await resultPackets.createExecutionPacket({
    runId: failRun.id,
    projectId: project.id,
    sessionId: readerSession.id,
    taskId: failItemId,
    attemptId: failAttempt.id,
    organizationId: org.id,
    nodeId: readerNode.id,
    revision: 1,
  });
  await collabStore.completeAttempt(failAttempt.id, {
    state: 'failed',
    failureKind: 'unknown_outcome',
    failureReason: 'Worker crashed after Bearer super_secret_token_999 and password=topsecret',
    resultPacketId: partialPkt.packetId,
  });

  // Insert failed binding + agent_interruption_incidents + factory_reconciliation_failures
  await workGraphStore.factoryTransaction((db) => {
    const ts = workGraphStore.now();
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_interruption_incidents (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL, node_id TEXT NOT NULL, binding_generation INTEGER,
      organization_revision INTEGER, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL, task_objective TEXT NOT NULL,
      parent_session_id TEXT NOT NULL, parent_node_id TEXT NOT NULL, root_session_id TEXT NOT NULL,
      category TEXT NOT NULL, source TEXT NOT NULL, confidence TEXT NOT NULL, evidence_ref TEXT NOT NULL,
      side_effects TEXT NOT NULL, occurred_at TEXT NOT NULL, trigger_id TEXT NOT NULL DEFAULT '',
      delivery_state TEXT NOT NULL DEFAULT 'pending', acknowledged_at TEXT, resolved_at TEXT,
      ancestors_json TEXT NOT NULL DEFAULT '[]', escalation_index INTEGER NOT NULL DEFAULT 0,
      escalation_at TEXT, escalation_trigger_id TEXT NOT NULL DEFAULT '', resolution_summary TEXT,
      resolution_evidence TEXT, next_check_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      reported_code TEXT NOT NULL DEFAULT ''
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS factory_reconciliation_failures (
      organization_id TEXT NOT NULL, work_item_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL,
      failures INTEGER NOT NULL, state TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
      error_code TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id,work_item_id,execution_epoch)
    )`).run();

    db.prepare(`INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'binding_fail_1', failItemId, 1, 1, 1, 'dispatch_fail_1', 'unknown',
      failCollab.id, failItemId, failAttempt.id, failRun.id,
      JSON.stringify({ packetId: partialPkt.packetId, artifactRefs: [`artifact:${failRun.id}/log.txt`] }),
      ts, ts,
    );
    db.prepare(`INSERT INTO agent_interruption_incidents (
      id, session_id, run_id, organization_id, node_id, binding_generation, organization_revision,
      attempt_id, task_id, task_objective, parent_session_id, parent_node_id, root_session_id,
      category, source, confidence, evidence_ref, side_effects, occurred_at, created_at, updated_at, reported_code
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'inc_stage2_fail_1', readerSession.id, failRun.id, org.id, readerNode.id, 1, 0,
      failAttempt.id, failItemId, 'Fail handoff', coordSession.id, coordNode.id, rootSession.id,
      'unknown_outcome', 'runner_exit', 'high', `run:${failRun.id}`, 'unknown', ts, ts, ts, 'RUNNER_LOST',
    );
    db.prepare(`INSERT INTO factory_reconciliation_failures VALUES(?,?,?,?,?,?,?,?)`).run(
      org.id, failItemId, 1, 3, 'exhausted', ts, 'RECONCILE_UNKNOWN_RUN', ts,
    );
  });

  const directEvidence = await factoryHandoff.getWorkerFailureHandoffEvidence(org.id, failItemId, OWNER_ACTOR);
  equal(directEvidence.unknownExecution, true);
  equal(directEvidence.autoRedispatchForbidden, true, 'unknown_outcome forbids automatic redispatch');
  ok(directEvidence.failures.length >= 1, 'Failure record present');
  ok(directEvidence.failures[0].incident_id === 'inc_stage2_fail_1', 'Failure linked to interruption incident');
  ok(directEvidence.failures[0].packet_id === partialPkt.packetId, 'Failure linked to ResultPacket');
  ok(!directEvidence.failures[0].reason.includes('super_secret_token_999'), 'Sensitive Bearer token redacted from failure reason');
  ok(!directEvidence.failures[0].reason.includes('topsecret'), 'Sensitive password redacted from failure reason');
  ok(Buffer.byteLength(JSON.stringify(directEvidence.failures[0]), 'utf8') <= 300, 'Failure entry fits workerRefs 300-byte budget');

  const itemBeforeHandoff = (await factoryControl.getFactoryWorkItem(org.id, failItemId, OWNER_ACTOR)).item;
  const createdHandoff = await factoryHandoff.createFactoryTaskHandoff({
    organizationId: org.id,
    workItemId: failItemId,
    expectedVersion: itemBeforeHandoff.rowVersion,
    commandId: 'handoff-fail-evidence-1',
  }, OWNER_ACTOR);
  equal(createdHandoff.unknownExecution, true, 'Handoff preserves unknownExecution flag');
  equal(createdHandoff.autoRedispatchForbidden, true, 'Handoff marks autoRedispatchForbidden on unknown_outcome');
  equal(createdHandoff.assessment, 'unknown', 'Handoff assessment is unknown rather than safe/current');
  ok(createdHandoff.staleReasons.includes('execution_outcome_unknown'), 'Stale reasons flag unknown execution outcome');
  ok(createdHandoff.failureEvidence.incidentRefs.some((i) => i.id === 'inc_stage2_fail_1'), 'Handoff surfaces interruption incident ref');
  ok(createdHandoff.failureEvidence.reconciliationFailures.some((rf) => rf.state === 'exhausted'), 'Handoff surfaces reconciliation dead-letter state');
  ok(createdHandoff.failureEvidence.artifactRefs.some((a) => a.packet_id === partialPkt.packetId), 'Handoff surfaces verifiable partial packet artifact');

  const remoteSummary = workGraphStore.factoryRead((db) => {
    const raw = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(failItemId);
    const c = JSON.parse(db.prepare('SELECT contract_json, digest FROM factory_work_contracts WHERE work_item_id = ? AND revision = 1').get(failItemId).contract_json);
    const cd = db.prepare('SELECT digest FROM factory_work_contracts WHERE work_item_id = ? AND revision = 1').get(failItemId).digest;
    return factoryHandoff.remoteFactoryTaskSummary(db, {
      organizationId: org.id,
      workItemId: raw.id,
      contractDigest: cd,
      payload: { contract: c },
    }, 8192);
  });
  const remoteArr = await remoteSummary;
  equal(remoteArr.facts.failures.length, 1, 'Bounded failure entry survives remoteFactoryTaskSummary 300-byte filter');
  equal(remoteArr.facts.failures[0].incident_id, 'inc_stage2_fail_1');

  // =========================================================================
  // 5. Stage 2 verifier #33 regression checks
  // =========================================================================

  // 5a. #33-2 / #33-3: Terminal/completed fanout steps & Work Items reject re-execution or tier switching
  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'should not execute completed fanout' } }),
    }, {
      organizationId: org.id,
      projectId: project.id,
      planId: collectedPlan.id,
      stepId: 'step-fanout',
      workflowId: 'fanout_completed_guard_check',
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'executeAdmittedPlanFanout rejects already-completed fanout work items with 409 FACTORY_CONFLICT',
  );

  const completedFanoutSliceAId = fanoutCtx.mapping.slice_a;
  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
      organizationId: org.id,
      workItemId: completedFanoutSliceAId,
      actorNodeId: coordNode.id,
      targetNameOrNodeId: 'investigator',
      targetTier: 'lightweight',
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'switchWorkItemSwarmMemberTier rejects completed Work Items with 409 FACTORY_CONFLICT',
  );

  // 5b. Dedicated org whose budget lives solely in organizations.budget_json (no policy.budgetLimits)
  const budgetRootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage2 Budget Only Root', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const budgetOrg = await orgStore.createOrganization({
    projectId: project.id,
    rootSessionId: budgetRootSession.id,
    state: 'active',
    currentRevision: 1,
    policy: {
      projectRoot: repoDir,
      factoryMaxConcurrent: 4,
      allowModelSwitch: true,
      allowedHarnesses: ['codex', 'claude'],
      allowedPaths: ['src/module-a'],
    },
    budget: { maxCost: 0.02, maxTokens: 5000, maxRuns: 5 },
    idempotencyKey: 'stage2-budget-only-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = [process.env.RAGENT_FACTORY_ORGANIZATIONS, budgetOrg.id].filter(Boolean).join(',');

  const createBudgetNode = async ({
    stableKey,
    nodeRole = 'specialist',
    sessionClass = 'WORKER',
    role,
    agentId,
    capabilities = ['run'],
    grant,
    writeScope = [],
  }) => {
    const fullCaps = [...new Set(['read', ...capabilities])];
    const node = await orgStore.createNode({
      organizationId: budgetOrg.id,
      stableKey,
      nodeRole,
      createdRevision: 1,
      lifecycleState: 'active',
      sessionClass,
      grant: { allowedCapabilities: fullCaps, ...grant },
    });
    const sess = await sessionManager.createSession(repoDir, 'codex', `Stage2 Budget ${stableKey}`, {
      projectId: project.id,
      sessionPlane: 'organization',
      sessionClass,
      organizationId: budgetOrg.id,
      organizationRevision: 1,
      nodeId: node.id,
      lifecycleMode: 'formal_org',
      managedScope: 'organization',
      organizationRootSessionId: budgetRootSession.id,
      controllerSessionId: budgetRootSession.id,
      parentSessionId: budgetRootSession.id,
      role,
      agentId,
      model: 'gpt-5.4-mini',
    });
    const bound = await orgStore.bindNodeSession(node.id, { sessionId: sess.id, expectedBindingGeneration: 0 });
    for (const cap of fullCaps) {
      await orgStore.createGrant({
        organizationId: budgetOrg.id,
        nodeId: bound.id,
        revision: 1,
        capability: cap,
        allow: true,
        scope: cap === 'write'
          ? { projectId: project.id, writablePaths: writeScope }
          : { projectId: project.id },
      });
    }
    return { node: bound, session: sess };
  };

  const budgetPlanner = await createBudgetNode({
    stableKey: 'budget-planner-node',
    role: 'planner',
    agentId: 'agent-budget-planner',
    grant: { canRead: true, canRun: true, canWrite: false, canReview: false, writablePaths: [] },
  });
  const budgetReader = await createBudgetNode({
    stableKey: 'budget-reader-node',
    role: 'researcher',
    agentId: 'agent-budget-reader',
    grant: { canRead: true, canRun: true, canWrite: false, canReview: false, writablePaths: [] },
  });
  const budgetCoord = await createBudgetNode({
    stableKey: 'budget-coord-node',
    nodeRole: 'root_leadership',
    sessionClass: 'WORKER',
    role: 'coordinator',
    agentId: 'agent-budget-coord',
    capabilities: ['run', 'write'],
    writeScope: ['src/module-a'],
    grant: {
      canRead: true,
      canRun: true,
      canWrite: true,
      canDelegate: true,
      maxDepth: 2,
      writablePaths: ['src/module-a'],
      workspaceScope: repoDir,
    },
  });
  const budgetReviewer = await createBudgetNode({
    stableKey: 'budget-reviewer-node',
    sessionClass: 'REVIEWER',
    role: 'reviewer',
    agentId: 'agent-budget-reviewer',
    capabilities: ['run', 'review'],
    grant: { canRead: true, canRun: true, canReview: true, canWrite: false, writablePaths: [] },
  });

  const budgetProposedWf = await workGraphStore.factoryTransaction((db) => {
    const proposal = factoryWorkflow.compileFactoryWorkflow({
      templateId: 'ragent-project-report',
      templateVersion: 1,
      organizationId: budgetOrg.id,
      projectId: project.id,
      objective: 'Proposed state swarm guard check',
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      maxAttempts: 1,
      maxCost: 0.01,
    });
    const orgRow = db.prepare('SELECT * FROM organizations WHERE id = ?').get(budgetOrg.id);
    return factoryWorkflow.instantiateFactoryWorkflowInTransaction(db, proposal, orgRow, 'budget-proposed-wf');
  });
  const budgetProposedWorkId = budgetProposedWf.instance.mapping.report;

  const budgetSwarmWf = await workGraphStore.factoryTransaction((db) => {
    const proposal = factoryWorkflow.compileFactoryWorkflow({
      templateId: 'ragent-reviewed-change',
      templateVersion: 1,
      organizationId: budgetOrg.id,
      projectId: project.id,
      objective: 'Swarm budget_json and blocked review check',
      targetBranch: 'main',
      allowedPaths: ['src/module-a'],
      candidateScope: 'src/module-a',
      maxAttempts: 1,
      maxCost: 0.01,
    });
    const orgRow = db.prepare('SELECT * FROM organizations WHERE id = ?').get(budgetOrg.id);
    return factoryWorkflow.instantiateFactoryWorkflowInTransaction(db, proposal, orgRow, 'budget-swarm-wf', {
      assignments: {
        implementation: { nodeId: budgetCoord.node.id, bindingGeneration: budgetCoord.node.bindingGeneration },
        review: { nodeId: budgetReviewer.node.id, bindingGeneration: budgetReviewer.node.bindingGeneration },
        integration: { nodeId: budgetCoord.node.id, bindingGeneration: budgetCoord.node.bindingGeneration },
      },
    });
  });
  const budgetSwarmWorkId = budgetSwarmWf.instance.mapping.implementation;
  const budgetBlockedReviewWorkId = budgetSwarmWf.instance.mapping.review;

  const budgetOtherWf = await workGraphStore.factoryTransaction((db) => {
    const proposal = factoryWorkflow.compileFactoryWorkflow({
      templateId: 'ragent-project-report',
      templateVersion: 1,
      organizationId: budgetOrg.id,
      projectId: project.id,
      objective: 'Other ready Work Item for cross-item isolation check',
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      maxAttempts: 1,
      maxCost: 0.01,
    });
    const orgRow = db.prepare('SELECT * FROM organizations WHERE id = ?').get(budgetOrg.id);
    return factoryWorkflow.instantiateFactoryWorkflowInTransaction(db, proposal, orgRow, 'budget-other-wf', {
      assignments: { report: { nodeId: budgetCoord.node.id, bindingGeneration: budgetCoord.node.bindingGeneration } },
    });
  });
  const budgetOtherWorkId = budgetOtherWf.instance.mapping.report;

  // #33-2: startWorkItemSwarm & switchWorkItemSwarmMemberTier reject proposed/blocked Work Items
  await rejects(
    () => swarmBridge.startWorkItemSwarm(bridgeDeps, {
      organizationId: budgetOrg.id,
      workItemId: budgetProposedWorkId,
      actorNodeId: budgetCoord.node.id,
      members: [{ name: 'proposed-worker', role: 'researcher', accessMode: 'read', workspace: 'inherit' }],
      projectRoot: repoDir,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'startWorkItemSwarm rejects proposed Work Item with 409 FACTORY_CONFLICT',
  );
  await rejects(
    () => swarmBridge.startWorkItemSwarm(bridgeDeps, {
      organizationId: budgetOrg.id,
      workItemId: budgetBlockedReviewWorkId,
      actorNodeId: budgetCoord.node.id,
      members: [{ name: 'blocked-worker', role: 'researcher', accessMode: 'read', workspace: 'inherit' }],
      projectRoot: repoDir,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'startWorkItemSwarm rejects blocked Work Item with 409 FACTORY_CONFLICT',
  );
  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
      organizationId: budgetOrg.id,
      workItemId: budgetBlockedReviewWorkId,
      actorNodeId: budgetCoord.node.id,
      targetNameOrNodeId: 'alpha',
      targetTier: 'standard',
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'switchWorkItemSwarmMemberTier rejects blocked Work Item with 409 FACTORY_CONFLICT',
  );

  // Spawn 'alpha' on open budgetSwarmWorkId to verify cross-item isolation + case-insensitive lookup (#33-3)
  const alphaStarted = await swarmBridge.startWorkItemSwarm(bridgeDeps, {
    organizationId: budgetOrg.id,
    workItemId: budgetSwarmWorkId,
    actorNodeId: budgetCoord.node.id,
    members: [{ name: 'alpha', role: 'researcher', accessMode: 'read', workspace: 'inherit', capabilities: ['read', 'run'] }],
    projectRoot: repoDir,
  });
  const alphaMember = alphaStarted.members[0];
  await swarmMod.markSwarmMemberState({ organizationId: budgetOrg.id, nodeId: alphaMember.nodeId, swarmState: 'waiting' });

  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
      organizationId: budgetOrg.id,
      workItemId: budgetOtherWorkId,
      actorNodeId: budgetCoord.node.id,
      targetNameOrNodeId: 'alpha',
      targetTier: 'standard',
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === swarmBridge.SWARM_WORK_ITEM_SCOPE_EXCEEDED && err?.statusCode === 403,
    'switchWorkItemSwarmMemberTier blocks cross-Work-Item member switching with 403 SWARM_WORK_ITEM_SCOPE_EXCEEDED',
  );

  const alphaNodeBeforeSwitch = await orgStore.getNode(alphaMember.nodeId);
  const alphaSwitched = await swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
    organizationId: budgetOrg.id,
    workItemId: budgetSwarmWorkId,
    actorNodeId: budgetCoord.node.id,
    targetNameOrNodeId: 'ALPHA',
    targetTier: 'standard',
    expectedBindingGeneration: alphaNodeBeforeSwitch.bindingGeneration,
    projectRoot: repoDir,
    actor: OWNER_ACTOR,
  });
  equal(alphaSwitched.member.nodeId, alphaMember.nodeId, 'switchWorkItemSwarmMemberTier resolves member stableKey case-insensitively');
  equal(alphaSwitched.tiering.selectedModel, 'gpt-5.4-mini');

  // 5c. #33-1 + #33-2 on executeAdmittedPlanFanout: blocked step + organizations.budget_json enforcement
  const budgetProjectFact = await respProject.captureResponsibilityProject(budgetOrg.id, project.id);
  const budgetFanoutReadyEntry = {
    ...readFanoutEntry,
    entryId: 'budget-fanout-ready',
    nodeBindings: { read: { nodeId: budgetReader.node.id, bindingGeneration: budgetReader.node.bindingGeneration } },
  };
  const budgetFanoutBlockedEntry = {
    ...readFanoutEntry,
    entryId: 'budget-fanout-blocked',
    nodeBindings: { read: { nodeId: budgetReader.node.id, bindingGeneration: budgetReader.node.bindingGeneration } },
  };
  const budgetResp = await respService.createResponsibility({
    organizationId: budgetOrg.id,
    projectId: project.id,
    objective: 'Verify organizations.budget_json and blocked fanout guards',
    successCriteria: ['Blocked and budget-overrun fanout rejected cleanly'],
    idempotencyKey: 'stage2-budget-resp-init',
    policy: {
      ...basePlannerPolicy,
      maxCost: 0.01,
      projectFactId: budgetProjectFact.id,
      nodeBindings: { planning: { nodeId: budgetPlanner.node.id, bindingGeneration: budgetPlanner.node.bindingGeneration } },
      capabilityGates: { allowFanout: true, allowSwarm: false, allowWrite: false, allowModelSwitch: false },
      planCatalog: [budgetFanoutReadyEntry, budgetFanoutBlockedEntry],
    },
  }, OWNER_ACTOR);
  await respService.setResponsibilityLifecycle(budgetResp.responsibility.id, 'resume', {
    expectedVersion: budgetResp.responsibility.rowVersion,
    idempotencyKey: 'stage2-budget-resp-resume',
  }, OWNER_ACTOR);
  const budgetRespActive = await respService.getResponsibility(budgetResp.responsibility.id, OWNER_ACTOR);
  const budgetTrigRes = await respTrigger.createResponsibilityTrigger(budgetResp.responsibility.id, {
    type: 'at_time',
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
    confirmed: true,
    expectedVersion: budgetRespActive.responsibility.rowVersion,
    idempotencyKey: 'stage2-budget-resp-trig',
  }, OWNER_ACTOR);
  await respTrigger.reconcileResponsibilityTriggerBindings();
  await respTrigger.deliverResponsibilityTrigger({
    id: budgetTrigRes.binding.triggerId,
    sessionId: budgetRootSession.id,
    triggerType: 'at_time',
    occurrence: 0,
    scheduledAt: budgetTrigRes.binding.config.scheduledAt,
  });
  const budgetRespRuntime = respRuntimeMod.createResponsibilityRuntime({
    intervalMs: 60000,
    onError: (err) => respErrors.push(err),
  });
  budgetRespRuntime.start();
  await budgetRespRuntime.tick();
  await budgetRespRuntime.stop();
  equal(respErrors.length, 0, `Budget responsibility runtime errors: ${respErrors.map((e) => e?.stack || e?.message).join('; ')}`);

  const budgetPlanItem = (await factoryControl.listFactoryWorkItems(budgetOrg.id, {}, OWNER_ACTOR)).items
    .find((w) => w.source?.templateKey === 'planning');
  ok(budgetPlanItem, 'Planning item created for budget-only org');

  const budgetLease = await factoryControl.acquireFactorySchedulerLease({
    organizationId: budgetOrg.id,
    ownerToken: 'stage2-budget-scheduler',
    ttlMs: 60000,
  }, schedActor);
  const claimedBudgetPlan = await factoryControl.claimFactoryWork({
    organizationId: budgetOrg.id,
    workItemId: budgetPlanItem.id,
    expectedVersion: budgetPlanItem.rowVersion,
    dispatchKey: `plan-dispatch-${budgetPlanItem.id}`,
    leaseOwnerToken: budgetLease.ownerToken,
    leaseGeneration: budgetLease.generation,
    bindingGeneration: budgetPlanner.node.bindingGeneration,
    managedSessionId: budgetPlanner.session.id,
    runtimeTool: 'codex',
  }, schedActor);

  const budgetPlanCollab = await collabStore.createCollaborationRecord({
    rootSessionId: budgetRootSession.id,
    title: 'Budget Fanout Guard Planning Collab',
    plan: {
      version: 1,
      tasks: [{
        id: budgetPlanItem.id,
        title: 'Propose 2-step fanout DAG',
        agentId: 'agent-budget-planner',
        role: 'planner',
        projectId: project.id,
        objective: budgetPlanItem.contract.objective,
        dependsOn: [],
        acceptance: [],
        writablePaths: [],
        retry: { maxAttempts: 1, retryOn: [] },
        runtime: {},
        timeoutMs: 60000,
      }],
    },
    idempotencyKey: `plan-collab-${budgetPlanItem.id}`,
  });
  await collabStore.markReadyTasks(budgetPlanCollab.id);
  const budgetPlanAttempt = await collabStore.claimTaskAttempt(budgetPlanItem.id, { sessionId: budgetPlanner.session.id });
  const budgetCatalog = budgetRespActive.policy.planCatalog;
  const budgetPlanPayload = {
    schemaVersion: 1,
    decision: 'plan',
    steps: [
      {
        id: 'step-ready-fanout',
        entryId: budgetCatalog[0].entryId,
        entryDigest: budgetCatalog[0].entryDigest,
        templateId: budgetCatalog[0].templateId,
        templateVersion: budgetCatalog[0].templateVersion,
        templateDigest: budgetCatalog[0].templateDigest,
        nodeBindings: budgetCatalog[0].nodeBindings,
        dependsOn: [],
      },
      {
        id: 'step-blocked-fanout',
        entryId: budgetCatalog[1].entryId,
        entryDigest: budgetCatalog[1].entryDigest,
        templateId: budgetCatalog[1].templateId,
        templateVersion: budgetCatalog[1].templateVersion,
        templateDigest: budgetCatalog[1].templateDigest,
        nodeBindings: budgetCatalog[1].nodeBindings,
        dependsOn: ['step-ready-fanout'],
      },
    ],
  };
  const budgetPlanRun = await createTestRun({
    runId: `run_plan_${budgetPlanItem.id}`,
    session: budgetPlanner.session,
    projectId: project.id,
    state: 'completed',
    summary: JSON.stringify(budgetPlanPayload),
    usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, costUsd: 0.001 },
  });
  await collabStore.bindAttemptRun(budgetPlanAttempt.id, { sessionId: budgetPlanner.session.id, runId: budgetPlanRun.id });
  const budgetPlanPacket = await resultPackets.createExecutionPacket({
    runId: budgetPlanRun.id,
    projectId: project.id,
    sessionId: budgetPlanner.session.id,
    taskId: budgetPlanItem.id,
    attemptId: budgetPlanAttempt.id,
    organizationId: budgetOrg.id,
    nodeId: budgetPlanner.node.id,
    revision: 1,
  });
  await collabStore.completeAttempt(budgetPlanAttempt.id, { state: 'succeeded', resultPacketId: budgetPlanPacket.packetId });
  const boundBudgetPlan = await factoryControl.updateFactoryBinding({
    organizationId: budgetOrg.id,
    workItemId: budgetPlanItem.id,
    expectedVersion: claimedBudgetPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: claimedBudgetPlan.item.executionEpoch,
    bindingGeneration: budgetPlanner.node.bindingGeneration,
    action: 'bind_run',
    payload: {
      collaborationId: budgetPlanCollab.id,
      taskId: budgetPlanItem.id,
      attemptId: budgetPlanAttempt.id,
      runId: budgetPlanRun.id,
    },
  }, schedActor);
  await factoryControl.updateFactoryBinding({
    organizationId: budgetOrg.id,
    workItemId: budgetPlanItem.id,
    expectedVersion: boundBudgetPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: boundBudgetPlan.item.executionEpoch,
    bindingGeneration: budgetPlanner.node.bindingGeneration,
    action: 'submit_candidate',
    payload: {
      digest: budgetPlanPacket.digest.slice(7),
      packetId: budgetPlanPacket.packetId,
      packetDigest: budgetPlanPacket.digest,
      terminalEvidenceRef: `run:${budgetPlanRun.id}`,
    },
  }, schedActor, {
    verifyCandidate: ({ db, binding, item }) => reportEvidence.verifyFactoryReportEvidence(db, item, binding, budgetPlanPacket),
  });

  await respPlans.collectResponsibilityPlans();
  const budgetPlan = (await respPlans.listResponsibilityPlans(budgetResp.responsibility.id, OWNER_ACTOR)).plans[0];
  ok(budgetPlan, 'Collected budget-only org Stage 2 plan');
  const budgetRespBeforeApprove = await respService.getResponsibility(budgetResp.responsibility.id, OWNER_ACTOR);
  const budgetApproval = await respPlans.approveResponsibilityPlan(budgetResp.responsibility.id, budgetPlan.id, {
    expectedVersion: budgetRespBeforeApprove.responsibility.rowVersion,
    proposalDigest: budgetPlan.proposalDigest,
    confirmed: true,
    idempotencyKey: 'stage2-budget-approve-plan',
  }, OWNER_ACTOR);
  await factoryAdmission.admitResponsibilityPlan({
    organizationId: budgetOrg.id,
    projectId: project.id,
    planId: budgetPlan.id,
    planDigest: budgetPlan.proposalDigest,
    approvalId: budgetApproval.approvalId,
    commandId: `admit-cmd-${budgetPlan.id}`,
    idempotencyKey: `admit-idem-${budgetPlan.id}`,
  }, admissionActor);

  // Blocked step must fail DAG gate with 409 FACTORY_CONFLICT
  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'blocked step must not execute' } }),
    }, {
      organizationId: budgetOrg.id,
      projectId: project.id,
      planId: budgetPlan.id,
      stepId: 'step-blocked-fanout',
      workflowId: 'budget_blocked_fanout_check',
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'executeAdmittedPlanFanout rejects blocked DAG step with 409 FACTORY_CONFLICT',
  );

  // Ready step reserves against organizations.budget_json (maxCost: 0.02) even with no policy.budgetLimits
  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'over budget_json must not execute' }, usage: { costUsd: 0.01 } }),
    }, {
      organizationId: budgetOrg.id,
      projectId: project.id,
      planId: budgetPlan.id,
      stepId: 'step-ready-fanout',
      workflowId: 'budget_json_fanout_limit_check',
    }),
    (err) => err?.code === governor.ORG_BUDGET_EXCEEDED && err?.statusCode === 409,
    'executeAdmittedPlanFanout enforces organizations.budget_json when policy.budgetLimits is omitted',
  );

  // Exhaust organizations.budget_json (0.02) via governor reservation + settlement
  await governor.reserveFactoryBudget({
    organizationId: budgetOrg.id,
    revision: 1,
    reservationId: 'exhaust-budget-only-org',
    idempotencyKey: 'exhaust-budget-only-org',
    delta: { tokens: 200, cost: 0.02, runs: 1 },
  });
  await governor.settleFactoryBudget({
    organizationId: budgetOrg.id,
    revision: 1,
    reservationId: 'exhaust-budget-only-org',
    idempotencyKey: 'exhaust-budget-only-org',
    backendUsage: { tokens: 200, cost: 0.02, runs: 1 },
  });

  const budgetOnlyTiering = await swarmBridge.resolveSwarmWorkItemModelTier({
    organizationId: budgetOrg.id,
    workItemId: budgetSwarmWorkId,
    targetTier: 'lightweight',
    actor: OWNER_ACTOR,
  });
  equal(budgetOnlyTiering.budgetExceeded, true, 'resolveSwarmWorkItemModelTier detects exhaustion from organizations.budget_json');
  equal(budgetOnlyTiering.budgetOk, false);
  equal(budgetOnlyTiering.reason, 'budget_exhausted');

  const alphaNodeAfterSwitch = await orgStore.getNode(alphaMember.nodeId);
  await rejects(
    () => swarmBridge.switchWorkItemSwarmMemberTier(bridgeDeps, {
      organizationId: budgetOrg.id,
      workItemId: budgetSwarmWorkId,
      actorNodeId: budgetCoord.node.id,
      targetNameOrNodeId: 'alpha',
      targetTier: 'lightweight',
      expectedBindingGeneration: alphaNodeAfterSwitch.bindingGeneration,
      projectRoot: repoDir,
      actor: OWNER_ACTOR,
    }),
    (err) => err?.code === governor.ORG_BUDGET_EXCEEDED && err?.statusCode === 409,
    'switchWorkItemSwarmMemberTier rejects once organizations.budget_json cost cap is exhausted',
  );

  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'exhausted budget must not run' } }),
    }, {
      organizationId: budgetOrg.id,
      projectId: project.id,
      planId: budgetPlan.id,
      stepId: 'step-ready-fanout',
      workflowId: 'budget_json_exhausted_fanout_check',
    }),
    (err) => err?.code === governor.ORG_BUDGET_EXCEEDED && err?.statusCode === 409,
    'executeAdmittedPlanFanout fails fast with ORG_BUDGET_EXCEEDED once organizations.budget_json is exhausted',
  );

  // =========================================================================
  // 6. Parallel Fan-out with maxTokens configured on org + dailyBudget (#37)
  // =========================================================================
  const tokRootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage2 MaxTokens Parallel Root', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const tokOrg = await orgStore.createOrganization({
    projectId: project.id,
    rootSessionId: tokRootSession.id,
    state: 'active',
    currentRevision: 1,
    policy: {
      projectRoot: repoDir,
      factoryMaxConcurrent: 4,
      allowModelSwitch: true,
      allowedHarnesses: ['codex', 'claude'],
      allowedPaths: ['src/module-a'],
      budgetLimits: { maxCost: 5.0, maxTokens: 200000, maxRuns: 10 },
    },
    budget: { maxCost: 5.0, maxTokens: 200000, maxRuns: 10 },
    idempotencyKey: 'stage2-max-tokens-parallel-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = [process.env.RAGENT_FACTORY_ORGANIZATIONS, tokOrg.id].filter(Boolean).join(',');

  const createTokNode = async ({ stableKey, role, agentId }) => {
    const fullCaps = ['read', 'run'];
    const node = await orgStore.createNode({
      organizationId: tokOrg.id,
      stableKey,
      nodeRole: 'specialist',
      createdRevision: 1,
      lifecycleState: 'active',
      sessionClass: 'WORKER',
      grant: { allowedCapabilities: fullCaps, canRead: true, canRun: true, canWrite: false, canReview: false, writablePaths: [] },
    });
    const sess = await sessionManager.createSession(repoDir, 'codex', `Stage2 Tok ${stableKey}`, {
      projectId: project.id,
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      organizationId: tokOrg.id,
      organizationRevision: 1,
      nodeId: node.id,
      lifecycleMode: 'formal_org',
      managedScope: 'organization',
      organizationRootSessionId: tokRootSession.id,
      controllerSessionId: tokRootSession.id,
      parentSessionId: tokRootSession.id,
      role,
      agentId,
      model: 'gpt-5.4-nano',
    });
    const bound = await orgStore.bindNodeSession(node.id, { sessionId: sess.id, expectedBindingGeneration: 0 });
    for (const cap of fullCaps) {
      await orgStore.createGrant({
        organizationId: tokOrg.id,
        nodeId: bound.id,
        revision: 1,
        capability: cap,
        allow: true,
        scope: { projectId: project.id },
      });
    }
    return { node: bound, session: sess };
  };

  const tokPlanner = await createTokNode({ stableKey: 'tok-planner-node', role: 'planner', agentId: 'agent-tok-planner' });
  const tokReader = await createTokNode({ stableKey: 'tok-reader-node', role: 'researcher', agentId: 'agent-tok-reader' });
  const tokProjectFact = await respProject.captureResponsibilityProject(tokOrg.id, project.id);
  const tokFanoutEntry = {
    ...readFanoutEntry,
    entryId: 'tok-fanout-parallel',
    maxConcurrency: 2,
    nodeBindings: { read: { nodeId: tokReader.node.id, bindingGeneration: tokReader.node.bindingGeneration } },
  };
  const tokResp = await respService.createResponsibility({
    organizationId: tokOrg.id,
    projectId: project.id,
    objective: 'Verify parallel maxTokens slicing in executeAdmittedPlanFanout',
    successCriteria: ['Both parallel slices reserve bounded tokens and complete'],
    idempotencyKey: 'stage2-tok-resp-init',
    policy: {
      ...basePlannerPolicy,
      projectFactId: tokProjectFact.id,
      nodeBindings: { planning: { nodeId: tokPlanner.node.id, bindingGeneration: tokPlanner.node.bindingGeneration } },
      dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxTokens: 100000, maxCost: 2.0 },
      capabilityGates: { allowFanout: true, allowSwarm: false, allowWrite: false, allowModelSwitch: false },
      planCatalog: [tokFanoutEntry],
    },
  }, OWNER_ACTOR);
  await respService.setResponsibilityLifecycle(tokResp.responsibility.id, 'resume', {
    expectedVersion: tokResp.responsibility.rowVersion,
    idempotencyKey: 'stage2-tok-resp-resume',
  }, OWNER_ACTOR);
  const tokRespActive = await respService.getResponsibility(tokResp.responsibility.id, OWNER_ACTOR);
  const tokTrigRes = await respTrigger.createResponsibilityTrigger(tokResp.responsibility.id, {
    type: 'at_time',
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
    confirmed: true,
    expectedVersion: tokRespActive.responsibility.rowVersion,
    idempotencyKey: 'stage2-tok-resp-trig',
  }, OWNER_ACTOR);
  await respTrigger.reconcileResponsibilityTriggerBindings();
  await respTrigger.deliverResponsibilityTrigger({
    id: tokTrigRes.binding.triggerId,
    sessionId: tokRootSession.id,
    triggerType: 'at_time',
    occurrence: 0,
    scheduledAt: tokTrigRes.binding.config.scheduledAt,
  });
  const tokRespRuntime = respRuntimeMod.createResponsibilityRuntime({
    intervalMs: 60000,
    onError: (err) => respErrors.push(err),
  });
  tokRespRuntime.start();
  await tokRespRuntime.tick();
  await tokRespRuntime.stop();
  equal(respErrors.length, 0, `Token test responsibility errors: ${respErrors.map((e) => e?.message).join('; ')}`);

  const tokPlanItem = (await factoryControl.listFactoryWorkItems(tokOrg.id, {}, OWNER_ACTOR)).items
    .find((w) => w.source?.templateKey === 'planning');
  ok(tokPlanItem, 'Planning item created for maxTokens parallel org');
  const tokLease = await factoryControl.acquireFactorySchedulerLease({
    organizationId: tokOrg.id,
    ownerToken: 'stage2-tok-scheduler',
    ttlMs: 60000,
  }, schedActor);
  const claimedTokPlan = await factoryControl.claimFactoryWork({
    organizationId: tokOrg.id,
    workItemId: tokPlanItem.id,
    expectedVersion: tokPlanItem.rowVersion,
    dispatchKey: `plan-dispatch-${tokPlanItem.id}`,
    leaseOwnerToken: tokLease.ownerToken,
    leaseGeneration: tokLease.generation,
    bindingGeneration: tokPlanner.node.bindingGeneration,
    managedSessionId: tokPlanner.session.id,
    runtimeTool: 'codex',
  }, schedActor);
  const tokCollab = await collabStore.createCollaborationRecord({
    rootSessionId: tokRootSession.id,
    title: 'Parallel MaxTokens Planning Collab',
    plan: {
      version: 1,
      tasks: [{
        id: tokPlanItem.id,
        title: 'Propose parallel maxTokens fanout',
        agentId: 'agent-tok-planner',
        role: 'planner',
        projectId: project.id,
        objective: tokPlanItem.contract.objective,
        dependsOn: [],
        acceptance: [],
        writablePaths: [],
        retry: { maxAttempts: 1, retryOn: [] },
        runtime: {},
        timeoutMs: 60000,
      }],
    },
    idempotencyKey: `plan-collab-${tokPlanItem.id}`,
  });
  await collabStore.markReadyTasks(tokCollab.id);
  const tokAttempt = await collabStore.claimTaskAttempt(tokPlanItem.id, { sessionId: tokPlanner.session.id });
  const tokCat = tokRespActive.policy.planCatalog[0];
  const tokPlanRun = await createTestRun({
    runId: `run_plan_${tokPlanItem.id}`,
    session: tokPlanner.session,
    projectId: project.id,
    state: 'completed',
    summary: JSON.stringify({
      schemaVersion: 1,
      decision: 'plan',
      steps: [{
        id: 'step-tok-fanout',
        entryId: tokCat.entryId,
        entryDigest: tokCat.entryDigest,
        templateId: tokCat.templateId,
        templateVersion: tokCat.templateVersion,
        templateDigest: tokCat.templateDigest,
        nodeBindings: tokCat.nodeBindings,
        dependsOn: [],
      }],
    }),
    usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, costUsd: 0.001 },
  });
  await collabStore.bindAttemptRun(tokAttempt.id, { sessionId: tokPlanner.session.id, runId: tokPlanRun.id });
  const tokPlanPacket = await resultPackets.createExecutionPacket({
    runId: tokPlanRun.id,
    projectId: project.id,
    sessionId: tokPlanner.session.id,
    taskId: tokPlanItem.id,
    attemptId: tokAttempt.id,
    organizationId: tokOrg.id,
    nodeId: tokPlanner.node.id,
    revision: 1,
  });
  await collabStore.completeAttempt(tokAttempt.id, { state: 'succeeded', resultPacketId: tokPlanPacket.packetId });
  const boundTokPlan = await factoryControl.updateFactoryBinding({
    organizationId: tokOrg.id,
    workItemId: tokPlanItem.id,
    expectedVersion: claimedTokPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: claimedTokPlan.item.executionEpoch,
    bindingGeneration: tokPlanner.node.bindingGeneration,
    action: 'bind_run',
    payload: {
      collaborationId: tokCollab.id,
      taskId: tokPlanItem.id,
      attemptId: tokAttempt.id,
      runId: tokPlanRun.id,
    },
  }, schedActor);
  await factoryControl.updateFactoryBinding({
    organizationId: tokOrg.id,
    workItemId: tokPlanItem.id,
    expectedVersion: boundTokPlan.item.rowVersion,
    contractRevision: 1,
    executionEpoch: boundTokPlan.item.executionEpoch,
    bindingGeneration: tokPlanner.node.bindingGeneration,
    action: 'submit_candidate',
    payload: {
      digest: tokPlanPacket.digest.slice(7),
      packetId: tokPlanPacket.packetId,
      packetDigest: tokPlanPacket.digest,
      terminalEvidenceRef: `run:${tokPlanRun.id}`,
    },
  }, schedActor, {
    verifyCandidate: ({ db, binding, item }) => reportEvidence.verifyFactoryReportEvidence(db, item, binding, tokPlanPacket),
  });
  await respPlans.collectResponsibilityPlans();
  const tokPlan = (await respPlans.listResponsibilityPlans(tokResp.responsibility.id, OWNER_ACTOR)).plans[0];
  ok(tokPlan, 'Collected parallel maxTokens Stage 2 plan');
  const tokRespBeforeApprove = await respService.getResponsibility(tokResp.responsibility.id, OWNER_ACTOR);
  const tokApproval = await respPlans.approveResponsibilityPlan(tokResp.responsibility.id, tokPlan.id, {
    expectedVersion: tokRespBeforeApprove.responsibility.rowVersion,
    proposalDigest: tokPlan.proposalDigest,
    confirmed: true,
    idempotencyKey: 'stage2-tok-approve-plan',
  }, OWNER_ACTOR);
  await factoryAdmission.admitResponsibilityPlan({
    organizationId: tokOrg.id,
    projectId: project.id,
    planId: tokPlan.id,
    planDigest: tokPlan.proposalDigest,
    approvalId: tokApproval.approvalId,
    commandId: `admit-cmd-${tokPlan.id}`,
    idempotencyKey: `admit-idem-${tokPlan.id}`,
  }, admissionActor);

  // Force true concurrent reservation overlap using a 2-party arrival barrier before either settles
  let barrierArrived = 0;
  let releaseBarrier;
  const bothReserved = new Promise((resolve) => { releaseBarrier = resolve; });
  const tokFanoutRun = await factoryAdmission.executeAdmittedPlanFanout({
    runStep: async ({ step }) => {
      barrierArrived += 1;
      if (barrierArrived === 2) releaseBarrier();
      await Promise.race([
        bothReserved,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Expected concurrent slice_a & slice_b execution')), 3000)),
      ]);
      return {
        output: { summary: `tok-ok:${step.key}` },
        usage: { inputTokens: 60, outputTokens: 60, totalTokens: 120, costUsd: 0.01 },
      };
    },
  }, {
    organizationId: tokOrg.id,
    projectId: project.id,
    planId: tokPlan.id,
    stepId: 'step-tok-fanout',
    maxConcurrency: 2,
    workflowId: 'tok_parallel_max_tokens_check',
  });
  equal(tokFanoutRun.status, 'completed', 'Concurrent parallel slices succeed with org.budget.maxTokens & dailyBudget.maxTokens');
  equal(tokFanoutRun.governorCounter.totals.tokens, 240);
  equal(tokFanoutRun.governorCounter.reserved.tokens, 0);
  equal(tokFanoutRun.governorCounter.reservations.res_tok_parallel_max_tokens_check_slice_a?.delta?.tokens, 50000);
  equal(tokFanoutRun.governorCounter.reservations.res_tok_parallel_max_tokens_check_slice_b?.delta?.tokens, 50000);

  // Second run verifies updated remaining tokens (100000 - 240 = 99760 -> 49880/slice)
  const tokFanoutSecond = await factoryAdmission.executeAdmittedPlanFanout({
    runStep: async ({ step }) => ({
      output: { summary: `tok-second:${step.key}` },
      usage: { inputTokens: 60, outputTokens: 60, totalTokens: 120, costUsd: 0.01 },
    }),
  }, {
    organizationId: tokOrg.id,
    projectId: project.id,
    planId: tokPlan.id,
    stepId: 'step-tok-fanout',
    maxConcurrency: 1,
    workflowId: 'tok_parallel_max_tokens_second',
  });
  equal(tokFanoutSecond.status, 'completed', 'Subsequent fanout computes bounded slice from updated remainingTokens');
  equal(tokFanoutSecond.governorCounter.totals.tokens, 480);
  equal(tokFanoutSecond.governorCounter.reservations.res_tok_parallel_max_tokens_second_slice_a?.delta?.tokens, 49880);
  equal(tokFanoutSecond.governorCounter.reservations.res_tok_parallel_max_tokens_second_slice_b?.delta?.tokens, 49880);

  // Tight token budget (maxTokens == used 480 -> 0 remaining) rejects cleanly upfront
  await rejects(
    () => factoryAdmission.executeAdmittedPlanFanout({
      runStep: async () => ({ output: { summary: 'exhausted maxTokens must not execute' } }),
    }, {
      organizationId: tokOrg.id,
      projectId: project.id,
      planId: tokPlan.id,
      stepId: 'step-tok-fanout',
      workflowId: 'tok_exhausted_max_tokens_check',
      budgetLimits: { maxTokens: 480 },
    }),
    (err) => err?.code === governor.ORG_BUDGET_EXCEEDED && err?.statusCode === 409,
    'executeAdmittedPlanFanout rejects with 409 ORG_BUDGET_EXCEEDED when availableTokens <= 0',
  );

  void createAgentInterruptionIncidentTable;
  console.log('test-stage2-swarm-bridge: ok (all assertions passed)');
}

try {
  await runTests();
} finally {
  try {
    await resultPackets.closeResultPacketStore();
  } catch {}
  try {
    await orgStore.closeOrganizationDatabase?.();
  } catch {}
  rmSync(tempHome, { recursive: true, force: true });
}
