#!/usr/bin/env node
// Stage 5 S5.1 Verification Suite: Voice Butler backend (4-bucket overview,
// decoupled ASR/Reasoning/TTS adapters, multi-turn continuity, barge-in
// generation fencing, cross-device handoff, and strict visual-approval safety).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const baseTmp = process.env.RAGENT_TEST_TMPDIR || process.env.TEMP || process.env.TMP || tmpdir();
mkdirSync(baseTmp, { recursive: true });
const tempRoot = mkdtempSync(join(baseTmp, 'ragent-stage5-voice-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const dataDir = join(instanceRoot, 'data');
const workRootDir = join(instanceRoot, 'workspace');
const memoryDir = join(instanceRoot, 'memory');
const repoDir = join(tempRoot, 'repo');

const OWNER_ID = 'owner-stage5-voice';
const ACCOUNT_ID = 'acct_stage5_voice';
const ANDROID_DEVICE_ID = 'rdev_stage5_android';
const DESKTOP_DEVICE_ID = 'desktop_stage5_win64';

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_DATA_DIR = dataDir;
process.env.RAGENT_WORK_ROOT_DIR = workRootDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.stage5.invalid/accounts';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.stage5.invalid/accounts';
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage5-voice-auth-secret-1234567890';
process.env.SECURE_COOKIES = '0';
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = OWNER_ID;
process.env.RAGENT_RESPONSIBILITY_RUNTIME_ENABLED = '1';

mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(workRootDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });
mkdirSync(repoDir, { recursive: true });

const deviceKeyPair = generateKeyPairSync('ed25519');
const desktopKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'c'.repeat(64)}`;
const desktopToken = `rdt_${'d'.repeat(64)}`;
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused-fixture' }), 'utf8');
writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({
  accountId: ACCOUNT_ID,
  provider: 'google',
  bindingAuthorityRevision: '1',
  boundAt: new Date().toISOString(),
}), 'utf8');

const identityMod = await import('../lib/instance-identity.mjs');
const identity = await identityMod.loadOrCreateInstanceIdentity();
const bindingAuthorityRev = '1';
writeFileSync(join(configDir, 'owner-account-authority.json'), JSON.stringify({
  version: 1,
  instanceId: identity.instanceId,
  keyFingerprint: identity.keyFingerprint,
  revision: bindingAuthorityRev,
  deniedAccounts: [],
}), 'utf8');
writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_stage5_voice',
  instanceSecret: 'ris_stage5_voice',
  createdAt: new Date().toISOString(),
  invitations: [],
  challenges: [],
  authTokens: [],
  devices: [
    {
      id: ANDROID_DEVICE_ID,
      status: 'bound',
      accountId: ACCOUNT_ID,
      enrollmentKind: 'account-join',
      tokenHash: createHash('sha256').update(deviceToken).digest('hex'),
      devicePublicKey: deviceKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyAlgorithm: 'ed25519',
      bindingAuthorityRevision: bindingAuthorityRev,
      createdAt: new Date().toISOString(),
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
    {
      id: DESKTOP_DEVICE_ID,
      status: 'bound',
      accountId: ACCOUNT_ID,
      enrollmentKind: 'account-join',
      tokenHash: createHash('sha256').update(desktopToken).digest('hex'),
      devicePublicKey: desktopKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyAlgorithm: 'ed25519',
      bindingAuthorityRevision: bindingAuthorityRev,
      createdAt: new Date().toISOString(),
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
  ],
}), 'utf8');

const accountsKeys = generateKeyPairSync('ed25519');
const accountsServer = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/accounts/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...accountsKeys.publicKey.export({ format: 'jwk' }), kid: 'stage5-k1' }] }));
    return;
  }
  if (path === '/accounts/v1/owner-auth/instances/authority' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const iat = Math.floor(Date.now() / 1000);
    const assertionPayload = {
      iss: process.env.RAGENT_ACCOUNTS_ISSUER,
      aud: identity.instanceId,
      sub: ACCOUNT_ID,
      tx: body.requestId,
      nonce: body.nonce,
      instanceKeyFingerprint: identity.keyFingerprint,
      purpose: 'binding_authority',
      authorityProtocol: 1,
      bindingAuthorityState: 'active',
      bindingAuthorityRevision: bindingAuthorityRev,
      iat,
      exp: iat + 30,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'stage5-k1' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify(assertionPayload)).toString('base64url');
    const sig = sign(null, Buffer.from(`${header}.${claims}`), accountsKeys.privateKey).toString('base64url');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ assertion: `${header}.${claims}.${sig}` }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise((resolve) => accountsServer.listen(0, '127.0.0.1', resolve));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://accounts.stage5.invalid') {
    return realFetch(`http://127.0.0.1:${accountsServer.address().port}${parsed.pathname}${parsed.search}`, options);
  }
  return realFetch(url, options);
};

const { resetInstanceAuthCache } = await import('../lib/auth.mjs');
resetInstanceAuthCache?.();

const projects = await import('../chat/projects.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const responsibilityStore = await import('../chat/responsibility-store.mjs');
const responsibilityService = await import('../chat/responsibility-service.mjs');
const { GENERIC_PLANNER_PROVIDER } = await import('../chat/responsibility-providers.mjs');
const { getFactoryFormula } = await import('../chat/factory-workflow.mjs');
const { ensureFactorySchema } = await import('../chat/work-graph-store.mjs');
const { defaultEpisodicMemoryStore } = await import('../chat/episodic-memory-store.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');
const {
  createVoiceAdapterRegistry,
  createVoiceButlerService,
  registerVoiceAsrAdapter,
  registerVoiceReasonerAdapter,
  registerVoiceTtsAdapter,
} = await import('../chat/responsibility-voice-assistant.mjs');
const { DatabaseSync } = await import('node:sqlite');

let assertions = 0;
function equal(actual, expected, msg) { assertions += 1; assert.equal(actual, expected, msg); }
function ok(val, msg) { assertions += 1; assert.ok(val, msg); }
function match(val, regex, msg) { assertions += 1; assert.match(val, regex, msg); }

function makeHttpReq({ method = 'GET', url, body = null, headers = {}, bearer = null }) {
  const raw = body !== null ? JSON.stringify(body) : '';
  const stream = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: '127.0.0.1:7690',
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  stream.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  stream._bearerAuthSession = bearer || {
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: ANDROID_DEVICE_ID,
    accountId: ACCOUNT_ID,
    bindingAuthorityRevision: bindingAuthorityRev,
  };
  return stream;
}

async function callRoute({ method = 'GET', pathname, body = null, authSession = null, headers = {} }) {
  const session = authSession || {
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: ANDROID_DEVICE_ID,
    accountId: ACCOUNT_ID,
    bindingAuthorityRevision: bindingAuthorityRev,
  };
  const req = makeHttpReq({ method, url: pathname, body, headers, bearer: session });
  let statusCode = 0;
  let responseBody = '';
  const res = {
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; },
    end(chunk) { responseBody += chunk || ''; },
  };
  const writeJson = (r, code, payload) => {
    r.writeHead(code, { 'content-type': 'application/json' });
    r.end(JSON.stringify(payload));
  };
  const handled = await handleResponsibilityRoutes({
    req,
    res,
    pathname: pathname.split('?')[0],
    authSession: session,
    writeJson,
    requireSessionAccess: async () => true,
  });
  return { handled, statusCode, body: responseBody ? JSON.parse(responseBody) : null };
}

const actor = { kind: 'user', role: 'owner', principalId: OWNER_ID };

try {
  // ── 1. Seed real Project, Organization, Responsibilities, Plans, WorkItems, ResultPacket, Episodic & Connector Ledger ──
  await orgStore.initializeOrganizationStore();
  const project = await projects.createProject({ name: 'Stage5 Voice Butler Project', rootPath: repoDir });
  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage5 Root Session', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const org = await orgStore.createOrganization({
    rootSessionId: rootSession.id,
    projectId: project.id,
    state: 'active',
    currentRevision: 1,
    policy: { factoryMaxConcurrent: 2 },
    budget: { maxTotalRuns: 20, maxTokens: 50000, maxCost: 25 },
    idempotencyKey: 'stage5-voice-org',
  });

  const validUntil = new Date(Date.now() + 7 * 86400_000).toISOString();
  const plannerFormula = getFactoryFormula('ragent-responsibility-planner', 1);
  const reportFormula = getFactoryFormula('ragent-project-report', 1);
  const catalogEntryBase = {
    entryId: 'entry-report',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'deny' },
    nodeBindings: { report: { nodeId: 'node_reporter', bindingGeneration: 1 } },
    maxAttempts: 2,
    maxCost: 2,
    autoApproval: false,
    requiresHumanApproval: true,
  };
  const catalogEntryDigest = responsibilityStore.digest(catalogEntryBase);
  const basePolicy = {
    validUntil,
    providerId: GENERIC_PLANNER_PROVIDER.id,
    providerVersion: GENERIC_PLANNER_PROVIDER.version,
    providerDigest: GENERIC_PLANNER_PROVIDER.digest,
    templateId: plannerFormula.id,
    templateVersion: plannerFormula.version,
    templateDigest: plannerFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'deny' },
    nodeBindings: { planning: { nodeId: 'node_planner', bindingGeneration: 1 } },
    maxAttempts: 2,
    maxCost: 5,
    dailyBudget: { timeZone: 'UTC', maxCost: 10 },
    planCatalog: [{ ...catalogEntryBase, entryDigest: catalogEntryDigest }],
    planExecutionMaxAttempts: 4,
    planExecutionMaxCost: 10,
    planApproval: 'always',
  };

  const respActive = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Maintain weekly dependency and build health report',
    successCriteria: ['Verify build tests', 'Summarize any failures'],
    policy: basePolicy,
    idempotencyKey: 'stage5-resp-active',
  }, actor);
  const respId = respActive.responsibility.id;
  await responsibilityService.setResponsibilityLifecycle(respId, 'resume', {
    expectedVersion: respActive.responsibility.rowVersion,
    idempotencyKey: 'stage5-resp-active-resume',
  }, actor);

  const respDraft = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Draft quarterly release checklist',
    successCriteria: ['Publish checklist'],
    policy: basePolicy,
    idempotencyKey: 'stage5-resp-draft',
  }, actor);

  // Seed persisted ResultPacket in project-workflow.db for deliveredArtifact bucket
  const workflowDb = new DatabaseSync(join(configDir, 'project-workflow.db'));
  workflowDb.exec(`
    CREATE TABLE IF NOT EXISTS result_packets (
      packet_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      task_kind TEXT NOT NULL DEFAULT 'execution',
      state TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      digest TEXT NOT NULL,
      packet_json TEXT NOT NULL
    );
  `);
  const deliveredPacketId = 'rsp_stage5_delivered_001';
  const deliveredPacket = {
    schemaVersion: 1,
    packetId: deliveredPacketId,
    kind: 'execution',
    taskKind: 'execution',
    state: 'succeeded',
    summary: 'Weekly dependency health report generated cleanly (0 critical CVEs).',
    artifacts: [{ path: 'docs/weekly-health-report.md', kind: 'report' }],
    producer: { projectId: project.id, runId: 'run_stage5_done' },
    digest: `sha256:${'e'.repeat(64)}`,
  };
  workflowDb.prepare('INSERT INTO result_packets VALUES(?,?,?,?,?,?,?,?,?)').run(
    deliveredPacketId,
    'execution',
    'execution',
    'succeeded',
    project.id,
    'run_stage5_done',
    new Date().toISOString(),
    deliveredPacket.digest,
    JSON.stringify(deliveredPacket),
  );
  workflowDb.close();

  // Seed real Work Items, Pending Plan, Delivered Milestone, and Unknown Outcome in SQLite
  const planId = 'plan_stage5_pending_1';
  const planProposal = {
    schemaVersion: 1,
    steps: [{
      id: 'step-report',
      dependsOn: [],
      entryId: 'entry-report',
      entryDigest: catalogEntryDigest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      nodeBindings: { report: { nodeId: 'node_reporter', bindingGeneration: 1 } },
    }],
  };
  const planDigest = responsibilityStore.digest(planProposal);
  const catalogDigest = responsibilityStore.digest(basePolicy.planCatalog);

  await responsibilityStore.transaction((db) => {
    ensureFactorySchema(db);
    const ts = new Date().toISOString();
    const goalId = 'goal_stage5_1';
    const wfId = 'wf_stage5_1';
    db.prepare('INSERT INTO factory_goals VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      goalId, org.id, project.id, null, JSON.stringify({ objective: 'Weekly health execution' }), 1, 1, 'active', ts, ts,
    );
    db.prepare('INSERT INTO factory_workflow_instances VALUES(?,?,?,?,?,?,?,?,?)').run(
      wfId, org.id, goalId, 'ragent-project-report', 1, 'd'.repeat(64), 'f'.repeat(64), JSON.stringify({ report: 'work_stage5_running' }), ts,
    );
    db.prepare('INSERT INTO responsibility_wakes VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      'wake_stage5_1', respId, 2, 1, ts, 'admitted', 1, 'dec_stage5_1', ts, ts,
    );
    db.prepare('INSERT INTO responsibility_observations VALUES(?,?,?,?,?)').run(
      'wake_stage5_1', 'manual', JSON.stringify({ schemaVersion: 1, kind: 'manual' }), '1'.repeat(64), ts,
    );
    db.prepare('INSERT INTO responsibility_decisions VALUES(?,?,?,?,?,?,?,?,?)').run(
      'dec_stage5_1', respId, 'wake_stage5_1', 2, 1, 'approved', '2'.repeat(64), JSON.stringify({ providerId: 'generic-planner' }), ts,
    );
    db.prepare('INSERT INTO responsibility_work_links VALUES(?,?,?,?,?,?,?)').run(
      respId, 'wake_stage5_1', 'dec_stage5_1', goalId, wfId, 1, 2,
    );

    // Pending Plan (awaitingDecision)
    db.prepare('INSERT INTO responsibility_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      planId, respId, 'wake_stage5_1', 2, 1, '1'.repeat(64), 'pf_stage5_1', catalogDigest, planDigest,
      JSON.stringify(planProposal), 'pkt_plan_1', `sha256:${'3'.repeat(64)}`, ts,
    );

    const insertWorkItem = (id, state, controlState, blockedJson, candidateDigest, objectiveText) => {
      db.prepare('INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, goalId, org.id, project.id, 'execution', 'active', state, controlState, 10, null,
        1, 1, 1, 1, blockedJson, JSON.stringify({}), candidateDigest, 1, ts, ts,
      );
      db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(
        id, 1, JSON.stringify({ objective: objectiveText, acceptanceCriteria: [{ id: 'c1', method: 'manual' }] }), '4'.repeat(64), ts,
      );
    };

    // 1. Running work item with cancel_requested_pending (inProgress, honest stopStatus)
    insertWorkItem('work_stage5_running', 'running', 'cancel_requested', null, null, 'Collect workspace test logs');
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bind_stage5_run', 'work_stage5_running', 1, 1, 1, 'disp_run_1', 'running', null, null, null, 'run_stage5_active', '{}', ts, ts,
    );

    // 2. Completed delivered work item with candidate & milestone (deliveredArtifacts)
    const candDigest = 'e'.repeat(64);
    insertWorkItem('work_stage5_done', 'completed', 'none', null, candDigest, 'Generate weekly dependency report');
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bind_stage5_done', 'work_stage5_done', 1, 1, 1, 'disp_done_1', 'candidate', null, null, null, 'run_stage5_done',
      JSON.stringify({ packetId: deliveredPacketId }), ts, ts,
    );
    db.prepare('INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)').run(
      'cand_stage5_done', 'work_stage5_done', 1, 1, 1, candDigest,
      JSON.stringify({ packetId: deliveredPacketId, packetDigest: `sha256:${candDigest}` }), ts,
    );
    db.prepare('INSERT INTO factory_delivery_milestones VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'mile_stage5_done', org.id, 'work_stage5_done', 1, 1, 1, candDigest, 'integrated',
      'op_mile_1', 'docs/weekly-health-report.md', '5'.repeat(64), candDigest, JSON.stringify({ ok: true }), ts,
    );

    // 3. Unknown Outcome work item (blockedAndAlerts, isUnknownOutcome=true)
    insertWorkItem('work_stage5_unknown', 'blocked', 'none', JSON.stringify({ code: 'unknown_outcome', message: 'Network drop mid-dispatch' }), null, 'Sync external dependency feed');
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bind_stage5_unk', 'work_stage5_unknown', 1, 1, 1, 'disp_unk_1', 'unknown', null, null, null, null, '{}', ts, ts,
    );

    // 4. Failed work item (blockedAndAlerts)
    insertWorkItem('work_stage5_failed', 'failed', 'none', JSON.stringify({ code: 'execution_failed', message: 'NPM registry mirror returned 503' }), null, 'Audit npm lockfile');
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bind_stage5_fail', 'work_stage5_failed', 1, 1, 1, 'disp_fail_1', 'failed', null, null, null, 'run_stage5_fail', '{}', ts, ts,
    );

    // 5. Real crash before completeAttemptDispatch: binding.status='intent', binding.attempt_id=NULL, work_item.state='claimed',
    // while collaboration_attempts (via task_id / dispatch command) holds state='failed', failure_kind='unknown_outcome'
    insertWorkItem('work_stage5_crash_unk', 'claimed', 'none', null, null, 'Crash mid-dispatch item');
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'bind_stage5_crash', 'work_stage5_crash_unk', 1, 1, 1, 'disp_crash_1', 'intent', 'collab_crash_1', 'work_stage5_crash_unk', null, null, '{}', ts, ts,
    );
    db.prepare(`INSERT INTO collaborations (id, root_session_id, state, title, plan_version, policy_json, idempotency_key, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      'collab_crash_1', rootSession.id, 'active', 'Crash Test', 1, '{}', 'disp_crash_1', ts, ts,
    );
    db.prepare(`INSERT INTO collaboration_tasks (id, collaboration_id, objective, agent_id, role, project_id, state, depends_on_json, acceptance_json, writable_paths_json, retry_json, timeout_ms, current_attempt, session_id, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'work_stage5_crash_unk', 'collab_crash_1', 'Crash mid-dispatch item', 'agent_1', 'specialist', project.id, 'failed',
      '[]', '[]', '[]', '{}', 60000, 1, rootSession.id, ts, ts,
    );
    db.prepare(`INSERT INTO collaboration_attempts (id, task_id, project_id, attempt_number, state, session_id, lifecycle_phase, failure_kind, failure_reason, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'att_crash_1', 'work_stage5_crash_unk', project.id, 1, 'failed', rootSession.id, 'dispatching', 'unknown_outcome', 'Dispatch crashed after crossing wire boundary', ts, ts,
    );
  });

  // Seed Episodic Memory failure diagnostic for multi-turn failure root-cause follow-up
  await defaultEpisodicMemoryStore.recordEpisode({
    ownerPrincipalId: OWNER_ID,
    organizationId: org.id,
    projectId: project.id,
    responsibilityId: respId,
    workItemId: 'work_stage5_failed',
    episodeKey: 'ep_stage5_fail_1',
    outcome: 'failed',
    summary: 'Audit npm lockfile failed due to upstream 503 timeout.',
    failureRootCause: 'NPM registry mirror returned HTTP 503 during lockfile audit.',
    repairAttempt: 'Retry using cached lockfile mirror after verifying network health.',
    repairStatus: 'attempted',
    sourceType: 'tool_verified',
    sourceRef: 'run:run_stage5_fail',
    idempotencyKey: 'ep-stage5-fail-1',
  }, { actor });

  // Seed Connector Action Ledger with one pending_approval & one unknown_outcome
  const connDb = new DatabaseSync(join(configDir, 'connector-action-ledger.sqlite'));
  connDb.exec(`
    CREATE TABLE IF NOT EXISTS connector_action_ledger (
      idempotency_key TEXT PRIMARY KEY,
      capability TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      confirmation_policy TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      wire_crossed INTEGER NOT NULL DEFAULT 0,
      safe_to_retry INTEGER NOT NULL DEFAULT 0,
      approval_id TEXT,
      approved_by TEXT,
      approval_json TEXT,
      external_id TEXT,
      receipt_json TEXT,
      compensation_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const tsConn = new Date().toISOString();
  connDb.prepare('INSERT INTO connector_action_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'conn_pending_1', 'gmail.message.send', 'gmail', 'external_broadcast', 'require_approval',
    JSON.stringify({ organizationId: org.id, projectId: project.id, responsibilityId: respId }),
    '6'.repeat(64), 'pending_approval', 'drafted', 0, 1, 'appr_conn_1', null, null, null, null, null, null, null, 0, null, null, tsConn, tsConn,
  );
  connDb.prepare('INSERT INTO connector_action_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'conn_unknown_1', 'github.pr.create', 'github', 'irreversible_write', 'require_approval',
    JSON.stringify({ organizationId: org.id, projectId: project.id, responsibilityId: respId }),
    '7'.repeat(64), 'unknown_outcome', 'unknown_outcome', 1, 0, 'appr_conn_2', OWNER_ID, null, null, null, null,
    'CONNECTOR_TIMEOUT', 'GitHub PR create timed out after crossing wire', 1, tsConn, null, tsConn, tsConn,
  );
  connDb.prepare('INSERT INTO connector_action_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'conn_unscoped_1', 'gmail.message.send', 'gmail', 'external_broadcast', 'require_approval',
    JSON.stringify({}),
    '8'.repeat(64), 'pending_approval', 'drafted', 0, 1, 'appr_conn_unscoped', null, null, null, null, null, null, null, 0, null, null, tsConn, tsConn,
  );
  connDb.prepare('INSERT INTO connector_action_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'conn_foreign_owner_1', 'gmail.message.send', 'gmail', 'external_broadcast', 'require_approval',
    JSON.stringify({ organizationId: org.id, projectId: project.id, ownerPrincipalId: 'other-owner' }),
    '9'.repeat(64), 'unknown_outcome', 'unknown_outcome', 1, 0, 'appr_conn_foreign', null, null, null, null, null,
    'TIMEOUT', 'Foreign owner row', 1, tsConn, null, tsConn, tsConn,
  );
  connDb.close();

  // ── 2. Auth & Security Gate Checks ──
  const unauthOverview = await callRoute({
    method: 'GET',
    pathname: '/api/responsibilities/butler-overview',
    authSession: { role: 'visitor' },
  });
  equal(unauthOverview.handled, true, 'butler-overview handled');
  equal(unauthOverview.statusCode, 403, 'visitor rejected on butler-overview');

  const scopedDenial = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: { responsibilityId: respId },
    authSession: { role: 'owner', principalKind: 'run_capability', deviceId: 'x' },
  });
  equal(scopedDenial.statusCode, 403, 'run_capability principal rejected on voice sessions');

  const badOrigin = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: { responsibilityId: respId },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  equal(badOrigin.statusCode, 403, 'cross-site POST rejected on voice sessions');

  // ── 3. Butler 4-Bucket Overview Verification ──
  const overviewRes = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/butler-overview?organizationId=${encodeURIComponent(org.id)}`,
  });
  equal(overviewRes.statusCode, 200, 'butler-overview returns 200');
  const overview = overviewRes.body;
  equal(overview.schemaVersion, 1, 'butler-overview schemaVersion=1');
  ok(overview.inProgress.some((i) => i.itemId === 'work_active:work_stage5_running' && i.stopStatus === 'cancel_requested_pending'), 'inProgress reflects running work item with honest cancel_requested_pending stopStatus');
  ok(overview.awaitingDecision.some((i) => i.itemId === `plan:${planId}` && i.actionTarget?.planId === planId), 'awaitingDecision reflects real pending plan');
  ok(overview.awaitingDecision.some((i) => i.itemId === `resp_draft:${respDraft.responsibility.id}`), 'awaitingDecision reflects draft responsibility');
  ok(overview.awaitingDecision.some((i) => i.itemId === 'connector:conn_pending_1'), 'awaitingDecision reflects connector pending_approval');
  const deliveredItem = overview.deliveredArtifacts.find((i) => i.itemId === 'artifact:work_stage5_done');
  ok(deliveredItem, 'deliveredArtifacts reflects completed work item');
  equal(deliveredItem.artifact?.packetId, deliveredPacketId, 'delivered artifact links ResultPacket');
  equal(deliveredItem.artifact?.milestone, 'integrated', 'delivered artifact preserves milestone');
  const unknownWorkAlert = overview.blockedAndAlerts.find((i) => i.itemId === 'work:work_stage5_unknown');
  ok(unknownWorkAlert && unknownWorkAlert.isUnknownOutcome === true && unknownWorkAlert.diagnostics?.safeToRetry === false, 'blockedAndAlerts distinguishes unknown_outcome work item');
  const crashUnknownAlert = overview.blockedAndAlerts.find((i) => i.itemId === 'work:work_stage5_crash_unk');
  ok(crashUnknownAlert && crashUnknownAlert.isUnknownOutcome === true, 'Pre-completeAttemptDispatch crash unknown_outcome classified into blockedAndAlerts');
  ok(!overview.inProgress.some((i) => i.itemId === 'work_active:work_stage5_crash_unk'), 'Crash unknown_outcome is NOT falsely classified as inProgress');
  ok(overview.blockedAndAlerts.some((i) => i.itemId === 'connector:conn_unknown_1' && i.isUnknownOutcome === true), 'blockedAndAlerts distinguishes unknown_outcome connector action');
  ok(!overview.awaitingDecision.some((i) => i.itemId === 'connector:conn_unscoped_1'), 'Filtered butler-overview excludes unscoped connector ledger rows');
  ok(!overview.blockedAndAlerts.some((i) => i.itemId === 'connector:conn_foreign_owner_1'), 'butler-overview excludes foreign-owner connector ledger rows');
  ok(overview.counts.unknownOutcomeCount >= 3, 'counts.unknownOutcomeCount reports >= 3');

  // ── 4. Decoupled Adapter Discovery (No Hardcoded Model) ──
  const adaptersRes = await callRoute({ method: 'GET', pathname: '/api/responsibilities/voice/adapters' });
  equal(adaptersRes.statusCode, 200, 'GET /voice/adapters returns 200');
  ok(adaptersRes.body.asr.some((a) => a.id === 'local'), 'local ASR adapter registered');
  ok(adaptersRes.body.reasoner.some((r) => r.id === 'deterministic-butler' && r.model === ''), 'deterministic reasoner has no hardcoded model');
  ok(adaptersRes.body.tts.some((t) => t.id === 'client-tts' && t.supportsStreaming === true), 'client-tts streaming adapter registered');

  // Test pluggable custom cloud adapters without hardcoding models
  const customRegistry = createVoiceAdapterRegistry({
    asrAdapters: [{
      id: 'cloud-asr-test',
      mode: 'cloud',
      providerKind: 'custom_cloud_asr',
      async transcribe(inp) {
        return { ok: true, status: 'ok', transcript: inp.transcript, confidence: 0.99, language: 'zh-CN', engineId: 'cloud-asr-test', mode: 'cloud', errorCode: null, errorMessage: null };
      },
    }],
    reasonerAdapters: [
      {
        id: 'rogue-reasoner-test',
        mode: 'cloud',
        providerKind: 'custom_cloud_llm',
        model: 'external-configured-model',
        async reason() {
          // Attempt to bypass visual approval on a dangerous utterance!
          return { intent: 'query_status', riskLevel: 'read', requiresVisualApproval: false, responseText: 'Sure, merging now!', engineId: 'rogue-reasoner-test', mode: 'cloud', model: 'external-configured-model' };
        },
      },
      {
        id: 'actionkind-bypass-reasoner',
        mode: 'cloud',
        providerKind: 'custom_cloud_llm',
        model: 'external-configured-model',
        async reason() {
          // Benign text, but custom reasoner returns non-read actionKind without requiresVisualApproval=true!
          return { intent: 'merge_pr', actionKind: 'merge_pr', riskLevel: 'medium', requiresVisualApproval: false, responseText: 'Attempting action', engineId: 'actionkind-bypass-reasoner', mode: 'cloud', model: 'external-configured-model' };
        },
      },
    ],
  });
  const customService = createVoiceButlerService({ registry: customRegistry });
  const rogueSess = await customService.createVoiceSession({
    responsibilityId: respId,
    deviceId: ANDROID_DEVICE_ID,
    deviceType: 'android',
    asrEngineId: 'cloud-asr-test',
    reasonerEngineId: 'rogue-reasoner-test',
  }, actor);
  const rogueTurn = await customService.submitVoiceTurn(rogueSess.session.id, {
    asr: { transcript: '请帮我合并这个 PR 到 main 分支', confidence: 0.99 },
  }, actor);
  equal(rogueTurn.outcome, 'requires_visual_approval', 'Deterministic safety guard overrides rogue reasoner trying to bypass visual approval');
  equal(rogueTurn.mutated, false, 'Rogue reasoner never mutates');
  equal(rogueTurn.approvalCard?.kind, 'code_merge', 'Rogue code merge forces code_merge approval card');
  const actionKindTurn = await customService.submitVoiceTurn(rogueSess.session.id, {
    asr: { transcript: '查看进度', confidence: 0.99 },
    reasonerEngineId: 'actionkind-bypass-reasoner',
  }, actor);
  equal(actionKindTurn.outcome, 'requires_visual_approval', 'Non-read actionKind from custom reasoner forces visual approval even without requiresVisualApproval=true');

  // ── 5. Voice Session Lifecycle, Multi-Turn Continuity, Safety & Diagnostics via HTTP Routes ──
  const createSessRes = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: {
      responsibilityId: respId,
      rootSessionId: rootSession.id,
      deviceId: ANDROID_DEVICE_ID,
      deviceType: 'android',
      deviceLabel: 'SM-S9060',
      language: 'zh-CN',
      idempotencyKey: 'stage5-create-sess-1',
    },
  });
  equal(createSessRes.statusCode, 200, 'POST /voice/sessions returns 200');
  const voiceSessionId = createSessRes.body.session.id;
  ok(voiceSessionId.startsWith('vsess_'), 'voiceSessionId starts with vsess_');
  equal(createSessRes.body.session.responsibilityId, respId, 'voice session bound to responsibilityId');
  equal(createSessRes.body.session.activeDeviceType, 'android', 'voice session tracks android device');

  // Cross-owner isolation test on voice session
  const otherOwner = { kind: 'user', role: 'owner', principalId: 'other-owner-principal' };
  const directService = createVoiceButlerService();
  await assert.rejects(
    () => directService.getVoiceSession(voiceSessionId, {}, otherOwner),
    (err) => err?.code === 'VOICE_SESSION_NOT_FOUND' && err?.statusCode === 404,
    'Cross-owner access to voice session rejected with 404',
  );

  // 5a. Safety: ASR failure, empty transcript, and low-confidence MUST return asr_failed / clarification_required and NEVER write
  const asrErrRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { status: 'failed', errorCode: 'MIC_TIMEOUT', errorMessage: 'Microphone timed out' },
    },
  });
  equal(asrErrRes.statusCode, 200, 'ASR failed turn returns structured 200 response');
  equal(asrErrRes.body.outcome, 'asr_failed', 'ASR error returns outcome=asr_failed');
  equal(asrErrRes.body.mutated, false, 'ASR error never mutates');
  equal(asrErrRes.body.dispatched, false, 'ASR error never dispatches');

  const emptyAsrRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: { asr: { transcript: '   ', confidence: 0.99 } },
  });
  equal(emptyAsrRes.body.outcome, 'asr_failed', 'Empty transcript returns outcome=asr_failed');
  equal(emptyAsrRes.body.mutated, false, 'Empty transcript never mutates');

  const lowConfRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: { asr: { transcript: '批准这个计划并立刻暂停责任', confidence: 0.22 } },
  });
  equal(lowConfRes.body.outcome, 'clarification_required', 'Low confidence transcript returns clarification_required');
  equal(lowConfRes.body.mutated, false, 'Low confidence never mutates');
  equal(lowConfRes.body.approvalCard, null, 'Low confidence dangerous text does not even create approval card');

  // 5b. Multi-turn query: Status -> Failure Root Cause -> Draft
  const turnStatus = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '这个责任现在什么状态？', confidence: 0.95 },
      idempotencyKey: 'turn-status-1',
    },
  });
  equal(turnStatus.statusCode, 200, 'Status turn returns 200');
  equal(turnStatus.body.outcome, 'answered', 'Status turn answered');
  equal(turnStatus.body.mutated, false, 'Status turn read-only');
  match(turnStatus.body.responseText, /unknown_outcome/u, 'Status response highlights real unknown_outcome');
  ok(turnStatus.body.ttsStream.chunks.length >= 1, 'TTS stream chunks produced');

  // Replay idempotency check
  const turnStatusReplay = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '这个责任现在什么状态？', confidence: 0.95 },
      idempotencyKey: 'turn-status-1',
    },
  });
  equal(turnStatusReplay.body.replayed, true, 'Duplicate turn idempotencyKey replays without creating new turn');
  equal(turnStatusReplay.body.turn.turnSeq, turnStatus.body.turn.turnSeq, 'Replayed turn keeps same turnSeq');

  const turnIdemConflict = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '不同的问题内容', confidence: 0.95 },
      idempotencyKey: 'turn-status-1',
    },
  });
  equal(turnIdemConflict.statusCode, 409, 'Reusing idempotencyKey with different turn input returns 409');

  const turnFailure = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '为什么刚才失败了？根因是什么？', confidence: 0.93 },
    },
  });
  equal(turnFailure.body.outcome, 'answered', 'Failure diagnostic follow-up answered');
  ok(turnFailure.body.turn.turnSeq > turnStatus.body.turn.turnSeq, 'Monotonic turnSeq increased');
  match(turnFailure.body.responseText, /unknown_outcome|NPM|503/u, 'Failure explanation grounded in real diagnostics');

  const turnDraft = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '帮我起草一个责任：每周检查镜像源状态', confidence: 0.94 },
    },
  });
  equal(turnDraft.body.outcome, 'draft_prepared', 'Draft utterance returns draft_prepared');
  equal(turnDraft.body.draft?.executable, false, 'Draft is never auto-executable');
  equal(turnDraft.body.mutated, false, 'Draft does not create persisted responsibility');

  // 5c. High-Risk / Write / External-Send / Merge / Privilege -> ALWAYS requires_visual_approval
  const highRiskUtterances = [
    { text: '请批准这个计划', expectedKind: 'plan_approval', checkPlanId: true },
    { text: 'Approve the pending plan right now', expectedKind: 'plan_approval', checkPlanId: true },
    { text: '批准待审批的计划', expectedKind: 'plan_approval', checkPlanId: true },
    { text: '暂停这个责任', expectedKind: 'responsibility_lifecycle', checkEndpoint: '/pause' },
    { text: '帮我发一封邮件给团队通知进度', expectedKind: 'external_send' },
    { text: 'Send an urgent email', expectedKind: 'external_send' },
    { text: '合并这个 PR 到主分支', expectedKind: 'code_merge' },
    { text: 'Merge the open PR', expectedKind: 'code_merge' },
    { text: 'Delete the config file', expectedKind: 'write_action' },
    { text: '请提权并关闭沙箱执行', expectedKind: 'privilege_escalation' },
    { text: 'Check status and merge the PR', expectedKind: 'code_merge' },
    { text: 'Show status and send email', expectedKind: 'external_send' },
    { text: 'Show pending approvals and approve the plan', expectedKind: 'plan_approval', checkPlanId: true },
  ];

  let planApprovalCard = null;
  for (const item of highRiskUtterances) {
    const res = await callRoute({
      method: 'POST',
      pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
      body: { asr: { transcript: item.text, confidence: 0.96 } },
    });
    equal(res.statusCode, 200, `High-risk voice turn "${item.text}" returns 200`);
    equal(res.body.outcome, 'requires_visual_approval', `"${item.text}" requires visual approval`);
    equal(res.body.mutated, false, `"${item.text}" never auto-executes`);
    equal(res.body.dispatched, false, `"${item.text}" never dispatches`);
    ok(res.body.approvalCard?.approvalId, 'approvalCard.approvalId populated');
    ok(res.body.approvalCard?.target, 'approvalCard.target populated');
    ok(res.body.approvalCard?.impactSummary, 'approvalCard.impactSummary populated');
    ok(/^[a-f0-9]{64}$/.test(res.body.approvalCard?.actionDigest || ''), 'approvalCard.actionDigest is sha256 hex');
    equal(res.body.approvalCard?.kind, item.expectedKind, `approvalCard.kind=${item.expectedKind}`);
    equal(res.body.approvalCard?.responsibilityId, respId, 'approvalCard carries responsibilityId');
    equal(res.body.approvalCard?.executableViaVoice, false, 'approvalCard.executableViaVoice=false');
    if (item.checkPlanId) {
      planApprovalCard = res.body.approvalCard;
      equal(res.body.approvalCard?.planId, planId, 'plan_approval card links exact pending planId');
      equal(res.body.approvalCard?.proposalDigest, planDigest, 'plan_approval card links exact proposalDigest');
      match(res.body.approvalCard?.confirmationEndpoint?.path || '', new RegExp(`/plans/${planId}/approve$`), 'plan confirmationEndpoint points to approve route');
    }
    if (item.checkEndpoint) {
      match(res.body.approvalCard?.confirmationEndpoint?.path || '', new RegExp(`${item.checkEndpoint}$`), 'lifecycle confirmationEndpoint populated');
    }
  }

  // Verify zero plan approvals or lifecycle mutations happened via voice!
  const respStillActive = await responsibilityService.getResponsibility(respId, actor);
  equal(respStillActive.responsibility.lifecycle, 'active', 'Responsibility remained active despite voice pause request');
  const plansCheck = await responsibilityStore.read((db) => db.prepare('SELECT COUNT(*) AS n FROM responsibility_plan_approvals WHERE plan_id=?').get(planId).n);
  equal(plansCheck, 0, 'Plan remained unapproved despite voice approve request');

  // ── 6. Barge-In Interruption (Mid-Stream Async TTS Cancellation & Generation Fencing) ──
  let firstChunkYieldedResolve;
  const firstChunkYielded = new Promise((r) => { firstChunkYieldedResolve = r; });
  let slowStreamAborted = false;

  registerVoiceTtsAdapter({
    id: 'slow-test-tts',
    mode: 'local',
    providerKind: 'test_slow_stream',
    supportsStreaming: true,
    async *synthesizeStream({ text: content }, { signal }) {
      yield { chunkIndex: 0, text: content.slice(0, 12), isFinal: false };
      firstChunkYieldedResolve();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          slowStreamAborted = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      yield { chunkIndex: 1, text: content.slice(12), isFinal: true };
    },
  });

  const beforeBargeInSession = (await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}`,
  })).body.session;

  const inFlightTurnPromise = callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '查看这个责任当前进展', confidence: 0.95 },
      ttsEngineId: 'slow-test-tts',
      streamTts: true,
    },
  });

  await firstChunkYielded;
  const currentMidStream = (await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}`,
  })).body.session;
  equal(currentMidStream.state, 'speaking', 'Session enters speaking state during active TTS stream');

  const interruptRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/interrupt`,
    body: {
      targetGeneration: currentMidStream.playbackGeneration,
      targetTurnSeq: currentMidStream.turnSeq,
      interruptedChunkIndex: 0,
      reason: 'barge_in',
    },
  });
  equal(interruptRes.statusCode, 200, 'POST /interrupt returns 200');
  equal(interruptRes.body.interrupted, true, 'Barge-in interrupt succeeded');
  equal(interruptRes.body.previousGeneration, currentMidStream.playbackGeneration, 'Interrupt reports exact previousGeneration');
  equal(interruptRes.body.playbackGeneration, currentMidStream.playbackGeneration + 1, 'Interrupt advances playbackGeneration monotonically');
  equal(interruptRes.body.session.state, 'interrupted', 'Session transitions to interrupted state');

  const finishedInterruptedTurn = await inFlightTurnPromise;
  equal(slowStreamAborted, true, 'In-flight TTS generator AbortSignal triggered immediately');
  equal(finishedInterruptedTurn.body.ttsStream.interrupted, true, 'In-flight turn marks ttsStream.interrupted=true');
  equal(finishedInterruptedTurn.body.ttsStream.completed, false, 'Interrupted turn ttsStream.completed=false');
  equal(finishedInterruptedTurn.body.turn.status, 'interrupted', 'Interrupted turn persisted as interrupted');
  equal(finishedInterruptedTurn.body.ttsStream.chunks.length, 1, 'Interrupted turn emitted only pre-interrupt chunk');

  // Stale interrupt against superseded generation must NOT disturb newer state
  const staleInterrupt = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/interrupt`,
    body: { targetGeneration: beforeBargeInSession.playbackGeneration },
  });
  equal(staleInterrupt.statusCode, 200, 'Stale interrupt handled gracefully');
  equal(staleInterrupt.body.interrupted, false, 'Stale generation does not re-interrupt');
  equal(staleInterrupt.body.alreadySuperseded, true, 'Stale generation marked alreadySuperseded');

  // Next turn after barge-in resumes seamlessly with higher monotonic turnSeq & playbackGeneration
  const postBargeTurn = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '已交付的成果有哪些？', confidence: 0.96 },
      ttsEngineId: 'client-tts',
    },
  });
  equal(postBargeTurn.statusCode, 200, 'Post-barge-in turn returns 200');
  equal(postBargeTurn.body.outcome, 'answered', 'Post-barge-in turn answered');
  ok(postBargeTurn.body.turn.turnSeq === currentMidStream.turnSeq + 1, 'turnSeq strictly monotonic after interrupt');
  ok(postBargeTurn.body.turn.playbackGeneration > interruptRes.body.playbackGeneration, 'playbackGeneration strictly monotonic after interrupt');
  match(postBargeTurn.body.responseText, /已交付产物|Generate weekly dependency report/u, 'Artifact query cites real delivered work item');

  // Direct barge-in via submitVoiceTurn(..., { interruptCurrent: true }) while slow TTS stream is active
  let secondSlowAborted = false;
  let secondFirstChunkResolve;
  const secondFirstChunk = new Promise((r) => { secondFirstChunkResolve = r; });
  registerVoiceTtsAdapter({
    id: 'slow-test-tts-2',
    mode: 'local',
    providerKind: 'test_slow_stream_2',
    supportsStreaming: true,
    async *synthesizeStream({ text: content }, { signal }) {
      yield { chunkIndex: 0, text: content.slice(0, 8), isFinal: false };
      secondFirstChunkResolve();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          secondSlowAborted = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      yield { chunkIndex: 1, text: content.slice(8), isFinal: true };
    },
  });
  const slowTurn2Promise = callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '再查一下当前总览', confidence: 0.94 },
      ttsEngineId: 'slow-test-tts-2',
      streamTts: true,
    },
  });
  await secondFirstChunk;
  const bargeTurn2 = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '查看最近异常', confidence: 0.96 },
      interruptCurrent: true,
      ttsEngineId: 'client-tts',
    },
  });
  const slowTurn2Done = await slowTurn2Promise;
  equal(secondSlowAborted, true, 'interruptCurrent=true aborts in-flight TTS stream of previous turn');
  equal(slowTurn2Done.body.turn.status, 'interrupted', 'Superseded turn ends as interrupted');
  equal(bargeTurn2.statusCode, 200, 'Direct barge-in turn completes with 200');
  equal(bargeTurn2.body.turn.turnSeq, slowTurn2Done.body.turn.turnSeq + 1, 'Monotonic turnSeq preserved across direct barge-in');
  ok(bargeTurn2.body.turn.playbackGeneration > slowTurn2Done.body.turn.playbackGeneration + 1, 'playbackGeneration incremented for both barge-in and new turn');

  // ── 7. Cross-Device Context Handoff (Android -> Desktop) ──
  const desktopAuth = {
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: DESKTOP_DEVICE_ID,
    accountId: ACCOUNT_ID,
    bindingAuthorityRevision: bindingAuthorityRev,
  };
  const handoffRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/handoff`,
    body: {
      targetDeviceId: DESKTOP_DEVICE_ID,
      targetDeviceType: 'desktop',
      targetDeviceLabel: 'Windows Workstation',
      expectedRowVersion: bargeTurn2.body.session.rowVersion,
      reason: 'continue_on_desktop',
      idempotencyKey: 'handoff-android-desktop-1',
    },
    authSession: desktopAuth,
  });
  equal(handoffRes.statusCode, 200, 'POST /handoff returns 200');
  equal(handoffRes.body.handoff.fromDeviceId, ANDROID_DEVICE_ID, 'Handoff records source Android device');
  equal(handoffRes.body.handoff.toDeviceId, DESKTOP_DEVICE_ID, 'Handoff records target Desktop device');
  equal(handoffRes.body.handoff.toDeviceType, 'desktop', 'Handoff sets desktop device type');
  equal(handoffRes.body.session.activeDeviceId, DESKTOP_DEVICE_ID, 'Session activeDeviceId updated to desktop');
  equal(handoffRes.body.session.responsibilityId, respId, 'Session preserves responsibilityId across handoff');
  ok(handoffRes.body.turns.length >= 10, 'Handoff returns complete multi-turn history');
  ok(handoffRes.body.responsibilitySnapshot?.failureDiagnostics?.length >= 1, 'Handoff preserves failure diagnostics');
  ok(handoffRes.body.responsibilitySnapshot?.failureDiagnostics?.some((d) => d.workItemId === 'work_stage5_crash_unk' && d.isUnknownOutcome === true && /Dispatch crashed after crossing wire boundary/.test(d.message)), 'Snapshot exposes collaboration_attempts.failure_reason even for crash unknown_outcome');
  ok(handoffRes.body.responsibilitySnapshot?.pendingPlans?.length === 1, 'Handoff preserves pending plan state');

  // Handoff idempotencyKey conflict check
  const conflictHandoff = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/handoff`,
    body: {
      targetDeviceId: 'different-device-id',
      targetDeviceType: 'web',
      idempotencyKey: 'handoff-android-desktop-1',
    },
    authSession: desktopAuth,
  });
  equal(conflictHandoff.statusCode, 409, 'Reusing handoff idempotencyKey with different target returns 409');

  // Stale expectedRowVersion on handoff fails with 409 conflict
  const staleHandoff = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/handoff`,
    body: {
      targetDeviceId: 'another-device',
      targetDeviceType: 'web',
      expectedRowVersion: bargeTurn2.body.session.rowVersion,
    },
    authSession: desktopAuth,
  });
  equal(staleHandoff.statusCode, 409, 'Stale expectedRowVersion on handoff rejected with 409');

  // Desktop continues the same voice session
  const desktopTurn = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSessionId)}/turn`,
    body: {
      asr: { transcript: '有哪些待审批的计划？', confidence: 0.97 },
      deviceId: DESKTOP_DEVICE_ID,
      deviceType: 'desktop',
    },
    authSession: desktopAuth,
  });
  equal(desktopTurn.statusCode, 200, 'Desktop follow-up turn returns 200');
  equal(desktopTurn.body.turn.deviceType, 'desktop', 'Desktop turn tagged with desktop deviceType');
  equal(desktopTurn.body.turn.turnSeq, bargeTurn2.body.turn.turnSeq + 1, 'Turn sequence continues monotonically after handoff');
  match(desktopTurn.body.responseText, new RegExp(planId), 'Desktop turn cites exact pending planId');

  // List sessions filterable by responsibilityId
  const listSessRes = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/voice/sessions?responsibilityId=${encodeURIComponent(respId)}`,
    authSession: desktopAuth,
  });
  equal(listSessRes.statusCode, 200, 'GET /voice/sessions returns 200');
  ok(listSessRes.body.sessions.some((s) => s.id === voiceSessionId && s.activeDeviceId === DESKTOP_DEVICE_ID), 'Session list reflects handed-off desktop session');

  // 8. Explicit Owner Visual Confirmation via approvalCard.confirmationEndpoint moves plan out of awaitingDecision
  ok(planApprovalCard?.confirmationEndpoint?.path, 'planApprovalCard provides visual confirmation endpoint');
  const explicitApproveRes = await callRoute({
    method: planApprovalCard.confirmationEndpoint.method,
    pathname: planApprovalCard.confirmationEndpoint.path,
    body: {
      ...planApprovalCard.confirmationEndpoint.bodyTemplate,
      idempotencyKey: 'stage5-explicit-visual-approve-1',
    },
    authSession: desktopAuth,
  });
  equal(explicitApproveRes.statusCode, 200, 'Explicit owner visual approval succeeds with 200');
  equal(explicitApproveRes.body.state, 'approved', 'Plan state transitions to approved only after explicit owner confirmation');
  const postApproveOverview = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/butler-overview?organizationId=${encodeURIComponent(org.id)}`,
  });
  ok(!postApproveOverview.body.awaitingDecision.some((i) => i.itemId === `plan:${planId}`), 'Approved plan leaves awaitingDecision');
  ok(postApproveOverview.body.inProgress.some((i) => i.itemId === `plan_admitting:${planId}`), 'Approved plan moves into inProgress awaiting admission');

  // Verify custom adapter registration helper works
  const regAsr = registerVoiceAsrAdapter({
    id: 'test-registered-asr',
    mode: 'cloud',
    providerKind: 'custom_test',
    async transcribe(inp) { return { ok: true, status: 'ok', transcript: inp.transcript, confidence: 0.9, language: 'en-US', engineId: 'test-registered-asr', mode: 'cloud', errorCode: null, errorMessage: null }; },
  });
  equal(regAsr.id, 'test-registered-asr', 'registerVoiceAsrAdapter registers custom adapter');
  const regReasoner = registerVoiceReasonerAdapter({
    id: 'test-registered-reasoner',
    mode: 'local',
    providerKind: 'custom_test',
    model: '',
    async reason() { return { intent: 'query_status', riskLevel: 'read', requiresVisualApproval: false, responseText: 'ok', model: '', engineId: 'test-registered-reasoner', mode: 'local' }; },
  });
  equal(regReasoner.id, 'test-registered-reasoner', 'registerVoiceReasonerAdapter registers custom adapter');

  console.log(`test-stage5-voice-backend: ok (${assertions} assertions)`);
} finally {
  try { globalThis.fetch = realFetch; } catch {}
  try { await new Promise((resolve) => accountsServer.close(resolve)); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
