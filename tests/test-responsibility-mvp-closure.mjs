#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Script } from 'node:vm';

const baseTmpDir = process.env.RAGENT_TEST_TMPDIR || process.env.TMPDIR || process.env.TEMP || tmpdir();
mkdirSync(baseTmpDir, { recursive: true });
const tempRoot = mkdtempSync(join(baseTmpDir, 'ragent-mvp-closure-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const workspace = join(tempRoot, 'workspace');
const srcDir = join(workspace, 'src');
const fakeHarnessRoot = join(tempRoot, 'harnesses');
const fakeCodexBinDir = join(fakeHarnessRoot, 'codex', 'node_modules', '.bin');

mkdirSync(fakeCodexBinDir, { recursive: true });
writeFileSync(join(fakeCodexBinDir, 'codex.cmd'), '@echo off\r\necho codex-cli 0.1.0\r\n', 'utf8');
writeFileSync(join(fakeCodexBinDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.1.0"\n', 'utf8');
try { chmodSync(join(fakeCodexBinDir, 'codex'), 0o755); } catch {}
process.env.RAGENT_HARNESS_ROOT = fakeHarnessRoot;
process.env.PATH = `${fakeCodexBinDir}${delimiter}${process.env.PATH || ''}`;

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';
process.env.RAGENT_ORG_SESSION_ADDRESSABILITY = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = 'owner-mvp';
process.env.RAGENT_FACTORY_ORGANIZATIONS = 'org_mvp_closure_1,org_mvp_closure_2,org_mvp_closure_3';
process.env.RAGENT_AUTH_SESSION_SECRET = 'mvp-closure-test-auth-secret';

mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, 'README.md'), '# MVP Test Workspace\n', 'utf8');

const projects = await import('../chat/projects.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { classifyAttemptOutcome } = await import('../chat/collaboration-plan.mjs');
const workGraph = await import('../chat/work-graph.mjs');
const workGraphStore = await import('../chat/work-graph-store.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const runs = await import('../chat/runs.mjs');
const history = await import('../chat/history.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const workflow = await import('../chat/factory-workflow.mjs');
const { createFactoryExecutionAdapter } = await import('../chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await import('../chat/factory-scheduler.mjs');
const { decideFactoryManualAcceptance } = await import('../chat/factory-acceptance.mjs');
const { resolveFactoryRunBudget } = await import('../chat/factory-run-budget.mjs');
const { verifyFactoryResponsibilityFence } = await import('../chat/factory-responsibility-admission.mjs');
const reconciliation = await import('../chat/factory-reconciliation.mjs');
const {
  GENERIC_PLANNER_PROVIDER,
  PROJECT_REPORT_PROVIDER,
} = await import('../chat/responsibility-providers.mjs');
const {
  createResponsibility,
  getResponsibility,
  listResponsibilityWorkLinks,
  listResponsibilityActivity,
  updateResponsibility,
  setResponsibilityLifecycle,
} = await import('../chat/responsibility-service.mjs');
const { wakeResponsibility } = await import('../chat/responsibility-events.mjs');
const { createResponsibilityRuntime } = await import('../chat/responsibility-runtime.mjs');
const {
  listResponsibilityPlans,
  approveResponsibilityPlan,
  collectResponsibilityPlans,
} = await import('../chat/responsibility-plans.mjs');
const responsibilityStore = await import('../chat/responsibility-store.mjs');
const auth = await import('../lib/auth.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');
const { handleFactoryRoutes } = await import('../chat/router-factory-routes.mjs');

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const val = target[prop];
    if (typeof val === 'function') {
      return (...args) => {
        assertionCount += 1;
        return val.apply(target, args);
      };
    }
    return val;
  },
});

const activeRuntimes = [];
const OWNER_ACTOR = { kind: 'user', role: 'owner', principalId: 'owner-mvp' };
let ownerCookieHeader = '';
let ownerAuthSession = { role: 'owner' };
const SCHEDULER_ACTOR = {
  kind: 'service',
  role: 'factory_scheduler',
  principalId: 'factory-scheduler:owner-mvp',
  authorizingPrincipalId: 'owner-mvp',
};

function futureIso(days = 30) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function callRoute(handler, { method, path, body = null, authSession = ownerAuthSession }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': 'application/json', ...(ownerCookieHeader ? { cookie: ownerCookieHeader } : {}) };
  req.socket = { encrypted: false };
  let statusCode = 0;
  let payload = null;
  const res = {};
  const writeJson = (_res, status, data) => {
    statusCode = status;
    payload = data;
  };
  const promise = handler({ req, res, pathname: path, authSession, writeJson });
  process.nextTick(() => {
    if (body !== null) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
    }
    req.emit('end');
  });
  const handled = await promise;
  return { handled, statusCode, payload };
}

function makeHttpResponse(statusCode, payload) {
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/**
 * Create a controlled collaboration orchestrator backed by real SQLite collaboration-store,
 * real FS Run records, real history final_answer events, and real ResultPackets.
 */
function createRealBackedOrchestrator({ projectId, folder, onDispatch }) {
  const trackedRuns = [];
  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      getSession: (id) => sessionManager.getSession(id),
      getApp: async (id) => (id ? {
        id,
        name: id,
        tool: 'codex',
        model: 'gpt-5',
        effort: 'medium',
        accessMode: 'read',
        runtime: { tool: 'codex', model: 'gpt-5', effort: 'medium' },
      } : null),
      getProject: () => projects.getProject(projectId),
      createSession: (dir, tool, name, extra) => sessionManager.createSession(dir, tool, name, extra),
      sendMessage: async (sessionId, text, _images, options = {}) => {
        const session = await sessionManager.getSession(sessionId);
        a.ok(session, `session ${sessionId} exists for dispatch`);
        const behavior = onDispatch ? await onDispatch({ sessionId, session, text, options }) : { mode: 'complete', summary: 'default ok' };

        if (behavior.mode === 'pre_dispatch_crash') {
          const err = new Error('Simulated crash after uncertain provider dispatch');
          err.code = 'ETIMEDOUT';
          throw err;
        }

        const run = await runs.createRun({
          status: {
            sessionId,
            requestId: options.requestId,
            tool: session.tool || 'codex',
            model: session.model || 'gpt-5',
            effort: session.effort || 'medium',
            state: 'running',
            startedAt: behavior.startedAt || new Date().toISOString(),
            createdAt: behavior.createdAt || new Date().toISOString(),
          },
          manifest: {
            sessionId,
            requestId: options.requestId,
            projectId,
            folder,
            executionScope: options.executionScope || { projectId },
          },
        });
        const budgetProbe = options.requestId
          ? await resolveFactoryRunBudget({ sessionId, requestId: options.requestId, runId: run.id, managed: true })
          : null;
        trackedRuns.push({ runId: run.id, sessionId, requestId: options.requestId, budgetProbe });

        if (behavior.mode === 'complete' || behavior.mode === 'complete_with_cancel_requested') {
          await finalizeTestRun({
            runId: run.id,
            sessionId,
            requestId: options.requestId,
            summary: behavior.summary,
            usage: behavior.usage,
            cancelRequested: behavior.mode === 'complete_with_cancel_requested',
          });
        }

        const currentRun = await runs.getRun(run.id);
        return { session, run: currentRun, prompt: text };
      },
      getRunState: (id) => runs.getRun(id),
      getRun: (id) => runs.getRun(id),
      getRunResult: (id) => runs.getRunResult(id),
      getRunManifest: (id) => runs.getRunManifest(id),
      listRunIds: () => runs.listRunIds(),
      requestRunCancel: (id) => runs.requestRunCancel(id),
      loadHistory: (sessionId) => history.loadHistory(sessionId),
      resolveRuntimeReadOnlyCapability: async () => ({
        supportsReadOnlyFilesystem: true,
        sandboxMode: 'test-ro',
        runtimeId: 'test-ro',
      }),
    },
  });
  orchestrator.trackedRuns = trackedRuns;
  return orchestrator;
}

async function finalizeTestRun({ runId, sessionId, requestId, summary, usage = undefined, cancelRequested = false }) {
  await history.appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    messagePhase: 'final_answer',
    providerMessageId: `msg_${runId}`,
    content: summary,
    runId,
    requestId,
  });
  if (usage) {
    await history.appendEvent(sessionId, {
      type: 'usage',
      usageScope: 'provider_turn_total',
      costSource: 'provider_reported',
      costUsd: usage.costUsd ?? usage.cost_usd ?? 0.04,
      usageAccountingTokens: usage.totalTokens ?? usage.total_tokens ?? 200,
      runId,
      requestId,
    });
  }
  if (cancelRequested) {
    await runs.requestRunCancel(runId);
  }
  const resultPayload = {
    ok: true,
    summary,
    ...(usage !== undefined ? { usage } : {}),
  };
  const doneAt = new Date().toISOString();
  await runs.updateRun(runId, (r) => ({
    ...r,
    state: 'completed',
    completedAt: doneAt,
    finalizedAt: doneAt,
  }));
  await runs.writeRunResult(runId, resultPayload);
}

async function provisionOrgWithWorkers({ orgId, rootTitle, plannerKey, workerKey }) {
  const rootSession = await sessionManager.createSession(workspace, 'codex', rootTitle, {
    sessionPlane: 'user',
    projectId: (await projects.listProjects())[0].id,
    model: 'gpt-5',
    effort: 'medium',
  });
  const project = (await projects.listProjects())[0];

  const org = await orgStore.createOrganization({
    id: orgId,
    rootSessionId: rootSession.id,
    projectId: project.id,
    currentRevision: 1,
    policy: { factoryMaxConcurrent: 4 },
    budget: { agents: 10, runs: 100, tokens: 200000, cost: 100 },
  });
  await orgStore.createRevision(org.id, {
    revision: 1,
    proposal: { title: rootTitle },
    compiled: { nodes: [] },
    digest: createHash('sha256').update(orgId).digest('hex'),
    state: 'draft',
  });
  await orgStore.freezeRevision(org.id, 1);

  async function addWorkerNode(stableKey, role, capabilities, writablePaths = []) {
    const grant = {
      canWrite: capabilities.includes('write'),
      canReview: capabilities.includes('review'),
      canDelegate: false,
      allowedCapabilities: capabilities,
      writablePaths,
      executionIsolation: 'shared',
    };
    const roleInst = await orgStore.createRoleInstance({
      organizationId: org.id,
      organizationRevision: 1,
      stableKey: `role-${stableKey}`,
      role,
      agentId: `agent-${stableKey}`,
    });
    const node = await orgStore.createNode({
      organizationId: org.id,
      stableKey,
      nodeRole: role,
      createdRevision: 1,
      roleInstanceId: roleInst.id,
      bindingGeneration: 0,
      sessionClass: 'WORKER',
      grant,
    });
    await orgStore.bindRoleInstanceNode(roleInst.id, node.id);
    const session = await sessionManager.createSession(workspace, 'codex', `Worker ${stableKey}`, {
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      organizationRootSessionId: rootSession.id,
      controllerSessionId: rootSession.id,
      parentSessionId: rootSession.id,
      organizationId: org.id,
      organizationNodeId: node.id,
      organizationRevision: 1,
      roleInstanceId: roleInst.id,
      projectId: project.id,
      templateId: `tpl-${stableKey}`,
      model: 'gpt-5',
      effort: 'medium',
      accessMode: capabilities.includes('write') ? 'write' : 'read',
    });
    await orgStore.bindNodeSession(node.id, {
      expectedBindingGeneration: 0,
      sessionId: session.id,
      roleInstanceId: roleInst.id,
    });
    await orgStore.materializeFrozenNodeGrants({
      organizationId: org.id,
      nodeId: node.id,
      revision: 1,
      expectedGrant: grant,
    });
    const freshNode = await orgStore.getNode(node.id);
    return { node: freshNode, session, roleInst };
  }

  const planner = await addWorkerNode(plannerKey, 'planner', ['read', 'review', 'run']);
  const reporter = await addWorkerNode(workerKey, 'specialist', ['read', 'run']);
  return { project, rootSession, org, planner, reporter };
}

async function admitTestWorkItem({
  organizationId,
  projectId,
  title,
  objective,
  assigneeNodeId,
  priority = 1,
  responsibility = null,
  source = { kind: 'manual' },
  maxAttempts = 1,
  maxCost = 1,
  criterionId = 'ac_manual',
}) {
  const op = responsibility ? `mvp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const goalRes = await factoryControl.executeFactoryCommand({
    commandId: `cmd_goal_${op}`,
    idempotencyKey: `goal_${op}`,
    organizationId,
    targetId: organizationId,
    type: 'CreateGoal',
    payload: { projectId, title, objective },
  }, OWNER_ACTOR);
  const itemRes = await factoryControl.executeFactoryCommand({
    commandId: `cmd_wi_${op}`,
    idempotencyKey: `wi_${op}`,
    organizationId,
    targetId: organizationId,
    type: 'CreateWorkItem',
    payload: {
      goalId: goalRes.goal.id,
      kind: 'analysis',
      ownership: 'active',
      priority,
      assigneeNodeId,
      contract: {
        objective,
        requiredRole: 'specialist',
        accessMode: 'read',
        allowedPaths: [],
        writablePaths: [],
        acceptanceCriteria: [{ id: criterionId, method: 'manual' }],
        retry: { maxAttempts },
        budget: { maxCost },
        budgetReservation: { cost: maxCost },
        maxAttempts,
        maxCost,
        resource: { projectId, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
        ...(responsibility ? { responsibility } : {}),
      },
      source,
    },
  }, OWNER_ACTOR);
  const approvedRes = await factoryControl.executeFactoryCommand({
    commandId: `cmd_approve_${op}`,
    idempotencyKey: `approve_${op}`,
    organizationId,
    targetId: itemRes.item.id,
    type: 'ApproveContract',
    expectedVersion: itemRes.item.rowVersion,
    payload: {},
  }, OWNER_ACTOR);
  return { goal: goalRes.goal, workItem: approvedRes.item };
}

async function getWorkItemDetail(organizationId, workItemId) {
  return factoryControl.getFactoryWorkItem(organizationId, workItemId, OWNER_ACTOR, { includeReport: true });
}

async function listWakes(responsibilityId) {
  return responsibilityStore.read((db) =>
    db.prepare('SELECT * FROM responsibility_wakes WHERE responsibility_id = ? ORDER BY created_at, id').all(responsibilityId),
  );
}

function buildMinimalDomSandbox(fetcher) {
  function makeElement(tagName) {
    const el = {
      tagName: String(tagName || 'div').toUpperCase(),
      children: [],
      attributes: {},
      style: {},
      className: '',
      id: '',
      type: '',
      value: '',
      placeholder: '',
      checked: false,
      disabled: false,
      hidden: false,
      maxLength: 4000,
      listeners: new Map(),
      _textContent: '',
      _innerHTML: '',
      parentElement: null,
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      replaceChildren(...nodes) {
        this.children = [];
        this._textContent = '';
        this._innerHTML = '';
        for (const node of nodes) this.appendChild(node);
      },
      setAttribute(name, val) {
        const s = String(val);
        this.attributes[name] = s;
        if (name === 'id') this.id = s;
        if (name === 'class') this.className = s;
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      dispatch(type, extra = {}) {
        for (const fn of this.listeners.get(type) || []) {
          fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...extra });
        }
      },
      click() {
        this.dispatch('click');
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const results = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (matches(child, selector)) results.push(child);
            walk(child);
          }
        };
        walk(this);
        return results;
      },
      get textContent() {
        if (this.children.length === 0) return this._textContent || '';
        return this.children.map((c) => c.textContent).join(' ');
      },
      set textContent(v) {
        this.children = [];
        this._textContent = String(v ?? '');
      },
      get innerHTML() {
        if (this._innerHTML) return this._innerHTML;
        return this.children
          .map((c) => `<${c.tagName.toLowerCase()}>${c.textContent}</${c.tagName.toLowerCase()}>`)
          .join('');
      },
      set innerHTML(v) {
        this._innerHTML = String(v ?? '');
      },
      getBoundingClientRect() {
        return { width: 800, height: 600 };
      },
      closest() {
        return null;
      },
    };
    return el;
  }

  function matches(el, selector) {
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    if (selector.startsWith('.')) return String(el.className || '').split(/\s+/).includes(selector.slice(1));
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  const body = makeElement('body');
  const document = {
    documentElement: { lang: 'en', dataset: {} },
    body,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => body.querySelector(`#${id}`),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener() {},
  };
  const domTimers = new Set();
  const win = {
    document,
    fetch: fetcher,
    ragentFetch: fetcher,
    crypto: globalThis.crypto,
    location: { search: '' },
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn, ms, ...args) {
      const id = setTimeout(fn, ms, ...args);
      id.unref?.();
      domTimers.add(id);
      return id;
    },
    clearTimeout(id) {
      domTimers.delete(id);
      clearTimeout(id);
    },
    requestAnimationFrame(fn) { fn(Date.now()); return 1; },
    cancelAnimationFrame() {},
    prompt() { return 'owner confirmed resolution'; },
    confirm() { return true; },
  };
  win.window = win;
  return {
    win,
    document,
    cleanup() {
      for (const id of domTimers) clearTimeout(id);
      domTimers.clear();
    },
  };
}

async function runTests() {
  const ownerToken = await auth.issueSession({ role: 'owner', username: 'owner' });
  a.ok(ownerToken, 'owner session token issued');
  ownerCookieHeader = auth.setCookie(ownerToken).split(';')[0];
  ownerAuthSession = auth.getAuthSession({ headers: { cookie: ownerCookieHeader }, socket: { encrypted: false } }) || { role: 'owner' };
  await projects.ensureProjectsInitialized();
  await projects.createProject({ name: 'MVP Project', rootPath: workspace });
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();
  await collabStore.initializeCollaborationStore();

  const plannerFormula = workflow.getFactoryFormula('ragent-responsibility-planner', 1);
  const reportFormula = workflow.getFactoryFormula('ragent-project-report', 1);

  // =========================================================================
  // Group 1: Full non-CI generic-planner E2E + stale-version & fence guards
  // =========================================================================
  const env1 = await provisionOrgWithWorkers({
    orgId: 'org_mvp_closure_1',
    rootTitle: 'MVP Closure Root 1',
    plannerKey: 'planner-main',
    workerKey: 'reporter-main',
  });

  let nextDispatchMode = 'planner_plan';
  const orchestrator1 = createRealBackedOrchestrator({
    projectId: env1.project.id,
    folder: workspace,
    onDispatch: async () => {
      if (nextDispatchMode === 'planner_plan') {
        const planJson = JSON.stringify({
          schemaVersion: 1,
          decision: 'plan',
          steps: [
            {
              id: 'report-1',
              entryId: 'report-entry-1',
              entryDigest: undefined,
              templateId: 'ragent-project-report',
              templateVersion: 1,
              templateDigest: reportFormula.digest,
              nodeBindings: { report: { nodeId: env1.reporter.node.id, bindingGeneration: 1 } },
              dependsOn: [],
            },
          ],
        });
        return {
          mode: 'complete',
          summary: `Here is the bounded plan:\n\`\`\`json\n${planJson}\n\`\`\``,
          usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200, cost_usd: 0.04 },
        };
      }
      if (nextDispatchMode === 'step_report') {
        return {
          mode: 'complete',
          summary: 'Project readiness report: all bounded checks reviewed cleanly.',
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.03 },
        };
      }
      return { mode: 'complete', summary: 'Unexpected dispatch' };
    },
  });

  const adapter1 = createFactoryExecutionAdapter({
    organizationId: env1.org.id,
    actor: SCHEDULER_ACTOR,
    orchestrator: orchestrator1,
  });
  const scheduler1 = createFactoryScheduler({
    organizationId: env1.org.id,
    actor: SCHEDULER_ACTOR,
    adapter: adapter1,
    admissionEnabled: true,
  });

  const plannerCatalogEntry = {
    entryId: 'report-entry-1',
    capability: 'project-report',
    templateId: 'ragent-project-report',
    templateVersion: 1,
    templateDigest: reportFormula.digest,
    nodeBindings: { report: { nodeId: env1.reporter.node.id, bindingGeneration: 1 } },
    resource: { projectId: env1.project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    maxAttempts: 1,
    maxCost: 1,
    autoApproval: false,
    requiresHumanApproval: true,
  };

  const policy1 = {
    providerId: 'generic-planner',
    providerVersion: GENERIC_PLANNER_PROVIDER.version,
    providerDigest: GENERIC_PLANNER_PROVIDER.digest,
    templateId: 'ragent-responsibility-planner',
    templateVersion: 1,
    templateDigest: plannerFormula.digest,
    validUntil: futureIso(30),
    resource: { projectId: env1.project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    networkPermissionConfirmed: true,
    nodeBindings: { planning: { nodeId: env1.planner.node.id, bindingGeneration: 1 } },
    maxAttempts: 1,
    maxCost: 1,
    dailyBudget: { timeZone: 'Asia/Shanghai', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    planCatalog: [plannerCatalogEntry],
    planExecutionMaxAttempts: 2,
    planExecutionMaxCost: 2,
    planApproval: 'always',
  };

  // Create via real HTTP route
  const createdRespRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    path: '/api/responsibilities',
    body: {
      projectId: env1.project.id,
      organizationId: env1.org.id,
      objective: 'Maintain project readiness baseline',
      successCriteria: ['Generate project readiness report and verify acceptance'],
      intervalMs: 60000,
      policy: policy1,
      idempotencyKey: 'mvp-create-1',
    },
  });
  a.equal(createdRespRes.handled, true, 'POST /api/responsibilities handled');
  a.equal(createdRespRes.statusCode, 200, `POST /api/responsibilities returns 200: ${JSON.stringify(createdRespRes.payload)}`);
  const resp1 = createdRespRes.payload.responsibility;
  const savedEntryDigest = createdRespRes.payload.policy.planCatalog[0].entryDigest;
  a.ok(savedEntryDigest, 'normalized catalog computes entryDigest');
  const getResp1Res = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    path: `/api/responsibilities/${resp1.id}`,
  });
  a.equal(getResp1Res.statusCode, 200, 'GET /api/responsibilities/:id returns 200');
  a.equal(getResp1Res.payload.budgetStatus?.costEnforcement, 'admission_estimate_only', 'exposes admission_estimate_only boundary');
  a.equal(getResp1Res.payload.budgetStatus?.hardCapAvailable, false, 'exposes hardCapAvailable: false');

  // Inject real normalized entryDigest into fake planner output
  const realPlanDispatch = orchestrator1;
  void realPlanDispatch;
  const patchedEntryDigest = savedEntryDigest;
  const orchestrator1Wrapped = createRealBackedOrchestrator({
    projectId: env1.project.id,
    folder: workspace,
    onDispatch: async () => {
      if (nextDispatchMode === 'planner_plan') {
        const planJson = JSON.stringify({
          schemaVersion: 1,
          decision: 'plan',
          steps: [
            {
              id: 'report-1',
              entryId: 'report-entry-1',
              entryDigest: patchedEntryDigest,
              templateId: 'ragent-project-report',
              templateVersion: 1,
              templateDigest: reportFormula.digest,
              nodeBindings: { report: { nodeId: env1.reporter.node.id, bindingGeneration: 1 } },
              dependsOn: [],
            },
          ],
        });
        return {
          mode: 'complete',
          summary: `\`\`\`json\n${planJson}\n\`\`\``,
          usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200, cost_usd: 0.04 },
        };
      }
      return {
        mode: 'complete',
        summary: 'Project readiness report: verified.',
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.03 },
      };
    },
  });
  const schedErrors = [];
  const adapter1Real = createFactoryExecutionAdapter({
    organizationId: env1.org.id,
    actor: SCHEDULER_ACTOR,
    orchestrator: orchestrator1Wrapped,
  });
  const scheduler1Real = createFactoryScheduler({
    organizationId: env1.org.id,
    actor: SCHEDULER_ACTOR,
    adapter: adapter1Real,
    admissionEnabled: true,
    pollMs: 60000,
    onError: (e) => schedErrors.push(e?.message || String(e)),
  });
  activeRuntimes.push(scheduler1Real, orchestrator1, orchestrator1Wrapped);
  void scheduler1;

  // Stale-version update rejection
  await a.rejects(
    () => updateResponsibility(resp1.id, {
      expectedVersion: 999,
      objective: 'Stale write should fail',
      idempotencyKey: 'stale-update-1',
    }, OWNER_ACTOR),
    (err) => err?.code === 'RESPONSIBILITY_CONFLICT',
    'stale expectedVersion rejected on updateResponsibility',
  );

  // Resume + wake idempotency & coalescing
  const resumed1 = await setResponsibilityLifecycle(resp1.id, 'resume', {
    expectedVersion: resp1.rowVersion,
    idempotencyKey: 'resume-1',
  }, OWNER_ACTOR);
  a.equal(resumed1.responsibility.lifecycle, 'active', 'responsibility resumed to active');

  const wake1 = await wakeResponsibility(resp1.id, {
    expectedVersion: resumed1.responsibility.rowVersion,
    idempotencyKey: 'wake-idem-1',
  }, OWNER_ACTOR);
  const wake1Replay = await wakeResponsibility(resp1.id, {
    expectedVersion: resumed1.responsibility.rowVersion,
    idempotencyKey: 'wake-idem-1',
  }, OWNER_ACTOR);
  a.equal(wake1Replay.wake.id, wake1.wake.id, 'duplicate wake with same idempotencyKey replays cleanly');
  a.equal(wake1Replay.replayed, true, 'wake replay flagged');

  const wakeCoalesced = await wakeResponsibility(resp1.id, {
    expectedVersion: resumed1.responsibility.rowVersion,
    idempotencyKey: 'wake-coalesce-2',
  }, OWNER_ACTOR);
  a.notEqual(wakeCoalesced.wake.id, wake1.wake.id, 'second wake with distinct idempotencyKey queued');

  // Tick responsibility runtime -> first wake admits planning work item; overlapping second wake is held/skipped instead of double-admitting
  const runtime1 = createResponsibilityRuntime({ intervalMs: 60000, onError: (err) => { throw err; } });
  activeRuntimes.push(runtime1);
  runtime1.start();
  await runtime1.tick();

  const detailAfterWake = await getResponsibility(resp1.id, OWNER_ACTOR);
  const wakesAfter1 = await listWakes(resp1.id);
  const wakeRetry1 = await responsibilityStore.read((db) => db.prepare('SELECT * FROM responsibility_wake_retry').all());
  const actAfter1 = await listResponsibilityActivity(resp1.id, {}, OWNER_ACTOR);
  const admittedWakes1 = wakesAfter1.filter((w) => w.state === 'admitted');
  a.equal(
    admittedWakes1.length,
    1,
    `exactly one wake admitted; wakes=${JSON.stringify(wakesAfter1)} retry=${JSON.stringify(wakeRetry1)} activity=${JSON.stringify(actAfter1.activity)}`,
  );
  a.equal(admittedWakes1[0].id, wake1.wake.id, 'oldest wake is admitted');

  // Run factory scheduler -> dispatches planner run -> orchestrator reconciles Run -> adapter produces ResultPacket & review work item
  await scheduler1Real.start();
  await orchestrator1Wrapped.reconcile();
  await scheduler1Real.tick();

  // Collect responsibility plans via runtime tick (supports single fenced JSON block)
  await runtime1.tick();
  const plansAfterCollect = await listResponsibilityPlans(resp1.id, OWNER_ACTOR);
  a.equal(plansAfterCollect.plans.length, 1, 'collected 1 plan proposal from fenced planner ResultPacket');
  const collectedPlan = plansAfterCollect.plans[0];
  a.equal(collectedPlan.state, 'pending_review', 'non-auto plan starts in pending_review');
  a.equal(collectedPlan.admitted, false, 'unapproved plan is not yet admitted');

  // Stale proposalDigest / expectedVersion plan approval fails
  await a.rejects(
    () => approveResponsibilityPlan(resp1.id, collectedPlan.id, {
      expectedVersion: 999,
      proposalDigest: collectedPlan.proposalDigest,
      confirmed: true,
      idempotencyKey: 'approve-stale-ver',
    }, OWNER_ACTOR),
    /changed|RESPONSIBILITY_CONFLICT/,
    'stale-version plan approval rejected',
  );
  await a.rejects(
    () => approveResponsibilityPlan(resp1.id, collectedPlan.id, {
      expectedVersion: detailAfterWake.responsibility.rowVersion,
      proposalDigest: '0'.repeat(64),
      confirmed: true,
      idempotencyKey: 'approve-bad-digest',
    }, OWNER_ACTOR),
    /changed|RESPONSIBILITY_CONFLICT/,
    'mismatched proposalDigest plan approval rejected',
  );

  // Valid manual approval via HTTP route
  const approveRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    path: `/api/responsibilities/${resp1.id}/plans/${collectedPlan.id}/approve`,
    body: {
      expectedVersion: detailAfterWake.responsibility.rowVersion,
      proposalDigest: collectedPlan.proposalDigest,
      confirmed: true,
      idempotencyKey: 'approve-plan-ok',
    },
  });
  a.equal(approveRes.statusCode, 200, 'POST approve plan returns 200');
  a.equal(approveRes.payload.state, 'approved', 'plan approved');

  // Admit approved plan into Factory and execute step Run
  nextDispatchMode = 'step_report';
  await runtime1.tick();
  const plansAfterAdmit = await listResponsibilityPlans(resp1.id, OWNER_ACTOR);
  a.equal(plansAfterAdmit.plans[0].state, 'admitted', 'approved plan transitions to admitted');
  a.equal(plansAfterAdmit.plans[0].executions.length, 1, 'plan execution recorded');
  const stepGoalId = plansAfterAdmit.plans[0].executions[0].goalId;

  await scheduler1Real.tick();
  await orchestrator1Wrapped.reconcile();
  await scheduler1Real.tick();

  const workLinksBeforeAccept = await listResponsibilityWorkLinks(resp1.id, OWNER_ACTOR);
  a.equal(workLinksBeforeAccept.links.length, 2, 'work links include both planning wake and step execution');
  const stepLink = workLinksBeforeAccept.links.find((l) => l.goalId === stepGoalId);
  a.ok(stepLink && stepLink.workItemIds.length === 1, 'step goal has 1 work item');
  const stepDetail = await getWorkItemDetail(env1.org.id, stepLink.workItemIds[0]);
  const stepItem = stepDetail.item;
  a.equal(stepItem.state, 'review', 'step report item reached review state');

  // Cannot complete responsibility while step work item is still pending review (even with confirmed: true)
  await a.rejects(
    () => setResponsibilityLifecycle(resp1.id, 'complete', {
      expectedVersion: detailAfterWake.responsibility.rowVersion,
      confirmed: true,
      idempotencyKey: 'complete-premature',
    }, OWNER_ACTOR),
    (err) => err?.code === 'RESPONSIBILITY_WORK_PENDING' && Array.isArray(err.blockers) && err.blockers.length === 1,
    'cannot complete responsibility while step work item is awaiting review',
  );

  // Owner manual acceptance on the step report work item
  const goalDetail = await getWorkItemDetail(env1.org.id, stepItem.id);
  const criterionId = goalDetail.item.contract.acceptanceCriteria[0].id;
  await decideFactoryManualAcceptance({
    organizationId: env1.org.id,
    workItemId: stepItem.id,
    criterionId,
    decision: 'passed',
    rationale: 'Verified report accuracy',
    contractRevision: goalDetail.item.contractRevision,
    gateGeneration: goalDetail.item.gateGeneration,
    candidateDigest: goalDetail.item.candidateDigest,
    expectedVersion: goalDetail.item.rowVersion,
    commandId: 'accept-step-1',
    idempotencyKey: 'accept-step-1',
  }, OWNER_ACTOR);

  // Runtime processes acceptance -> marks workflow completed -> owner completes & archives cleanly
  await runtime1.tick();
  const completeRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    path: `/api/responsibilities/${resp1.id}/complete`,
    body: {
      expectedVersion: detailAfterWake.responsibility.rowVersion,
      confirmed: true,
      idempotencyKey: 'complete-final',
    },
  });
  a.equal(completeRes.statusCode, 200, `complete succeeds even though consumed planning item remains in review: ${JSON.stringify(completeRes.payload)}`);
  a.equal(completeRes.payload.responsibility.lifecycle, 'completed', 'responsibility completed');

  const archiveRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    path: `/api/responsibilities/${resp1.id}/archive`,
    body: {
      expectedVersion: completeRes.payload.responsibility.rowVersion,
      confirmed: true,
      idempotencyKey: 'archive-final',
    },
  });
  a.equal(archiveRes.statusCode, 200, `archive succeeds: ${JSON.stringify(archiveRes.payload)}`);
  a.equal(archiveRes.payload.responsibility.lifecycle, 'archived', 'responsibility archived');

  // Fresh subprocess restart read verification
  const restartProbeScript = `
    import { getResponsibility, listResponsibilityWorkLinks } from './chat/responsibility-service.mjs';
    import { getFactoryBudgetObservation } from './chat/factory-reconciliation.mjs';
    const r = await getResponsibility(${JSON.stringify(resp1.id)}, ${JSON.stringify(OWNER_ACTOR)});
    const l = await listResponsibilityWorkLinks(${JSON.stringify(resp1.id)}, ${JSON.stringify(OWNER_ACTOR)});
    const b = await getFactoryBudgetObservation({ organizationId: ${JSON.stringify(env1.org.id)}, workItemId: ${JSON.stringify(stepItem.id)} }, ${JSON.stringify(OWNER_ACTOR)});
    console.log(JSON.stringify({ lifecycle: r.responsibility.lifecycle, linkCount: l.links.length, costEnforcement: b.costEnforcement, boundaryMode: b.budgetBoundary?.mode, hardCapAvailable: b.budgetBoundary?.hardCapAvailable, rolledOver: b.windowDetail?.rolledOver ?? null }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', restartProbeScript], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf8',
  });
  a.equal(child.status, 0, `fresh subprocess restart read exited cleanly: ${child.stderr}`);
  const parsedRestart = JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
  a.equal(parsedRestart.lifecycle, 'archived', 'fresh process reads archived responsibility');
  a.equal(parsedRestart.linkCount, 2, 'fresh process reads both work links');
  a.equal(parsedRestart.costEnforcement, 'admission_estimate_only', 'fresh process reports admission_estimate_only');
  a.equal(parsedRestart.boundaryMode, 'admission_estimate_only', 'fresh process reports budgetBoundary.mode admission_estimate_only');
  a.equal(parsedRestart.hardCapAvailable, false, 'fresh process reports hardCapAvailable: false');

  // =========================================================================
  // Group 2: Auto-admitted report, wait nextCheckAt floor, waiting recovery,
  //          wake lease expiry, and stale-revision superseding
  // =========================================================================
  const env2 = await provisionOrgWithWorkers({
    orgId: 'org_mvp_closure_2',
    rootTitle: 'MVP Closure Root 2',
    plannerKey: 'planner-two',
    workerKey: 'reporter-two',
  });

  // Test timezone validation & immutability
  await a.rejects(
    () => createResponsibility({
      projectId: env2.project.id,
      organizationId: env2.org.id,
      objective: 'Bad timezone check',
      successCriteria: ['valid'],
      policy: {
        ...policy1,
        nodeBindings: { planning: { nodeId: env2.planner.node.id, bindingGeneration: 1 } },
        dailyBudget: { timeZone: ' Mars/Olympus ', maxRuns: 5 },
      },
      idempotencyKey: 'bad-tz',
    }, OWNER_ACTOR),
    /Invalid dailyBudget/,
    'whitespace-padded / invalid IANA timezone rejected',
  );
  await a.rejects(
    () => createResponsibility({
      projectId: env2.project.id,
      organizationId: env2.org.id,
      objective: 'Bad dailyBudget key',
      successCriteria: ['valid'],
      policy: {
        ...policy1,
        nodeBindings: { planning: { nodeId: env2.planner.node.id, bindingGeneration: 1 } },
        dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 5, bogusField: 1 },
      },
      idempotencyKey: 'bad-key',
    }, OWNER_ACTOR),
    /Invalid dailyBudget/,
    'unknown dailyBudget key rejected',
  );

  // Create second responsibility in America/Los_Angeles with an auto-admissible report catalog entry
  const autoCatalogEntry = {
    entryId: 'auto-report-1',
    capability: 'project-report',
    templateId: 'ragent-project-report',
    templateVersion: 1,
    templateDigest: reportFormula.digest,
    nodeBindings: { report: { nodeId: env2.reporter.node.id, bindingGeneration: 1 } },
    resource: { projectId: env2.project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    maxAttempts: 1,
    maxCost: 1,
    autoApproval: true,
    requiresHumanApproval: false,
  };
  const createdResp2 = await createResponsibility({
    projectId: env2.project.id,
    organizationId: env2.org.id,
    objective: 'Auto-admissible report & unknown-outcome safety suite',
    successCriteria: ['Verify auto-admission and unknown_outcome invariants'],
    policy: {
      ...policy1,
      nodeBindings: { planning: { nodeId: env2.planner.node.id, bindingGeneration: 1 } },
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 2, maxTokens: 50000, maxCost: 10 },
      planCatalog: [autoCatalogEntry],
      planApproval: 'within_policy',
      planAutoAdmissionConfirmed: true,
    },
    idempotencyKey: 'create-resp-2',
  }, OWNER_ACTOR);
  const autoEntryDigest = createdResp2.policy.planCatalog[0].entryDigest;

  // Resuming moves active, test runtime waiting recovery when scheduler temporarily disabled
  const resumed2 = await setResponsibilityLifecycle(createdResp2.responsibility.id, 'resume', {
    expectedVersion: createdResp2.responsibility.rowVersion,
    idempotencyKey: 'resume-2',
  }, OWNER_ACTOR);
  const waitingWake = await wakeResponsibility(createdResp2.responsibility.id, {
    expectedVersion: resumed2.responsibility.rowVersion,
    idempotencyKey: 'wake-waiting-1',
  }, OWNER_ACTOR);

  process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '0';
  await runtime1.tick();
  const heldWake = (await listWakes(createdResp2.responsibility.id)).find((w) => w.id === waitingWake.wake.id);
  a.equal(heldWake.state, 'waiting', 'wake held in waiting when factory scheduler disabled');

  // Re-enable scheduler & simulate next_retry_at due -> runtime must re-arm waiting -> admitted
  process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
  await responsibilityStore.transaction((db) => {
    db.prepare('UPDATE responsibility_wake_retry SET next_retry_at = ? WHERE wake_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), waitingWake.wake.id);
  });
  await runtime1.tick();
  const afterRearm = await getResponsibility(createdResp2.responsibility.id, OWNER_ACTOR);
  a.equal((await listWakes(createdResp2.responsibility.id)).find((w) => w.id === waitingWake.wake.id).state, 'admitted', 'waiting wake re-armed once retry timer elapsed');

  // Test auto-approval for policy-authorized project-report plan triggered by the re-armed waiting wake
  const env2Mode = { kind: 'auto_plan', preCrash: false };
  const orchestrator2 = createRealBackedOrchestrator({
    projectId: env2.project.id,
    folder: workspace,
    onDispatch: async () => {
      if (env2Mode.kind === 'auto_plan') {
        return {
          mode: 'complete',
          summary: JSON.stringify({
            schemaVersion: 1,
            decision: 'plan',
            steps: [{
              id: 'auto-step-1',
              entryId: 'auto-report-1',
              entryDigest: autoEntryDigest,
              templateId: 'ragent-project-report',
              templateVersion: 1,
              templateDigest: reportFormula.digest,
              nodeBindings: { report: { nodeId: env2.reporter.node.id, bindingGeneration: 1 } },
              dependsOn: [],
            }],
          }),
          usage: { input_tokens: 90, output_tokens: 40, total_tokens: 130, cost_usd: 0.02 },
        };
      }
      if (env2Mode.kind === 'step_complete_with_cancel') {
        return {
          mode: 'keep_running',
          summary: 'Running while cancel arrives',
          // Omit usage intentionally to verify conservative reservation retention when usage is unknown
        };
      }
      if (env2Mode.kind === 'pre_dispatch_crash') {
        return { mode: 'pre_dispatch_crash' };
      }
      return { mode: 'complete', summary: 'Report finished' };
    },
  });
  const sched2Errors = [];
  const scheduler2 = createFactoryScheduler({
    organizationId: env2.org.id,
    actor: SCHEDULER_ACTOR,
    adapter: createFactoryExecutionAdapter({
      organizationId: env2.org.id,
      actor: SCHEDULER_ACTOR,
      orchestrator: orchestrator2,
    }),
    admissionEnabled: true,
    pollMs: 60000,
    onError: (e) => sched2Errors.push({ message: e?.message || String(e), code: e?.code }),
  });
  activeRuntimes.push(scheduler2, orchestrator2);

  await scheduler2.start();
  await orchestrator2.reconcile();
  await scheduler2.tick();
  await runtime1.tick();
  const autoPlans = await listResponsibilityPlans(createdResp2.responsibility.id, OWNER_ACTOR);
  a.equal(autoPlans.plans.length, 1, 'planner produced plan for authorized auto-report');
  a.equal(autoPlans.plans[0].approvedBy, 'responsibility-policy-auto', 'authorized project-report plan auto-approved without human prompt');
  a.equal(autoPlans.plans[0].state, 'admitted', 'auto-approved plan admitted automatically into Factory');

  // Execute the auto-admitted report step: dispatch live Run, trigger pause(stopExisting:true) -> cancel_requested,
  // then complete the Run before stop arrives -> verify completed_pending_review & completed_before_stop
  env2Mode.kind = 'step_complete_with_cancel';
  await scheduler2.tick();
  const runningStepInfo = orchestrator2.trackedRuns.at(-1);
  a.ok(runningStepInfo?.runId, 'auto step Run started');

  // Verify resolveFactoryRunBudget returned boundary + timezone metadata during live dispatch admission
  const liveBudgetProbe = runningStepInfo.budgetProbe;
  a.ok(liveBudgetProbe, 'resolveFactoryRunBudget resolved active managed Run budget during dispatch');
  a.equal(liveBudgetProbe.costEnforcement, 'admission_estimate_only', 'resolveFactoryRunBudget reports admission_estimate_only');
  a.equal(liveBudgetProbe.hardCapAvailable, false, 'resolveFactoryRunBudget reports hardCapAvailable: false');
  a.equal(liveBudgetProbe.responsibilityScope?.timeZone, 'America/Los_Angeles', 'resolveFactoryRunBudget exposes responsibility timeZone');

  // Direct invariant check on classifyAttemptOutcome
  a.equal(
    classifyAttemptOutcome({ state: 'completed', cancelRequested: true }).state,
    'succeeded',
    'completed run with cancelRequested MUST classify as succeeded, never cancelled',
  );

  // Request stop while running -> sets work item control_state = 'cancel_requested' and run.cancelRequested = true
  const resp2BeforeCancelRace = await getResponsibility(createdResp2.responsibility.id, OWNER_ACTOR);
  const cancelRacePause = await setResponsibilityLifecycle(createdResp2.responsibility.id, 'pause', {
    expectedVersion: resp2BeforeCancelRace.responsibility.rowVersion,
    stopExisting: true,
    idempotencyKey: 'pause-race-complete-before-stop',
  }, OWNER_ACTOR);
  await finalizeTestRun({
    runId: runningStepInfo.runId,
    sessionId: runningStepInfo.sessionId,
    requestId: runningStepInfo.requestId,
    summary: 'Completed right before stop arrived',
    cancelRequested: true,
  });
  await orchestrator2.reconcile();
  await scheduler2.tick();
  const resumedAfterRace = await setResponsibilityLifecycle(createdResp2.responsibility.id, 'resume', {
    expectedVersion: cancelRacePause.responsibility.rowVersion,
    idempotencyKey: 'resume-after-race',
  }, OWNER_ACTOR);

  // Test expired wake lease recovery & stale-revision wake superseding
  const staleWake = await responsibilityStore.transaction((db) => {
    const wid = responsibilityStore.newId('wake');
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(wid, createdResp2.responsibility.id, 1, resumedAfterRace.responsibility.policyRevision, ts, 'pending', 1, null, ts, ts);
    db.prepare('INSERT INTO responsibility_wake_leases VALUES(?,?,?,?)')
      .run(wid, 'dead-worker', 1, new Date(Date.now() - 60000).toISOString());
    return wid;
  });
  // Update objective (bumps revision) so old-revision wake is superseded on runtime tick
  await updateResponsibility(createdResp2.responsibility.id, {
    expectedVersion: resumedAfterRace.responsibility.rowVersion,
    objective: 'Updated objective after stale wake',
    idempotencyKey: 'update-resp-2',
  }, OWNER_ACTOR);
  await runtime1.tick();
  a.equal((await listWakes(createdResp2.responsibility.id)).find((w) => w.id === staleWake).state, 'superseded', 'stale-revision wake with expired lease superseded cleanly');

  const links2 = await listResponsibilityWorkLinks(createdResp2.responsibility.id, OWNER_ACTOR);
  const autoStepLink = links2.links.find((l) => l.goalId === autoPlans.plans[0].executions[0].goalId);
  const autoStepItem = (await getWorkItemDetail(env2.org.id, autoStepLink.workItemIds[0])).item;
  a.equal(autoStepItem.state, 'blocked', 'completed run despite cancel_requested blocks work item pending review rather than cancelling');
  a.equal(autoStepItem.blockedReason?.code, 'completed_pending_review', 'completed run despite cancel_requested sets blockedReason.code = completed_pending_review');
  a.equal(autoStepItem.controlState, 'none', 'controlState clears cleanly to none after completed_before_stop');
  const reconCompletedBeforeStop = await reconciliation.getFactoryReconciliation(
    { organizationId: env2.org.id, workItemId: autoStepItem.id },
    OWNER_ACTOR,
  );
  a.equal(reconCompletedBeforeStop.stopStatus, 'completed_before_stop', 'reconciliation accurately labels completed_before_stop');
  a.equal(reconCompletedBeforeStop.stopConfirmed, false, 'stopConfirmed is false when run completed before stop');

  // Budget reservation without provider usage must stay retained (NOT released as unstarted)
  const unknownUsageBudget = await reconciliation.getFactoryBudgetObservation(
    { organizationId: env2.org.id, workItemId: autoStepItem.id },
    OWNER_ACTOR,
  );
  a.equal(unknownUsageBudget.reservationRetained, true, 'completed run without usage telemetry retains conservative budget reservation');
  a.equal(unknownUsageBudget.windowDetail.timeZone, 'America/Los_Angeles', 'budget observation exposes America/Los_Angeles timezone');

  // Reject changing dailyBudget.timeZone once a budget window row exists
  const freshResp2 = await getResponsibility(createdResp2.responsibility.id, OWNER_ACTOR);
  await a.rejects(
    () => updateResponsibility(createdResp2.responsibility.id, {
      expectedVersion: freshResp2.responsibility.rowVersion,
      policy: {
        ...policy1,
        nodeBindings: { planning: { nodeId: env2.planner.node.id, bindingGeneration: 1 } },
        dailyBudget: { timeZone: 'Europe/London', maxRuns: 2 },
        planCatalog: [autoCatalogEntry],
      },
      idempotencyKey: 'change-tz-rejected',
    }, OWNER_ACTOR),
    (err) => err?.code === 'RESPONSIBILITY_CONFLICT',
    'changing dailyBudget.timeZone after budget window creation is rejected',
  );

  // =========================================================================
  // Group 3: unknown_outcome reconciliation, verify-accepted without lease,
  //          non-auto-retry, explicit owner resolution, cancel-while-running,
  //          and timezone daily rollover + budget exhaustion + revocation
  // =========================================================================
  // 3A. Rollover & budget rejection test on env2 (maxRuns: 2 in America/Los_Angeles)
  await workGraphStore.factoryTransaction((db) => {
    db.prepare(`INSERT OR REPLACE INTO organization_responsibility_budget_windows
      (responsibility_id, day, time_zone, totals_json, reserved_json)
      VALUES (?, '2000-01-01', 'America/Los_Angeles', ?, ?)`)
      .run(
        createdResp2.responsibility.id,
        JSON.stringify({ agents: 0, runs: 2, tokens: 1000, cost: 5.0 }),
        JSON.stringify({ agents: 0, runs: 0, tokens: 0, cost: 0 }),
      );
  });
  const afterPastWindow = await getResponsibility(createdResp2.responsibility.id, OWNER_ACTOR);
  a.ok(afterPastWindow.budgetStatus.recentWindows.some((w) => w.day === '2000-01-01'), 'historical window retained for audit');
  a.equal(afterPastWindow.budgetStatus.rolledOverFromDay, '2000-01-01', 'rollover identifies prior historical day');
  a.ok(afterPastWindow.budgetStatus.currentWindow && afterPastWindow.budgetStatus.currentWindow.day !== '2000-01-01', 'rollover opens clean current day window');

  // =========================================================================
  // Group 3 (env3 / org_mvp_closure_3): ORG_BUDGET_EXCEEDED, unknown_outcome
  // reconciliation, verify-accepted without lease, explicit owner resolve,
  // cancel-while-running, and pause/grant revocation fences
  // =========================================================================
  const env3 = await provisionOrgWithWorkers({
    orgId: 'org_mvp_closure_3',
    rootTitle: 'MVP Closure Root 3',
    plannerKey: 'planner-three',
    workerKey: 'reporter-three',
  });
  const env3Mode = { kind: 'complete' };
  const orchestrator3 = createRealBackedOrchestrator({
    projectId: env3.project.id,
    folder: workspace,
    onDispatch: async () => {
      if (env3Mode.kind === 'pre_dispatch_crash') return { mode: 'pre_dispatch_crash' };
      return {
        mode: 'complete',
        summary: JSON.stringify({
          schemaVersion: 1,
          decision: 'wait',
          reason: 'Scheduled wait probe',
          nextCheckAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        usage: { input_tokens: 60, output_tokens: 30, total_tokens: 90, cost_usd: 0.01 },
      };
    },
  });
  const sched3Errors = [];
  const scheduler3 = createFactoryScheduler({
    organizationId: env3.org.id,
    actor: SCHEDULER_ACTOR,
    adapter: createFactoryExecutionAdapter({
      organizationId: env3.org.id,
      actor: SCHEDULER_ACTOR,
      orchestrator: orchestrator3,
    }),
    admissionEnabled: true,
    pollMs: 60000,
    onError: (e) => sched3Errors.push({ message: e?.message || String(e), code: e?.code }),
  });
  activeRuntimes.push(scheduler3, orchestrator3);
  await scheduler3.start();

  const policy3Base = {
    ...policy1,
    nodeBindings: { planning: { nodeId: env3.planner.node.id, bindingGeneration: 1 } },
    planCatalog: [{
      ...autoCatalogEntry,
      nodeBindings: { report: { nodeId: env3.reporter.node.id, bindingGeneration: 1 } },
      resource: { projectId: env3.project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    }],
    planApproval: 'within_policy',
    planAutoAdmissionConfirmed: true,
  };

  // Test ORG_BUDGET_EXCEEDED using a dedicated daily maxRuns: 1 responsibility after its first run succeeds
  const capRespCreated = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'Budget exhaustion verification',
    successCriteria: ['Daily maxRuns=1 enforced on excess reservation'],
    policy: {
      ...policy3Base,
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 1, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-cap-resp',
  }, OWNER_ACTOR);
  const capRespResumed = await setResponsibilityLifecycle(capRespCreated.responsibility.id, 'resume', {
    expectedVersion: capRespCreated.responsibility.rowVersion,
    idempotencyKey: 'resume-cap-resp',
  }, OWNER_ACTOR);
  await wakeResponsibility(capRespCreated.responsibility.id, {
    expectedVersion: capRespResumed.responsibility.rowVersion,
    idempotencyKey: 'wake-cap-1',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const capLinks = await listResponsibilityWorkLinks(capRespCreated.responsibility.id, OWNER_ACTOR);
  const capPlanItemId = capLinks.links[0].workItemIds[0];
  await scheduler3.tick();
  await orchestrator3.reconcile();
  await scheduler3.tick();
  await runtime1.tick();
  await a.rejects(
    () => governor.reserveFactoryBudget({
      organizationId: env3.org.id,
      revision: 1,
      reservationId: 'res_budget_exceed_1',
      factoryWorkItemId: capPlanItemId,
      delta: { runs: 1, cost: 1 },
      idempotencyKey: 'reserve-exceed-1',
    }),
    (err) => err?.code === 'ORG_BUDGET_EXCEEDED',
    'daily maxRuns cap rejects excess admission with ORG_BUDGET_EXCEEDED',
  );
  // Pause capResp so it stays cleanly idle
  await setResponsibilityLifecycle(capRespCreated.responsibility.id, 'pause', {
    expectedVersion: capRespResumed.responsibility.rowVersion,
    idempotencyKey: 'pause-cap-resp',
  }, OWNER_ACTOR);

  // 3B. Pre-dispatch crash -> unknown_outcome non-auto-retry + verify-accepted without scheduler lease
  // Create a clean responsibility (resp3) whose admitted planner item goes into pre_dispatch_crash
  const resp3Created = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'Unknown outcome reconciliation and cancel-while-running verification',
    successCriteria: ['Recover lost run_id receipt and label cancel_requested honestly'],
    policy: {
      ...policy3Base,
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-resp-3',
  }, OWNER_ACTOR);
  const resp3Resumed = await setResponsibilityLifecycle(resp3Created.responsibility.id, 'resume', {
    expectedVersion: resp3Created.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-3',
  }, OWNER_ACTOR);
  await wakeResponsibility(resp3Created.responsibility.id, {
    expectedVersion: resp3Resumed.responsibility.rowVersion,
    idempotencyKey: 'wake-resp-3',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const resp3Links = await listResponsibilityWorkLinks(resp3Created.responsibility.id, OWNER_ACTOR);
  const unknownItem = (await getWorkItemDetail(env3.org.id, resp3Links.links[0].workItemIds[0])).item;

  async function loadItemDispatchState(workItemId) {
    return workGraphStore.factoryRead((db) => {
      const b = db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id = ?').get(workItemId);
      const collab = b?.collaboration_id
        ? db.prepare('SELECT * FROM collaborations WHERE id = ?').get(b.collaboration_id)
        : (b ? db.prepare('SELECT * FROM collaborations WHERE root_session_id = ? AND idempotency_key = ?').get(env3.rootSession.id, b.dispatch_key) : null);
      const cmd = collab
        ? db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE collaboration_id = ? AND task_id = ?').get(collab.id, workItemId)
        : null;
      const att = cmd?.attempt_id
        ? db.prepare('SELECT * FROM collaboration_attempts WHERE id = ?').get(cmd.attempt_id)
        : (collab ? db.prepare('SELECT * FROM collaboration_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(workItemId) : null);
      const attempts = collab
        ? db.prepare('SELECT * FROM collaboration_attempts WHERE task_id = ? ORDER BY attempt_number').all(workItemId)
        : [];
      return { b, collab, cmd, att, attempts };
    });
  }

  async function expireActiveAttempt(workItemId) {
    const past = new Date(Date.now() - 60000).toISOString();
    await workGraphStore.factoryTransaction((db) => {
      db.prepare('UPDATE collaboration_attempts SET dispatch_deadline = ?, queue_deadline = ?, execution_deadline = ?, lease_until = ? WHERE task_id = ? AND state = ?')
        .run(past, past, past, past, workItemId, 'running');
    });
  }

  // Put item into dispatch crash (`pre_dispatch_crash`) + deadline expiry -> unknown_outcome
  env3Mode.kind = 'pre_dispatch_crash';
  await scheduler3.tick();
  await orchestrator3.reconcile();
  await expireActiveAttempt(unknownItem.id);
  await orchestrator3.reconcile();
  // Extra scheduler ticks must NEVER auto-redispatch an unverified unknown_outcome binding
  await scheduler3.tick();
  await scheduler3.tick();
  const afterCrash = await getWorkItemDetail(env3.org.id, unknownItem.id);
  const reconCrash = await reconciliation.getFactoryReconciliation(
    { organizationId: env3.org.id, workItemId: unknownItem.id },
    OWNER_ACTOR,
  );
  const crashDb = await loadItemDispatchState(unknownItem.id);
  const unknownCrashBinding = afterCrash.item.bindings.find((b) => b.status === 'unknown') || afterCrash.item.bindings[0];
  a.ok(
    unknownCrashBinding,
    `expected binding after crash; item=${JSON.stringify(afterCrash.item)} sched3Errors=${JSON.stringify(sched3Errors)}`,
  );
  a.equal(crashDb.attempts.length, 1, 'unknown_outcome never auto-spawns a second attempt');
  a.equal(crashDb.att?.failure_kind, 'unknown_outcome', 'expired uncertain dispatch marks attempt unknown_outcome');
  a.ok(
    reconCrash.unknownOutcome?.isUnknown === true,
    `uncertain dispatch marks unknownOutcome.isUnknown=true (binding=${unknownCrashBinding.status}, cmd=${crashDb.cmd?.state}, att=${crashDb.att?.state}/${crashDb.att?.failure_kind}, recon=${JSON.stringify(reconCrash.unknownOutcome)})`,
  );

  // Verify unverified unknown binding NEVER auto-retries via RetryWork
  await a.rejects(
    () => factoryControl.executeFactoryCommand({
      commandId: 'cmd_retry_blocked_unknown',
      idempotencyKey: 'retry-blocked-unknown',
      organizationId: env3.org.id,
      targetId: unknownItem.id,
      type: 'RetryWork',
      expectedVersion: afterCrash.item.rowVersion,
      payload: {},
    }, OWNER_ACTOR),
    () => true,
    'RetryWork refuses unverified unknown_outcome binding',
  );

  // Also test resolveFactoryUnknownOutcome guards BEFORE creating accepted run on disk:
  // confirm_finished must fail while unverified!
  const unverifiedResolveBad = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${unknownItem.id}/reconcile/resolve`,
    body: {
      commandId: 'cmd-resolve-bad-finished',
      expectedVersion: afterCrash.item.rowVersion,
      executionEpoch: afterCrash.item.executionEpoch,
      resolution: 'confirm_finished',
      rationale: 'Should reject unverified confirm_finished',
      confirmed: true,
      idempotencyKey: 'resolve-bad-finished',
    },
  });
  a.ok(unverifiedResolveBad.statusCode >= 400, 'resolve refuses confirm_finished without verified terminal Run receipt');

  // Simulate lost-runId crash recovery case: Run WAS accepted on disk with matching requestId,
  // while dispatch_commands became 'cancelled' and attempt became failed(unknown_outcome) with run_id=NULL
  const recoveredBinding = await loadItemDispatchState(unknownItem.id);
  a.ok(recoveredBinding.collab && recoveredBinding.cmd && recoveredBinding.att, 'linked collaboration dispatch/attempt exist before recovery');
  await scheduler3.stop();
  await workGraphStore.factoryTransaction((db) => {
    const ts = new Date().toISOString();
    db.prepare("UPDATE collaboration_dispatch_commands SET state='cancelled',updated_at=? WHERE id=?")
      .run(ts, recoveredBinding.cmd.id);
    db.prepare("UPDATE collaboration_attempts SET state='failed',failure_kind='unknown_outcome',run_id=NULL,updated_at=? WHERE id=?")
      .run(ts, recoveredBinding.att.id);
    // Clear active scheduler lease so owner manual verification is tested WITHOUT an active scheduler lease!
    db.prepare('DELETE FROM factory_scheduler_leases WHERE organization_id = ?').run(env3.org.id);
  });
  const orphanRun = await runs.createRun({
    status: {
      sessionId: env3.planner.session.id,
      requestId: recoveredBinding.cmd.request_id,
      tool: 'codex',
      state: 'running',
    },
    manifest: {
      sessionId: env3.planner.session.id,
      requestId: recoveredBinding.cmd.request_id,
      projectId: env3.project.id,
      folder: workspace,
    },
  });

  // Owner verifies accepted Run receipt via HTTP route WITHOUT active scheduler lease!
  const verifyRes = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${unknownItem.id}/reconcile/verify-accepted`,
    body: {
      expectedVersion: afterCrash.item.rowVersion,
      executionEpoch: afterCrash.item.executionEpoch,
      expectedRunId: orphanRun.id,
    },
  });
  a.equal(verifyRes.statusCode, 200, `owner verify-accepted succeeds without active scheduler lease: ${JSON.stringify(verifyRes.payload)}`);
  a.equal(verifyRes.payload.state, 'accepted', 'verify-accepted recovers accepted Run');
  a.equal(verifyRes.payload.runId, orphanRun.id, 'verify-accepted recovers exact orphan Run ID');
  a.equal(verifyRes.payload.recoveredUnknownOutcomeRunLink, true, 'reports recoveredUnknownOutcomeRunLink');

  // While recovered orphanRun is running, trigger cancel-while-running via pause(stopExisting: true)
  const pausedWithCancel = await setResponsibilityLifecycle(resp3Created.responsibility.id, 'pause', {
    expectedVersion: resp3Resumed.responsibility.rowVersion,
    stopExisting: true,
    idempotencyKey: 'pause-stop-existing-1',
  }, OWNER_ACTOR);
  a.equal(pausedWithCancel.existingWorkStopped, false, 'pause with stopExisting honestly marks existingWorkStopped: false');
  a.equal(pausedWithCancel.stop.requested, true, 'pause records stop.requested: true');
  const reconCancelPending = await reconciliation.getFactoryReconciliation(
    { organizationId: env3.org.id, workItemId: unknownItem.id },
    OWNER_ACTOR,
  );
  a.equal(reconCancelPending.controlState, 'cancel_requested', 'controlState reports cancel_requested while running');
  a.equal(reconCancelPending.stopConfirmed, false, 'stopConfirmed is false while Run has not stopped');
  a.equal(reconCancelPending.stopStatus, 'cancel_requested_pending', 'cancel_requested is never mislabeled stopped');

  // Cannot resolve as confirm_stopped while live Run is still running on disk!
  const latestUnknownItem = await getWorkItemDetail(env3.org.id, unknownItem.id);
  const liveResolveDenied = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${unknownItem.id}/reconcile/resolve`,
    body: {
      commandId: 'cmd-resolve-while-live',
      expectedVersion: latestUnknownItem.item.rowVersion,
      executionEpoch: latestUnknownItem.item.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Attempt resolve while run still live',
      confirmed: true,
      idempotencyKey: 'resolve-while-live',
    },
  });
  a.ok(liveResolveDenied.statusCode >= 400, 'resolve refuses confirm_stopped while Run is still running');

  // Create a truly unverified unknown_outcome item (no Run on disk) to test explicit owner confirm_stopped resolution
  const trueUnknownResp = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'True unverified unknown outcome',
    successCriteria: ['Never confirmed by provider'],
    policy: {
      ...policy3Base,
      nodeBindings: { planning: { nodeId: env3.reporter.node.id, bindingGeneration: 1 } },
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-resp-true-unknown',
  }, OWNER_ACTOR);
  const trueUnknownResumed = await setResponsibilityLifecycle(trueUnknownResp.responsibility.id, 'resume', {
    expectedVersion: trueUnknownResp.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-true-unknown',
  }, OWNER_ACTOR);
  await wakeResponsibility(trueUnknownResp.responsibility.id, {
    expectedVersion: trueUnknownResumed.responsibility.rowVersion,
    idempotencyKey: 'wake-resp-true-unknown',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const trueUnknownLinks = await listResponsibilityWorkLinks(trueUnknownResp.responsibility.id, OWNER_ACTOR);
  const trueUnknownItem = (await getWorkItemDetail(env3.org.id, trueUnknownLinks.links[0].workItemIds[0])).item;
  env3Mode.kind = 'pre_dispatch_crash';
  await scheduler3.start();
  await scheduler3.tick();
  await orchestrator3.reconcile();
  await expireActiveAttempt(trueUnknownItem.id);
  await orchestrator3.reconcile();
  await scheduler3.tick();
  const trueUnknownLoaded = await getWorkItemDetail(env3.org.id, trueUnknownItem.id);
  const trueUnknownDb = await loadItemDispatchState(trueUnknownItem.id);
  const trueUnknownRecon = await reconciliation.getFactoryReconciliation(
    { organizationId: env3.org.id, workItemId: trueUnknownItem.id },
    OWNER_ACTOR,
  );
  a.ok(
    trueUnknownRecon.unknownOutcome?.isUnknown === true,
    `true unverified crash binding is unknownOutcome (state=${trueUnknownLoaded.item.state}, blocked=${JSON.stringify(trueUnknownLoaded.item.blockedReason)}, bindings=${JSON.stringify(trueUnknownLoaded.item.bindings)}, cmd=${trueUnknownDb.cmd?.state}, att=${trueUnknownDb.att?.state}/${trueUnknownDb.att?.failure_kind}, recon=${JSON.stringify(trueUnknownRecon.unknownOutcome)}, sched3Errors=${JSON.stringify(sched3Errors)})`,
  );

  // confirm_stopped without cancel_requested/pause_requested (or cancelled Run) must be refused
  const uncancelledResolveDenied = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${trueUnknownItem.id}/reconcile/resolve`,
    body: {
      commandId: 'cmd-resolve-uncancelled-denied',
      expectedVersion: trueUnknownLoaded.item.rowVersion,
      executionEpoch: trueUnknownLoaded.item.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Cannot confirm_stopped before stop/cancel requested',
      confirmed: true,
      idempotencyKey: 'resolve-uncancelled-denied',
    },
  });
  a.equal(uncancelledResolveDenied.statusCode, 409, 'confirm_stopped without cancelled Run requires cancel_requested or pause_requested');

  // Request stop via pause(stopExisting: true), then explicitly resolve as confirm_stopped
  await setResponsibilityLifecycle(trueUnknownResp.responsibility.id, 'pause', {
    expectedVersion: trueUnknownResumed.responsibility.rowVersion,
    stopExisting: true,
    idempotencyKey: 'pause-true-unknown-stop',
  }, OWNER_ACTOR);
  const trueUnknownPaused = await getWorkItemDetail(env3.org.id, trueUnknownItem.id);
  a.equal(trueUnknownPaused.item.controlState, 'cancel_requested', 'pause(stopExisting) puts trueUnknownItem into cancel_requested');

  const resolveOk = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${trueUnknownItem.id}/reconcile/resolve`,
    body: {
      commandId: 'cmd-resolve-true-unknown-1',
      expectedVersion: trueUnknownPaused.item.rowVersion,
      executionEpoch: trueUnknownPaused.item.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Verified provider dashboard has zero runs launched',
      confirmed: true,
      idempotencyKey: 'resolve-true-unknown-1',
    },
  });
  a.equal(resolveOk.statusCode, 200, `explicit owner resolution confirm_stopped succeeds when unverified & no live/completed run: ${JSON.stringify(resolveOk.payload)}`);
  a.equal(resolveOk.payload.resolution, 'confirm_stopped', 'resolution confirmed');
  a.equal(resolveOk.payload.item?.state, 'cancelled', 'confirm_stopped transitions cancel_requested item to cancelled');
  a.equal(resolveOk.payload.item?.controlState, 'none', 'controlState clears after confirmed stop');
  a.equal(resolveOk.payload.binding?.status, 'stopped', 'binding reaches stopped terminal state');
  const resolveReplay = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    path: `/api/organizations/${env3.org.id}/factory/work-items/${trueUnknownItem.id}/reconcile/resolve`,
    body: {
      commandId: 'cmd-resolve-true-unknown-1',
      expectedVersion: trueUnknownPaused.item.rowVersion,
      executionEpoch: trueUnknownPaused.item.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Verified provider dashboard has zero runs launched',
      confirmed: true,
      idempotencyKey: 'resolve-true-unknown-1',
    },
  });
  a.equal(resolveReplay.payload.replayed, true, 'explicit resolution replays idempotently');

  // Verify budget reservation is still retained for conservative unverified resolution
  const retainedAfterResolve = await reconciliation.getFactoryBudgetObservation(
    { organizationId: env3.org.id, workItemId: trueUnknownItem.id },
    OWNER_ACTOR,
  );
  a.equal(retainedAfterResolve.reservationRetained, true, 'explicit confirm_stopped keeps unknown-usage reservation retained unless fresh unstarted receipt verified');

  // 3B-2. Pending outbound 5s backoff recovery: verifyFactoryAcceptedRun recovers Run immediately
  // without waiting for deferAttemptDispatch's 5s backoff window, then resolveFactoryUnknownOutcome
  // TOCTOU guard rejects concurrent live binding transition.
  const backoffResp = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'Immediate verify-accepted during outbound dispatch backoff',
    successCriteria: ['Recover Run receipt immediately while dispatch command is backed off'],
    policy: {
      ...policy3Base,
      nodeBindings: { planning: { nodeId: env3.reporter.node.id, bindingGeneration: 1 } },
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-resp-backoff-rec',
  }, OWNER_ACTOR);
  const backoffResumed = await setResponsibilityLifecycle(backoffResp.responsibility.id, 'resume', {
    expectedVersion: backoffResp.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-backoff-rec',
  }, OWNER_ACTOR);
  await wakeResponsibility(backoffResp.responsibility.id, {
    expectedVersion: backoffResumed.responsibility.rowVersion,
    idempotencyKey: 'wake-resp-backoff-rec',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const backoffLinks = await listResponsibilityWorkLinks(backoffResp.responsibility.id, OWNER_ACTOR);
  const backoffItemId = backoffLinks.links[0].workItemIds[0];
  env3Mode.kind = 'pre_dispatch_crash';
  await scheduler3.tick();
  await orchestrator3.reconcile();

  const backoffState = await loadItemDispatchState(backoffItemId);
  a.equal(backoffState.cmd?.state, 'pending', 'deferAttemptDispatch keeps backed-off command pending');
  a.equal(backoffState.cmd?.claim_token, null, 'backed-off command has no active claim token');
  a.ok(backoffState.cmd?.available_at > new Date().toISOString(), 'backed-off command is still inside outbound retry backoff window');
  a.equal(backoffState.att?.state, 'running', 'backed-off attempt remains running/dispatching');

  const backoffRun = await runs.createRun({
    status: {
      sessionId: backoffState.cmd.session_id,
      requestId: backoffState.cmd.request_id,
      tool: 'codex',
      state: 'running',
    },
    manifest: {
      sessionId: backoffState.cmd.session_id,
      requestId: backoffState.cmd.request_id,
      projectId: env3.project.id,
      folder: workspace,
    },
  });
  const backoffObs = await reconciliation.getFactoryReconciliation(
    { organizationId: env3.org.id, workItemId: backoffItemId },
    OWNER_ACTOR,
  );
  a.equal(backoffObs.acceptedRunObservation.state, 'found', 'getFactoryReconciliation detects backed-off accepted Run');
  a.equal(backoffObs.unknownOutcome.canVerifyAcceptedRun, true, 'canVerifyAcceptedRun is true during outbound backoff');

  const backoffDetailBefore = await getWorkItemDetail(env3.org.id, backoffItemId);
  const backoffVerified = await reconciliation.verifyFactoryAcceptedRun({
    organizationId: env3.org.id,
    workItemId: backoffItemId,
    expectedVersion: backoffDetailBefore.item.rowVersion,
    executionEpoch: backoffDetailBefore.item.executionEpoch,
    expectedRunId: backoffRun.id,
  }, OWNER_ACTOR);
  a.equal(backoffVerified.state, 'accepted', 'verifyFactoryAcceptedRun immediately adopts backed-off Run without waiting 5s');
  a.equal(backoffVerified.runId, backoffRun.id, 'verifyFactoryAcceptedRun returns exact backed-off Run ID');

  // Complete backoffRun so env3.reporter node becomes free for TOCTOU race check
  await finalizeTestRun({
    runId: backoffRun.id,
    sessionId: backoffState.cmd.session_id,
    requestId: backoffState.cmd.request_id,
    summary: JSON.stringify({
      schemaVersion: 1,
      decision: 'wait',
      reason: 'backoff run done',
      nextCheckAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50, cost_usd: 0.01 },
  });
  await orchestrator3.reconcile();
  await scheduler3.tick();

  // TOCTOU race guard check for resolveFactoryUnknownOutcome:
  // While preflight + findRunByRequest runs asynchronously (no Run on disk yet),
  // a concurrent update binds a live running Run onto factory_execution_bindings.
  const toctouResp = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'TOCTOU race guard during unknown outcome resolution',
    successCriteria: ['Reject resolveFactoryUnknownOutcome if binding becomes live concurrently'],
    policy: {
      ...policy3Base,
      nodeBindings: { planning: { nodeId: env3.reporter.node.id, bindingGeneration: 1 } },
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-resp-toctou-race',
  }, OWNER_ACTOR);
  const toctouResumed = await setResponsibilityLifecycle(toctouResp.responsibility.id, 'resume', {
    expectedVersion: toctouResp.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-toctou-race',
  }, OWNER_ACTOR);
  await wakeResponsibility(toctouResp.responsibility.id, {
    expectedVersion: toctouResumed.responsibility.rowVersion,
    idempotencyKey: 'wake-resp-toctou-race',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const toctouLinks = await listResponsibilityWorkLinks(toctouResp.responsibility.id, OWNER_ACTOR);
  const toctouItemId = toctouLinks.links[0].workItemIds[0];
  env3Mode.kind = 'pre_dispatch_crash';
  await scheduler3.tick();
  await orchestrator3.reconcile();
  const toctouPreDetail = await getWorkItemDetail(env3.org.id, toctouItemId);
  const toctouBinding = toctouPreDetail.item.bindings[0];
  a.ok(toctouBinding && toctouBinding.status === 'intent' && !toctouBinding.runId, 'toctou binding starts intent with no runId');

  const resolveRacePromise = reconciliation.resolveFactoryUnknownOutcome({
    organizationId: env3.org.id,
    workItemId: toctouItemId,
    commandId: 'cmd-toctou-race-1',
    expectedVersion: toctouPreDetail.item.rowVersion,
    executionEpoch: toctouPreDetail.item.executionEpoch,
    resolution: 'confirm_failed',
    rationale: 'Should lose race when binding becomes live',
    confirmed: true,
    idempotencyKey: 'toctou-race-1',
  }, OWNER_ACTOR);
  // Yield one microtask so preflight finishes synchronously while findRunByRequest awaits async FS IO
  await Promise.resolve();
  await Promise.resolve();
  await workGraphStore.factoryTransaction((db) => {
    db.prepare("UPDATE factory_execution_bindings SET status='running', run_id='run_toctou_live', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), toctouBinding.id);
  });
  await a.rejects(
    () => resolveRacePromise,
    (err) => err?.code === 'FACTORY_CONFLICT',
    'resolveFactoryUnknownOutcome refuses concurrent live binding transition (TOCTOU guard)',
  );
  const toctouPostBinding = await workGraphStore.factoryRead((db) =>
    db.prepare('SELECT status, run_id FROM factory_execution_bindings WHERE id = ?').get(toctouBinding.id),
  );
  a.equal(toctouPostBinding.status, 'running', 'concurrent live binding status preserved on TOCTOU conflict');
  a.equal(toctouPostBinding.run_id, 'run_toctou_live', 'concurrent live run_id preserved on TOCTOU conflict');

  // 3C. Pause + Grant revocation immediately blocks responsibility admission fence
  const resp4Created = await createResponsibility({
    projectId: env3.project.id,
    organizationId: env3.org.id,
    objective: 'Immediate revocation and pause fence check',
    successCriteria: ['Pause and grant revocation reject fence before dispatch'],
    policy: {
      ...policy3Base,
      dailyBudget: { timeZone: 'America/Los_Angeles', maxRuns: 10, maxTokens: 50000, maxCost: 10 },
    },
    idempotencyKey: 'create-resp-4',
  }, OWNER_ACTOR);
  const resp4Resumed = await setResponsibilityLifecycle(resp4Created.responsibility.id, 'resume', {
    expectedVersion: resp4Created.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-4',
  }, OWNER_ACTOR);
  await wakeResponsibility(resp4Created.responsibility.id, {
    expectedVersion: resp4Resumed.responsibility.rowVersion,
    idempotencyKey: 'wake-resp-4',
  }, OWNER_ACTOR);
  await runtime1.tick();
  const resp4Links = await listResponsibilityWorkLinks(resp4Created.responsibility.id, OWNER_ACTOR);
  const revItemId = resp4Links.links[0].workItemIds[0];

  // Passes fence while active and granted
  await workGraphStore.factoryRead((db) => {
    const wiRow = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(revItemId);
    const fence = verifyFactoryResponsibilityFence(db, wiRow, { bindingGeneration: 1 });
    a.equal(fence?.providerId, 'generic-planner', 'fence passes before pause or grant revocation');
  });

  // Pause immediately blocks factory fence
  const paused4 = await setResponsibilityLifecycle(resp4Created.responsibility.id, 'pause', {
    expectedVersion: resp4Resumed.responsibility.rowVersion,
    idempotencyKey: 'pause-resp-4',
  }, OWNER_ACTOR);
  await a.rejects(
    () => workGraphStore.factoryRead((db) => {
      const wiRow = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(revItemId);
      return verifyFactoryResponsibilityFence(db, wiRow, { bindingGeneration: 1 });
    }),
    () => true,
    'paused responsibility immediately blocks factory fence',
  );

  // Resume then revoke planner node 'run' capability grant -> fence rejects revocation immediately
  await setResponsibilityLifecycle(resp4Created.responsibility.id, 'resume', {
    expectedVersion: paused4.responsibility.rowVersion,
    idempotencyKey: 'resume-again-4',
  }, OWNER_ACTOR);
  await orgStore.createGrant({
    organizationId: env3.org.id,
    nodeId: env3.planner.node.id,
    revision: 1,
    capability: 'run',
    allow: false,
    scope: { projectId: env3.project.id },
  });
  await a.rejects(
    () => workGraphStore.factoryRead((db) => {
      const wiRow = db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(revItemId);
      return verifyFactoryResponsibilityFence(db, wiRow, { bindingGeneration: 1 });
    }),
    () => true,
    'revoked run grant immediately blocks responsibility admission fence',
  );

  // =========================================================================
  // Group 4: Real static/chat/organization-view.js UI rendering & actions
  // =========================================================================
  const httpFetcher = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const parsedUrl = new URL(url, 'http://127.0.0.1');
    const path = parsedUrl.pathname;
    const body = options.body || null;
    const rResp = await callRoute(handleResponsibilityRoutes, { method, path, body });
    if (rResp.handled) return makeHttpResponse(rResp.statusCode, rResp.payload);
    const fResp = await callRoute(handleFactoryRoutes, { method, path, body });
    if (fResp.handled) return makeHttpResponse(fResp.statusCode, fResp.payload);
    if (path === `/api/organizations/${env2.org.id}/factory/work-items` || path === `/api/organizations/${env3.org.id}/factory/work-items`) {
      const fList = await callRoute(handleFactoryRoutes, { method: 'GET', path });
      return makeHttpResponse(fList.statusCode, fList.payload);
    }
    return makeHttpResponse(404, { error: 'Not found in test fetcher' });
  };

  const { win, cleanup: cleanupDom } = buildMinimalDomSandbox(httpFetcher);
  const orgViewCode = readFileSync(join(process.cwd(), 'static/chat/organization-view.js'), 'utf8');
  const vmScript = new Script(orgViewCode, { filename: 'static/chat/organization-view.js' });
  vmScript.runInNewContext({
    window: win,
    document: win.document,
    globalThis: win,
    crypto: win.crypto,
    console,
    URL,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Promise,
    Set,
    Map,
    Error,
    setTimeout,
    clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
  });
  const orgView = win.RagentOrganizationView;
  a.ok(orgView, 'organization-view attaches RagentOrganizationView in sandbox');
  orgView.dom.detailScreen = win.document.createElement('div');
  orgView.projection = { organizationId: env2.org.id, rootSessionId: env2.rootSession.id, nodes: [], edges: [] };

  // Open responsibility detail in UI and verify budget boundary + workSummary rendering
  await orgView.showFactoryWork(createdResp2.responsibility.id);
  const respUiText = orgView.dom.detailScreen.textContent;
  a.ok(respUiText.includes('America/Los_Angeles'), 'UI renders responsibility budget time zone');
  a.ok(respUiText.includes('admission_estimate_only') || respUiText.includes('admission budget') || respUiText.includes('provider hard cap'),
    'UI discloses admission budget vs non-guaranteed provider hard cap');
  a.ok(respUiText.includes('cancel_requested') || respUiText.includes('completed before stop'),
    'UI distinguishes cancel_requested/completed_before_stop from stopped');

  // Navigate to cancel_requested / unknown work item in UI on env3 (resp3Created / unknownItem)
  orgView.projection = { organizationId: env3.org.id, rootSessionId: env3.rootSession.id, nodes: [], edges: [] };
  await orgView.showFactoryWork(resp3Created.responsibility.id);
  const itemButtons = orgView.dom.detailScreen.querySelectorAll('button');
  const unknownItemBtn = itemButtons.find((b) => b.textContent.includes(unknownItem.id) || b.textContent.includes('cancel_requested'));
  a.ok(unknownItemBtn, 'UI lists cancel_requested unknownItem on env3 responsibility view');
  unknownItemBtn.click();
  await new Promise((r) => setTimeout(r, 40));
  const itemUiText = orgView.dom.detailScreen.textContent;
  a.ok(!itemUiText.includes('Stop confirmed') || itemUiText.includes('cancel_requested_pending') || itemUiText.includes('cancel requested'),
    'UI item detail never falsely labels cancel_requested as confirmed stopped');
  orgView.projection = { organizationId: env2.org.id, rootSessionId: env2.rootSession.id, nodes: [], edges: [] };

  // Test fresh unstarted unknown_outcome item in UI for explicit resolve button + POST
  const freshUnknownGoal = await admitTestWorkItem({
    organizationId: env2.org.id,
    projectId: env2.project.id,
    title: 'UI unknown resolve target',
    objective: 'UI resolve flow',
    assigneeNodeId: env2.reporter.node.id,
    priority: 7,
  });
  const uiUnknownId = freshUnknownGoal.workItem.id;
  await workGraphStore.factoryTransaction((db) => {
    const ts = new Date().toISOString();
    db.prepare(`UPDATE factory_work_items
      SET state = 'claimed', control_state = 'cancel_requested', execution_epoch = 1, binding_generation = 1, updated_at = ?
      WHERE id = ?`).run(ts, uiUnknownId);
    db.prepare(`INSERT INTO factory_execution_bindings
      (id, work_item_id, contract_revision, execution_epoch, binding_generation, dispatch_key, status, collaboration_id, task_id, attempt_id, run_id, details_json, created_at, updated_at)
      VALUES (?, ?, 1, 1, 1, 'disp_ui_unk', 'unknown', 'collab_ui_unk', 'task_ui_unk', 'att_ui_unk', NULL, '{}', ?, ?)`)
      .run('bind_ui_unk', uiUnknownId, ts, ts);
  });

  await orgView.showFactoryWork();
  const listBtns = orgView.dom.detailScreen.querySelectorAll('button');
  const targetBtn = listBtns.find((b) => b.textContent.includes('UI resolve flow'));
  a.ok(targetBtn, `UI work list displays unknown item (buttons=${listBtns.map((b) => b.textContent).join(' | ')})`);
  targetBtn.click();
  for (let i = 0; i < 40; i += 1) {
    if (orgView.dom.detailScreen.textContent.includes('Confirm stopped after owner verification')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const detailText = orgView.dom.detailScreen.textContent;
  a.ok(
    detailText.includes('Confirm stopped after owner verification')
      && detailText.includes('Confirm failed (unknown outcome; retains unverified budget reservation)')
      && (detailText.includes('禁止自动重派') || detailText.includes('unknown_outcome')),
    `UI shows explicit unknown_outcome resolution controls: ${detailText}`,
  );

  const resolveBtn = orgView.dom.detailScreen.querySelectorAll('button').find((b) => b.textContent.includes('Confirm stopped after owner verification'));
  a.ok(resolveBtn, 'UI renders Confirm stopped resolution action for unknown_outcome item');
  resolveBtn.click();
  for (let i = 0; i < 40; i += 1) {
    const check = await getWorkItemDetail(env2.org.id, uiUnknownId);
    if (check.item.state === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const afterResolveItem = await getWorkItemDetail(env2.org.id, uiUnknownId);
  a.equal(afterResolveItem.item.state, 'cancelled', `UI Confirm stopped resolution updates server item state to cancelled: ${JSON.stringify(afterResolveItem.item)}`);
  a.equal(afterResolveItem.item.controlState, 'none', 'UI Confirm stopped clears cancel_requested controlState');
  a.equal(afterResolveItem.item.bindings.find((b) => b.id === 'bind_ui_unk')?.status, 'stopped', 'UI Confirm stopped transitions binding to stopped');

  orgView.dom.detailScreen.hidden = true;
  cleanupDom();

  const activities = await listResponsibilityActivity(createdResp2.responsibility.id, {}, OWNER_ACTOR);
  a.ok(activities.activity.length >= 4, 'audit trail activity events preserved cleanly');

  console.log(`test-responsibility-mvp-closure: ok (${assertionCount} assertions)`);
}

try {
  await runTests();
} finally {
  for (const runner of activeRuntimes) {
    try {
      await runner?.stop?.();
    } catch {}
  }
  try {
    sessionManager.killAll();
  } catch {}
  try {
    await resultPackets.closeResultPacketStore();
  } catch {}
  try {
    const { closeWorkspaceLeaseStore } = await import('../chat/workspace-leases.mjs');
    await closeWorkspaceLeaseStore();
  } catch {}
  try {
    const { closePhaseGateStore } = await import('../chat/phase-gates.mjs');
    await closePhaseGateStore();
  } catch {}
  try {
    auth.closeAuthSessionStore();
  } catch {}
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
