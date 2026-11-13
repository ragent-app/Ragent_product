import { withDatabase } from './collaboration-store.mjs';
import { createHash } from 'node:crypto';

const lifecycleError = (message, statusCode = 409) => Object.assign(new Error(message), { code: 'ORG_LIFECYCLE_CONFLICT', statusCode });
function lifecycleSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_lifecycle_operations (
    command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, kind TEXT NOT NULL, payload_digest TEXT NOT NULL,
    prior_state TEXT NOT NULL, expected_revision INTEGER NOT NULL, target_root_session_id TEXT,
    binding_snapshot TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_org_lifecycle_pending ON organization_lifecycle_operations(organization_id) WHERE state='pending';
  CREATE TABLE IF NOT EXISTS organization_root_binding_history (
    organization_id TEXT NOT NULL, root_session_id TEXT NOT NULL, generation INTEGER NOT NULL, command_id TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(organization_id,generation)
  );
  CREATE TABLE IF NOT EXISTS organization_node_rebind_operations (
    command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, node_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    expected_generation INTEGER NOT NULL, old_session_id TEXT, state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  if (!db.prepare('PRAGMA table_info(organization_lifecycle_operations)').all().some(c => c.name === 'actor_id')) db.exec('ALTER TABLE organization_lifecycle_operations ADD COLUMN actor_id TEXT');
}
export async function beginNodeRebind({ organizationId,nodeId,commandId,actorId,expectedGeneration }) {
  if (!organizationId || !nodeId || !commandId || commandId.length > 120 || !actorId || !Number.isInteger(expectedGeneration) || expectedGeneration < 0) throw lifecycleError('Invalid node rebind request',400);
  return withDatabase(db => {
    lifecycleSchema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const old=db.prepare('SELECT * FROM organization_node_rebind_operations WHERE command_id=?').get(commandId);
      if (old) { if (old.organization_id!==organizationId || old.node_id!==nodeId || old.actor_id!==actorId || old.expected_generation!==expectedGeneration) throw lifecycleError('Command ID belongs to another request'); db.exec('COMMIT'); return {state:old.state,oldSessionId:old.old_session_id,result:old.result_json ? JSON.parse(old.result_json) : null,replayed:true}; }
      const org=db.prepare('SELECT state FROM organizations WHERE id=?').get(organizationId);
      const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId);
      if (!org || !node) throw lifecycleError('Organization or node not found',404);
      if (['archived','lifecycle_pending'].includes(org.state) || node.retired_revision !== null || node.binding_generation !== expectedGeneration) throw lifecycleError('Organization or node binding changed');
      const ts=new Date().toISOString();
      db.prepare('INSERT INTO organization_node_rebind_operations VALUES (?,?,?,?,?,?,?,?,?,?)').run(commandId,organizationId,nodeId,actorId,expectedGeneration,node.current_session_id,'pending',null,ts,ts);
      db.exec('COMMIT'); return {state:'pending',oldSessionId:node.current_session_id};
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate:true });
}
export async function finishNodeRebind({ organizationId,nodeId,commandId,result }) {
  return withDatabase(db => {
    lifecycleSchema(db); const op=db.prepare('SELECT * FROM organization_node_rebind_operations WHERE command_id=? AND organization_id=? AND node_id=?').get(commandId,organizationId,nodeId);
    if (!op) throw lifecycleError('Node rebind operation not found',404);
    if (op.state==='completed') return {commandId,state:'completed',result:JSON.parse(op.result_json),replayed:true};
    if (op.state!=='pending') throw lifecycleError('Node rebind was cancelled');
    const node=db.prepare('SELECT current_session_id,binding_generation FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId);
    if (!node || node.current_session_id!==result.sessionId || node.binding_generation!==op.expected_generation+1) throw lifecycleError('Replacement binding is not confirmed');
    db.prepare("UPDATE organization_node_rebind_operations SET state='completed',result_json=?,updated_at=? WHERE command_id=? AND state='pending'").run(JSON.stringify(result),new Date().toISOString(),commandId);
    return {commandId,state:'completed',result};
  }, { mutate:true });
}
export async function cancelNodeRebind({ organizationId,nodeId,commandId }) {
  return withDatabase(db => {
    lifecycleSchema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const op=db.prepare('SELECT * FROM organization_node_rebind_operations WHERE command_id=? AND organization_id=? AND node_id=?').get(commandId,organizationId,nodeId);
      if (!op) throw lifecycleError('Node rebind operation not found',404);
      if (op.state==='cancelled') { db.exec('COMMIT'); return {commandId,state:'cancelled',replayed:true}; }
      if (op.state!=='pending') throw lifecycleError('Completed node rebind cannot be cancelled');
      const node=db.prepare('SELECT current_session_id,binding_generation FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId);
      if (!node || node.binding_generation!==op.expected_generation || node.current_session_id!==op.old_session_id) throw lifecycleError('Binding changed; reconcile the pending operation first');
      db.prepare("UPDATE organization_node_rebind_operations SET state='cancelled',updated_at=? WHERE command_id=?").run(new Date().toISOString(),commandId);
      db.exec('COMMIT'); return {commandId,state:'cancelled'};
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, {mutate:true});
}
function snapshotBindings(db, organizationId) {
  return db.prepare('SELECT id,current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE organization_id=? ORDER BY id').all(organizationId);
}
const exists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export async function beginOrganizationLifecycle({ organizationId, commandId, kind, expectedVersion, targetRootSessionId = '', actorId }) {
  if (!organizationId || !commandId || commandId.length > 255 || !actorId || !['archive','rebind_root'].includes(kind) || !Number.isInteger(expectedVersion) || (kind === 'rebind_root' && !targetRootSessionId)) throw lifecycleError('Invalid lifecycle request',400);
  const payloadDigest = createHash('sha256').update(JSON.stringify({ organizationId,kind,expectedVersion,targetRootSessionId,actorId })).digest('hex');
  return withDatabase(db => {
    lifecycleSchema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM organization_lifecycle_operations WHERE command_id=?').get(commandId);
      if (replay) { if (replay.payload_digest !== payloadDigest) throw lifecycleError('Command ID belongs to a different request'); db.exec('COMMIT'); return { commandId,state:replay.state,result:replay.result_json ? JSON.parse(replay.result_json) : null,replayed:true }; }
      const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
      if (!org) throw lifecycleError('Organization not found',404);
      if (org.state === 'archived' || org.state === 'lifecycle_pending' || org.version !== expectedVersion) throw lifecycleError('Organization state or version changed');
      if (kind === 'rebind_root' && (targetRootSessionId === org.root_session_id || db.prepare('SELECT 1 FROM organizations WHERE root_session_id=?').get(targetRootSessionId))) throw lifecycleError('Target root session is already bound');
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO organization_lifecycle_operations(command_id,organization_id,kind,payload_digest,prior_state,expected_revision,target_root_session_id,binding_snapshot,state,result_json,created_at,updated_at,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(commandId,organizationId,kind,payloadDigest,org.state,org.current_revision,targetRootSessionId || null,JSON.stringify(snapshotBindings(db,organizationId)),'pending',null,ts,ts,actorId);
      db.prepare("UPDATE organizations SET state='lifecycle_pending',version=version+1,updated_at=? WHERE id=? AND version=?").run(ts,organizationId,expectedVersion);
      db.exec('COMMIT'); return { commandId,state:'pending',organizationId,kind };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate:true });
}
export async function getOrganizationLifecycle(commandId) {
  return withDatabase(db => { lifecycleSchema(db); const op=db.prepare('SELECT * FROM organization_lifecycle_operations WHERE command_id=?').get(commandId); if (!op) throw lifecycleError('Lifecycle operation not found',404); return { commandId:op.command_id,organizationId:op.organization_id,kind:op.kind,state:op.state,targetRootSessionId:op.target_root_session_id,result:op.result_json ? JSON.parse(op.result_json) : null }; });
}
export async function getOrganizationLifecycleInfo(organizationId) {
  return withDatabase(db => {
    lifecycleSchema(db);
    const org=db.prepare('SELECT id,state,version,current_revision,root_session_id FROM organizations WHERE id=?').get(organizationId);
    if (!org) throw lifecycleError('Organization not found',404);
    const op=db.prepare("SELECT command_id,kind,state,target_root_session_id FROM organization_lifecycle_operations WHERE organization_id=? AND state='pending'").get(organizationId);
    const nodeRebinds=db.prepare("SELECT command_id,node_id,expected_generation FROM organization_node_rebind_operations WHERE organization_id=? AND state='pending' ORDER BY created_at").all(organizationId);
    const nodes=db.prepare('SELECT id,stable_key,current_session_id,binding_generation FROM organization_nodes WHERE organization_id=? AND retired_revision IS NULL ORDER BY stable_key,id').all(organizationId);
    return {organizationId,state:org.state,version:org.version,revision:org.current_revision,rootSessionId:org.root_session_id,
      pending:op ? {commandId:op.command_id,kind:op.kind,state:op.state,targetRootSessionId:op.target_root_session_id} : null,
      pendingNodeRebinds:nodeRebinds.map(row=>({commandId:row.command_id,nodeId:row.node_id,expectedGeneration:row.expected_generation})),
      nodes:nodes.map(row=>({nodeId:row.id,stableKey:row.stable_key,sessionId:row.current_session_id,bindingGeneration:row.binding_generation}))};
  });
}
export async function getOrganizationLifecycleSessionSnapshot(organizationId) {
  return withDatabase(db => {
    const org=db.prepare('SELECT id,project_id,root_session_id FROM organizations WHERE id=?').get(organizationId);
    if (!org) throw lifecycleError('Organization not found',404);
    const ids=db.prepare('SELECT current_session_id FROM organization_nodes WHERE organization_id=? AND retired_revision IS NULL AND current_session_id IS NOT NULL').all(organizationId).map(r=>r.current_session_id);
    return { projectId:org.project_id || '', sessionIds:[...new Set([org.root_session_id,...ids].filter(Boolean))] };
  });
}
export async function finishOrganizationLifecycle({ organizationId, commandId, cancel = false, sessionFacts = null }) {
  return withDatabase(db => {
    lifecycleSchema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const op=db.prepare('SELECT * FROM organization_lifecycle_operations WHERE command_id=? AND organization_id=?').get(commandId,organizationId);
      if (!op) throw lifecycleError('Lifecycle operation not found',404);
      if (op.state !== 'pending') { db.exec('COMMIT'); return {commandId,state:op.state,result:op.result_json ? JSON.parse(op.result_json) : null,replayed:true}; }
      const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
      if (!org || org.state !== 'lifecycle_pending') throw lifecycleError('Organization transition state changed');
      if (cancel) {
        const result={organizationId,state:op.prior_state}; const ts=new Date().toISOString();
        db.prepare('UPDATE organizations SET state=?,version=version+1,updated_at=? WHERE id=?').run(op.prior_state,ts,organizationId);
        db.prepare("UPDATE organization_lifecycle_operations SET state='cancelled',result_json=?,updated_at=? WHERE command_id=?").run(JSON.stringify(result),ts,commandId);
        db.exec('COMMIT'); return {commandId,state:'cancelled',result};
      }
      if (org.current_revision !== op.expected_revision || JSON.stringify(snapshotBindings(db,organizationId)) !== op.binding_snapshot) throw lifecycleError('Organization revision or node bindings changed; cancel and review');
      if (!sessionFacts?.checked || sessionFacts.activeSessionIds?.length) throw lifecycleError('Active or unknown session Runs must be resolved before finalizing');
      if (op.kind === 'rebind_root' && (!sessionFacts.targetExists || !sessionFacts.targetProjectMatches)) throw lifecycleError('Target root session is missing or belongs to another project');
      if (exists(db,'organization_operations') && db.prepare("SELECT 1 FROM organization_operations WHERE organization_id=? AND state NOT IN ('completed','failed_terminal') LIMIT 1").get(organizationId)) throw lifecycleError('Organization operations are pending');
      if (db.prepare("SELECT 1 FROM organization_node_rebind_operations WHERE organization_id=? AND state='pending' LIMIT 1").get(organizationId)) throw lifecycleError('Node replacement operations are pending');
      if (exists(db,'factory_execution_bindings') && db.prepare("SELECT 1 FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? AND b.status IN ('intent','running','unknown') LIMIT 1").get(organizationId)) throw lifecycleError('Factory execution is active or unknown');
      if (exists(db,'factory_work_items') && db.prepare("SELECT 1 FROM factory_work_items WHERE organization_id=? AND ownership='active' AND state NOT IN ('completed','cancelled','failed') LIMIT 1").get(organizationId)) throw lifecycleError('Active Factory work must finish or be cancelled');
      if (exists(db,'collaborations') && db.prepare("SELECT 1 FROM collaborations WHERE (root_session_id=? OR (json_valid(policy_json) AND json_extract(policy_json,'$.organizationId')=?)) AND state NOT IN ('completed','cancelled','failed') LIMIT 1").get(org.root_session_id,organizationId)) throw lifecycleError('Collaborations are still active');
      const ts=new Date().toISOString(); let result;
      if (op.kind === 'archive') { db.prepare("UPDATE organizations SET state='archived',version=version+1,updated_at=? WHERE id=?").run(ts,organizationId); result={organizationId,state:'archived'}; }
      else {
        if (db.prepare('SELECT 1 FROM organizations WHERE root_session_id=? AND id<>?').get(op.target_root_session_id,organizationId)) throw lifecycleError('Target root session became bound');
        let generation=Number(db.prepare('SELECT COALESCE(MAX(generation),0) AS generation FROM organization_root_binding_history WHERE organization_id=?').get(organizationId).generation);
        if (!generation) db.prepare('INSERT INTO organization_root_binding_history VALUES (?,?,?,?,?)').run(organizationId,org.root_session_id,++generation,commandId,ts);
        db.prepare('INSERT INTO organization_root_binding_history VALUES (?,?,?,?,?)').run(organizationId,op.target_root_session_id,++generation,commandId,ts);
        db.prepare('UPDATE organizations SET root_session_id=?,state=?,version=version+1,updated_at=? WHERE id=?').run(op.target_root_session_id,op.prior_state,ts,organizationId);
        result={organizationId,state:op.prior_state,oldRootSessionId:org.root_session_id,rootSessionId:op.target_root_session_id,bindingGeneration:generation};
      }
      db.prepare("UPDATE organization_lifecycle_operations SET state='completed',result_json=?,updated_at=? WHERE command_id=?").run(JSON.stringify(result),ts,commandId);
      db.exec('COMMIT'); return {commandId,state:'completed',result};
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate:true });
}

// The organization and its task history outlive a client session. Guard root
// and current node bindings while the organization is live.
export async function getLiveOrganizationSessionReference(sessionId) {
  return withDatabase(db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organizations'").get()) return null;
    const root = db.prepare("SELECT id FROM organizations WHERE root_session_id=? AND state <> 'archived' LIMIT 1").get(sessionId);
    if (root) return { organizationId: root.id, kind: 'root' };
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_nodes'").get()) return null;
    const node = db.prepare(`SELECT n.organization_id,n.id,n.binding_generation,o.current_revision FROM organization_nodes n JOIN organizations o ON o.id=n.organization_id
      WHERE n.current_session_id=? AND n.retired_revision IS NULL AND o.state <> 'archived' LIMIT 1`).get(sessionId);
    return node ? { organizationId: node.organization_id, kind: 'node', nodeId: node.id, bindingGeneration: node.binding_generation, organizationRevision: node.current_revision } : null;
  });
}

// A Factory staging child is recognized only by the durable outbox attempt,
// frozen policy, current work epoch and current managed-node binding.
export async function getFactoryMessageScope(sessionId, requestId) {
  return withDatabase(db => {
    for (const name of ['collaboration_dispatch_commands','factory_work_items','factory_execution_bindings']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return null;
    }
    const rows = db.prepare(`SELECT d.attempt_id,c.policy_json FROM collaboration_dispatch_commands d
      JOIN collaborations c ON c.id=d.collaboration_id JOIN collaboration_attempts a ON a.id=d.attempt_id AND a.task_id=d.task_id
      WHERE d.session_id=? AND (?='' OR d.request_id=?) AND d.state IN ('pending','claimed','completed')`).all(sessionId,requestId || '',requestId || '');
    if (rows.length !== 1) return null;
    let policy; try { policy = JSON.parse(rows[0].policy_json || '{}'); } catch { return null; }
    const f = policy.factoryExecution;
    if (!f || !f.organizationId || !f.workItemId || !f.managedSessionId || !Number.isInteger(f.executionEpoch) || !Number.isInteger(f.bindingGeneration)) return null;
    const row = db.prepare(`SELECT n.id FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id
      JOIN organization_nodes n ON n.id=w.assignee_node_id AND n.organization_id=w.organization_id
      JOIN organizations o ON o.id=w.organization_id
      WHERE w.id=? AND w.organization_id=? AND w.execution_epoch=? AND w.binding_generation=?
        AND b.execution_epoch=w.execution_epoch AND b.binding_generation=w.binding_generation AND b.dispatch_key=?
        AND w.state IN ('claimed','running') AND w.control_state='none' AND b.status IN ('intent','running')
        AND n.current_session_id=? AND n.binding_generation=w.binding_generation AND n.retired_revision IS NULL AND o.state<>'archived' AND o.current_revision=?`).get(f.workItemId,f.organizationId,f.executionEpoch,f.bindingGeneration,f.dispatchKey,f.managedSessionId,f.organizationRevision);
    if (!row) return null;
    return { kind:'organization_message', organizationId:f.organizationId, nodeId:row.id, bindingGeneration:f.bindingGeneration, organizationRevision:f.organizationRevision,
      managedSessionId:f.managedSessionId, workItemId:f.workItemId, executionEpoch:f.executionEpoch, attemptId:rows[0].attempt_id };
  });
}

export async function assertNodeWorkQuiescent(organizationId, nodeId, sessionId) {
  return withDatabase(db => {
    if (exists(db,'factory_work_items') && exists(db,'factory_execution_bindings') && db.prepare(`SELECT 1 FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id WHERE w.organization_id=? AND w.assignee_node_id=? AND b.status IN ('intent','running','unknown') LIMIT 1`).get(organizationId,nodeId)) throw lifecycleError('Node has an active or unknown Factory execution');
    if (exists(db,'collaboration_attempts') && db.prepare("SELECT 1 FROM collaboration_attempts WHERE session_id=? AND (state NOT IN ('succeeded','failed','cancelled') OR (state='failed' AND failure_kind='unknown_outcome')) LIMIT 1").get(sessionId)) throw lifecycleError('Node session has an active or unknown collaboration attempt');
    return true;
  });
}
