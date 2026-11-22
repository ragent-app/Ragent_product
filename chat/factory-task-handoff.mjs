// Immutable, bounded references to Work Graph facts. A handoff is context,
// not an authorization or a replacement for the underlying records.
import { randomUUID, createHash } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, encode, decode, itemRow } from './work-graph-store.mjs';
import { authorize, selectItem, required } from './work-graph.mjs';

function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_task_handoffs (
  id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,work_item_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,payload_digest TEXT NOT NULL,row_version INTEGER NOT NULL,contract_revision INTEGER NOT NULL,
  execution_epoch INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,organization_revision INTEGER NOT NULL
); CREATE TRIGGER IF NOT EXISTS factory_task_handoff_immutable_update BEFORE UPDATE ON factory_task_handoffs BEGIN SELECT RAISE(ABORT,'immutable task handoff'); END;
CREATE TRIGGER IF NOT EXISTS factory_task_handoff_immutable_delete BEFORE DELETE ON factory_task_handoffs BEGIN SELECT RAISE(ABORT,'immutable task handoff'); END;`); }
function safeFact(value,depth=0) {
  if(depth>5) return null;
  if(typeof value==='string') return value.slice(0,2000);
  if(value===null || typeof value==='boolean' || typeof value==='number') return value;
  if(Array.isArray(value)) return value.slice(0,50).map(entry=>safeFact(entry,depth+1));
  if(!value || typeof value!=='object') return null;
  const output={}; for(const [key,entry] of Object.entries(value).slice(0,50)) {
    if(/secret|credential|token|password|private.?key|cookie|environment/i.test(key)) continue;
    output[key]=safeFact(entry,depth+1);
  } return output;
}
function tableExists(db,name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function redactSensitiveText(text) {
  return String(text || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]')
    .replace(/((?:secret|credential|token|password|private[_-]?key|cookie|api[_-]?key|auth)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
}
function fitBoundedEntry(entry, maxBytes = 290, trimOrder = ['reconcile_error', 'reconcile_state', 'evidence_ref', 'incident_category', 'reason', 'packet_id', 'incident_id']) {
  const out = { ...entry };
  if (Buffer.byteLength(encode(out), 'utf8') <= maxBytes) return out;
  const textTruncateOrder = new Set(['reason', 'evidence_ref', 'reconcile_error', 'path', 'digest']);
  for (const key of trimOrder) {
    if (textTruncateOrder.has(key) && typeof out[key] === 'string' && out[key].length > 48) {
      out[key] = `${out[key].slice(0, 45)}...`;
      if (Buffer.byteLength(encode(out), 'utf8') <= maxBytes) return out;
    }
  }
  for (const key of trimOrder) {
    if (key in out) {
      if (key === 'reason' && typeof out[key] === 'string' && out[key].length > 24) {
        out[key] = `${out[key].slice(0, 21)}...`;
        if (Buffer.byteLength(encode(out), 'utf8') <= maxBytes) return out;
      }
      delete out[key];
      if (Buffer.byteLength(encode(out), 'utf8') <= maxBytes) return out;
    }
  }
  return out;
}
function boundedArray(items, limit = 5, maxEntryBytes = 300) {
  let truncated = items.length > limit;
  const kept = [];
  for (const entry of items.slice(0, limit)) {
    const fitted = fitBoundedEntry(entry, maxEntryBytes);
    if (Buffer.byteLength(encode(fitted), 'utf8') <= maxEntryBytes) {
      kept.push(fitted);
    } else {
      truncated = true;
    }
  }
  return { kept, truncated };
}
export function collectWorkerFailureHandoffEvidence(db, organizationId, workItemId) {
  const hasBindings = tableExists(db, 'factory_execution_bindings');
  const hasAttempts = tableExists(db, 'collaboration_attempts');
  const bindingRows = hasBindings
    ? db.prepare('SELECT id,contract_revision,execution_epoch,binding_generation,status,collaboration_id,task_id,attempt_id,run_id,details_json,updated_at FROM factory_execution_bindings WHERE work_item_id=? ORDER BY execution_epoch DESC,id DESC LIMIT 51').all(workItemId)
    : [];
  const attemptRows = (hasBindings && hasAttempts)
    ? db.prepare(`SELECT a.id,a.run_id,a.task_id,a.state,a.failure_kind,a.failure_reason,a.result_packet_id,a.report_json,a.created_at,
        b.id AS binding_id,b.status AS binding_status,b.execution_epoch,b.binding_generation,b.details_json AS binding_details_json
      FROM factory_execution_bindings b
      LEFT JOIN collaboration_attempts a ON a.id=b.attempt_id
      WHERE b.work_item_id=? AND (a.state='failed' OR b.status IN ('failed','unknown') OR a.failure_kind IS NOT NULL)
      ORDER BY COALESCE(a.created_at, b.updated_at) DESC, b.id DESC LIMIT 51`).all(workItemId)
    : [];

  const runIds = new Set();
  const attemptIds = new Set();
  const taskIds = new Set([workItemId]);
  for (const b of bindingRows) {
    if (b.run_id) runIds.add(b.run_id);
    if (b.attempt_id) attemptIds.add(b.attempt_id);
    if (b.task_id) taskIds.add(b.task_id);
  }
  for (const a of attemptRows) {
    if (a.run_id) runIds.add(a.run_id);
    if (a.id) attemptIds.add(a.id);
    if (a.task_id) taskIds.add(a.task_id);
  }

  let incidentRows = [];
  if (tableExists(db, 'agent_interruption_incidents')) {
    const incCols = new Set(db.prepare('PRAGMA table_info(agent_interruption_incidents)').all().map(c => c.name));
    const reportedExpr = incCols.has('reported_code') ? 'reported_code' : "'' AS reported_code";
    const conditions = [];
    const params = [];
    if (runIds.size) {
      const list = [...runIds];
      conditions.push(`run_id IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (attemptIds.size) {
      const list = [...attemptIds];
      conditions.push(`attempt_id IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (taskIds.size) {
      const list = [...taskIds];
      conditions.push(`task_id IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (conditions.length) {
      incidentRows = db.prepare(`SELECT id,run_id,attempt_id,task_id,category,source,confidence,evidence_ref,side_effects,occurred_at,delivery_state,acknowledged_at,resolved_at,${reportedExpr}
        FROM agent_interruption_incidents
        WHERE organization_id=? AND (${conditions.join(' OR ')})
        ORDER BY occurred_at DESC, id DESC LIMIT 51`).all(organizationId, ...params);
    }
  }

  let nativeInterruptions = [];
  if (tableExists(db, 'native_member_interruptions') && runIds.size) {
    const list = [...runIds];
    nativeInterruptions = db.prepare(`SELECT id,run_id,member_id,provider,state,occurred_at,delivery_state,resolved_at
      FROM native_member_interruptions
      WHERE organization_id=? AND run_id IN (${list.map(() => '?').join(',')})
      ORDER BY occurred_at DESC, id DESC LIMIT 51`).all(organizationId, ...list);
  }

  const reconciliationRows = tableExists(db, 'factory_reconciliation_failures')
    ? db.prepare('SELECT execution_epoch,failures,state,error_code,next_attempt_at,updated_at FROM factory_reconciliation_failures WHERE organization_id=? AND work_item_id=? ORDER BY execution_epoch DESC LIMIT 51').all(organizationId, workItemId)
    : [];

  const incidentByRunId = new Map();
  const incidentByAttemptId = new Map();
  for (const inc of incidentRows) {
    if (inc.run_id && !incidentByRunId.has(inc.run_id)) incidentByRunId.set(inc.run_id, inc);
    if (inc.attempt_id && !incidentByAttemptId.has(inc.attempt_id)) incidentByAttemptId.set(inc.attempt_id, inc);
  }
  const reconByEpoch = new Map();
  for (const rf of reconciliationRows) {
    if (!reconByEpoch.has(rf.execution_epoch)) reconByEpoch.set(rf.execution_epoch, rf);
  }

  const failureEntries = [];
  const seenFailureRunOrIds = new Set();
  for (const row of attemptRows) {
    const bDetails = decode(row.binding_details_json, {});
    const inc = (row.id && incidentByAttemptId.get(row.id)) || (row.run_id && incidentByRunId.get(row.run_id)) || null;
    const recon = reconByEpoch.get(row.execution_epoch) || null;
    const packetId = row.result_packet_id || (typeof bDetails?.packetId === 'string' ? bDetails.packetId : '') || '';
    const failureKind = row.failure_kind || (row.binding_status === 'unknown' ? 'unknown_outcome' : 'execution_failed');
    const rawReason = row.failure_reason || bDetails?.error || bDetails?.reason || '';
    const entry = {
      id: row.id || row.binding_id,
      run_id: row.run_id || null,
      failure_kind: failureKind,
      ...(packetId ? { packet_id: packetId } : {}),
      ...(inc ? { incident_id: inc.id, incident_category: inc.category } : {}),
      ...(inc?.evidence_ref ? { evidence_ref: redactSensitiveText(String(inc.evidence_ref).slice(0, 96)) } : {}),
      ...(recon ? { reconcile_state: recon.state, reconcile_error: redactSensitiveText(String(recon.error_code || '').slice(0, 64)) } : {}),
      ...(rawReason ? { reason: redactSensitiveText(String(rawReason).slice(0, 120)) } : {}),
    };
    failureEntries.push(fitBoundedEntry(entry, 290));
    if (row.run_id) seenFailureRunOrIds.add(row.run_id);
    if (row.id) seenFailureRunOrIds.add(row.id);
    if (row.binding_id) seenFailureRunOrIds.add(row.binding_id);
  }

  // Ensure orphan interruption incidents (e.g. Run crashed before collaboration_attempts updated) are surfaced as failure evidence.
  for (const inc of incidentRows) {
    if ((inc.run_id && seenFailureRunOrIds.has(inc.run_id)) || (inc.attempt_id && seenFailureRunOrIds.has(inc.attempt_id))) continue;
    const unknownSideEffects = inc.category === 'unknown_outcome' || (!inc.resolved_at && String(inc.side_effects || '').toLowerCase() === 'unknown');
    failureEntries.push(fitBoundedEntry({
      id: inc.attempt_id || inc.id,
      run_id: inc.run_id || null,
      failure_kind: unknownSideEffects ? 'unknown_outcome' : (inc.category || 'interrupted'),
      incident_id: inc.id,
      incident_category: inc.category,
      ...(inc.evidence_ref ? { evidence_ref: redactSensitiveText(String(inc.evidence_ref).slice(0, 96)) } : {}),
    }, 290));
  }

  const incidentRefs = [
    ...incidentRows.map(inc => fitBoundedEntry({
      kind: 'agent_interruption',
      id: inc.id,
      run_id: inc.run_id || null,
      category: inc.category,
      source: inc.source,
      confidence: inc.confidence,
      side_effects: inc.side_effects,
      delivery_state: inc.delivery_state,
      resolved_at: inc.resolved_at || null,
      evidence_ref: redactSensitiveText(String(inc.evidence_ref || '').slice(0, 96)),
      ...(inc.reported_code ? { reported_code: redactSensitiveText(String(inc.reported_code).slice(0, 48)) } : {}),
    }, 290, ['evidence_ref', 'reported_code', 'source', 'confidence'])),
    ...nativeInterruptions.map(ni => fitBoundedEntry({
      kind: 'native_member_interruption',
      id: ni.id,
      run_id: ni.run_id,
      member_id: ni.member_id,
      provider: ni.provider,
      state: ni.state,
      delivery_state: ni.delivery_state,
      resolved_at: ni.resolved_at || null,
    }, 290, ['provider', 'member_id'])),
  ];

  const reconciliationFailures = reconciliationRows.map(rf => fitBoundedEntry({
    execution_epoch: rf.execution_epoch,
    failures: rf.failures,
    state: rf.state,
    error_code: redactSensitiveText(String(rf.error_code || '').slice(0, 64)),
    next_attempt_at: rf.next_attempt_at || null,
  }, 290, ['error_code', 'next_attempt_at']));

  const artifactRefs = [];
  const seenArtifacts = new Set();
  const pushArtifact = (ref) => {
    const key = encode(ref);
    if (seenArtifacts.has(key)) return;
    seenArtifacts.add(key);
    artifactRefs.push(fitBoundedEntry(ref, 290, ['path', 'evidence_ref', 'handoff_id', 'digest']));
  };
  for (const row of attemptRows) {
    const bDetails = decode(row.binding_details_json, {});
    const report = decode(row.report_json, {});
    const packetId = row.result_packet_id || (typeof bDetails?.packetId === 'string' ? bDetails.packetId : '');
    if (packetId) pushArtifact({ kind: 'result_packet', packet_id: packetId, run_id: row.run_id || null });
    if (typeof bDetails?.handoffId === 'string' && bDetails.handoffId) {
      pushArtifact({ kind: 'worker_handoff', handoff_id: bDetails.handoffId, run_id: row.run_id || null });
    }
    const extraRefs = Array.isArray(bDetails?.artifactRefs) ? bDetails.artifactRefs : (Array.isArray(report?.evidenceRefs) ? report.evidenceRefs : []);
    for (const ref of extraRefs.slice(0, 10)) {
      if (typeof ref === 'string' && ref.trim()) {
        pushArtifact({ kind: 'artifact_ref', evidence_ref: redactSensitiveText(ref.trim().slice(0, 120)), run_id: row.run_id || null });
      }
    }
  }
  for (const inc of incidentRows) {
    if (inc.evidence_ref) {
      pushArtifact({ kind: 'incident_evidence', incident_id: inc.id, evidence_ref: redactSensitiveText(String(inc.evidence_ref).slice(0, 120)), run_id: inc.run_id || null });
    }
  }

  const unknownExecution = Boolean(
    bindingRows.some(b => b.status === 'unknown')
    || failureEntries.some(f => f.failure_kind === 'unknown_outcome')
    || incidentRows.some(inc => inc.category === 'unknown_outcome' || (!inc.resolved_at && String(inc.side_effects || '').toLowerCase() === 'unknown'))
    || reconciliationRows.some(rf => rf.state === 'exhausted' || rf.state === 'dead_letter')
  );

  return {
    failures: failureEntries.slice(0, 50),
    incidentRefs: incidentRefs.slice(0, 50),
    reconciliationFailures: reconciliationFailures.slice(0, 50),
    artifactRefs: artifactRefs.slice(0, 50),
    unknownExecution,
    autoRedispatchForbidden: unknownExecution,
    truncated: failureEntries.length > 50 || incidentRefs.length > 50 || reconciliationRows.length > 50 || artifactRefs.length > 50,
  };
}
function sourceRefs(db,organizationId,workItemId,contractRevision,executionEpoch,{skipMessages=false}={}) {
  const dependencies=db.prepare('SELECT predecessor_id,milestone,candidate_digest FROM factory_dependencies WHERE successor_id=? ORDER BY predecessor_id LIMIT 101').all(workItemId);
  const bindings=db.prepare('SELECT id,contract_revision,execution_epoch,binding_generation,status,attempt_id,run_id FROM factory_execution_bindings WHERE work_item_id=? ORDER BY execution_epoch DESC,id LIMIT 51').all(workItemId);
  const candidates=db.prepare('SELECT id,digest,contract_revision,execution_epoch FROM factory_candidates WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const decisions=db.prepare('SELECT id,criterion_id,decision,candidate_digest,contract_revision FROM factory_acceptance_decisions WHERE work_item_id=? ORDER BY created_at DESC,id LIMIT 51').all(workItemId);
  const failureEvidence=collectWorkerFailureHandoffEvidence(db,organizationId,workItemId);
  const failures=failureEvidence.failures;
  const hasMessages=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_messages'").get();
  const hasReplies=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_replies'").get();
  const hasRespondBy=hasMessages && db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c=>c.name==='respond_by');
  const questions=hasMessages && hasReplies && !skipMessages ? db.prepare(`SELECT m.message_id,${hasRespondBy?'m.respond_by':'NULL AS respond_by'} FROM organization_team_messages m WHERE m.organization_id=? AND m.work_item_id=? AND m.request_type='required_response' AND NOT EXISTS (SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) ORDER BY m.created_at,m.message_id LIMIT 51`).all(organizationId,workItemId) : [];
  const hasRelations=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relations'").get();
  const hasChanges=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_team_relation_changes'").get();
  const relationVersion=hasRelations ? (hasChanges ? db.prepare('SELECT MAX(version) AS version FROM (SELECT version FROM organization_team_relations WHERE organization_id=? UNION ALL SELECT version FROM organization_team_relation_changes WHERE organization_id=?)').get(organizationId,organizationId).version : db.prepare('SELECT MAX(version) AS version FROM organization_team_relations WHERE organization_id=?').get(organizationId).version) || 0 : 0;
  return {
    workItemId,
    contractRevision,
    executionEpoch,
    relationVersion,
    dependencies:dependencies.slice(0,100),
    bindings:bindings.slice(0,50),
    candidates:candidates.slice(0,50),
    decisions:decisions.slice(0,50),
    failures:failures.slice(0,50),
    incidentRefs:failureEvidence.incidentRefs.slice(0,50),
    reconciliationFailures:failureEvidence.reconciliationFailures.slice(0,50),
    artifactRefs:failureEvidence.artifactRefs.slice(0,50),
    unansweredMessageRefs:hasMessages && hasReplies ? questions.slice(0,50) : 'unknown',
    remainingBudget:'unknown',
    truncated:dependencies.length>100||bindings.length>50||candidates.length>50||decisions.length>50||failureEvidence.truncated||questions.length>50,
  };
}
function workerRefs(db,organizationId,workItemId,contractRevision,executionEpoch,nodeId) {
  const refs=sourceRefs(db,organizationId,workItemId,contractRevision,executionEpoch,{skipMessages:true});
  for (const key of ['dependencies','bindings','candidates','decisions','failures','incidentRefs','reconciliationFailures','artifactRefs']) {
    const { kept, truncated } = boundedArray(Array.isArray(refs[key]) ? refs[key] : [], 5, 300);
    if (truncated) refs.truncated = true;
    refs[key] = kept;
  }
  if (Array.isArray(refs.unansweredMessageRefs)) {
    const hasRespondBy=db.prepare('PRAGMA table_info(organization_team_messages)').all().some(c=>c.name==='respond_by');
    const messages=db.prepare(`SELECT m.message_id,m.body AS full_body,${hasRespondBy?'m.respond_by':'NULL AS respond_by'} FROM organization_team_messages m WHERE m.organization_id=? AND m.work_item_id=? AND m.recipient_node_id=? AND m.request_type='required_response' AND NOT EXISTS (SELECT 1 FROM organization_team_replies r WHERE r.message_id=m.message_id) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 6`).all(organizationId,workItemId,nodeId).map(({full_body,...entry})=>({...entry,body:String(full_body || '').slice(0,100),body_truncated:String(full_body || '').length>100,body_digest:createHash('sha256').update(String(full_body || '')).digest('hex')}));
    refs.unansweredMessageRefs=messages.slice(0,5).filter(entry=>{ const fits=Buffer.byteLength(encode(entry),'utf8')<=700; if(!fits) refs.truncated=true; return fits; });
    refs.truncated=refs.truncated || messages.length>5 || messages.some(message=>message.body_truncated);
  }
  return refs;
}

// Only task facts cross the instance boundary. Inbox contents and identifiers
// are intentionally excluded; the signed operation owns this immutable copy.
export function remoteFactoryTaskSummary(db,input,maxBytes) {
  const item=selectItem(db,input.organizationId,input.workItemId);
  const refs=sourceRefs(db,input.organizationId,item.id,item.contract_revision,item.execution_epoch,{skipMessages:true});
  delete refs.unansweredMessageRefs;
  const summary={schemaVersion:1,workItemId:item.id,contractRevision:item.contract_revision,executionEpoch:item.execution_epoch,
    contractDigest:input.contractDigest,sourceVersion:item.row_version,organizationRevision:input.payload.contract.organizationRevision,
    facts:{dependencies:[],candidates:[],decisions:[],failures:[]},omitted:['inbox_messages','contract_duplicate'],truncated:refs.truncated};
  if(!Number.isSafeInteger(maxBytes) || Buffer.byteLength(encode(summary),'utf8')>maxBytes) throw factoryError('REMOTE_INVALID','Remote payload has no room for task context',400);
  for(const key of Object.keys(summary.facts)) {
    if(refs[key].length>5) summary.truncated=true;
    for(const entry of refs[key].slice(0,5)) {
      if(Buffer.byteLength(encode(entry),'utf8')>300) { summary.truncated=true; continue; }
      summary.facts[key].push(entry);
      if(Buffer.byteLength(encode(summary),'utf8')>maxBytes) { summary.facts[key].pop(); summary.truncated=true; }
    }
  }
  if(Buffer.byteLength(encode(summary),'utf8')>maxBytes) throw factoryError('REMOTE_INVALID','Remote task context exceeds payload limit',400);
  return summary;
}
function publicHandoff(db,row,item,org) {
  const facts=decode(row.snapshot_json,{});
  const current=item && (facts.workerScope ? workerRefs(db,row.organization_id,row.work_item_id,item.contract_revision,item.execution_epoch,facts.workerScope.nodeId) : sourceRefs(db,row.organization_id,row.work_item_id,item.contract_revision,item.execution_epoch));
  const reasons=[];
  if(!item) reasons.push('work_unavailable');
  if(item && item.row_version!==row.row_version) reasons.push('work_version_changed');
  if(item && item.contract_revision!==row.contract_revision) reasons.push('contract_revision_changed');
  if(item && item.execution_epoch!==row.execution_epoch) reasons.push('execution_epoch_changed');
  if(!org) reasons.push('organization_unavailable');
  else if(org.current_revision!==row.organization_revision) reasons.push('organization_revision_changed');
  if(item && facts.workerScope && item.assignee_node_id!==facts.workerScope.nodeId) reasons.push('assignee_changed');
  if(item && facts.workerScope && item.binding_generation!==facts.workerScope.bindingGeneration) reasons.push('binding_generation_changed');
  if(item && JSON.stringify(current)!==JSON.stringify(facts.sourceRefs)) reasons.push('source_refs_changed');
  const live=item && itemRow(db,item);
  const limited=!!(live && item.row_version===row.row_version && (encode(facts.contract)!==encode(live.contract) || encode(facts.blockedReason)!==encode(live.blockedReason)));
  const truncated=!!(facts.sourceRefs?.truncated || current?.truncated || facts.contractTruncated || facts.blockedReasonTruncated || limited);
  const unavailable=!facts.sourceRefs || facts.sourceRefs.unansweredMessageRefs==='unknown' || current?.unansweredMessageRefs==='unknown';
  const unknownExecution=Boolean(
    current?.bindings?.some(binding=>binding.status==='unknown')
    || current?.failures?.some(failure=>failure.failure_kind==='unknown_outcome')
    || current?.incidentRefs?.some(inc=>inc.category==='unknown_outcome' || (!inc.resolved_at && String(inc.side_effects || '').toLowerCase()==='unknown'))
    || current?.reconciliationFailures?.some(rf=>rf.state==='exhausted' || rf.state==='dead_letter')
  );
  if(truncated) reasons.push('source_data_truncated');
  if(unavailable) reasons.push('source_data_unavailable');
  if(unknownExecution) reasons.push('execution_outcome_unknown');
  const stale=!item || (!facts.workerScope && facts.sourceRefs?.truncated === true) || item.row_version!==row.row_version || item.contract_revision!==row.contract_revision || item.execution_epoch!==row.execution_epoch || org?.current_revision!==row.organization_revision || (facts.workerScope && (item.assignee_node_id!==facts.workerScope.nodeId || item.binding_generation!==facts.workerScope.bindingGeneration)) || JSON.stringify(current)!==JSON.stringify(facts.sourceRefs);
  const assessment=truncated||unavailable||unknownExecution||!item||!org?'unknown':stale?'stale':'current';
  const failureEvidence = current ? {
    failures: current.failures || [],
    incidentRefs: current.incidentRefs || [],
    reconciliationFailures: current.reconciliationFailures || [],
    artifactRefs: current.artifactRefs || [],
  } : null;
  return {
    id:row.id,
    organizationId:row.organization_id,
    workItemId:row.work_item_id,
    contractRevision:row.contract_revision,
    executionEpoch:row.execution_epoch,
    organizationRevision:row.organization_revision,
    asOf:row.created_at,
    sourceVersion:row.row_version,
    stale,
    staleReasons:reasons,
    assessment,
    assessesExecutionSafety:false,
    unknownExecution,
    autoRedispatchForbidden:unknownExecution,
    failureEvidence,
    freshness:facts.workerScope && (facts.sourceRefs?.truncated || facts.contractTruncated || facts.blockedReasonTruncated)?'unknown_truncated':'checked',
    facts,
    schemaVersion:1,
  };
}

// Internal dispatch path only. The caller must enforce the scheduler lease and
// current grant fence immediately before and after this transaction.
export async function prepareFactoryWorkerHandoff(scope) {
  const {organizationId,workItemId,nodeId,contractRevision,executionEpoch,bindingGeneration,nodeBindingGeneration,organizationRevision,dispatchKey,managedSessionId}=scope || {};
  if (![organizationId,workItemId,nodeId,dispatchKey,managedSessionId].every(value=>typeof value==='string' && value) || ![contractRevision,executionEpoch,bindingGeneration,nodeBindingGeneration,organizationRevision].every(Number.isInteger)) throw factoryError('FACTORY_INVALID','Incomplete worker handoff scope',400);
  return factoryTransaction(db=>{
    schema(db);
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
    const item=selectItem(db,organizationId,workItemId);
    const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND dispatch_key=?').get(workItemId,dispatchKey);
    const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId);
    if (!org || org.state!=='active' || org.current_revision!==organizationRevision || item.assignee_node_id!==nodeId || item.state!=='claimed' || item.control_state!=='none' || item.contract_revision!==contractRevision || item.execution_epoch!==executionEpoch || item.binding_generation!==bindingGeneration || !node || node.retired_revision!==null || node.current_session_id!==managedSessionId || node.binding_generation!==nodeBindingGeneration || !binding || binding.status!=='intent' || binding.contract_revision!==contractRevision || binding.execution_epoch!==executionEpoch || binding.binding_generation!==bindingGeneration) throw factoryError('FACTORY_CONFLICT','Worker handoff scope changed');
    const work=itemRow(db,item), refs=workerRefs(db,organizationId,workItemId,contractRevision,executionEpoch,nodeId);
    let contract=safeFact(work.contract); const contractTooLarge=Buffer.byteLength(encode(contract),'utf8')>12000; const contractTruncated=contractTooLarge || encode(contract)!==encode(work.contract); if(contractTooLarge) contract={omitted:'Contract details exceed the context limit; use the bound task contract.'};
    let blockedReason=safeFact(work.blockedReason); const blockedReasonTooLarge=Buffer.byteLength(encode(blockedReason),'utf8')>2000; const blockedReasonTruncated=blockedReasonTooLarge || encode(blockedReason)!==encode(work.blockedReason); if(blockedReasonTooLarge) blockedReason={omitted:'Blocked reason exceeds the context limit.'};
    const snapshot={state:work.state,controlState:work.controlState,assigneeNodeId:nodeId,contract,contractTruncated,contractDigest:work.contractDigest,blockedReason,blockedReasonTruncated,sourceRefs:refs,workerScope:{nodeId,bindingGeneration,nodeBindingGeneration},summaryLimits:'Selected sources are bounded; text fields and recipient message bodies may be shortened. Full contract and source records remain authoritative.'};
    if(Buffer.byteLength(encode(snapshot),'utf8')>32768) throw factoryError('FACTORY_INVALID','Task context exceeds its bounded size',400);
    const commandId=`handoff_dispatch_${createHash('sha256').update(JSON.stringify([organizationId,workItemId,dispatchKey,item.row_version,organizationRevision,snapshot])).digest('hex')}`;
    const existing=db.prepare('SELECT policy_json FROM collaborations WHERE root_session_id=? AND idempotency_key=?').get(org.root_session_id,dispatchKey);
    if (existing) {
      const fixed=decode(existing.policy_json,{})?.factoryExecution;
      const prior=fixed?.handoffId && db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=? AND work_item_id=?').get(fixed.handoffId,organizationId,workItemId);
      if (!prior || fixed.handoffDigest!==createHash('sha256').update(prior.snapshot_json).digest('hex') || prior.command_id!==commandId || publicHandoff(db,prior,item,org).stale) throw factoryError('FACTORY_CONFLICT','Existing dispatch handoff is stale; reconcile the fixed dispatch');
      return publicHandoff(db,prior,item,org);
    }
    if (binding.collaboration_id || binding.task_id || binding.attempt_id || binding.run_id || db.prepare('SELECT 1 FROM collaboration_dispatch_commands d LEFT JOIN collaborations c ON c.id=d.collaboration_id WHERE d.task_id=? AND c.id IS NULL LIMIT 1').get(workItemId)) throw factoryError('FACTORY_CONFLICT','Dispatch facts are incomplete; reconcile before preparing new input');
    const prior=db.prepare('SELECT * FROM factory_task_handoffs WHERE command_id=?').get(commandId);
    if (prior) { const result=publicHandoff(db,prior,item,org); if(result.stale) throw factoryError('FACTORY_CONFLICT','Dispatch handoff is stale'); return result; }
    const id=`handoff_${randomUUID()}`,ts=now(),payloadDigest=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    db.prepare('INSERT INTO factory_task_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,organizationId,workItemId,commandId,'factory-dispatch-service',payloadDigest,item.row_version,contractRevision,executionEpoch,encode(snapshot),ts,organizationRevision);
    return publicHandoff(db,db.prepare('SELECT * FROM factory_task_handoffs WHERE id=?').get(id),item,org);
  });
}

export function verifyFactoryWorkerHandoff(db,context) {
  const row=db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=? AND work_item_id=?').get(context.handoffId,context.organizationId,context.workItemId);
  if (!row || createHash('sha256').update(row.snapshot_json).digest('hex')!==context.handoffDigest) return false;
  const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(context.organizationId), item=selectItem(db,context.organizationId,context.workItemId);
  const facts=decode(row.snapshot_json,{}), node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assignee_node_id,context.organizationId);
  return !!org && !!node && facts.workerScope?.nodeId===node.id && facts.workerScope?.bindingGeneration===context.bindingGeneration && facts.workerScope?.nodeBindingGeneration===node.binding_generation && node.current_session_id===context.managedSessionId && row.contract_revision===context.contractRevision && row.execution_epoch===context.executionEpoch && !publicHandoff(db,row,item,org).stale;
}
export async function createFactoryTaskHandoff(input,actor) {
  const organizationId=required(input?.organizationId,'organizationId'),workItemId=required(input?.workItemId,'workItemId'),commandId=required(input?.commandId,'commandId');
  if(actor?.kind!=='user' || actor?.role!=='owner') throw factoryError('FACTORY_FORBIDDEN','Owner access required',403);
  const payloadDigest=createHash('sha256').update(JSON.stringify({organizationId,workItemId,expectedVersion:input.expectedVersion,actor:actor.principalId})).digest('hex');
  return factoryTransaction(db=>{ schema(db); const org=authorize(db,organizationId,actor,'factory.read');
    const old=db.prepare('SELECT * FROM factory_task_handoffs WHERE command_id=?').get(commandId);
    if(old) { if(old.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Command ID belongs to another handoff'); return {...publicHandoff(db,old,selectItem(db,organizationId,workItemId),org),replayed:true}; }
    if (['archived','lifecycle_pending'].includes(org.state)) throw factoryError('FACTORY_CONFLICT','Organization lifecycle does not permit new handoffs');
    const row=selectItem(db,organizationId,workItemId); if(row.row_version!==input.expectedVersion) throw factoryError('FACTORY_CONFLICT','Work item version changed');
    const item=itemRow(db,row);
    const snapshot={state:item.state,controlState:item.controlState,assigneeNodeId:item.assigneeNodeId,contract:safeFact(item.contract),
      contractDigest:item.contractDigest,blockedReason:safeFact(item.blockedReason),sourceRefs:sourceRefs(db,organizationId,workItemId,item.contractRevision,item.executionEpoch)};
    if(Buffer.byteLength(encode(snapshot),'utf8')>32768) throw factoryError('FACTORY_INVALID','Task context exceeds its bounded size',400);
    const id=`handoff_${randomUUID()}`,ts=now(); db.prepare('INSERT INTO factory_task_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,organizationId,workItemId,commandId,actor.principalId,payloadDigest,row.row_version,row.contract_revision,row.execution_epoch,encode(snapshot),ts,org.current_revision);
    return publicHandoff(db,db.prepare('SELECT * FROM factory_task_handoffs WHERE id=?').get(id),row,org);
  });
}
export async function getFactoryTaskHandoff(organizationId,id,actor) {
  return factoryRead(db=>{ schema(db); const org=authorize(db,organizationId,actor,'factory.read'); const row=db.prepare('SELECT * FROM factory_task_handoffs WHERE id=? AND organization_id=?').get(id,organizationId); if(!row) throw factoryError('FACTORY_NOT_FOUND','Handoff not found',404); return publicHandoff(db,row,selectItem(db,organizationId,row.work_item_id),org); });
}
export async function getWorkerFailureHandoffEvidence(organizationId,workItemId,actor) {
  return factoryRead(db=>{ schema(db); authorize(db,organizationId,actor,'factory.read'); selectItem(db,organizationId,workItemId); return { schemaVersion: 1, organizationId, workItemId, ...collectWorkerFailureHandoffEvidence(db,organizationId,workItemId) }; });
}
