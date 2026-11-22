// Source-side binding, 3-state offline tracking, and receipt journal;
// target execution never becomes a source Work Graph acceptance decision.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, decode } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { signRemoteFactoryDelegation, signRemoteFactoryCancellation } from './remote-factory-operations.mjs';
import { verifySourceRemoteDelegation } from './factory-remote-admission.mjs';
import { remoteFactoryTaskSummary } from './factory-task-handoff.mjs';
import { proxyToTarget } from './router-target-runtime-routes.mjs';
import {
  getDeviceCapabilities,
  selectAuthorizedDeviceForTask,
  normalizePeerPolicySlice,
  configureDevicePeerAuthorization,
  getDevicePeerAuthorization,
} from './device-capability-registry.mjs';

export const REMOTE_OFFLINE_STATES = Object.freeze([
  'not_dispatched',
  'dispatched_unconfirmed',
  'dispatched_confirmed',
  'executed_unsynced',
  'synced',
  'terminal',
  'cancelled',
]);

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
const canonicalHash = (value) => hash(canonicalize(value));

function required(value, name) {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(result)) throw factoryError('REMOTE_INVALID', `${name} is invalid`, 400);
  return result;
}

function addColumn(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_factory_source_bindings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      target_instance_id TEXT NOT NULL,
      target_public_key TEXT NOT NULL,
      target_binding_id TEXT NOT NULL,
      target_binding_version INTEGER NOT NULL,
      version INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_factory_source_operations (
      binding_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      source_factory_binding_id TEXT NOT NULL UNIQUE,
      payload_digest TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(binding_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS remote_factory_reroute_journal (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      source_factory_binding_id TEXT NOT NULL,
      old_binding_id TEXT NOT NULL,
      old_operation_id TEXT NOT NULL,
      new_binding_id TEXT NOT NULL,
      new_operation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      rerouted_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  addColumn(db, 'remote_factory_source_bindings', 'binding_policy_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, 'remote_factory_source_operations', 'offline_state', "TEXT NOT NULL DEFAULT 'not_dispatched'");
  addColumn(db, 'remote_factory_source_operations', 'wire_dispatched', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_factory_source_operations', 'candidate_synced', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_factory_source_operations', 'candidate_digest', 'TEXT');
  addColumn(db, 'remote_factory_source_operations', 'candidate_json', 'TEXT');
  addColumn(db, 'remote_factory_source_operations', 'last_error', 'TEXT');
  addColumn(db, 'remote_factory_source_operations', 'dispatched_at', 'TEXT');
  addColumn(db, 'remote_factory_source_operations', 'synced_at', 'TEXT');
}

function binding(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    targetInstanceId: row.target_instance_id,
    targetPublicKey: row.target_public_key,
    targetBindingId: row.target_binding_id,
    targetBindingVersion: row.target_binding_version,
    version: row.version,
    enabled: !!row.enabled,
    expiresAt: row.expires_at,
    bindingPolicy: decode(row.binding_policy_json, {}),
  };
}

function projectSourceOperation(row) {
  if (!row) return null;
  const saved = decode(row.request_json, {});
  const receiptEnvelope = decode(row.receipt_json, null);
  return {
    bindingId: row.binding_id,
    operationId: row.operation_id,
    sourceFactoryBindingId: row.source_factory_binding_id,
    payloadDigest: row.payload_digest,
    status: row.status,
    offlineState: row.offline_state || (row.wire_dispatched ? 'dispatched_unconfirmed' : 'not_dispatched'),
    wireDispatched: Boolean(row.wire_dispatched),
    candidateSynced: Boolean(row.candidate_synced),
    candidateDigest: row.candidate_digest || null,
    lastError: row.last_error || null,
    dispatchedAt: row.dispatched_at || null,
    syncedAt: row.synced_at || null,
    targetInstanceId: saved?.binding?.targetInstanceId || null,
    receipt: receiptEnvelope?.receipt || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function configureRemoteFactorySourceBinding(input, actor) {
  const id = required(input?.id, 'id');
  const organizationId = required(input?.organizationId, 'organizationId');
  const target = required(input?.targetInstanceId, 'targetInstanceId');
  const targetBindingId = required(input?.targetBindingId, 'targetBindingId');
  if (actor?.kind !== 'user' || actor?.role !== 'owner') {
    throw factoryError('REMOTE_FORBIDDEN', 'Owner required', 403);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || !Number.isSafeInteger(input.targetBindingVersion) || input.targetBindingVersion < 1
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
    throw factoryError('REMOTE_INVALID', 'Binding version or expiry invalid', 400);
  }
  const key = text(input.targetPublicKey);
  try {
    if (createPublicKey(key).asymmetricKeyType !== 'ed25519'
        || `inst_${createInstancePublicKeyFingerprint(key).slice(0, 32)}` !== target) {
      throw new Error();
    }
  } catch {
    throw factoryError('REMOTE_INVALID', 'Target key does not match instance', 400);
  }
  const bindingPolicy = normalizePeerPolicySlice(input?.bindingPolicy || {});
  const result = await factoryTransaction((db) => {
    schema(db);
    authorize(db, organizationId, actor, 'factory.read');
    const old = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(id);
    if ((old?.version || 0) !== input.expectedVersion || (old && old.organization_id !== organizationId)) {
      throw factoryError('REMOTE_CONFLICT', 'Source binding changed', 409);
    }
    db.prepare(`
      INSERT INTO remote_factory_source_bindings (
        id, organization_id, target_instance_id, target_public_key,
        target_binding_id, target_binding_version, version, enabled, expires_at, updated_at, binding_policy_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        target_instance_id=excluded.target_instance_id,
        target_public_key=excluded.target_public_key,
        target_binding_id=excluded.target_binding_id,
        target_binding_version=excluded.target_binding_version,
        version=excluded.version,
        enabled=excluded.enabled,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at,
        binding_policy_json=excluded.binding_policy_json
    `).run(
      id, organizationId, target, key,
      targetBindingId, input.targetBindingVersion, input.expectedVersion + 1,
      input.enabled === false ? 0 : 1, new Date(input.expiresAt).toISOString(),
      now(), JSON.stringify(bindingPolicy),
    );
    return binding(db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(id));
  });

  if (input.ownerPolicy !== undefined || input.bindingPolicy !== undefined || input.ownerAuthorized !== undefined) {
    const existingPolicy = await getDevicePeerAuthorization(organizationId, target, { bindingId: id }).catch(() => null);
    await configureDevicePeerAuthorization({
      id: existingPolicy?.id,
      organizationId,
      bindingId: id,
      targetInstanceId: target,
      expectedVersion: existingPolicy?.version || 0,
      ownerAuthorized: input.ownerAuthorized !== false,
      ownerPolicy: input.ownerPolicy || existingPolicy?.ownerPolicy || {},
      bindingPolicy,
      enabled: input.enabled !== false,
      expiresAt: input.expiresAt,
    }, actor);
  }

  return result;
}

function verifyReceipt(envelope, b, request, sourceId) {
  if (!envelope || envelope.targetInstanceId !== b.targetInstanceId || !envelope.receipt
      || envelope.receipt.bindingId !== b.targetBindingId
      || envelope.receipt.operationId !== request.operationId || envelope.receipt.sourceInstanceId !== sourceId
      || envelope.receipt.requestId !== request.requestId
      || envelope.receipt.bindingVersion !== b.targetBindingVersion
      || envelope.receipt.sourceFactoryBindingId !== request.sourceFactoryBindingId
      || envelope.receipt.contractRevision !== request.contractRevision
      || envelope.receipt.executionEpoch !== request.executionEpoch) {
    throw factoryError('REMOTE_RECEIPT_INVALID', 'Receipt scope mismatch', 502);
  }
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(`ragent-remote-receipt-v1:${hash({ targetInstanceId: envelope.targetInstanceId, receipt: envelope.receipt })}`),
      createPublicKey(b.targetPublicKey),
      Buffer.from(text(envelope.signature), 'base64url'),
    );
  } catch {}
  if (!valid) throw factoryError('REMOTE_RECEIPT_INVALID', 'Receipt signature invalid', 502);
  return envelope.receipt;
}

function deriveOfflineStateFromReceipt(receipt, alreadySynced = false) {
  if (alreadySynced) return 'synced';
  if (receipt?.executionSyncState === 'executed_unsynced'
      || receipt?.candidateAvailable === true
      || receipt?.target?.state === 'review') {
    return 'executed_unsynced';
  }
  if (['failed', 'cancelled'].includes(receipt?.target?.state)
      || ['failed', 'cancelled'].includes(receipt?.target?.execution?.attemptState)) {
    return 'terminal';
  }
  return 'dispatched_confirmed';
}

async function readTargetRevision(targetId, proxyImpl = proxyToTarget) {
  const requestId = `summary_${randomUUID()}`;
  const { response, body } = await proxyImpl({
    targetId,
    requestId,
    idempotencyKey: requestId,
    method: 'GET',
    path: '/api/runtime/summary',
    operation: 'runtime.summary',
    resourceId: targetId,
    expectedRevision: 0,
  });
  if (!response.ok) throw factoryError('REMOTE_UNAVAILABLE', 'Target revision unavailable', 503);
  const summary = JSON.parse(body.toString('utf8'));
  const revision = Number(summary?.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw factoryError('REMOTE_UNAVAILABLE', 'Target revision invalid', 503);
  }
  return revision;
}

function buildCanonicalPayload(db, input, b, operationId) {
  const canonical = {
    bindingId: b.target_binding_id,
    operationId,
    requestId: required(input.requestId, 'requestId'),
    sourceFactoryBindingId: required(input.sourceFactoryBindingId, 'sourceFactoryBindingId'),
    bindingVersion: b.target_binding_version,
    contractRevision: input.contractRevision,
    executionEpoch: input.executionEpoch,
    contractDigest: input.contractDigest,
    payload: {
      ...input.payload,
      sourceBindingId: b.id,
      sourceBindingVersion: b.version,
      sourceWorkItemId: input.workItemId,
      taskSummary: null,
      taskSummaryDigest: '0'.repeat(64),
    },
  };
  // Reserve space for the signature field and its encoded value on the wire.
  const summaryBudget = 32768 - 256 - Buffer.byteLength(JSON.stringify(canonical), 'utf8') + 4;
  canonical.payload.taskSummary = remoteFactoryTaskSummary(db, input, summaryBudget);
  canonical.payload.taskSummaryDigest = hash(canonical.payload.taskSummary);
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > 32768) {
    throw factoryError('REMOTE_INVALID', 'Remote operation exceeds its shared payload limit', 400);
  }
  return canonical;
}

export async function dispatchRemoteFactoryOperation(
  input,
  actor,
  { verifyExternal, autoRoute = false, taskRequirements = null, ownerPolicy = null, proxyImpl = proxyToTarget } = {},
) {
  if (process.env.RAGENT_REMOTE_FACTORY_ENABLED !== '1') {
    throw factoryError('REMOTE_FACTORY_DISABLED', 'Remote Factory admission is disabled', 503);
  }
  if (typeof verifyExternal !== 'function') {
    throw factoryError('REMOTE_UNAVAILABLE', 'External authorization recheck required', 409);
  }

  let effectiveInput = { ...input };
  if (autoRoute === true || (!text(effectiveInput.bindingId) && taskRequirements)) {
    const selection = await selectAuthorizedDeviceForTask({
      organizationId: effectiveInput.organizationId,
      ...(taskRequirements || {}),
      accessMode: effectiveInput.payload?.contract?.accessMode || 'write',
      allowedPaths: effectiveInput.payload?.contract?.allowedPaths || [],
      requireRemoteFactoryBinding: true,
    }, { ownerPolicy });
    if (!selection.selected?.bindingId) {
      throw factoryError(
        'REMOTE_NO_AUTHORIZED_DEVICE',
        selection.reason || 'No authorized remote device matches task requirements',
        409,
        { rejected: selection.rejected },
      );
    }
    effectiveInput = {
      ...effectiveInput,
      bindingId: selection.selected.bindingId,
      bindingVersion: selection.selected.bindingVersion,
      payload: {
        ...(effectiveInput.payload || {}),
        sourceBindingId: selection.selected.bindingId,
        sourceBindingVersion: selection.selected.bindingVersion,
      },
    };
  }

  const bindingId = required(effectiveInput?.bindingId, 'bindingId');
  const operationId = required(effectiveInput?.operationId, 'operationId');
  const sourceId = (await loadOrCreateInstanceIdentity()).instanceId;

  const prepared = await factoryTransaction((db) => {
    schema(db);
    const b = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    if (!b || !b.enabled || Date.parse(b.expires_at) <= Date.now()
        || b.organization_id !== effectiveInput.organizationId || b.version !== effectiveInput.bindingVersion
        || effectiveInput.payload?.sourceBindingId !== b.id
        || effectiveInput.payload?.sourceBindingVersion !== b.version) {
      throw factoryError('REMOTE_FORBIDDEN', 'Source binding unavailable', 403);
    }
    verifySourceRemoteDelegation(db, effectiveInput, actor);
    const canonical = buildCanonicalPayload(db, effectiveInput, b, operationId);
    const payloadDigest = hash(canonical);
    const old = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?')
      .get(bindingId, operationId);
    if (old) {
      const saved = JSON.parse(old.request_json).canonical;
      const withoutSummary = (value) => {
        const payload = { ...value.payload };
        delete payload.taskSummary;
        delete payload.taskSummaryDigest;
        if (!saved.payload.sourceWorkItemId) delete payload.sourceWorkItemId;
        return { ...value, payload };
      };
      if (hash(saved) !== old.payload_digest || canonicalHash(withoutSummary(saved)) !== canonicalHash(withoutSummary(canonical))) {
        throw factoryError('REMOTE_CONFLICT', 'Operation identity reused', 409);
      }
      const existingOfflineState = old.offline_state || (old.wire_dispatched ? 'dispatched_unconfirmed' : 'not_dispatched');
      if (existingOfflineState !== 'not_dispatched' || Number(old.wire_dispatched) !== 0) {
        return {
          existing: true,
          replayForbidden: true,
          offlineState: existingOfflineState,
          binding: binding(b),
          canonical: saved,
        };
      }
      // Operation remained in not_dispatched (never crossed wire); refresh summary if needed.
      const ts = now();
      db.prepare('UPDATE remote_factory_source_operations SET payload_digest=?, request_json=?, updated_at=? WHERE binding_id=? AND operation_id=?')
        .run(payloadDigest, JSON.stringify({ canonical, binding: binding(b), sourceInstanceId: sourceId }), ts, bindingId, operationId);
      return { binding: binding(b), canonical, resumedNotDispatched: true };
    }
    if (db.prepare('SELECT 1 FROM remote_factory_source_operations WHERE source_factory_binding_id=?')
      .get(effectiveInput.sourceFactoryBindingId)) {
      throw factoryError('REMOTE_CONFLICT', 'Factory binding already delegated', 409);
    }
    const sourceBinding = binding(b);
    const ts = now();
    db.prepare(`
      INSERT INTO remote_factory_source_operations (
        binding_id, operation_id, source_factory_binding_id, payload_digest,
        request_json, status, receipt_json, created_at, updated_at,
        offline_state, wire_dispatched, candidate_synced
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      bindingId, operationId, effectiveInput.sourceFactoryBindingId, payloadDigest,
      JSON.stringify({ canonical, binding: sourceBinding, sourceInstanceId: sourceId }),
      'not_dispatched', null, ts, ts, 'not_dispatched', 0, 0,
    );
    return { binding: sourceBinding, canonical };
  });

  if (prepared.replayForbidden) {
    return {
      status: 'unknown',
      offlineState: prepared.offlineState,
      bindingId,
      operationId,
      reason: 'query_required',
      replayForbidden: true,
    };
  }

  // If device registry already knows target is offline/stale BEFORE wire send, stay not_dispatched.
  const registeredDevice = await getDeviceCapabilities(prepared.binding.targetInstanceId).catch(() => null);
  if (registeredDevice && registeredDevice.status !== 'online') {
    const reason = `target_device_${registeredDevice.status}`;
    await factoryTransaction((db) => {
      schema(db);
      db.prepare("UPDATE remote_factory_source_operations SET last_error=?, updated_at=? WHERE binding_id=? AND operation_id=? AND offline_state='not_dispatched'")
        .run(reason, now(), bindingId, operationId);
    });
    return {
      status: 'not_dispatched',
      offlineState: 'not_dispatched',
      bindingId,
      operationId,
      targetInstanceId: prepared.binding.targetInstanceId,
      reason,
      canWait: true,
      canReroute: true,
    };
  }

  const evidence = await verifyExternal();
  if (!evidence || evidence.clean !== true || !/^[a-f0-9]{40,64}$/.test(text(evidence.baseHead))
      || !text(evidence.baseBranch) || !/^[a-f0-9]{64}$/.test(text(evidence.baselineDigest))
      || evidence.baselineDigest !== prepared.canonical.payload.expectedBaselineDigest
      || evidence.baseHead !== prepared.canonical.payload.expectedBaseHead
      || evidence.baseBranch !== prepared.canonical.payload.expectedBaseBranch) {
    throw factoryError('REMOTE_CONFLICT', 'Source repository baseline changed', 409);
  }

  const checkBeforeSend = () => factoryRead((db) => {
    const current = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    if (!current || !current.enabled || current.version !== prepared.binding.version
        || Date.parse(current.expires_at) <= Date.now()) {
      throw factoryError('REMOTE_FORBIDDEN', 'Source binding changed', 403);
    }
    verifySourceRemoteDelegation(db, effectiveInput, actor);
    const template = {
      ...prepared.canonical,
      payload: { ...prepared.canonical.payload, taskSummary: null, taskSummaryDigest: '0'.repeat(64) },
    };
    const summary = remoteFactoryTaskSummary(db, effectiveInput, 32768 - 256 - Buffer.byteLength(JSON.stringify(template), 'utf8') + 4);
    if (hash(summary) !== prepared.canonical.payload.taskSummaryDigest) {
      throw factoryError('REMOTE_CONFLICT', 'Remote task context changed before sending', 409);
    }
  });

  await checkBeforeSend();

  let targetRevision;
  try {
    targetRevision = await readTargetRevision(prepared.binding.targetInstanceId, proxyImpl);
  } catch (error) {
    // Summary probe is read-only and failed BEFORE the side-effecting POST crossed the wire.
    const reason = 'target_unreachable_before_dispatch';
    await factoryTransaction((db) => {
      schema(db);
      db.prepare("UPDATE remote_factory_source_operations SET last_error=?, updated_at=? WHERE binding_id=? AND operation_id=? AND offline_state='not_dispatched'")
        .run(text(error?.message) || reason, now(), bindingId, operationId);
    });
    return {
      status: 'not_dispatched',
      offlineState: 'not_dispatched',
      bindingId,
      operationId,
      targetInstanceId: prepared.binding.targetInstanceId,
      reason,
      canWait: true,
      canReroute: true,
    };
  }

  await checkBeforeSend();
  const signed = await signRemoteFactoryDelegation(prepared.canonical);
  const path = `/api/remote-factory/bindings/${prepared.binding.targetBindingId}/operations/${operationId}`;
  const signedBody = JSON.stringify({ ...prepared.canonical, signature: signed.signature });
  if (Buffer.byteLength(signedBody, 'utf8') > 32768) {
    throw factoryError('REMOTE_INVALID', 'Signed remote operation exceeds its shared payload limit', 400);
  }

  // Persist dispatched_unconfirmed BEFORE sending POST across the wire so a crash
  // or dropped response never leads to blind replay or unsafe rerouting.
  await factoryTransaction((db) => {
    schema(db);
    const ts = now();
    const res = db.prepare(`
      UPDATE remote_factory_source_operations
      SET status='unknown', offline_state='dispatched_unconfirmed', wire_dispatched=1,
          dispatched_at=?, updated_at=?, last_error=NULL
      WHERE binding_id=? AND operation_id=? AND offline_state='not_dispatched' AND wire_dispatched=0
    `).run(ts, ts, bindingId, operationId);
    if (res.changes !== 1) {
      throw factoryError('REMOTE_CONFLICT', 'Operation already crossed dispatch boundary', 409);
    }
  });

  try {
    const { response, body } = await proxyImpl({
      targetId: prepared.binding.targetInstanceId,
      requestId: effectiveInput.requestId,
      idempotencyKey: effectiveInput.requestId,
      method: 'POST',
      path,
      operation: 'factory.remote.accept',
      resourceId: prepared.binding.targetBindingId,
      expectedRevision: targetRevision,
      body: signedBody,
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error('Target admission unavailable');
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = verifyReceipt(envelope, prepared.binding, prepared.canonical, sourceId);
    const nextOfflineState = deriveOfflineStateFromReceipt(receipt, false);
    await factoryTransaction((db) => {
      schema(db);
      db.prepare(`
        UPDATE remote_factory_source_operations
        SET status=?, offline_state=?, receipt_json=?, last_error=NULL, updated_at=?
        WHERE binding_id=? AND operation_id=?
      `).run(receipt.status, nextOfflineState, JSON.stringify(envelope), now(), bindingId, operationId);
    });
    return { ...receipt, offlineState: nextOfflineState };
  } catch (error) {
    await factoryTransaction((db) => {
      schema(db);
      db.prepare('UPDATE remote_factory_source_operations SET last_error=?, updated_at=? WHERE binding_id=? AND operation_id=?')
        .run(text(error?.message) || 'dispatch_unconfirmed', now(), bindingId, operationId);
    }).catch(() => {});
    return {
      status: 'unknown',
      offlineState: 'dispatched_unconfirmed',
      bindingId,
      operationId,
      reason: 'query_required',
      replayForbidden: true,
      canReroute: false,
    };
  }
}

export async function rerouteNotDispatchedOperation(
  {
    bindingId,
    operationId,
    newBindingId = '',
    newOperationId = '',
    taskRequirements = {},
    ownerPolicy = null,
    reason = 'target_offline',
  } = {},
  actor,
) {
  if (process.env.RAGENT_REMOTE_FACTORY_ENABLED !== '1') {
    throw factoryError('REMOTE_FACTORY_DISABLED', 'Remote Factory admission is disabled', 503);
  }
  const oldBindingId = required(bindingId, 'bindingId');
  const oldOperationId = required(operationId, 'operationId');
  if (!actor || !['user', 'service'].includes(actor.kind)) {
    throw factoryError('REMOTE_FORBIDDEN', 'Authorized actor required', 403);
  }

  const snapshot = await factoryRead((db) => {
    schema(db);
    const oldBinding = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(oldBindingId);
    const oldOp = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?')
      .get(oldBindingId, oldOperationId);
    if (!oldBinding || !oldOp) throw factoryError('REMOTE_NOT_FOUND', 'Operation unavailable', 404);
    authorize(db, oldBinding.organization_id, actor, 'factory.read');
    if (oldOp.offline_state !== 'not_dispatched' || Number(oldOp.wire_dispatched) !== 0 || oldOp.receipt_json) {
      throw factoryError('REMOTE_REROUTE_FORBIDDEN', 'Cannot reroute dispatched or unconfirmed operation; query receipt instead', 409);
    }
    const saved = JSON.parse(oldOp.request_json);
    return { organizationId: oldBinding.organization_id, oldBinding, oldOp, saved };
  });

  let targetBindingId = text(newBindingId);
  if (!targetBindingId) {
    const contract = snapshot.saved?.canonical?.payload?.contract || {};
    const selection = await selectAuthorizedDeviceForTask({
      organizationId: snapshot.organizationId,
      ...(taskRequirements || {}),
      accessMode: contract.accessMode || 'write',
      allowedPaths: contract.allowedPaths || [],
      excludeInstanceIds: [snapshot.oldBinding.target_instance_id],
      requireRemoteFactoryBinding: true,
    }, { ownerPolicy });
    if (!selection.selected?.bindingId) {
      throw factoryError(
        'REMOTE_NO_AUTHORIZED_DEVICE',
        selection.reason || 'No alternate authorized device available for reroute',
        409,
        { rejected: selection.rejected },
      );
    }
    targetBindingId = selection.selected.bindingId;
  }
  targetBindingId = required(targetBindingId, 'newBindingId');
  if (targetBindingId === oldBindingId) {
    throw factoryError('REMOTE_CONFLICT', 'Reroute requires a different target binding', 409);
  }

  const replacementOpId = newOperationId
    ? required(newOperationId, 'newOperationId')
    : `${oldOperationId.slice(0, 120)}_r_${randomUUID().slice(0, 8)}`;

  return factoryTransaction((db) => {
    schema(db);
    const currentOp = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?')
      .get(oldBindingId, oldOperationId);
    if (!currentOp || currentOp.offline_state !== 'not_dispatched' || Number(currentOp.wire_dispatched) !== 0 || currentOp.receipt_json) {
      throw factoryError('REMOTE_REROUTE_FORBIDDEN', 'Operation crossed wire boundary concurrently', 409);
    }
    const nextBinding = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(targetBindingId);
    if (!nextBinding || !nextBinding.enabled || Date.parse(nextBinding.expires_at) <= Date.now()
        || nextBinding.organization_id !== snapshot.organizationId) {
      throw factoryError('REMOTE_FORBIDDEN', 'Alternate source binding unavailable', 403);
    }
    if (nextBinding.target_instance_id === snapshot.oldBinding.target_instance_id) {
      throw factoryError('REMOTE_CONFLICT', 'Alternate binding targets the same device', 409);
    }
    if (db.prepare('SELECT 1 FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(targetBindingId, replacementOpId)) {
      throw factoryError('REMOTE_CONFLICT', 'Target operation ID already exists', 409);
    }

    const oldSaved = JSON.parse(currentOp.request_json);
    const nextBindingObj = binding(nextBinding);
    const nextCanonical = {
      ...oldSaved.canonical,
      bindingId: nextBinding.target_binding_id,
      bindingVersion: nextBinding.target_binding_version,
      operationId: replacementOpId,
      payload: {
        ...oldSaved.canonical.payload,
        sourceBindingId: nextBinding.id,
        sourceBindingVersion: nextBinding.version,
      },
    };
    const nextDigest = hash(nextCanonical);
    const ts = now();

    db.prepare(`
      INSERT INTO remote_factory_reroute_journal (
        id, organization_id, source_factory_binding_id, old_binding_id, old_operation_id,
        new_binding_id, new_operation_id, reason, rerouted_by, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      `reroute_${randomUUID()}`, snapshot.organizationId, currentOp.source_factory_binding_id,
      oldBindingId, oldOperationId, targetBindingId, replacementOpId,
      text(reason) || 'target_offline', actor.principalId || actor.role || 'owner', ts,
    );

    db.prepare('DELETE FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?')
      .run(oldBindingId, oldOperationId);
    db.prepare(`
      INSERT INTO remote_factory_source_operations (
        binding_id, operation_id, source_factory_binding_id, payload_digest,
        request_json, status, receipt_json, created_at, updated_at,
        offline_state, wire_dispatched, candidate_synced
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      targetBindingId, replacementOpId, currentOp.source_factory_binding_id, nextDigest,
      JSON.stringify({ canonical: nextCanonical, binding: nextBindingObj, sourceInstanceId: oldSaved.sourceInstanceId }),
      'not_dispatched', null, ts, ts, 'not_dispatched', 0, 0,
    );

    return {
      rerouted: true,
      oldBindingId,
      oldOperationId,
      newBindingId: targetBindingId,
      newOperationId: replacementOpId,
      newBindingVersion: nextBinding.version,
      targetInstanceId: nextBinding.target_instance_id,
      sourceFactoryBindingId: currentOp.source_factory_binding_id,
      offlineState: 'not_dispatched',
    };
  });
}

export async function getRemoteFactorySourceOperation(bindingId, operationId, actor) {
  bindingId = required(bindingId, 'bindingId');
  operationId = required(operationId, 'operationId');
  return factoryRead((db) => {
    schema(db);
    const b = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    const o = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId, operationId);
    if (!b || !o) throw factoryError('REMOTE_NOT_FOUND', 'Operation unavailable', 404);
    authorize(db, b.organization_id, actor, 'factory.read');
    return projectSourceOperation(o);
  });
}

export async function queryRemoteFactoryOperation(bindingId, operationId, actor, { targetRevision = 0, proxyImpl = proxyToTarget } = {}) {
  bindingId = required(bindingId, 'bindingId');
  operationId = required(operationId, 'operationId');
  const data = await factoryRead((db) => {
    schema(db);
    const b = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    const o = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId, operationId);
    if (!b || !o) throw factoryError('REMOTE_NOT_FOUND', 'Operation unavailable', 404);
    authorize(db, b.organization_id, actor, 'factory.read');
    const saved = JSON.parse(o.request_json);
    return {
      binding: saved.binding,
      request: saved.canonical,
      offlineState: o.offline_state || (o.wire_dispatched ? 'dispatched_unconfirmed' : 'not_dispatched'),
      wireDispatched: Boolean(o.wire_dispatched),
      candidateSynced: Boolean(o.candidate_synced),
    };
  });

  if (data.offlineState === 'not_dispatched' && !data.wireDispatched) {
    return {
      status: 'not_dispatched',
      offlineState: 'not_dispatched',
      bindingId,
      operationId,
      wireDispatched: false,
      canWait: true,
      canReroute: true,
    };
  }

  const path = `/api/remote-factory/bindings/${data.binding.targetBindingId}/operations/${operationId}`;
  const identity = await loadOrCreateInstanceIdentity();
  try {
    const requestId = `read_${randomUUID()}`;
    const { response, body } = await proxyImpl({
      targetId: data.binding.targetInstanceId,
      requestId,
      idempotencyKey: requestId,
      method: 'GET',
      path,
      operation: 'factory.remote.read',
      resourceId: data.binding.targetBindingId,
      expectedRevision: targetRevision,
    });
    if (!response.ok) throw new Error('Target receipt unavailable');
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = verifyReceipt(envelope, data.binding, data.request, identity.instanceId);
    const nextOfflineState = deriveOfflineStateFromReceipt(receipt, data.candidateSynced);
    await factoryTransaction((db) => {
      schema(db);
      db.prepare(`
        UPDATE remote_factory_source_operations
        SET status=?, offline_state=?, receipt_json=?, last_error=NULL, updated_at=?
        WHERE binding_id=? AND operation_id=?
      `).run(receipt.status, nextOfflineState, JSON.stringify(envelope), now(), bindingId, operationId);
    });
    return { ...receipt, offlineState: nextOfflineState };
  } catch {
    return {
      status: 'unknown',
      offlineState: data.offlineState === 'dispatched_confirmed' ? 'dispatched_unconfirmed' : data.offlineState,
      bindingId,
      operationId,
      reason: 'query_required',
      replayForbidden: true,
    };
  }
}

export async function fetchRemoteFactoryCandidate(bindingId, operationId, actor, { targetRevision = 0, proxyImpl = proxyToTarget } = {}) {
  bindingId = required(bindingId, 'bindingId');
  operationId = required(operationId, 'operationId');
  const data = await factoryRead((db) => {
    schema(db);
    const b = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    const o = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId, operationId);
    if (!b || !o || !b.enabled || Date.parse(b.expires_at) <= Date.now()) {
      throw factoryError('REMOTE_NOT_FOUND', 'Candidate authorization unavailable', 404);
    }
    authorize(db, b.organization_id, actor, 'factory.read');
    const saved = JSON.parse(o.request_json);
    if (!saved.binding || saved.binding.version !== b.version
        || saved.binding.targetInstanceId !== b.target_instance_id
        || saved.binding.targetPublicKey !== b.target_public_key) {
      throw factoryError('REMOTE_CONFLICT', 'Source authorization changed', 409);
    }
    return { binding: saved.binding, request: saved.canonical };
  });

  const path = `/api/remote-factory/bindings/${data.binding.targetBindingId}/operations/${operationId}/candidate`;
  const requestId = `candidate_${randomUUID()}`;
  const { response, body } = await proxyImpl({
    targetId: data.binding.targetInstanceId,
    requestId,
    idempotencyKey: requestId,
    method: 'GET',
    path,
    operation: 'factory.remote.candidate.read',
    resourceId: data.binding.targetBindingId,
    expectedRevision: targetRevision,
  });
  if (!response.ok || body.length > 4 * 1024 * 1024 + 4096) {
    throw factoryError('REMOTE_UNAVAILABLE', 'Candidate unavailable or too large', 503);
  }
  let signed;
  try {
    signed = JSON.parse(body.toString('utf8'));
  } catch {
    throw factoryError('REMOTE_RECEIPT_INVALID', 'Invalid candidate envelope', 502);
  }
  const e = signed?.envelope;
  const q = data.request;
  const local = (await loadOrCreateInstanceIdentity()).instanceId;
  if (!e || e.sourceInstanceId !== local || e.targetInstanceId !== data.binding.targetInstanceId
      || e.targetBindingId !== data.binding.targetBindingId || e.targetBindingVersion !== data.binding.targetBindingVersion
      || e.sourceBindingId !== bindingId || e.sourceBindingVersion !== data.binding.version
      || e.operationId !== operationId || e.requestId !== q.requestId
      || e.sourceFactoryBindingId !== q.sourceFactoryBindingId
      || e.sourceContractRevision !== q.contractRevision || e.sourceExecutionEpoch !== q.executionEpoch
      || e.baselineManifestDigest !== q.payload.expectedBaselineDigest) {
    throw factoryError('REMOTE_RECEIPT_INVALID', 'Candidate scope or baseline mismatch', 502);
  }
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(`ragent-remote-candidate-v1:${hash(e)}`),
      createPublicKey(data.binding.targetPublicKey),
      Buffer.from(text(signed.signature), 'base64url'),
    );
  } catch {}
  if (!valid) throw factoryError('REMOTE_RECEIPT_INVALID', 'Candidate signature invalid', 502);

  await factoryTransaction((db) => {
    schema(db);
    db.prepare(`
      UPDATE remote_factory_source_operations
      SET candidate_digest=?, candidate_json=?, offline_state=CASE WHEN candidate_synced=1 THEN 'synced' ELSE 'executed_unsynced' END, updated_at=?
      WHERE binding_id=? AND operation_id=?
    `).run(e.candidateDigest, JSON.stringify(signed), now(), bindingId, operationId);
  });
  return signed;
}

export async function reconcileRemoteFactoryOperation(
  bindingId,
  operationId,
  actor,
  { targetRevision = 0, pullCandidate = true, feedIntoReview = true, proxyImpl = proxyToTarget, importCandidateImpl = null } = {},
) {
  bindingId = required(bindingId, 'bindingId');
  operationId = required(operationId, 'operationId');
  let op = await getRemoteFactorySourceOperation(bindingId, operationId, actor);

  if (op.offlineState === 'not_dispatched' && !op.wireDispatched) {
    return {
      bindingId,
      operationId,
      offlineState: 'not_dispatched',
      action: 'wait_or_reroute',
      safeToReroute: true,
      wireDispatched: false,
    };
  }

  if (op.offlineState === 'synced' && op.candidateSynced) {
    return {
      bindingId,
      operationId,
      offlineState: 'synced',
      action: 'already_synced',
      candidateSynced: true,
      candidateDigest: op.candidateDigest,
    };
  }

  let receipt = null;
  if (['dispatched_unconfirmed', 'dispatched_confirmed'].includes(op.offlineState)) {
    receipt = await queryRemoteFactoryOperation(bindingId, operationId, actor, { targetRevision, proxyImpl });
    op = await getRemoteFactorySourceOperation(bindingId, operationId, actor);
    if (receipt.status === 'unknown' && receipt.reason === 'query_required') {
      return {
        bindingId,
        operationId,
        offlineState: op.offlineState,
        action: 'query_receipt_on_reconnect',
        replayForbidden: true,
        receipt,
      };
    }
    if (op.offlineState !== 'executed_unsynced') {
      return {
        bindingId,
        operationId,
        offlineState: op.offlineState,
        action: op.offlineState === 'terminal' ? 'terminal_observed' : 'await_execution',
        receipt,
      };
    }
  }

  if (op.offlineState === 'executed_unsynced') {
    if (!pullCandidate) {
      return {
        bindingId,
        operationId,
        offlineState: 'executed_unsynced',
        action: 'pull_candidate_required',
        receipt,
      };
    }
    const signed = await fetchRemoteFactoryCandidate(bindingId, operationId, actor, { targetRevision, proxyImpl });
    let imported = null;
    if (feedIntoReview) {
      const hasSourceWorkBinding = await factoryRead((db) => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_execution_bindings'").get()) return false;
        return Boolean(db.prepare('SELECT 1 FROM factory_execution_bindings WHERE id=?').get(op.sourceFactoryBindingId));
      });
      if (hasSourceWorkBinding || typeof importCandidateImpl === 'function') {
        const importer = importCandidateImpl || (await import('./factory-remote-evidence.mjs')).importRemoteFactoryCandidate;
        imported = await importer({ bindingId, operationId, signed }, actor);
      }
      await factoryTransaction((db) => {
        schema(db);
        const ts = now();
        db.prepare(`
          UPDATE remote_factory_source_operations
          SET candidate_synced=1, offline_state='synced', synced_at=?, updated_at=?
          WHERE binding_id=? AND operation_id=?
        `).run(ts, ts, bindingId, operationId);
      });
    }
    return {
      bindingId,
      operationId,
      offlineState: feedIntoReview ? 'synced' : 'executed_unsynced',
      action: feedIntoReview ? 'synced_to_review' : 'candidate_pulled',
      candidateDigest: signed.envelope.candidateDigest,
      candidateSynced: Boolean(feedIntoReview),
      reviewReady: Boolean(imported ? imported.item?.state === 'review' || imported.replayed : true),
      imported,
      signed,
    };
  }

  return {
    bindingId,
    operationId,
    offlineState: op.offlineState,
    action: 'observed',
    receipt,
  };
}

export async function requestRemoteFactoryCancellationFromSource(bindingId, operationId, actor, { targetRevision = 0, proxyImpl = proxyToTarget } = {}) {
  bindingId = required(bindingId, 'bindingId');
  operationId = required(operationId, 'operationId');
  const data = await factoryRead((db) => {
    schema(db);
    const b = db.prepare('SELECT * FROM remote_factory_source_bindings WHERE id=?').get(bindingId);
    const o = db.prepare('SELECT * FROM remote_factory_source_operations WHERE binding_id=? AND operation_id=?').get(bindingId, operationId);
    if (!b || !o) throw factoryError('REMOTE_NOT_FOUND', 'Operation unavailable', 404);
    authorize(db, b.organization_id, actor, 'factory.read');
    const saved = JSON.parse(o.request_json);
    return {
      binding: saved.binding,
      request: saved.canonical,
      offlineState: o.offline_state || (o.wire_dispatched ? 'dispatched_unconfirmed' : 'not_dispatched'),
      wireDispatched: Boolean(o.wire_dispatched),
    };
  });

  if (data.offlineState === 'not_dispatched' && !data.wireDispatched) {
    await factoryTransaction((db) => {
      schema(db);
      db.prepare(`
        UPDATE remote_factory_source_operations
        SET status='cancelled', offline_state='cancelled', updated_at=?
        WHERE binding_id=? AND operation_id=? AND offline_state='not_dispatched' AND wire_dispatched=0
      `).run(now(), bindingId, operationId);
    });
    return {
      bindingId,
      operationId,
      requestState: 'cancelled_before_dispatch',
      offlineState: 'cancelled',
      wireDispatched: false,
    };
  }

  const cancellation = {
    bindingId: data.binding.targetBindingId,
    operationId,
    cancelId: `cancel_${data.request.sourceFactoryBindingId}`,
    contractRevision: data.request.contractRevision,
    executionEpoch: data.request.executionEpoch,
  };
  const signature = await signRemoteFactoryCancellation(cancellation);
  const path = `/api/remote-factory/bindings/${cancellation.bindingId}/operations/${operationId}/cancel`;
  const requestId = `cancel_${randomUUID()}`;
  try {
    const currentRevision = await readTargetRevision(data.binding.targetInstanceId, proxyImpl);
    const { response, body } = await proxyImpl({
      targetId: data.binding.targetInstanceId,
      requestId,
      idempotencyKey: cancellation.cancelId,
      method: 'POST',
      path,
      operation: 'factory.remote.cancel',
      resourceId: cancellation.bindingId,
      expectedRevision: currentRevision,
      body: JSON.stringify({ ...cancellation, signature }),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error('Cancellation unconfirmed');
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = envelope?.receipt;
    let valid = false;
    try {
      valid = envelope.targetInstanceId === data.binding.targetInstanceId
        && verify(
          null,
          Buffer.from(`ragent-remote-receipt-v1:${hash({ targetInstanceId: envelope.targetInstanceId, receipt })}`),
          createPublicKey(data.binding.targetPublicKey),
          Buffer.from(text(envelope.signature), 'base64url'),
        );
    } catch {}
    if (!valid || receipt?.bindingId !== cancellation.bindingId || receipt?.operationId !== operationId
        || receipt?.cancelId !== cancellation.cancelId || receipt?.contractRevision !== cancellation.contractRevision
        || receipt?.executionEpoch !== cancellation.executionEpoch) {
      throw new Error('Cancellation receipt mismatch');
    }
    return receipt;
  } catch {
    return { operationId, requestState: 'unknown', reason: 'query_required' };
  }
}
