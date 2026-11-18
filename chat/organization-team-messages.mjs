import { isAppendOnlyRevisionCompatible } from './organization-revision-compatibility.mjs';
// Owner messages have a separate body record and an atomic typed-envelope
// reference. OWNER_MESSAGE's from_node_id is a protocol sentinel, not an agent.
import { createHash, randomUUID } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { ensureOrganizationMessageEnvelopeSchema } from './organization-messaging.mjs';
import { assertOrganizationCapability } from './organization-runtime-capabilities.mjs';
import { authorize } from './work-graph.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { code: 'TEAM_MESSAGE_INVALID', statusCode });
function schema(db) {
  ensureOrganizationMessageEnvelopeSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS organization_team_messages (
    message_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, sender_kind TEXT NOT NULL,
    sender_principal TEXT NOT NULL, recipient_node_id TEXT NOT NULL, work_item_id TEXT,
    correlation_id TEXT, request_type TEXT NOT NULL, reply_to TEXT, body TEXT NOT NULL,
    visibility TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
    envelope_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(organization_id,idempotency_key)
  ); CREATE INDEX IF NOT EXISTS idx_team_message_recipient ON organization_team_messages(organization_id,recipient_node_id,created_at);
  CREATE TABLE IF NOT EXISTS organization_team_delivery_receipts (
    message_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, body_digest TEXT NOT NULL,
    accepted_at TEXT NOT NULL, work_item_id TEXT, execution_epoch INTEGER, binding_generation INTEGER, PRIMARY KEY(message_id,run_id)
  );
  CREATE TABLE IF NOT EXISTS organization_team_replies (
    reply_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
    body TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(message_id,idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS organization_team_message_escalations (
    organization_id TEXT NOT NULL, source_message_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
    actor_id TEXT NOT NULL, recipient_node_id TEXT NOT NULL, notice_message_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, UNIQUE(organization_id,idempotency_key)
  );`);
  const columns = new Set(db.prepare('PRAGMA table_info(organization_team_delivery_receipts)').all().map(c => c.name));
  for (const [name, type] of [['work_item_id','TEXT'], ['execution_epoch','INTEGER'], ['binding_generation','INTEGER']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE organization_team_delivery_receipts ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c => c.name === 'respond_by')) db.exec('ALTER TABLE organization_team_messages ADD COLUMN respond_by TEXT');
}

// A broker-accepted Run is a delivery receipt only when the exact stored body
// and message ID occur inside its persisted input and its current node binding
// still identifies that Run's session. This never implies reading or reply.
export async function recordAcceptedTeamMessageInputs({ sessionId, runId, manifest } = {}) {
  if (!trim(sessionId) || !trim(runId) || !manifest) return 0;
  const { getRun, getRunManifest } = await import('./runs.mjs');
  const run = await getRun(runId);
  if (!run || run.sessionId !== sessionId || !run.runnerLifecycleAcceptedAt) return 0;
  manifest = await getRunManifest(runId);
  if (!manifest || manifest.sessionId !== sessionId) return 0;
  const scope = manifest.options?.sessionControlChannel?.scope;
  if (scope?.kind !== 'organization_message' || !scope.organizationId || !scope.nodeId || !Number.isInteger(scope.bindingGeneration)) return 0;
  const sections = [manifest.prompt, manifest.developerInstructions, manifest.systemPrefix].filter(x => typeof x === 'string');
  const included = [];
  for (const section of sections) {
    const pattern = /<organization-status-projection>\s*[^\n]*\n([^\n]+)\n<\/organization-status-projection>/g;
    for (const match of section.matchAll(pattern)) {
      try { const projection = JSON.parse(match[1]); if (Array.isArray(projection.pendingMessages)) included.push(...projection.pendingMessages.map(message => ({ ...message, organizationId: projection.organizationId }))); } catch {}
    }
  }
  if (!included.length) return 0;
  return withDatabase(db => {
    schema(db); db.exec('BEGIN IMMEDIATE');
    try {
      let count = 0;
      for (const input of included) {
        if (typeof input?.body !== 'string' || !trim(input.messageId) || !trim(input.organizationId)) continue;
        const row = db.prepare(`SELECT m.*,e.delivery_state,n.binding_generation AS node_binding,o.current_revision FROM organization_team_messages m
          JOIN internal_envelopes e ON e.envelope_id=m.envelope_id
          JOIN organization_nodes n ON n.id=m.recipient_node_id AND n.organization_id=m.organization_id
          JOIN organizations o ON o.id=n.organization_id
          WHERE m.message_id=? AND m.organization_id=? AND m.recipient_node_id=? AND n.current_session_id=? AND n.binding_generation=? AND n.retired_revision IS NULL AND o.state<>'archived'`).get(input.messageId,scope.organizationId,scope.nodeId,scope.managedSessionId || sessionId,scope.bindingGeneration);
        if (!row || !isAppendOnlyRevisionCompatible(db, scope.organizationId, scope.organizationRevision, row.current_revision) || row.body !== input.body || !['pending','delivered','acknowledged'].includes(row.delivery_state)) continue;
        let epoch = null;
        const workItemId = scope.workItemId || row.work_item_id;
        if (scope.workItemId && row.work_item_id && scope.workItemId !== row.work_item_id) continue;
        if (workItemId) {
          const work = db.prepare(`SELECT w.execution_epoch FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id AND b.execution_epoch=w.execution_epoch
            JOIN collaboration_attempts a ON a.id=b.attempt_id AND a.task_id=b.task_id
            WHERE w.id=? AND w.organization_id=? AND w.assignee_node_id=? AND w.state='running' AND w.control_state='none' AND b.status='running' AND b.run_id=? AND b.binding_generation=? AND a.run_id=? AND a.session_id=? AND (? IS NULL OR a.id=?) AND (? IS NULL OR w.execution_epoch=?)`)
            .get(workItemId,row.organization_id,scope.nodeId,runId,row.node_binding,runId,sessionId,scope.attemptId || null,scope.attemptId || null,scope.executionEpoch ?? null,scope.executionEpoch ?? null);
          if (!work) continue;
          epoch = work.execution_epoch;
        }
        const bodyDigest = createHash('sha256').update(row.body).digest('hex');
        const now = new Date().toISOString();
        db.prepare('INSERT OR IGNORE INTO organization_team_delivery_receipts(message_id,run_id,session_id,body_digest,accepted_at,work_item_id,execution_epoch,binding_generation) VALUES (?,?,?,?,?,?,?,?)').run(row.message_id,runId,sessionId,bodyDigest,now,workItemId || null,epoch,row.node_binding);
        db.prepare("UPDATE internal_envelopes SET delivery_state='delivered',delivery_generation=delivery_generation+1,delivered_at=?,to_session_id=? WHERE envelope_id=? AND delivery_state='pending'").run(now,sessionId,row.envelope_id);
        count++;
      }
      db.exec('COMMIT'); return count;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate: true });
}
function rowMessage(row) {
  return { messageId: row.message_id, organizationId: row.organization_id, senderKind: row.sender_kind,
    senderPrincipal: row.sender_principal, recipientNodeId: row.recipient_node_id, workItemId: row.work_item_id,
    correlationId: row.correlation_id, requestType: row.request_type, replyTo: row.reply_to,
    body: row.body, visibility: row.visibility, envelopeId: row.envelope_id, deliveryState: row.delivery_state,
    respondBy: row.respond_by || null, reply: row.reply_body ? { body: row.reply_body, createdAt: row.reply_created_at } : null,
    requestState: row.request_type === 'required_response' ? (row.reply_body ? 'answered' : row.respond_by && row.respond_by <= new Date().toISOString() ? 'overdue' : row.delivery_state === 'pending' ? 'requested' : 'delivered') : null,
    ...(row.escalation_message_id ? { escalation: { messageId: row.escalation_message_id, recipientNodeId: row.escalation_recipient_node_id, deliveryState: row.escalation_delivery_state || 'unknown' } } : {}),
    createdAt: row.created_at };
}
// An escalation is an explicit owner action and does not answer the request.
// The reminder contains no original message body and uses the existing inbox.
export async function escalateOverdueTeamMessage(input,actor) {
  assertOrganizationCapability('internalEnvelopes','organization messaging is disabled');
  if(actor?.kind!=='user' || actor?.role!=='owner' || !trim(actor.principalId)) throw fail('Owner access required',403);
  const organizationId=trim(input?.organizationId), nodeId=trim(input?.recipientNodeId), messageId=trim(input?.messageId), key=trim(input?.idempotencyKey);
  if(!organizationId || !nodeId || !messageId || !key || key.length>255) throw fail('Organization, recipient, message and idempotency key are required');
  return withDatabase(db=>{ schema(db); db.exec('BEGIN IMMEDIATE'); try {
    authorize(db,organizationId,actor,'factory.read');
    const replay=db.prepare('SELECT * FROM organization_team_message_escalations WHERE organization_id=? AND idempotency_key=?').get(organizationId,key);
    if(replay) {
      const original=db.prepare('SELECT recipient_node_id FROM organization_team_messages WHERE organization_id=? AND message_id=?').get(organizationId,messageId);
      if(replay.source_message_id!==messageId || replay.actor_id!==actor.principalId || original?.recipient_node_id!==nodeId) throw fail('Idempotency key belongs to a different escalation',409);
      const notice=db.prepare('SELECT m.*,e.delivery_state FROM organization_team_messages m JOIN internal_envelopes e ON e.envelope_id=m.envelope_id WHERE m.message_id=?').get(replay.notice_message_id);
      if(!notice) throw fail('Escalation receipt is unavailable',409);
      db.exec('COMMIT'); return {sourceMessageId:messageId,message:rowMessage(notice),replayed:true};
    }
    const source=db.prepare(`SELECT m.*,n.parent_node_id,n.retired_revision,n.lifecycle_state,o.current_revision,o.state AS org_state,
      EXISTS(SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) AS answered
      FROM organization_team_messages m JOIN organization_nodes n ON n.id=m.recipient_node_id AND n.organization_id=m.organization_id
      JOIN organizations o ON o.id=m.organization_id WHERE m.organization_id=? AND m.recipient_node_id=? AND m.message_id=?`).get(organizationId,nodeId,messageId);
    if(!source) throw fail('Request not found',404);
    if(['archived','lifecycle_pending'].includes(source.org_state) || source.retired_revision!==null || ['retired','deleted'].includes(source.lifecycle_state)) throw fail('Organization or recipient is not active',409);
    if(source.request_type!=='required_response' || !source.respond_by || !Number.isFinite(Date.parse(source.respond_by)) || Date.parse(source.respond_by)>Date.now() || source.answered) throw fail('Request is not overdue and unanswered',409);
    if(db.prepare('SELECT 1 FROM organization_team_message_escalations WHERE source_message_id=?').get(messageId)) throw fail('Request was already escalated',409);
    if(source.work_item_id && !db.prepare('SELECT 1 FROM factory_work_items WHERE id=? AND organization_id=? AND assignee_node_id=?').get(source.work_item_id,organizationId,nodeId)) throw fail('Request work item or assignment changed',409);
    const manager=db.prepare("SELECT id,current_session_id FROM organization_nodes WHERE id=? AND organization_id=? AND retired_revision IS NULL AND COALESCE(lifecycle_state,'active') NOT IN ('retired','deleted')").get(source.parent_node_id,organizationId);
    if(!manager || manager.id===nodeId) throw fail('Current manager is unavailable',409);
    const noticeId=`msg_${randomUUID()}`, envelopeId=`env_${randomUUID()}`, created=new Date().toISOString();
    const body=`An owner has escalated an overdue team response. Request ID: ${messageId}. Ask the owner for any details.`;
    const digest=createHash('sha256').update(JSON.stringify({source:messageId,recipient:manager.id,actor:actor.principalId})).digest('hex');
    db.prepare(`INSERT INTO internal_envelopes (envelope_id,organization_id,organization_revision,type,from_node_id,to_node_id,to_session_id,task_id,payload_ref_json,subject,delivery_state,delivery_generation,idempotency_key,created_at) VALUES (?,?,?,'OWNER_MESSAGE','@owner',?,?,NULL,?,?,'pending',0,?,?)`).run(envelopeId,organizationId,source.current_revision,manager.id,manager.current_session_id || null,JSON.stringify({messageId:noticeId}),'Overdue response reminder',`team:${noticeId}`,created);
    db.prepare(`INSERT INTO organization_team_messages(message_id,organization_id,sender_kind,sender_principal,recipient_node_id,work_item_id,correlation_id,request_type,reply_to,body,visibility,idempotency_key,payload_digest,envelope_id,created_at,respond_by) VALUES (?,?, 'user', ?, ?, NULL, ?, 'information', NULL, ?, 'recipient', ?, ?, ?, ?, NULL)`).run(noticeId,organizationId,actor.principalId,manager.id,messageId,body,`escalation:${noticeId}`,digest,envelopeId,created);
    db.prepare('INSERT INTO organization_team_message_escalations VALUES (?,?,?,?,?,?,?)').run(organizationId,messageId,key,actor.principalId,manager.id,noticeId,created);
    const notice=db.prepare('SELECT m.*,e.delivery_state FROM organization_team_messages m JOIN internal_envelopes e ON e.envelope_id=m.envelope_id WHERE m.message_id=?').get(noticeId);
    db.exec('COMMIT'); return {sourceMessageId:messageId,message:rowMessage(notice)};
  } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; } },{mutate:true});
}
export async function sendOwnerTeamMessage(input, actor) {
  assertOrganizationCapability('internalEnvelopes', 'organization messaging is disabled');
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !trim(actor.principalId)) throw fail('Owner access required', 403);
  const organizationId = trim(input?.organizationId), nodeId = trim(input?.recipientNodeId), body = trim(input?.body), key = trim(input?.idempotencyKey);
  if (!organizationId || !nodeId || !key || key.length > 255 || !body || Buffer.byteLength(body, 'utf8') > 8192) throw fail('Organization, recipient, idempotency key and bounded message are required');
  const requestType = input?.requestType || 'information', respondBy = trim(input?.respondBy);
  if (!['information','required_response'].includes(requestType)) throw fail('Unsupported request type');
  if (respondBy && (!Number.isFinite(Date.parse(respondBy)) || new Date(respondBy).toISOString() !== respondBy)) throw fail('respondBy must be an ISO timestamp');
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{20,}))/i.test(body)) throw fail('Credentials must not be included in messages');
  const workItemId = trim(input?.workItemId), correlationId = trim(input?.correlationId);
  const digest = createHash('sha256').update(JSON.stringify({ nodeId, body, workItemId, correlationId, requestType, respondBy, sender: actor.principalId })).digest('hex');
  return withDatabase(db => {
    schema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT m.*,e.delivery_state FROM organization_team_messages m JOIN internal_envelopes e ON e.envelope_id=m.envelope_id WHERE m.organization_id=? AND m.idempotency_key=?').get(organizationId,key);
      if (existing) { if (existing.payload_digest !== digest) throw fail('Idempotency key belongs to a different message',409); db.exec('COMMIT'); return rowMessage(existing); }
      const org = db.prepare('SELECT current_revision FROM organizations WHERE id=?').get(organizationId);
      const node = db.prepare("SELECT current_session_id FROM organization_nodes WHERE organization_id=? AND id=? AND lifecycle_state NOT IN ('retired','deleted')").get(organizationId,nodeId);
      if (!org || !node) throw fail('Organization or recipient not found',404);
      if (workItemId && (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get() || !db.prepare('SELECT 1 FROM factory_work_items WHERE id=? AND organization_id=?').get(workItemId,organizationId))) throw fail('Work item not found in organization',404);
      const messageId = `msg_${randomUUID()}`, envelopeId = `env_${randomUUID()}`, created = new Date().toISOString();
      db.prepare(`INSERT INTO internal_envelopes (envelope_id,organization_id,organization_revision,type,from_node_id,to_node_id,to_session_id,task_id,payload_ref_json,subject,delivery_state,delivery_generation,idempotency_key,created_at) VALUES (?,?,?,'OWNER_MESSAGE','@owner',?,?,?,?,?,'pending',0,?,?)`)
        .run(envelopeId,organizationId,org.current_revision,nodeId,node.current_session_id || null,workItemId || null,JSON.stringify({ messageId }), 'Owner message',`team:${messageId}`,created);
      db.prepare(`INSERT INTO organization_team_messages(message_id,organization_id,sender_kind,sender_principal,recipient_node_id,work_item_id,correlation_id,request_type,reply_to,body,visibility,idempotency_key,payload_digest,envelope_id,created_at,respond_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId,organizationId,'user',actor.principalId,nodeId,workItemId || null,correlationId || null,requestType,null,body,'recipient',key,digest,envelopeId,created,respondBy || null);
      const row = db.prepare('SELECT m.*,e.delivery_state FROM organization_team_messages m JOIN internal_envelopes e ON e.envelope_id=m.envelope_id WHERE m.message_id=?').get(messageId);
      db.exec('COMMIT'); return rowMessage(row);
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate: true });
}
export async function listTeamMessages(organizationId, nodeId, limit = 50) {
  return withDatabase(db => {
    schema(db);
    if (!db.prepare('SELECT 1 FROM organization_nodes WHERE organization_id=? AND id=?').get(organizationId,nodeId)) throw fail('Recipient not found',404);
    return db.prepare(`SELECT m.*,e.delivery_state,(SELECT body FROM organization_team_replies r WHERE r.message_id=m.message_id ORDER BY r.created_at DESC LIMIT 1) AS reply_body,(SELECT created_at FROM organization_team_replies r WHERE r.message_id=m.message_id ORDER BY r.created_at DESC LIMIT 1) AS reply_created_at,(SELECT x.notice_message_id FROM organization_team_message_escalations x WHERE x.source_message_id=m.message_id) AS escalation_message_id,(SELECT x.recipient_node_id FROM organization_team_message_escalations x WHERE x.source_message_id=m.message_id) AS escalation_recipient_node_id,(SELECT ne.delivery_state FROM organization_team_message_escalations x JOIN organization_team_messages nm ON nm.message_id=x.notice_message_id JOIN internal_envelopes ne ON ne.envelope_id=nm.envelope_id WHERE x.source_message_id=m.message_id) AS escalation_delivery_state FROM organization_team_messages m JOIN internal_envelopes e ON e.envelope_id=m.envelope_id WHERE m.organization_id=? AND m.recipient_node_id=? ORDER BY m.created_at DESC,m.message_id DESC LIMIT ?`).all(organizationId,nodeId,Math.max(1,Math.min(100,limit))).map(rowMessage);
  });
}

// principal is constructed by the signed Run capability authenticator, never
// from request JSON. Receipt, current binding and execution epoch fence writes.
export async function respondToTeamMessage({ messageId, action, body, idempotencyKey }, principal) {
  const scope = principal?.organizationMessageScope;
  if (principal?.principalKind !== 'run_capability' || scope?.kind !== 'organization_message' || !['ack','reply'].includes(action)) throw fail('Message capability required',403);
  const response = trim(body), key = trim(idempotencyKey);
  if (action === 'reply' && (!response || Buffer.byteLength(response,'utf8') > 8192 || !key || key.length > 255)) throw fail('Bounded reply and idempotency key are required');
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{20,}))/i.test(response)) throw fail('Credentials must not be included in messages');
  return withDatabase(db => {
    schema(db); db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT m.*,e.delivery_state,r.execution_epoch,r.binding_generation,r.work_item_id AS receipt_work_item_id,o.current_revision FROM organization_team_messages m
        JOIN internal_envelopes e ON e.envelope_id=m.envelope_id
        JOIN organization_team_delivery_receipts r ON r.message_id=m.message_id AND r.run_id=? AND r.session_id=?
        JOIN organization_nodes n ON n.id=m.recipient_node_id AND n.organization_id=m.organization_id
        JOIN organizations o ON o.id=n.organization_id
        WHERE m.message_id=? AND m.organization_id=? AND m.recipient_node_id=? AND n.current_session_id=?
          AND n.binding_generation=? AND n.retired_revision IS NULL AND r.binding_generation=n.binding_generation AND o.state<>'archived'`).get(principal.runId,principal.sessionId,messageId,scope.organizationId,scope.nodeId,scope.managedSessionId || principal.sessionId,scope.bindingGeneration);
      if (!row || !isAppendOnlyRevisionCompatible(db, scope.organizationId, scope.organizationRevision, row.current_revision)) throw fail('Message was not delivered to this current node binding and Run',403);
      if (row.receipt_work_item_id && !db.prepare(`SELECT 1 FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id AND b.execution_epoch=w.execution_epoch JOIN collaboration_attempts a ON a.id=b.attempt_id AND a.task_id=b.task_id WHERE w.id=? AND w.organization_id=? AND w.assignee_node_id=? AND w.execution_epoch=? AND w.state='running' AND w.control_state='none' AND b.status='running' AND b.run_id=? AND b.binding_generation=? AND a.run_id=? AND a.session_id=? AND (? IS NULL OR a.id=?)`).get(row.receipt_work_item_id,scope.organizationId,scope.nodeId,row.execution_epoch,principal.runId,scope.bindingGeneration,principal.runId,principal.sessionId,scope.attemptId || null,scope.attemptId || null)) throw fail('Work execution changed',409);
      let reply = null;
      if (action === 'reply') {
        const existing = db.prepare('SELECT * FROM organization_team_replies WHERE message_id=? AND idempotency_key=?').get(messageId,key);
        if (existing && (existing.body !== response || existing.node_id !== scope.nodeId)) throw fail('Idempotency key belongs to a different reply',409);
        if (!existing) db.prepare('INSERT INTO organization_team_replies VALUES (?,?,?,?,?,?,?)').run(`reply_${randomUUID()}`,messageId,principal.runId,scope.nodeId,response,key,new Date().toISOString());
        const saved = existing || db.prepare('SELECT * FROM organization_team_replies WHERE message_id=? AND idempotency_key=?').get(messageId,key);
        reply = { replyId: saved.reply_id, body: saved.body, createdAt: saved.created_at };
      }
      db.prepare("UPDATE internal_envelopes SET delivery_state='acknowledged',delivery_generation=delivery_generation+1,acknowledged_at=? WHERE envelope_id=? AND delivery_state='delivered'").run(new Date().toISOString(),row.envelope_id);
      db.exec('COMMIT'); return { messageId, deliveryState: 'acknowledged', reply };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate: true });
}
