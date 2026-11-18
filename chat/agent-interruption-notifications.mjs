import { createHash } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { getRun } from './runs.mjs';
import { getNode, getOrganization } from './organization-store.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';
import { createTrigger, getTrigger, listTriggers } from './triggers.mjs';
import { isAppendOnlyRevisionCompatible } from './organization-revision-compatibility.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const stamp = () => new Date().toISOString();
const nativeId = event => `native:${createHash('sha256').update(JSON.stringify([event.runId,event.memberId,event.id])).digest('hex')}`;
const escalationDelay = () => {
  const value = Number(process.env.RAGENT_INCIDENT_ESCALATION_MS);
  return Number.isInteger(value) && value >= 60000 ? value : 3600000;
};
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_interruption_incidents (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL, node_id TEXT NOT NULL, binding_generation INTEGER,
    organization_revision INTEGER, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL, task_objective TEXT NOT NULL, parent_session_id TEXT NOT NULL,
    parent_node_id TEXT NOT NULL, root_session_id TEXT NOT NULL, category TEXT NOT NULL,
    source TEXT NOT NULL, confidence TEXT NOT NULL, evidence_ref TEXT NOT NULL, side_effects TEXT NOT NULL,
    occurred_at TEXT NOT NULL, trigger_id TEXT NOT NULL DEFAULT '', delivery_state TEXT NOT NULL DEFAULT 'pending',
    acknowledged_at TEXT, resolved_at TEXT, ancestors_json TEXT NOT NULL DEFAULT '[]', escalation_index INTEGER NOT NULL DEFAULT 0,
    escalation_at TEXT, escalation_trigger_id TEXT NOT NULL DEFAULT '', resolution_summary TEXT, resolution_evidence TEXT,
    next_check_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_interruption_audit (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_interruption_reads (
      incident_id TEXT NOT NULL, session_id TEXT NOT NULL, first_read_at TEXT NOT NULL,
      PRIMARY KEY (incident_id, session_id));
    CREATE TABLE IF NOT EXISTS native_member_interruptions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, host_session_id TEXT NOT NULL,
      member_id TEXT NOT NULL, parent_kind TEXT NOT NULL, parent_member_id TEXT NOT NULL,
      provider TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL, occurred_at TEXT NOT NULL,
      organization_id TEXT NOT NULL, node_id TEXT NOT NULL, binding_generation INTEGER,
      organization_revision INTEGER, root_session_id TEXT NOT NULL, trigger_id TEXT NOT NULL DEFAULT '',
      delivery_state TEXT NOT NULL DEFAULT 'pending', next_check_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, acknowledged_at TEXT, resolved_at TEXT, resolution_summary TEXT, resolution_evidence TEXT,
      UNIQUE(run_id,member_id,event_id));
    CREATE INDEX IF NOT EXISTS agent_interruption_pending ON agent_interruption_incidents(delivery_state, resolved_at);`);
  const columns = new Set(db.prepare('PRAGMA table_info(agent_interruption_incidents)').all().map(column => column.name));
  if (!columns.has('reported_code')) db.exec("ALTER TABLE agent_interruption_incidents ADD COLUMN reported_code TEXT NOT NULL DEFAULT ''");
  const nativeColumns = new Set(db.prepare('PRAGMA table_info(native_member_interruptions)').all().map(column => column.name));
  if (!nativeColumns.has('recipient_session_id')) db.exec("ALTER TABLE native_member_interruptions ADD COLUMN recipient_session_id TEXT NOT NULL DEFAULT ''");
}
async function sessionById(id) {
  const { getSession } = await import('./session-manager.mjs');
  return getSession(id);
}

// The caller is the server's provider reconciler, after it has parsed and
// persisted the canonical member event in the host Run spool. A native member
// is never represented as a Ragent Run or independently addressable Session.
export async function observeNativeMemberInterruptions({ runId, events = [] } = {}) {
  const run = await getRun(text(runId));
  if (!run || !text(run.sessionId)) throw Object.assign(new Error('Host Run unavailable'), { code: 'INCIDENT_EVIDENCE_PENDING' });
  const live = await getLiveOrganizationSessionReference(run.sessionId);
  const hostSession = await sessionById(run.sessionId);
  if (!hostSession) throw Object.assign(new Error('Host Session unavailable'), { code: 'INCIDENT_EVIDENCE_PENDING' });
  const organized = !!live?.organizationId && ['root','node'].includes(live.kind);
  if (!organized && (text(hostSession.organizationId) || text(hostSession.organizationNodeId))) throw Object.assign(new Error('Organization binding unavailable'), { code:'INCIDENT_BINDING_PENDING' });
  const org = organized ? await getOrganization(live.organizationId) : null;
  if (organized && (!org || org.state === 'archived')) return { applicable: false };
  let count = 0;
  for (const event of events) {
    if (event?.runId !== run.id || event.rootSessionId !== run.sessionId || event.phase !== 'terminal'
        || !['failed','interrupted','lost'].includes(event.state) || !['codex','claude'].includes(event.sourceTag)
        || !text(event.id) || !text(event.memberId)) continue;
    const parentKind = ['member','root_session'].includes(event.parent?.kind) ? event.parent.kind : 'unknown';
    const parentId = parentKind === 'member' ? text(event.parent.id).slice(0,200) : '';
    const id = nativeId(event), now = stamp();
    count += await withDatabase(db => {
      schema(db); db.exec('BEGIN IMMEDIATE');
      try {
        const currentOrg = organized ? db.prepare('SELECT current_revision,root_session_id,state FROM organizations WHERE id=?').get(live.organizationId) : null;
        const node = organized && live.kind === 'node' ? db.prepare('SELECT current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(live.nodeId,live.organizationId) : null;
        if (organized && (!currentOrg || currentOrg.state === 'archived' || currentOrg.root_session_id !== org.rootSessionId
            || (live.kind === 'root' && currentOrg.root_session_id !== run.sessionId)
            || (live.kind === 'node' && (!node || node.retired_revision !== null || node.current_session_id !== run.sessionId || node.binding_generation !== live.bindingGeneration || currentOrg.current_revision !== live.organizationRevision)))) { db.exec('ROLLBACK'); return 0; }
        const inserted = db.prepare(`INSERT OR IGNORE INTO native_member_interruptions
          (id,run_id,host_session_id,member_id,parent_kind,parent_member_id,provider,event_id,state,occurred_at,organization_id,node_id,binding_generation,organization_revision,root_session_id,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,run.id,run.sessionId,text(event.memberId).slice(0,200),parentKind,parentId,event.sourceTag,text(event.id).slice(0,200),event.state,text(event.timestamp) || now,organized ? live.organizationId : '',organized && live.kind === 'node' ? live.nodeId : '',organized ? live.bindingGeneration ?? null : null,organized ? live.organizationRevision ?? null : null,organized ? org.rootSessionId : run.sessionId,now).changes;
        db.exec('COMMIT'); return inserted;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }, { mutate: true });
  }
  return { applicable: true, inserted: count };
}
async function persistedFactoryScope(sessionId, runId) {
  return withDatabase(db => {
    for (const name of ['factory_work_items','factory_execution_bindings','collaboration_dispatch_commands']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return null;
    }
    const rows = db.prepare(`SELECT a.id AS attempt_id,c.policy_json FROM collaboration_attempts a
      JOIN collaboration_dispatch_commands d ON d.attempt_id=a.id AND d.session_id=a.session_id
      JOIN collaborations c ON c.id=d.collaboration_id
      WHERE a.session_id=? AND a.run_id=? AND d.run_id=?`).all(sessionId,runId,runId);
    if (rows.length !== 1) return null;
    let f; try { f = JSON.parse(rows[0].policy_json || '{}').factoryExecution; } catch { return null; }
    if (!f || !f.organizationId || !f.workItemId || !f.managedSessionId || !Number.isInteger(f.bindingGeneration) || !Number.isInteger(f.organizationRevision)) return null;
    const match = db.prepare(`SELECT n.id FROM factory_work_items w
      JOIN factory_execution_bindings b ON b.work_item_id=w.id
      JOIN organization_nodes n ON n.id=w.assignee_node_id AND n.organization_id=w.organization_id
      JOIN organizations o ON o.id=w.organization_id
      WHERE w.id=? AND w.organization_id=? AND w.execution_epoch=? AND w.binding_generation=?
      AND b.execution_epoch=w.execution_epoch AND b.binding_generation=w.binding_generation AND b.dispatch_key=?
      AND n.current_session_id=? AND n.binding_generation=w.binding_generation AND n.retired_revision IS NULL
      AND o.state<>'archived' AND o.current_revision=?`).get(f.workItemId,f.organizationId,f.executionEpoch,f.bindingGeneration,f.dispatchKey,f.managedSessionId,f.organizationRevision);
    return match ? { kind: 'node', organizationId: f.organizationId, nodeId: match.id, bindingGeneration: f.bindingGeneration,
      organizationRevision: f.organizationRevision, attemptId: rows[0].attempt_id } : null;
  });
}
async function resolveBinding(session, run) {
  let ref = await getLiveOrganizationSessionReference(session.id);
  if (!ref || ref.kind !== 'node') {
    const factory = await getFactoryMessageScope(session.id, text(run.requestId));
    if (factory) ref = { ...factory, kind: 'node' };
    else ref = await persistedFactoryScope(session.id, run.id);
  }
  if (!ref || ref.kind !== 'node') {
    // Generic delegated Sessions are bound by server-created session metadata.
    // Do not fall back from a failed organization lookup to a guessed parent.
    if (text(session.organizationId) || text(session.organizationNodeId)) return null;
    if (text(session.delegatedFromSessionId) && text(session.parentSessionId)
        && text(session.delegatedFromSessionId) !== text(session.parentSessionId)) return null;
    const parentSessionId = text(session.delegatedFromSessionId || session.parentSessionId);
    if (!parentSessionId || parentSessionId === session.id || !await sessionById(parentSessionId)) return null;
    const parentRef = await getLiveOrganizationSessionReference(parentSessionId);
    if (parentRef) {
      const org = await getOrganization(parentRef.organizationId);
      if (!org) return null;
      const ancestors = [];
      const seen = new Set();
      let ancestor = parentRef.kind === 'node' ? await getNode(parentRef.nodeId) : null;
      while (ancestor) {
        if (seen.has(ancestor.id) || ancestor.organizationId !== org.id) return null;
        seen.add(ancestor.id);
        ancestors.push({ sessionId: ancestor.retiredRevision === null ? ancestor.currentSessionId : '', nodeId: ancestor.id, bindingGeneration: ancestor.bindingGeneration });
        const nextId = ancestor.parentNodeId;
        ancestor = nextId ? await getNode(nextId) : null;
        if (nextId && !ancestor) ancestors.push({ sessionId: '', nodeId: nextId, missing: true });
      }
      if (!ancestors.some(item => item.sessionId === org.rootSessionId)) ancestors.push({ sessionId: org.rootSessionId, nodeId: '' });
      if (ancestors[0]?.sessionId !== parentSessionId) return null;
      return { ref: { organizationId: org.id, organizationRevision: org.currentRevision }, node: { id: '' }, org,
        parentSessionId, parentNodeId: parentRef.nodeId || '', ancestors };
    }
    return { ref: {}, node: { id: '' }, org: { rootSessionId: parentSessionId }, parentSessionId, parentNodeId: '', ancestors: [{ sessionId: parentSessionId, nodeId: '' }] };
  }
  const node = await getNode(ref.nodeId);
  const org = await getOrganization(ref.organizationId);
  if (!node || !org || node.organizationId !== ref.organizationId || node.retiredRevision !== null
      || node.bindingGeneration !== ref.bindingGeneration) return null;
  const parent = node.parentNodeId ? await getNode(node.parentNodeId) : null;
  if (parent && parent.organizationId !== node.organizationId) return null;
  if (!node.parentNodeId && text(session.parentSessionId) !== org.rootSessionId && text(session.delegatedFromSessionId) !== org.rootSessionId) return null;
  const parentSessionId = node.parentNodeId ? (parent?.retiredRevision === null ? parent.currentSessionId : '') : org.rootSessionId;
  if (parentSessionId === session.id) return null;
  const ancestors = [];
  const seen = new Set([node.id]);
  if (node.parentNodeId && !parent) ancestors.push({ sessionId: '', nodeId: node.parentNodeId, missing: true });
  for (let ancestor = parent; ancestor;) {
    if (seen.has(ancestor.id) || ancestor.organizationId !== node.organizationId) return null;
    seen.add(ancestor.id);
    ancestors.push({ sessionId: ancestor.retiredRevision === null ? ancestor.currentSessionId : '', nodeId: ancestor.id, bindingGeneration: ancestor.bindingGeneration });
    const nextId = ancestor.parentNodeId;
    ancestor = nextId ? await getNode(nextId) : null;
    if (nextId && !ancestor) ancestors.push({ sessionId: '', nodeId: nextId, missing: true });
  }
  if (!ancestors.some(item => item.sessionId === org.rootSessionId)) ancestors.push({ sessionId: org.rootSessionId, nodeId: '' });
  if (ancestors[0]?.sessionId !== parentSessionId) return null;
  return { ref, node, org, parentSessionId, parentNodeId: node.parentNodeId || '', ancestors };
}

// Called only by the server terminal observer. Reload authoritative facts; do
// not trust a provider's narrative or a caller-supplied parent identity.
export async function observeAgentInterruption({ sessionId, runId } = {}) {
  const run = await getRun(text(runId));
  if (!run || run.id !== text(runId) || run.sessionId !== text(sessionId) || !run.finalizedAt) throw Object.assign(new Error('Finalized Run unavailable'), { code: 'INCIDENT_EVIDENCE_PENDING' });
  if (run.state !== 'failed') return { applicable: false, reason: 'not_failed' };
  const session = await sessionById(run.sessionId);
  if (!session) throw Object.assign(new Error('Run session unavailable'), { code: 'INCIDENT_EVIDENCE_PENDING' });
  if (!text(session.organizationId) && !text(session.organizationNodeId) && !text(session.delegatedFromSessionId) && !text(session.parentSessionId)) return { applicable: false, reason: 'not_delegated' };
  const superseded = await withDatabase(db => {
    schema(db);
    const rows = db.prepare(`SELECT a.attempt_number,t.current_attempt FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id WHERE a.run_id=? AND a.session_id=?`).all(run.id,session.id);
    if (rows.length !== 1 || Number(rows[0].attempt_number) === Number(rows[0].current_attempt)) return false;
    db.prepare('INSERT OR IGNORE INTO agent_interruption_audit VALUES(?,?,?,?)').run(run.id,session.id,'superseded_attempt',stamp());
    return true;
  }, { mutate: true });
  if (superseded) return { applicable: false, reason: 'superseded_attempt' };
  const binding = await resolveBinding(session, run);
  if (!binding) throw Object.assign(new Error('Live relationship evidence unavailable'), { code: 'INCIDENT_BINDING_PENDING' });
  const id = `run:${run.id}`;
  const now = stamp();
  const category = typeof run.result?.signal === 'string' && run.result.signal.trim() ? 'process_signal'
    : Number.isInteger(run.result?.exitCode) && run.result.exitCode !== 0 ? 'process_exit' : 'unknown_outcome';
  // The launch path persists a bounded code separately from its free-form
  // error message. Report it as unverified detail, never as a replay decision.
  const reportedCode = new Set(['REVISION_CONFLICT', 'REQUEST_EXPIRED', 'REQUEST_CANCELLED',
    'RESTRICTED_EXECUTION_UNAVAILABLE', 'RUN_EXECUTION_INPUT_UNAVAILABLE']).has(run.result?.errorCode)
    ? run.result.errorCode : '';
  const saved = await withDatabase(db => {
    schema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
    const attemptRows = db.prepare(`SELECT a.id,a.task_id,a.attempt_number,t.current_attempt,t.objective FROM collaboration_attempts a
      JOIN collaboration_tasks t ON t.id=a.task_id WHERE a.run_id=? AND a.session_id=?`).all(run.id,session.id);
    if (attemptRows.length > 1 || (binding.ref.attemptId && attemptRows[0]?.id !== binding.ref.attemptId)) { db.exec('ROLLBACK'); return false; }
    if (attemptRows.length === 1 && Number(attemptRows[0].attempt_number) !== Number(attemptRows[0].current_attempt)) {
      db.prepare('INSERT OR IGNORE INTO agent_interruption_audit VALUES(?,?,?,?)').run(run.id,session.id,'superseded_attempt',now);
      db.exec('COMMIT'); return 'superseded_attempt';
    }
    if (binding.ref.organizationId) {
      const currentOrg = db.prepare('SELECT root_session_id,current_revision FROM organizations WHERE id=?').get(binding.ref.organizationId);
      const currentNode = binding.node.id ? db.prepare('SELECT binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(binding.node.id,binding.ref.organizationId) : null;
      if (!currentOrg || currentOrg.root_session_id !== binding.org.rootSessionId || currentOrg.current_revision !== binding.ref.organizationRevision
          || (binding.node.id && (!currentNode || currentNode.retired_revision !== null || currentNode.binding_generation !== binding.ref.bindingGeneration))) { db.exec('ROLLBACK'); return false; }
      for (const ancestor of binding.ancestors.filter(item => item.nodeId)) {
        const current = db.prepare('SELECT current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(ancestor.nodeId,binding.ref.organizationId);
        if (ancestor.missing ? !!current : (!current || current.binding_generation !== ancestor.bindingGeneration || (current.retired_revision === null ? current.current_session_id || '' : '') !== ancestor.sessionId)) { db.exec('ROLLBACK'); return false; }
      }
    }
    db.prepare(`INSERT OR IGNORE INTO agent_interruption_incidents
      (id,session_id,run_id,organization_id,node_id,binding_generation,organization_revision,attempt_id,task_id,task_objective,parent_session_id,parent_node_id,root_session_id,category,source,confidence,evidence_ref,side_effects,occurred_at,ancestors_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,session.id,run.id,text(binding.ref.organizationId),binding.node.id,
      binding.ref.bindingGeneration ?? null,binding.ref.organizationRevision ?? null,text(attemptRows[0]?.id),text(attemptRows[0]?.task_id),text(attemptRows[0]?.objective).slice(0,1000),binding.parentSessionId,
      binding.parentNodeId,binding.org.rootSessionId,category,'run_status','authoritative_terminal',`run:${run.id}`,'unknown',text(run.completedAt) || now,JSON.stringify(binding.ancestors),now,now);
    const savedRow = db.prepare('SELECT session_id,run_id FROM agent_interruption_incidents WHERE id=?').get(id);
    if (reportedCode) db.prepare("UPDATE agent_interruption_incidents SET reported_code=? WHERE id=? AND reported_code=''").run(reportedCode,id);
    db.exec('COMMIT');
    return savedRow?.session_id === session.id && savedRow?.run_id === run.id;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }, { mutate: true });
  if (saved === 'superseded_attempt') return { applicable: false, reason: saved };
  if (!saved) throw Object.assign(new Error('Binding changed during observation'), { code: 'INCIDENT_BINDING_PENDING' });
  await reconcileAgentInterruptions();
  return { applicable: true, incidentId: id };
}

// Trigger delivery and incident acknowledgement are separate facts. A trigger
// is durable and deduplicated; repeated sweeps may safely recover an enqueue.
export async function reconcileAgentInterruptions() {
  await reconcileNativeMemberInterruptions();
  const rows = await withDatabase(db => { schema(db); return db.prepare(`SELECT * FROM agent_interruption_incidents
    WHERE resolved_at IS NULL AND next_check_at<=? AND (delivery_state IN ('pending','queued','escalated') OR
      (json_array_length(ancestors_json)>escalation_index+1 AND (delivery_state='unreachable' OR COALESCE(escalation_at,created_at)<=?)))
    ORDER BY next_check_at,created_at LIMIT 100`).all(stamp(),new Date(Date.now() - escalationDelay()).toISOString()); });
  for (const row of rows) {
    try {
      if (!row.trigger_id && Number(row.escalation_index) === 0) {
        const legacy = (await listTriggers({ sessionId: row.parent_session_id })).find(trigger =>
          trigger.dedupeKey === `delegated-child-terminal:${row.parent_session_id}:${row.session_id}`
          && (trigger.pendingEventKey === `run_terminal:${row.run_id}`
            || trigger.deliveredEventKeys?.includes(`run_terminal:${row.run_id}`)));
        if (legacy) {
          const delivery = legacy.deliveredEventKeys?.includes(`run_terminal:${row.run_id}`) ? 'delivered' : 'queued';
          await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET trigger_id=?,delivery_state=?,updated_at=? WHERE id=? AND trigger_id='' AND resolved_at IS NULL").run(legacy.id,delivery,stamp(),row.id); }, { mutate: true });
          continue;
        }
        const liveParent = row.organization_id ? await getLiveOrganizationSessionReference(row.parent_session_id) : null;
        const parentValid = !!row.parent_session_id && !!await sessionById(row.parent_session_id) && (!row.organization_id || (liveParent?.organizationId === row.organization_id
          && (row.parent_node_id ? liveParent.kind === 'node' && liveParent.nodeId === row.parent_node_id && liveParent.bindingGeneration === JSON.parse(row.ancestors_json)[0]?.bindingGeneration : liveParent.kind === 'root')));
        if (!parentValid) {
          await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET delivery_state='unreachable',updated_at=? WHERE id=? AND trigger_id=''").run(stamp(),row.id); }, { mutate: true });
          row.delivery_state = 'unreachable';
        } else {
          const trigger = await createTrigger({ sessionId: row.parent_session_id, scheduledAt: stamp(),
            dedupeKey: `agent-interruption:${row.run_id}`, title: 'A delegated run failed',
            text: `Delegated run ${row.run_id} failed (${row.category}). Review incident ${row.id}; delivery is not acknowledgement or resolution.` });
          await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET trigger_id=?,delivery_state='queued',updated_at=? WHERE id=? AND trigger_id=''").run(trigger.id,stamp(),row.id); }, { mutate: true });
        }
      } else if (Number(row.escalation_index) === 0) {
        const trigger = await getTrigger(row.trigger_id);
        if (trigger?.status === 'delivered') await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET delivery_state='delivered',updated_at=? WHERE id=? AND delivery_state='queued'").run(stamp(),row.id); }, { mutate: true });
        if (['failed','cancelled'].includes(trigger?.status)) {
          await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET delivery_state='unreachable',updated_at=? WHERE id=? AND delivery_state='queued'").run(stamp(),row.id); }, { mutate: true });
          row.delivery_state = 'unreachable';
        }
      }
      if (row.escalation_trigger_id && row.delivery_state === 'escalated') {
        const escalation = await getTrigger(row.escalation_trigger_id);
        if (['failed','cancelled'].includes(escalation?.status)) row.delivery_state = 'unreachable';
        else if (escalation?.status === 'delivered') {
          await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET delivery_state='delivered',updated_at=? WHERE id=? AND escalation_trigger_id=?").run(stamp(),row.id,row.escalation_trigger_id); }, { mutate: true });
        }
      }
      const ancestors = JSON.parse(row.ancestors_json || '[]');
      const nextIndex = Number(row.escalation_index) + 1;
      if (ancestors[nextIndex] && (row.delivery_state === 'unreachable' || Date.now() - Date.parse(row.escalation_at || row.created_at) >= escalationDelay())) {
        const target = ancestors[nextIndex];
        const live = await getLiveOrganizationSessionReference(target.sessionId);
        const valid = live?.organizationId === row.organization_id && (target.nodeId
          ? live.kind === 'node' && live.nodeId === target.nodeId && live.bindingGeneration === target.bindingGeneration
          : live.kind === 'root');
        const trigger = valid ? await createTrigger({ sessionId: target.sessionId, scheduledAt: stamp(),
          dedupeKey: `agent-interruption:${row.run_id}:level:${nextIndex}`, title: 'Delegated failure needs attention',
          text: `Incident ${row.id} remains unresolved. Review the failure and its current state.` }) : null;
        await withDatabase(db => { schema(db); db.prepare("UPDATE agent_interruption_incidents SET escalation_index=?,escalation_at=?,escalation_trigger_id=?,delivery_state=?,updated_at=? WHERE id=? AND escalation_index=? AND resolved_at IS NULL").run(nextIndex,stamp(),trigger?.id || '',valid ? 'escalated' : 'unreachable',stamp(),row.id,row.escalation_index); }, { mutate: true });
      }
    } catch { /* Keep the durable incident pending for the next sweep. */ }
    finally {
      await withDatabase(db => { schema(db); db.prepare('UPDATE agent_interruption_incidents SET next_check_at=? WHERE id=? AND resolved_at IS NULL').run(new Date(Date.now() + 30000).toISOString(),row.id); }, { mutate: true });
    }
  }
}

async function reconcileNativeMemberInterruptions() {
  const rows = await withDatabase(db => { schema(db); return db.prepare("SELECT * FROM native_member_interruptions WHERE resolved_at IS NULL AND next_check_at<=? ORDER BY next_check_at,created_at LIMIT 100").all(stamp()); });
  for (const row of rows) {
    try {
      if (!row.trigger_id) {
        const live = await getLiveOrganizationSessionReference(row.host_session_id);
        const hostValid = !row.organization_id || (live?.organizationId === row.organization_id && (row.node_id
          ? live.kind === 'node' && live.nodeId === row.node_id && live.bindingGeneration === row.binding_generation
          : live.kind === 'root'));
        const recipient = hostValid ? row.host_session_id : row.root_session_id;
        const trigger = await createTrigger({ sessionId: recipient, scheduledAt: stamp(), dedupeKey: `${row.id}:host`,
          title: 'Native member interrupted', text: `A ${row.provider} member ${row.member_id} reported ${row.state}. Native parent: ${row.parent_kind === 'member' ? row.parent_member_id : row.parent_kind}. This notice is delivered to the host session; inspect incident ${row.id}.` });
        await withDatabase(db => { schema(db); db.prepare("UPDATE native_member_interruptions SET trigger_id=?,recipient_session_id=?,delivery_state=? WHERE id=? AND trigger_id='' AND resolved_at IS NULL").run(trigger.id,recipient,recipient===row.host_session_id ? 'queued' : 'escalated',row.id); }, { mutate: true });
      } else {
        const trigger = await getTrigger(row.trigger_id);
        const timedOut = !row.acknowledged_at && Date.now()-Date.parse(row.created_at)>=escalationDelay();
        if ((['failed','cancelled'].includes(trigger?.status) || timedOut) && trigger?.sessionId !== row.root_session_id && row.host_session_id !== row.root_session_id) {
          const fallback = await createTrigger({ sessionId: row.root_session_id, scheduledAt: stamp(), dedupeKey: `${row.id}:root`, title: 'Native member interruption needs review', text: `Incident ${row.id} remains unacknowledged or host delivery was unavailable; inspect the original Run and native member evidence.` });
          await withDatabase(db => { schema(db); db.prepare("UPDATE native_member_interruptions SET trigger_id=?,recipient_session_id=?,delivery_state='escalated' WHERE id=? AND trigger_id=?").run(fallback.id,row.root_session_id,row.id,row.trigger_id); }, { mutate: true });
        } else if (trigger?.status === 'delivered') await withDatabase(db => { schema(db); db.prepare("UPDATE native_member_interruptions SET delivery_state='delivered' WHERE id=? AND trigger_id=?").run(row.id,row.trigger_id); }, { mutate: true });
        else if (['failed','cancelled'].includes(trigger?.status)) await withDatabase(db => { schema(db); db.prepare("UPDATE native_member_interruptions SET delivery_state='unreachable' WHERE id=? AND trigger_id=?").run(row.id,row.trigger_id); }, { mutate: true });
      }
    } catch { /* Preserve pending evidence for the next bounded sweep. */ }
    finally { await withDatabase(db => { schema(db); db.prepare('UPDATE native_member_interruptions SET next_check_at=? WHERE id=? AND resolved_at IS NULL').run(new Date(Date.now()+30000).toISOString(),row.id); }, { mutate: true }); }
  }
}

// The router must first authenticate the run capability; a claimed session ID
// by itself is not an authorization credential.
async function updateDisposition({ incidentId, authSession, summary, evidence }, action) {
  if (authSession?.principalKind !== 'run_capability') throw Object.assign(new Error('Run capability required'), { code: 'FORBIDDEN' });
  if (action === 'resolve' && (!text(summary) || !text(evidence))) throw Object.assign(new Error('Resolution summary and evidence are required'), { code: 'BAD_REQUEST' });
  if (text(incidentId).startsWith('native:')) return updateNativeDisposition({ incidentId,authSession,summary,evidence },action);
  const scope = authSession.organizationMessageScope;
  const sessionId = text(authSession.sessionId);
  const live = sessionId && await getLiveOrganizationSessionReference(sessionId);
  return withDatabase(db => {
    schema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
    const row = db.prepare('SELECT * FROM agent_interruption_incidents WHERE id=?').get(text(incidentId));
    const ancestors = row ? JSON.parse(row.ancestors_json || '[]') : [];
    const recipient = ancestors.find((entry,index) => index <= Number(row.escalation_index) && entry.sessionId === sessionId);
    if (!row || !recipient) throw Object.assign(new Error('Incident unavailable'), { code: 'FORBIDDEN' });
    if (row.organization_id) {
      const validRoot = live?.kind === 'root' && live.organizationId === row.organization_id && !recipient.nodeId;
      const validNode = live?.kind === 'node' && scope && live.organizationId === row.organization_id && scope.organizationId === live.organizationId
        && live.nodeId === recipient.nodeId && live.nodeId === scope.nodeId && live.bindingGeneration === recipient.bindingGeneration
        && live.bindingGeneration === scope.bindingGeneration;
      if (!validRoot && !validNode) throw Object.assign(new Error('Live binding required'), { code: 'FORBIDDEN' });
      const currentOrg = db.prepare('SELECT root_session_id,current_revision,state FROM organizations WHERE id=?').get(row.organization_id);
      if (!currentOrg || currentOrg.state === 'archived' || (validRoot && currentOrg.root_session_id !== sessionId)
          || (validNode && !isAppendOnlyRevisionCompatible(db,row.organization_id,scope.organizationRevision,currentOrg.current_revision))) throw Object.assign(new Error('Binding changed'), { code: 'FORBIDDEN' });
      if (validNode) {
        const current = db.prepare('SELECT current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(recipient.nodeId,row.organization_id);
        if (!current || current.current_session_id !== sessionId || current.binding_generation !== recipient.bindingGeneration || current.retired_revision !== null) throw Object.assign(new Error('Binding changed'), { code: 'FORBIDDEN' });
      }
    }
    const now = stamp();
    if (action === 'read') db.prepare('INSERT OR IGNORE INTO agent_interruption_reads (incident_id,session_id,first_read_at) VALUES(?,?,?)').run(row.id,sessionId,now);
    if (action === 'ack') db.prepare('UPDATE agent_interruption_incidents SET acknowledged_at=COALESCE(acknowledged_at,?),updated_at=? WHERE id=?').run(now,now,row.id);
    else if (action === 'resolve') db.prepare('UPDATE agent_interruption_incidents SET resolved_at=COALESCE(resolved_at,?),resolution_summary=COALESCE(resolution_summary,?),resolution_evidence=COALESCE(resolution_evidence,?),updated_at=? WHERE id=?').run(now,text(summary).slice(0,1000),text(evidence).slice(0,1000),now,row.id);
    db.exec('COMMIT');
    if (action === 'read') return {
      id: row.id, sessionId: row.session_id, runId: row.run_id, organizationId: row.organization_id || null,
      nodeId: row.node_id || null, taskId: row.task_id || null, taskObjective: row.task_objective || null, attemptId: row.attempt_id || null,
      bindingGeneration: row.binding_generation, organizationRevision: row.organization_revision,
      category: row.category, source: row.source, confidence: row.confidence, evidenceRef: row.evidence_ref,
      reportedCode: row.reported_code || null, reportedCodeVerified: false,
      sideEffects: row.side_effects, occurredAt: row.occurred_at, deliveryState: row.delivery_state,
      readAt: db.prepare('SELECT first_read_at FROM agent_interruption_reads WHERE incident_id=? AND session_id=?').get(row.id,sessionId)?.first_read_at || now,
      acknowledgedAt: row.acknowledged_at, resolvedAt: row.resolved_at,
      resolutionSummary: row.resolution_summary, resolutionEvidence: row.resolution_evidence, recoveryVerified: false,
    };
    return { id: row.id, action, recoveryVerified: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }, { mutate: true });
}

async function updateNativeDisposition({ incidentId,authSession,summary,evidence },action) {
  const sessionId=text(authSession.sessionId), live=await getLiveOrganizationSessionReference(sessionId), scope=authSession.organizationMessageScope;
  return withDatabase(db => {
    schema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const row=db.prepare('SELECT * FROM native_member_interruptions WHERE id=?').get(text(incidentId));
      const org=row && db.prepare('SELECT root_session_id,current_revision,state FROM organizations WHERE id=?').get(row.organization_id);
      const host=!!row && sessionId===row.host_session_id && (row.node_id
        ? live?.kind==='node' && live.nodeId===row.node_id && live.bindingGeneration===row.binding_generation && scope?.nodeId===row.node_id && scope.bindingGeneration===row.binding_generation
        : live?.kind==='root');
      const root=!!row && sessionId===row.root_session_id && live?.kind==='root' && (row.recipient_session_id===sessionId || row.host_session_id===sessionId);
      const hostOnly=!!row && !row.organization_id && sessionId===row.host_session_id;
      if (!row || (!hostOnly && (!org || org.state==='archived' || org.root_session_id!==row.root_session_id || live?.organizationId!==row.organization_id
          || (!host && !root)))) throw Object.assign(new Error('Incident unavailable'),{code:'FORBIDDEN'});
      if (host && row.node_id) {
        const node=db.prepare('SELECT current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(row.node_id,row.organization_id);
        if (!node || node.current_session_id!==sessionId || node.binding_generation!==row.binding_generation || node.retired_revision!==null || !isAppendOnlyRevisionCompatible(db,row.organization_id,scope.organizationRevision,org.current_revision)) throw Object.assign(new Error('Binding changed'),{code:'FORBIDDEN'});
      }
      const now=stamp();
      if (action==='read') db.prepare('INSERT OR IGNORE INTO agent_interruption_reads VALUES(?,?,?)').run(row.id,sessionId,now);
      if (action==='ack') db.prepare('UPDATE native_member_interruptions SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?').run(now,row.id);
      if (action==='resolve') db.prepare('UPDATE native_member_interruptions SET resolved_at=COALESCE(resolved_at,?),resolution_summary=COALESCE(resolution_summary,?),resolution_evidence=COALESCE(resolution_evidence,?) WHERE id=?').run(now,text(summary).slice(0,1000),text(evidence).slice(0,1000),row.id);
      db.exec('COMMIT');
      if (action!=='read') return {id:row.id,action,recoveryVerified:false};
      return { id:row.id, kind:'native_member', runId:row.run_id, sessionId:row.host_session_id, memberId:row.member_id,
        nativeParent:{kind:row.parent_kind,...(row.parent_member_id ? {memberId:row.parent_member_id} : {})}, recipientSessionId:sessionId,
        provider:row.provider, category:row.state, source:'provider_native_event', confidence:'provider_reported', evidenceRef:`run:${row.run_id}:event:${row.event_id}`,
        controlCapabilities:{individualControl:'unknown', nativeParentDelivery:'unavailable'},
        sideEffects:'unknown',occurredAt:row.occurred_at,deliveryState:row.delivery_state,acknowledgedAt:row.acknowledged_at,resolvedAt:row.resolved_at,
        resolutionSummary:row.resolution_summary,resolutionEvidence:row.resolution_evidence,recoveryVerified:false,
        readAt:db.prepare('SELECT first_read_at FROM agent_interruption_reads WHERE incident_id=? AND session_id=?').get(row.id,sessionId)?.first_read_at || now };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },{mutate:true});
}
export const acknowledgeAgentInterruption = input => updateDisposition(input, 'ack');
export const resolveAgentInterruption = input => updateDisposition(input, 'resolve');
export async function getAgentInterruption(input) {
  const incident = await updateDisposition(input, 'read');
  const run = await getRun(incident.runId);
  const receipt = incident.attemptId ? await withDatabase(db => {
    const row = db.prepare('SELECT collaboration_id,source,consumed_at FROM collaboration_replay_receipts WHERE attempt_id=?').get(incident.attemptId);
    return row ? { collaborationId: row.collaboration_id, source: row.source, consumed: !!row.consumed_at } : null;
  }) : null;
  return { ...incident, reconciliation: {
    runState: text(run?.state) || 'unavailable', finalizedAt: text(run?.finalizedAt) || null,
    sideEffects: 'unknown', receipt,
    nextStep: receipt && !receipt.consumed ? 'review_receipt_and_request_retry' : 'inspect_original_run_evidence',
  } };
}
export async function listAgentInterruptions({ authSession, limit = 50 } = {}) {
  if (authSession?.principalKind !== 'run_capability' || !text(authSession.sessionId)) throw Object.assign(new Error('Run capability required'), { code: 'FORBIDDEN' });
  const bounded = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 100));
  const ids = await withDatabase(db => {
    schema(db);
    const regular = db.prepare(`SELECT i.id,i.created_at FROM agent_interruption_incidents i, json_each(i.ancestors_json) a
      WHERE json_extract(a.value,'$.sessionId')=? AND CAST(a.key AS INTEGER)<=i.escalation_index
      ORDER BY i.created_at DESC LIMIT ?`).all(authSession.sessionId,bounded);
    const native = db.prepare('SELECT id,created_at FROM native_member_interruptions WHERE host_session_id=? OR recipient_session_id=? ORDER BY created_at DESC LIMIT ?').all(authSession.sessionId,authSession.sessionId,bounded);
    return [...regular,...native].sort((a,b)=>b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,bounded).map(row=>row.id);
  });
  const records = [];
  for (const incidentId of ids) {
    try { records.push(await getAgentInterruption({ incidentId, authSession })); } catch (error) { if (error?.code !== 'FORBIDDEN') throw error; }
  }
  return records;
}
