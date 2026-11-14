import { randomBytes } from 'crypto';
import { openDatabase as openCollaborationDatabase } from './collaboration-store.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { CHAT_COLLABORATIONS_DB, ORG_SHADOW_PROJECTION } from '../lib/config.mjs';
import { invalidateOrganizationProjectionCache } from './organization-projection-cache.mjs';

// Organization Runtime data layer (S8). The six organization tables live in the
// same Collaboration SQLite file (WAL, foreign keys ON) so organization
// commands, task creation and event writes can commit in one transaction.
// Migration is idempotent additive: CREATE TABLE IF NOT EXISTS for the base
// schema, plus a PRAGMA user_version guard for future additive steps.
const runOrganizationStoreMutation = createSerialTaskQueue();
const ORG_SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function orgError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Reuse the collaboration connection opener (same file, WAL, FK on) and layer
// the organization schema on top. New connections are cheap in SQLite; this
// keeps one canonical opener instead of two handles to the same file.
function openDatabase() {
  const db = openCollaborationDatabase();
  ensureOrganizationSchema(db);
  return db;
}

async function withDatabase(fn, { mutate = false } = {}) {
  const run = async () => {
    const db = openDatabase();
    try { return await fn(db); } finally { db.close(); }
  };
  const result = mutate ? await runOrganizationStoreMutation(run) : await run();
  if (mutate) {
    // Most organization writes return a normalized row carrying
    // organizationId. The organization row itself uses `id`; invalidate the
    // projection cache centrally so node/edge/gate/grant writes cannot leave a
    // short-lived stale projection behind.
    const organizationId = result?.organizationId
      || (result && result.projectId !== undefined ? result.id : '');
    if (organizationId) invalidateOrganizationProjectionCache(organizationId);
  }
  return result;
}

function ensureOrganizationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      root_session_id TEXT UNIQUE,
      state TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 0,
      progress_epoch INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      policy_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_revisions (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      proposal_json TEXT NOT NULL,
      compiled_json TEXT,
      digest TEXT,
      state TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, revision)
    );
    CREATE TABLE IF NOT EXISTS organization_nodes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL,
      node_role TEXT NOT NULL,
      created_revision INTEGER NOT NULL,
      retired_revision INTEGER,
      lifecycle_state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      grant_json TEXT NOT NULL,
      current_session_id TEXT,
      binding_generation INTEGER NOT NULL DEFAULT 0,
      role_instance_id TEXT,
      parent_node_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      session_class TEXT,
      idempotency_key TEXT,
      UNIQUE(organization_id, stable_key)
    );
    CREATE TABLE IF NOT EXISTS role_instances (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      organization_revision INTEGER NOT NULL,
      organization_node_id TEXT,
      stable_key TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      capability_profile_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, stable_key),
      UNIQUE(organization_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS delegation_grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      organization_revision INTEGER NOT NULL,
      parent_node_id TEXT NOT NULL,
      child_node_id TEXT,
      role_instance_id TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      allowed_capabilities_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      execution_isolation TEXT NOT NULL,
      max_depth INTEGER NOT NULL DEFAULT 3,
      max_children INTEGER NOT NULL DEFAULT 16,
      max_concurrent INTEGER NOT NULL DEFAULT 4,
      can_delegate INTEGER NOT NULL DEFAULT 0,
      lifecycle_state TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS organization_edges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      organization_revision INTEGER NOT NULL,
      stable_key TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      parent_node_id TEXT NOT NULL,
      child_node_id TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, stable_key),
      UNIQUE(organization_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS organization_grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES organization_nodes(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      capability TEXT NOT NULL,
      allow INTEGER NOT NULL,
      scope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_gates (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      phase_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      decision_json TEXT,
      decided_by_node_id TEXT,
      decided_at TEXT,
      packet_id TEXT,
      UNIQUE(organization_id, phase_id, generation)
    );
    CREATE TABLE IF NOT EXISTS organization_envelopes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      phase_id TEXT,
      attempt_id TEXT,
      packet_id TEXT,
      agent_report_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_nodes_org ON organization_nodes(organization_id, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_role_instances_org ON role_instances(organization_id, organization_revision, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_delegation_grants_parent ON delegation_grants(organization_id, parent_node_id, organization_revision);
    CREATE INDEX IF NOT EXISTS idx_org_edges_parent ON organization_edges(organization_id, parent_node_id, organization_revision);
    CREATE INDEX IF NOT EXISTS idx_org_grants_node ON organization_grants(node_id, revision);
    CREATE INDEX IF NOT EXISTS idx_org_gates_org_phase ON organization_gates(organization_id, phase_id, generation);
    CREATE INDEX IF NOT EXISTS idx_org_envelopes_org ON organization_envelopes(organization_id, node_id, revision);
  `);
  // S9 additive columns for idempotent command replay (constitution §2.19):
  // createOrganization and reviseOrganization key their crash-recovery replay on
  // an idempotency_key. Fresh databases get the column from CREATE TABLE above;
  // S8 databases need a guarded additive ALTER.
  const orgColumns = new Set(db.prepare('PRAGMA table_info(organizations)').all().map((column) => column.name));
  if (!orgColumns.has('idempotency_key')) {
    db.exec('ALTER TABLE organizations ADD COLUMN idempotency_key TEXT');
  }
  const revisionColumns = new Set(db.prepare('PRAGMA table_info(organization_revisions)').all().map((column) => column.name));
  if (!revisionColumns.has('idempotency_key')) {
    db.exec('ALTER TABLE organization_revisions ADD COLUMN idempotency_key TEXT');
  }
  // A revision idempotency key maps to exactly one revision per organization;
  // replaying the same key after a crash returns the same revision instead of
  // minting a second one. NULL keys (ordinary revisions) are not indexed.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_revisions_idem
    ON organization_revisions(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  const nodeColumns = new Set(db.prepare('PRAGMA table_info(organization_nodes)').all().map((column) => column.name));
  const nodeAdditions = [
    ['current_session_id', 'TEXT'],
    ['binding_generation', 'INTEGER NOT NULL DEFAULT 0'],
    ['role_instance_id', 'TEXT'],
    ['parent_node_id', 'TEXT'],
    ['depth', 'INTEGER NOT NULL DEFAULT 0'],
    ['session_class', 'TEXT'],
    ['idempotency_key', 'TEXT'],
  ];
  for (const [column, definition] of nodeAdditions) {
    if (!nodeColumns.has(column)) db.exec(`ALTER TABLE organization_nodes ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_nodes_idem
    ON organization_nodes(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_org_nodes_parent
    ON organization_nodes(organization_id, parent_node_id, lifecycle_state)`);
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (schemaVersion < ORG_SCHEMA_VERSION) {
    migrateOrganizationSchema(db, schemaVersion);
    db.exec(`PRAGMA user_version = ${ORG_SCHEMA_VERSION}`);
  }
}

function migrateOrganizationSchema(db, fromVersion) {
  if (fromVersion < 1) {
    // S8 base schema is created by the idempotent CREATE TABLE IF NOT EXISTS
    // block above. Future slices add guarded, additive steps here (PRAGMA
    // table_info + ALTER TABLE ADD COLUMN), mirroring collaboration-store.mjs.
  }
}

function rowOrganization(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id || '',
    rootSessionId: row.root_session_id,
    state: row.state,
    currentRevision: row.current_revision,
    progressEpoch: row.progress_epoch,
    version: row.version,
    policy: parseJson(row.policy_json, {}),
    budget: parseJson(row.budget_json, {}),
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowRevision(row) {
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    revision: row.revision,
    proposal: parseJson(row.proposal_json, {}),
    compiled: parseJson(row.compiled_json, null),
    digest: row.digest || '',
    state: row.state,
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
  };
}

function rowNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    stableKey: row.stable_key,
    nodeRole: row.node_role,
    createdRevision: row.created_revision,
    retiredRevision: row.retired_revision ?? null,
    lifecycleState: row.lifecycle_state,
    version: row.version,
    grant: parseJson(row.grant_json, {}),
    currentSessionId: row.current_session_id || '',
    bindingGeneration: Number(row.binding_generation || 0),
    roleInstanceId: row.role_instance_id || '',
    parentNodeId: row.parent_node_id || '',
    depth: Number(row.depth || 0),
    sessionClass: row.session_class || '',
    idempotencyKey: row.idempotency_key || '',
  };
}

function rowRoleInstance(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationRevision: row.organization_revision,
    organizationNodeId: row.organization_node_id || '',
    stableKey: row.stable_key,
    role: row.role,
    agentId: row.agent_id,
    capabilityProfile: parseJson(row.capability_profile_json, {}),
    policy: parseJson(row.policy_json, {}),
    budget: parseJson(row.budget_json, {}),
    lifecycleState: row.lifecycle_state,
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowDelegationGrant(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationRevision: row.organization_revision,
    parentNodeId: row.parent_node_id,
    childNodeId: row.child_node_id || '',
    roleInstanceId: row.role_instance_id || '',
    generation: row.generation,
    allowedCapabilities: parseJson(row.allowed_capabilities_json, []),
    scope: parseJson(row.scope_json, {}),
    accessMode: row.access_mode,
    executionIsolation: row.execution_isolation,
    maxDepth: row.max_depth,
    maxChildren: row.max_children,
    maxConcurrent: row.max_concurrent,
    canDelegate: !!row.can_delegate,
    lifecycleState: row.lifecycle_state,
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
  };
}

function rowOrganizationEdge(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationRevision: row.organization_revision,
    stableKey: row.stable_key,
    edgeType: row.edge_type,
    parentNodeId: row.parent_node_id,
    childNodeId: row.child_node_id,
    idempotencyKey: row.idempotency_key || '',
    createdAt: row.created_at,
  };
}

function rowGrant(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    nodeId: row.node_id,
    revision: row.revision,
    capability: row.capability,
    allow: !!row.allow,
    scope: parseJson(row.scope_json, {}),
    createdAt: row.created_at,
  };
}

function rowGate(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    phaseId: row.phase_id,
    generation: row.generation,
    state: row.state,
    decision: parseJson(row.decision_json, null),
    decidedByNodeId: row.decided_by_node_id || '',
    decidedAt: row.decided_at || '',
    packetId: row.packet_id || '',
  };
}

function rowEnvelope(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    nodeId: row.node_id || '',
    revision: row.revision,
    phaseId: row.phase_id || '',
    attemptId: row.attempt_id || '',
    packetId: row.packet_id || '',
    agentReport: parseJson(row.agent_report_json, {}),
    createdAt: row.created_at,
  };
}

function requireOrganization(db, organizationId) {
  const row = db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId);
  if (!row) throw orgError('ORGANIZATION_NOT_FOUND', `organization ${organizationId} not found`);
  return row;
}

export async function initializeOrganizationStore() {
  await withDatabase(() => true, { mutate: true });
  return CHAT_COLLABORATIONS_DB;
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export async function createOrganization({
  id: organizationId = id('org'),
  projectId = '',
  rootSessionId,
  state = 'active',
  policy = {},
  budget = {},
  currentRevision = 0,
  progressEpoch = 0,
  version = 1,
  idempotencyKey = '',
} = {}) {
  if (!rootSessionId) throw orgError('BAD_REQUEST', 'rootSessionId is required');
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Crash-recovery replay (constitution §2.19): the same idempotency key
      // against the same root session returns the original organization instead
      // of creating a second one.
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM organizations WHERE root_session_id = ? AND idempotency_key = ?').get(rootSessionId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowOrganization(replay);
        }
      }
      const existing = db.prepare('SELECT id FROM organizations WHERE root_session_id = ?').get(rootSessionId);
      if (existing) {
        throw orgError('ORGANIZATION_ROOT_SESSION_CONFLICT', `an organization already exists for root session ${rootSessionId}`);
      }
      db.prepare(`INSERT INTO organizations
        (id, project_id, root_session_id, state, current_revision, progress_epoch, version, policy_json, budget_json, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(organizationId, projectId || null, rootSessionId, state, currentRevision, progressEpoch, version,
          json(policy, {}), json(budget, {}), idempotencyKey || null, timestamp, timestamp);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowOrganization(db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId));
  }, { mutate: true });
}

export async function getOrganization(organizationId) {
  const normalized = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!normalized) return null;
  return withDatabase((db) => rowOrganization(db.prepare('SELECT * FROM organizations WHERE id = ?').get(normalized)));
}

export async function getOrganizationByRootSession(rootSessionId) {
  const normalized = typeof rootSessionId === 'string' ? rootSessionId.trim() : '';
  if (!normalized) return null;
  return withDatabase((db) => {
    const current = db.prepare('SELECT * FROM organizations WHERE root_session_id = ?').get(normalized);
    if (current) return rowOrganization(current);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_root_binding_history'").get()) return null;
    return rowOrganization(db.prepare(`SELECT o.* FROM organization_root_binding_history h JOIN organizations o ON o.id=h.organization_id
      WHERE h.root_session_id=? ORDER BY h.created_at DESC,h.generation DESC LIMIT 1`).get(normalized));
  });
}

export async function listOrganizations({ projectId = '' } = {}) {
  return withDatabase((db) => {
    const rows = projectId
      ? db.prepare('SELECT * FROM organizations WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : db.prepare('SELECT * FROM organizations ORDER BY created_at DESC').all();
    return rows.map(rowOrganization);
  });
}

export async function updateOrganizationVersion(organizationId, {
  state,
  currentRevision,
  progressEpoch,
  version,
  policy,
  budget,
} = {}) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    if (!row) return null;
    db.prepare(`UPDATE organizations SET
        state = ?, current_revision = ?, progress_epoch = ?, version = ?,
        policy_json = ?, budget_json = ?, updated_at = ?
      WHERE id = ?`)
      .run(state ?? row.state, currentRevision ?? row.current_revision, progressEpoch ?? row.progress_epoch,
        version ?? row.version,
        policy !== undefined ? json(policy, {}) : row.policy_json,
        budget !== undefined ? json(budget, {}) : row.budget_json,
        nowIso(), organizationId);
    return rowOrganization(db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId));
  }, { mutate: true });
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export async function createRevision(organizationId, { revision, proposal = {}, compiled = null, digest = '', state = 'draft' } = {}) {
  if (!Number.isInteger(revision) || revision < 1) throw orgError('BAD_REQUEST', 'revision must be a positive integer');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision);
      if (existing) {
        // A frozen revision is immutable; every new constitution must be a
        // higher revision (constitution §2.13). Draft re-uploads are allowed.
        if (existing.state === 'frozen') {
          throw orgError('REVISION_FROZEN', `revision ${revision} of organization ${organizationId} is frozen and cannot be modified`);
        }
        db.prepare(`UPDATE organization_revisions
          SET proposal_json = ?, compiled_json = ?, digest = ?, state = ?
          WHERE organization_id = ? AND revision = ?`)
          .run(json(proposal, {}), compiled !== null ? json(compiled, null) : existing.compiled_json, digest, state, organizationId, revision);
        db.exec('COMMIT');
        return rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision));
      }
      db.prepare(`INSERT INTO organization_revisions
        (organization_id, revision, proposal_json, compiled_json, digest, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(organizationId, revision, json(proposal, {}), compiled !== null ? json(compiled, null) : null, digest, state, timestamp);
      db.exec('COMMIT');
      return rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

export async function getRevision(organizationId, revision) {
  return withDatabase((db) => rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision)));
}

export async function listRevisions(organizationId) {
  return withDatabase((db) => db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? ORDER BY revision').all(organizationId).map(rowRevision));
}

export async function freezeRevision(organizationId, revision) {
  return withDatabase((db) => {
    const existing = db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision);
    if (!existing) return null;
    if (existing.state === 'frozen') return rowRevision(existing);
    db.prepare("UPDATE organization_revisions SET state = 'frozen' WHERE organization_id = ? AND revision = ?").run(organizationId, revision);
    return rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision));
  }, { mutate: true });
}

// S9: atomically append a revision on top of the organization head with a CAS
// version advance. Mirrors advanceGateGeneration: the caller passes the
// expectedCurrentRevision it compiled against; the transaction verifies the
// head still matches, rejects a pre-existing draft at the next revision number,
// and advances current_revision so the next revise builds on the new head.
// A matching idempotency key replays the original revision (crash recovery,
// constitution §2.19) instead of minting a second object.
export async function createRevisionAtHead(organizationId, {
  expectedCurrentRevision = null,
  proposal = {},
  compiled = null,
  digest = '',
  idempotencyKey = '',
} = {}) {
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
      if (!org) throw orgError('ORGANIZATION_NOT_FOUND', `organization ${organizationId} not found`);
      const base = Number(org.current_revision || 0);
      if (expectedCurrentRevision !== null && expectedCurrentRevision !== undefined && Number(expectedCurrentRevision) !== base) {
        throw orgError('REVISION_CONFLICT', `organization ${organizationId} current revision is ${base}, expected ${expectedCurrentRevision}`);
      }
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND idempotency_key = ?').get(organizationId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowRevision(replay);
        }
      }
      const revision = base + 1;
      const existing = db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision);
      if (existing) {
        throw orgError('REVISION_CONFLICT', `revision ${revision} already exists for organization ${organizationId}; current head moved on`);
      }
      db.prepare(`INSERT INTO organization_revisions
        (organization_id, revision, proposal_json, compiled_json, digest, state, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(organizationId, revision, json(proposal, {}), compiled !== null ? json(compiled, null) : null, digest, idempotencyKey || null, timestamp);
      db.prepare('UPDATE organizations SET current_revision = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(revision, timestamp, organizationId);
      db.exec('COMMIT');
      return rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, revision));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export async function createNode({
  id: nodeId = id('node'),
  organizationId,
  stableKey,
  nodeRole,
  createdRevision = 0,
  lifecycleState = 'active',
  grant = {},
  currentSessionId = '',
  bindingGeneration = 0,
  roleInstanceId = '',
  parentNodeId = '',
  depth = 0,
  sessionClass = '',
  idempotencyKey = '',
} = {}) {
  if (!organizationId) throw orgError('BAD_REQUEST', 'organizationId is required');
  if (!stableKey) throw orgError('BAD_REQUEST', 'stableKey is required');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? AND idempotency_key = ?').get(organizationId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowNode(replay);
        }
      }
      const existing = db.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? AND stable_key = ?').get(organizationId, stableKey);
      if (existing) {
        throw orgError('ORGANIZATION_NODE_STABLE_KEY_CONFLICT', `a node with stable_key "${stableKey}" already exists in organization ${organizationId}`);
      }
      db.prepare(`INSERT INTO organization_nodes
        (id, organization_id, stable_key, node_role, created_revision, retired_revision, lifecycle_state, version, grant_json,
         current_session_id, binding_generation, role_instance_id, parent_node_id, depth, session_class, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nodeId, organizationId, stableKey, nodeRole, createdRevision, null, lifecycleState, 1, json(grant, {}),
          currentSessionId || null, Math.max(0, Number(bindingGeneration) || 0), roleInstanceId || null,
          parentNodeId || null, Math.max(0, Number(depth) || 0), sessionClass || null, idempotencyKey || null);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (isUniqueConstraintError(error)) {
        throw orgError('ORGANIZATION_NODE_STABLE_KEY_CONFLICT', `a node with stable_key "${stableKey}" already exists in organization ${organizationId}`);
      }
      throw error;
    }
    return rowNode(db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId));
  }, { mutate: true });
}

export async function retireNode(nodeId, { retiredRevision = 0 } = {}) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId);
    if (!row) return null;
    if (row.lifecycle_state === 'retired') return rowNode(row);
    db.prepare("UPDATE organization_nodes SET lifecycle_state = 'retired', retired_revision = ?, version = version + 1 WHERE id = ?")
      .run(retiredRevision, nodeId);
    return rowNode(db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId));
  }, { mutate: true });
}

export async function getNode(nodeId) {
  return withDatabase((db) => rowNode(db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId)));
}

export async function getNodeByStableKey(organizationId, stableKey) {
  return withDatabase((db) => rowNode(db.prepare(
    'SELECT * FROM organization_nodes WHERE organization_id = ? AND stable_key = ?',
  ).get(organizationId, stableKey)));
}

export async function listOrganizationNodes(organizationId) {
  return withDatabase((db) => db.prepare(
    'SELECT * FROM organization_nodes WHERE organization_id = ? ORDER BY stable_key, id',
  ).all(organizationId).map(rowNode));
}

export async function listOrganizationNodesByStates(organizationId, { lifecycleStates = [], limit = 500 } = {}) {
  const wanted = Array.isArray(lifecycleStates)
    ? [...new Set(lifecycleStates.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
    : [];
  const boundedLimit = Math.max(1, Math.min(5000, Number.isInteger(limit) && limit > 0 ? limit : 500));
  return withDatabase((db) => {
    const rows = wanted.length > 0
      ? db.prepare(`SELECT * FROM organization_nodes WHERE organization_id = ? AND lifecycle_state IN (${wanted.map(() => '?').join(',')}) ORDER BY stable_key, id LIMIT ?`).all(organizationId, ...wanted, boundedLimit)
      : db.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? ORDER BY stable_key, id LIMIT ?').all(organizationId, boundedLimit);
    return rows.map(rowNode);
  });
}

export async function bindNodeSession(nodeId, {
  expectedBindingGeneration,
  sessionId,
  roleInstanceId = undefined,
  rebindCommandId = '',
} = {}) {
  if (!nodeId || !sessionId) throw orgError('BAD_REQUEST', 'nodeId and sessionId are required');
  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId);
      if (!current) throw orgError('ORGANIZATION_NODE_NOT_FOUND', `node ${nodeId} not found`);
      const hasRebindTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_node_rebind_operations'").get();
      if (hasRebindTable && db.prepare("SELECT 1 FROM organization_node_rebind_operations WHERE organization_id=? AND node_id=? AND state='pending' AND command_id<>? LIMIT 1").get(current.organization_id,nodeId,rebindCommandId || '')) throw orgError('ORG_OPERATION_CONFLICT', 'Another node replacement is pending');
      if (rebindCommandId) {
        const operation = db.prepare("SELECT * FROM organization_node_rebind_operations WHERE command_id=? AND organization_id=? AND node_id=? AND state='pending'").get(rebindCommandId,current.organization_id,nodeId);
        const org = db.prepare('SELECT state FROM organizations WHERE id=?').get(current.organization_id);
        if (!operation || ['archived','lifecycle_pending'].includes(org?.state) || operation.expected_generation !== expectedBindingGeneration || operation.old_session_id !== current.current_session_id) throw orgError('ORG_OPERATION_CONFLICT', 'Node replacement operation is no longer pending');
      }
      if (rebindCommandId || (current.current_session_id && current.current_session_id !== sessionId)) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_run_admissions'").get() && db.prepare("SELECT 1 FROM organization_run_admissions WHERE organization_id=? AND node_id=? AND state NOT IN ('resolved','unpublished') LIMIT 1").get(current.organization_id,nodeId)) throw orgError('ORG_OPERATION_CONFLICT', 'Node has an unresolved Run admission');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_execution_bindings'").get() && db.prepare("SELECT 1 FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? AND w.assignee_node_id=? AND b.status IN ('intent','running','unknown') LIMIT 1").get(current.organization_id,nodeId)) throw orgError('ORG_OPERATION_CONFLICT', 'Node has active or unknown Factory execution');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_attempts'").get() && db.prepare("SELECT 1 FROM collaboration_attempts WHERE session_id=? AND (state NOT IN ('succeeded','failed','cancelled') OR (state='failed' AND failure_kind='unknown_outcome')) LIMIT 1").get(current.current_session_id)) throw orgError('ORG_OPERATION_CONFLICT', 'Node has active or unknown collaboration attempt');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_attempts'").get() && db.prepare(`SELECT 1 FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id JOIN collaborations c ON c.id=t.collaboration_id
          WHERE json_valid(c.policy_json) AND json_extract(c.policy_json,'$.organizationId')=? AND json_extract(c.policy_json,'$.organizationNodeId')=?
          AND (a.state NOT IN ('succeeded','failed','cancelled') OR (a.state='failed' AND a.failure_kind='unknown_outcome')) LIMIT 1`).get(current.organization_id,nodeId)) throw orgError('ORG_OPERATION_CONFLICT', 'Node has active or unknown managed collaboration attempt');
      }
      if (expectedBindingGeneration !== undefined
        && Number(expectedBindingGeneration) !== Number(current.binding_generation || 0)) {
        throw orgError('ORG_OPERATION_CONFLICT', `node ${nodeId} binding generation is ${current.binding_generation}, expected ${expectedBindingGeneration}`);
      }
      const nextGeneration = Number(current.binding_generation || 0) + 1;
      db.prepare(`UPDATE organization_nodes
        SET current_session_id = ?, binding_generation = ?, role_instance_id = COALESCE(?, role_instance_id), version = version + 1
        WHERE id = ? AND binding_generation = ?`)
        .run(sessionId, nextGeneration, roleInstanceId === undefined ? null : (roleInstanceId || null), nodeId, current.binding_generation || 0);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) {
        throw orgError('ORG_OPERATION_CONFLICT', `node ${nodeId} binding changed concurrently`);
      }
      db.exec('COMMIT');
      return rowNode(db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

export async function createRoleInstance({
  id: roleInstanceId = id('role'),
  organizationId,
  organizationRevision,
  organizationNodeId = '',
  stableKey,
  role,
  agentId,
  capabilityProfile = {},
  policy = {},
  budget = {},
  lifecycleState = 'active',
  idempotencyKey = '',
} = {}) {
  if (!organizationId || !stableKey || !role || !agentId) {
    throw orgError('BAD_REQUEST', 'organizationId, stableKey, role and agentId are required');
  }
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM role_instances WHERE organization_id = ? AND idempotency_key = ?').get(organizationId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowRoleInstance(replay);
        }
      }
      const existing = db.prepare('SELECT * FROM role_instances WHERE organization_id = ? AND stable_key = ?').get(organizationId, stableKey);
      if (existing) {
        if (existing.agent_id === agentId && existing.organization_revision === organizationRevision) {
          db.exec('COMMIT');
          return rowRoleInstance(existing);
        }
        throw orgError('ORG_OPERATION_CONFLICT', `role instance stable key ${stableKey} already exists`);
      }
      const timestamp = nowIso();
      db.prepare(`INSERT INTO role_instances
        (id, organization_id, organization_revision, organization_node_id, stable_key, role, agent_id,
         capability_profile_json, policy_json, budget_json, lifecycle_state, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(roleInstanceId, organizationId, organizationRevision, organizationNodeId || null, stableKey, role, agentId,
          json(capabilityProfile, {}), json(policy, {}), json(budget, {}), lifecycleState, idempotencyKey || null, timestamp, timestamp);
      db.exec('COMMIT');
      return rowRoleInstance(db.prepare('SELECT * FROM role_instances WHERE id = ?').get(roleInstanceId));
    } catch (error) {
      db.exec('ROLLBACK');
      if (isUniqueConstraintError(error)) throw orgError('ORG_OPERATION_CONFLICT', `role instance ${stableKey} conflicts with an existing fact`);
      throw error;
    }
  }, { mutate: true });
}

export async function getRoleInstance(roleInstanceId) {
  return withDatabase((db) => rowRoleInstance(db.prepare('SELECT * FROM role_instances WHERE id = ?').get(roleInstanceId)));
}

export async function bindRoleInstanceNode(roleInstanceId, organizationNodeId) {
  if (!roleInstanceId || !organizationNodeId) throw orgError('BAD_REQUEST', 'roleInstanceId and organizationNodeId are required');
  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM role_instances WHERE id = ?').get(roleInstanceId);
      if (!current) throw orgError('ORGANIZATION_ROLE_INSTANCE_NOT_FOUND', `role instance ${roleInstanceId} not found`);
      const node = db.prepare('SELECT id, organization_id FROM organization_nodes WHERE id = ?').get(organizationNodeId);
      if (!node || node.organization_id !== current.organization_id) {
        throw orgError('ORGANIZATION_NODE_NOT_FOUND', `node ${organizationNodeId} does not belong to the role instance organization`);
      }
      if (current.organization_node_id && current.organization_node_id !== organizationNodeId) {
        throw orgError('ORG_OPERATION_CONFLICT', `role instance ${roleInstanceId} is already bound to another node`);
      }
      db.prepare(`UPDATE role_instances SET organization_node_id = ?, updated_at = ?
        WHERE id = ? AND (organization_node_id IS NULL OR organization_node_id = ?)`)
        .run(organizationNodeId, nowIso(), roleInstanceId, organizationNodeId);
      if (db.prepare('SELECT changes() AS changes').get().changes !== 1) {
        throw orgError('ORG_OPERATION_CONFLICT', `role instance ${roleInstanceId} binding changed concurrently`);
      }
      db.exec('COMMIT');
      return rowRoleInstance(db.prepare('SELECT * FROM role_instances WHERE id = ?').get(roleInstanceId));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }, { mutate: true });
}

export async function listRoleInstances(organizationId, { revision = null } = {}) {
  return withDatabase((db) => {
    const rows = revision === null || revision === undefined
      ? db.prepare('SELECT * FROM role_instances WHERE organization_id = ? ORDER BY organization_revision, stable_key, id').all(organizationId)
      : db.prepare('SELECT * FROM role_instances WHERE organization_id = ? AND organization_revision = ? ORDER BY stable_key, id').all(organizationId, revision);
    return rows.map(rowRoleInstance);
  });
}

export async function createDelegationGrant({
  id: grantId = id('dgrant'),
  organizationId,
  organizationRevision,
  parentNodeId,
  childNodeId = '',
  roleInstanceId = '',
  generation = 1,
  allowedCapabilities = [],
  scope = {},
  accessMode = 'read_only',
  executionIsolation = 'shared',
  maxDepth = 3,
  maxChildren = 16,
  maxConcurrent = 4,
  canDelegate = false,
  lifecycleState = 'active',
  idempotencyKey = '',
} = {}) {
  if (!organizationId || !parentNodeId) throw orgError('BAD_REQUEST', 'organizationId and parentNodeId are required');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM delegation_grants WHERE organization_id = ? AND idempotency_key = ?').get(organizationId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowDelegationGrant(replay);
        }
      }
      const timestamp = nowIso();
      db.prepare(`INSERT INTO delegation_grants
        (id, organization_id, organization_revision, parent_node_id, child_node_id, role_instance_id, generation,
         allowed_capabilities_json, scope_json, access_mode, execution_isolation, max_depth, max_children,
         max_concurrent, can_delegate, lifecycle_state, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(grantId, organizationId, organizationRevision, parentNodeId, childNodeId || null, roleInstanceId || null, generation,
          json(allowedCapabilities, []), json(scope, {}), accessMode, executionIsolation, maxDepth, maxChildren,
          maxConcurrent, canDelegate ? 1 : 0, lifecycleState, idempotencyKey || null, timestamp);
      db.exec('COMMIT');
      return rowDelegationGrant(db.prepare('SELECT * FROM delegation_grants WHERE id = ?').get(grantId));
    } catch (error) {
      db.exec('ROLLBACK');
      if (isUniqueConstraintError(error)) throw orgError('ORG_OPERATION_CONFLICT', `delegation grant conflicts with an existing fact`);
      throw error;
    }
  }, { mutate: true });
}

export async function getDelegationGrant(grantId) {
  return withDatabase((db) => rowDelegationGrant(db.prepare('SELECT * FROM delegation_grants WHERE id = ?').get(grantId)));
}

export async function listDelegationGrants(organizationId, { parentNodeId = '', revision = null } = {}) {
  return withDatabase((db) => {
    const clauses = ['organization_id = ?'];
    const params = [organizationId];
    if (parentNodeId) { clauses.push('parent_node_id = ?'); params.push(parentNodeId); }
    if (revision !== null && revision !== undefined) { clauses.push('organization_revision = ?'); params.push(revision); }
    return db.prepare(`SELECT * FROM delegation_grants WHERE ${clauses.join(' AND ')} ORDER BY organization_revision, generation, id`)
      .all(...params).map(rowDelegationGrant);
  });
}

export async function createOrganizationEdge({
  id: edgeId = id('edge'),
  organizationId,
  organizationRevision,
  stableKey,
  edgeType = 'MANAGES',
  parentNodeId,
  childNodeId,
  idempotencyKey = '',
} = {}) {
  if (!organizationId || !stableKey || !parentNodeId || !childNodeId) {
    throw orgError('BAD_REQUEST', 'organizationId, stableKey, parentNodeId and childNodeId are required');
  }
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const replay = db.prepare('SELECT * FROM organization_edges WHERE organization_id = ? AND idempotency_key = ?').get(organizationId, idempotencyKey);
        if (replay) {
          db.exec('COMMIT');
          return rowOrganizationEdge(replay);
        }
      }
      const existing = db.prepare('SELECT * FROM organization_edges WHERE organization_id = ? AND stable_key = ?').get(organizationId, stableKey);
      if (existing) {
        if (existing.parent_node_id === parentNodeId && existing.child_node_id === childNodeId && existing.edge_type === edgeType) {
          db.exec('COMMIT');
          return rowOrganizationEdge(existing);
        }
        throw orgError('ORG_OPERATION_CONFLICT', `organization edge ${stableKey} conflicts with an existing fact`);
      }
      db.prepare(`INSERT INTO organization_edges
        (id, organization_id, organization_revision, stable_key, edge_type, parent_node_id, child_node_id, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(edgeId, organizationId, organizationRevision, stableKey, edgeType, parentNodeId, childNodeId, idempotencyKey || null, nowIso());
      db.exec('COMMIT');
      return rowOrganizationEdge(db.prepare('SELECT * FROM organization_edges WHERE id = ?').get(edgeId));
    } catch (error) {
      db.exec('ROLLBACK');
      if (isUniqueConstraintError(error)) throw orgError('ORG_OPERATION_CONFLICT', `organization edge ${stableKey} conflicts with an existing fact`);
      throw error;
    }
  }, { mutate: true });
}

export async function listOrganizationEdges(organizationId, { revision = null } = {}) {
  return withDatabase((db) => {
    const rows = revision === null || revision === undefined
      ? db.prepare('SELECT * FROM organization_edges WHERE organization_id = ? ORDER BY organization_revision, stable_key, id').all(organizationId)
      : db.prepare('SELECT * FROM organization_edges WHERE organization_id = ? AND organization_revision = ? ORDER BY stable_key, id').all(organizationId, revision);
    return rows.map(rowOrganizationEdge);
  });
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

// Materialize only the capabilities already derived from a frozen revision.
// Existing ledger entries, including revocations, are never overwritten by a
// provisioning replay.
export async function materializeFrozenNodeGrants({ organizationId, nodeId, revision, expectedGrant } = {}) {
  return withDatabase(db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
      const node = db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId, organizationId);
      const frozen = db.prepare('SELECT state FROM organization_revisions WHERE organization_id=? AND revision=?').get(organizationId, revision);
      if (!org || !node || frozen?.state !== 'frozen' || org.current_revision !== revision
          || node.created_revision !== revision || node.retired_revision !== null || node.lifecycle_state !== 'active') {
        throw orgError('ORG_OPERATION_CONFLICT', 'Frozen node authority changed');
      }
      const grant = parseJson(node.grant_json, null);
      if (!grant || JSON.stringify(grant) !== JSON.stringify(expectedGrant) || !Array.isArray(grant.allowedCapabilities)) {
        throw orgError('ORG_OPERATION_CONFLICT', 'Frozen node grant differs from provisioned authority');
      }
      const valid = new Set(['read', 'write', 'manage', 'review', 'aggregate', 'input', 'run']);
      const capabilities = [...new Set(grant.allowedCapabilities)];
      if (capabilities.some(capability => typeof capability !== 'string' || !valid.has(capability))) throw orgError('BAD_REQUEST', 'Invalid frozen capability');
      for (const capability of capabilities) {
        const prior = db.prepare('SELECT id FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? LIMIT 1')
          .get(organizationId, nodeId, capability, revision);
        if (prior) continue;
        const scope = { ...(org.project_id ? { projectId: org.project_id } : {}),
          ...(capability === 'write' ? { writablePaths: Array.isArray(grant.writablePaths) ? grant.writablePaths : [] } : {}) };
        db.prepare('INSERT INTO organization_grants (id,organization_id,node_id,revision,capability,allow,scope_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(id('grant'), organizationId, nodeId, revision, capability, 1, json(scope, {}), nowIso());
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate: true });
}

export async function createGrant({
  id: grantId = id('grant'),
  organizationId,
  nodeId,
  revision = 0,
  capability,
  allow = true,
  scope = {},
} = {}) {
  if (!organizationId) throw orgError('BAD_REQUEST', 'organizationId is required');
  if (!nodeId) throw orgError('BAD_REQUEST', 'nodeId is required');
  if (!capability) throw orgError('BAD_REQUEST', 'capability is required');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    const node = db.prepare('SELECT id FROM organization_nodes WHERE id = ? AND organization_id = ?').get(nodeId, organizationId);
    if (!node) throw orgError('ORGANIZATION_NODE_NOT_FOUND', `node ${nodeId} does not belong to organization ${organizationId}`);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO organization_grants
      (id, organization_id, node_id, revision, capability, allow, scope_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(grantId, organizationId, nodeId, revision, capability, allow ? 1 : 0, json(scope, {}), timestamp);
    return rowGrant(db.prepare('SELECT * FROM organization_grants WHERE id = ?').get(grantId));
  }, { mutate: true });
}

// Grants recorded at a revision are effective for the node at that revision and
// every later one (accumulated capability grants, in line with "按 (node_id,
// revision) 生效"). allow=false rows carry the revoke signal for S9 to apply.
export async function effectiveGrantsForNode(nodeId, revision) {
  return withDatabase((db) => db.prepare('SELECT * FROM organization_grants WHERE node_id = ? AND revision <= ? ORDER BY revision, id')
    .all(nodeId, revision).map(rowGrant));
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export async function createGate({
  id: gateId = id('gate'),
  organizationId,
  phaseId,
  generation,
  state = 'open',
  decision = null,
  decidedByNodeId = '',
  decidedAt = '',
  packetId = '',
} = {}) {
  if (!organizationId) throw orgError('BAD_REQUEST', 'organizationId is required');
  if (!phaseId) throw orgError('BAD_REQUEST', 'phaseId is required');
  if (!Number.isInteger(generation) || generation < 1) throw orgError('BAD_REQUEST', 'generation must be a positive integer');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO organization_gates
      (id, organization_id, phase_id, generation, state, decision_json, decided_by_node_id, decided_at, packet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(gateId, organizationId, phaseId, generation, state,
        decision !== null ? json(decision, null) : null, decidedByNodeId || null, decidedAt || null, packetId || null);
    return rowGate(db.prepare('SELECT * FROM organization_gates WHERE id = ?').get(gateId));
  }, { mutate: true });
}

// Without a generation argument, returns the latest gate for the phase.
export async function getGate(organizationId, phaseId, generation = null) {
  return withDatabase((db) => {
    const row = generation === null || generation === undefined
      ? db.prepare('SELECT * FROM organization_gates WHERE organization_id = ? AND phase_id = ? ORDER BY generation DESC LIMIT 1').get(organizationId, phaseId)
      : db.prepare('SELECT * FROM organization_gates WHERE organization_id = ? AND phase_id = ? AND generation = ?').get(organizationId, phaseId, generation);
    return rowGate(row);
  });
}

// Gate generations are immutable and advance one at a time (constitution §2.14):
// each decision creates a fresh generation with a CAS on the current generation.
export async function advanceGateGeneration(organizationId, phaseId, {
  fromGeneration = 0,
  state = 'decided',
  decision = null,
  decidedByNodeId = '',
  packetId = '',
  decidedAt = '',
} = {}) {
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const latest = db.prepare('SELECT generation FROM organization_gates WHERE organization_id = ? AND phase_id = ? ORDER BY generation DESC LIMIT 1').get(organizationId, phaseId);
      const currentGeneration = latest ? latest.generation : 0;
      if (currentGeneration !== fromGeneration) {
        throw orgError('GATE_STALE_GENERATION', `gate generation for ${organizationId}/${phaseId} is ${currentGeneration}, expected ${fromGeneration}`);
      }
      const nextGeneration = currentGeneration + 1;
      db.prepare(`INSERT INTO organization_gates
        (id, organization_id, phase_id, generation, state, decision_json, decided_by_node_id, decided_at, packet_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id('gate'), organizationId, phaseId, nextGeneration, state,
          decision !== null ? json(decision, null) : null, decidedByNodeId || null, decidedAt || timestamp, packetId || null);
      db.exec('COMMIT');
      return rowGate(db.prepare('SELECT * FROM organization_gates WHERE organization_id = ? AND phase_id = ? AND generation = ?').get(organizationId, phaseId, nextGeneration));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export async function createEnvelope({
  id: envelopeId = id('envelope'),
  organizationId,
  nodeId = '',
  revision = 0,
  phaseId = '',
  attemptId = '',
  packetId = '',
  agentReport = {},
} = {}) {
  if (!organizationId) throw orgError('BAD_REQUEST', 'organizationId is required');
  return withDatabase((db) => {
    requireOrganization(db, organizationId);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO organization_envelopes
      (id, organization_id, node_id, revision, phase_id, attempt_id, packet_id, agent_report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelopeId, organizationId, nodeId || null, revision, phaseId || null, attemptId || null, packetId || null, json(agentReport, {}), timestamp);
    return rowEnvelope(db.prepare('SELECT * FROM organization_envelopes WHERE id = ?').get(envelopeId));
  }, { mutate: true });
}

export async function getEnvelope(envelopeId) {
  return withDatabase((db) => rowEnvelope(db.prepare('SELECT * FROM organization_envelopes WHERE id = ?').get(envelopeId)));
}

export async function listOrganizationGates(organizationId, { openOnly = false } = {}) {
  return withDatabase((db) => {
    const sql = openOnly
      ? "SELECT * FROM organization_gates WHERE organization_id = ? AND state NOT IN ('decided', 'completed', 'cancelled') ORDER BY phase_id, generation"
      : 'SELECT * FROM organization_gates WHERE organization_id = ? ORDER BY phase_id, generation';
    return db.prepare(sql).all(organizationId).map(rowGate);
  });
}

// ---------------------------------------------------------------------------
// Shadow projection (read-only, gated by ORG_SHADOW_PROJECTION)
// ---------------------------------------------------------------------------

// When ORG_SHADOW_PROJECTION=1, project a read-only summary of the
// organization, its current frozen revision and its node roster into Session
// JSON. Never the authority: S9+ only consumes this as a compatible projection.
export async function projectOrganizationShadow(organizationId) {
  if (!ORG_SHADOW_PROJECTION) return null;
  return withDatabase((db) => {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    if (!org) return null;
    const revision = org.current_revision
      ? rowRevision(db.prepare('SELECT * FROM organization_revisions WHERE organization_id = ? AND revision = ?').get(organizationId, org.current_revision))
      : null;
    const nodes = db.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? ORDER BY created_revision, id').all(organizationId).map((row) => {
      const node = rowNode(row);
      return {
        id: node.id,
        stableKey: node.stableKey,
        nodeRole: node.nodeRole,
        lifecycleState: node.lifecycleState,
        version: node.version,
      };
    });
    return {
      organizationId: org.id,
      projectId: org.project_id || '',
      rootSessionId: org.root_session_id,
      state: org.state,
      currentRevision: org.current_revision,
      progressEpoch: org.progress_epoch,
      version: org.version,
      revision,
      nodes,
    };
  });
}

function isUniqueConstraintError(error) {
  return error && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed');
}
