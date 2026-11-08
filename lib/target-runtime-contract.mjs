// Shared contract primitives for the Web and Android target-runtime model.
// This module deliberately contains no transport, account, or provider logic.

export const TARGET_RUNTIME_SCHEMA_VERSION = 1;

export const TARGET_RUNTIME_STATES = Object.freeze([
  'paired',
  'connecting',
  'online',
  'degraded',
  'offline',
  'revoked',
]);

export const TARGET_RUNTIME_ENTITY_TYPES = Object.freeze([
  'session',
  'run',
  'approval',
  'notification',
]);

export const TARGET_RUNTIME_EVENT_TYPES = Object.freeze([
  'created',
  'updated',
  'deleted',
  'snapshot',
]);

export const TARGET_COMMAND_STATUSES = Object.freeze([
  'accepted',
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
]);

export const TARGET_RUNTIME_OPERATIONS = Object.freeze([
  'agent.read',
  'agent.write',
  'approval.read',
  'connector.read',
  'connector.write',
  'file.read',
  'file.write',
  'home.read',
  'model.read',
  'notification.read',
  'notification.write',
  'project.read',
  'project.write',
  'provider.read',
  'provider.write',
  'run.read',
  'runtime.summary',
  'session.create',
  'settings.write',
  'settings.read',
  'session.read',
  'session.message',
  'session.queue',
  'session.update',
  'session.delete',
  'session.cancel',
  'session.compact',
  'session.drop-tools',
  'session.fork',
  'run.cancel',
  'approval.resolve',
  'tool.read',
  'tool.write',
  'trigger.read',
  'trigger.write',
  'usage.read',
  'voice.install',
  'voice.install.read',
  'voice.recognition',
  'voice.settings.read',
  'voice.settings.write',
  'workflow.read',
  'workflow.write',
]);

export class TargetRuntimeContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TargetRuntimeContractError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, field, { required = false, max = 256 } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (required && !normalized) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_FIELD_REQUIRED', `${field} is required`);
  }
  if (normalized.length > max) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_FIELD_INVALID', `${field} is too long`);
  }
  return normalized;
}

function revision(value, field, fallback = 0) {
  const normalized = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_REVISION_INVALID', `${field} must be a non-negative integer`);
  }
  return normalized;
}

function timestamp(value, field, { required = false, nowMs = Date.now(), future = false } = {}) {
  const normalized = text(value, field, { required, max: 64 });
  if (!normalized) return '';
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_TIMESTAMP_INVALID', `${field} must be an ISO timestamp`);
  }
  if (future && parsed <= nowMs) {
    throw new TargetRuntimeContractError('TARGET_COMMAND_EXPIRED', 'Command expiry must be in the future', 409);
  }
  return new Date(parsed).toISOString();
}

function stringList(value, maxItems = 64) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_LIST_INVALID', 'capabilities must be an array');
  }
  return [...new Set(value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function enumValue(value, values, field, fallback) {
  const normalized = text(value, field, { max: 64 }) || fallback;
  if (!values.includes(normalized)) {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_ENUM_INVALID', `${field} is invalid`);
  }
  return normalized;
}

export function normalizeTargetDescriptor(input = {}) {
  const source = objectValue(input);
  const targetId = text(source.targetId, 'targetId', { required: true, max: 160 });
  const instanceId = text(source.instanceId, 'instanceId', { required: true, max: 160 });
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    targetId,
    instanceId,
    deviceKind: text(source.deviceKind, 'deviceKind', { max: 32 }) || 'computer',
    label: text(source.label || source.name, 'label', { max: 128 }) || targetId,
    platform: text(source.platform, 'platform', { max: 32 }) || '',
    status: enumValue(source.status, TARGET_RUNTIME_STATES, 'status', 'offline'),
    runtimeVersion: text(source.runtimeVersion, 'runtimeVersion', { max: 128 }) || '',
    capabilities: stringList(source.capabilities),
    snapshotVersion: revision(source.snapshotVersion, 'snapshotVersion'),
    lastSeenAt: timestamp(source.lastSeenAt, 'lastSeenAt'),
  });
}

export function normalizeTargetCatalog(input = {}) {
  const source = objectValue(input);
  const targets = Array.isArray(source.targets)
    ? source.targets.map(normalizeTargetDescriptor)
    : [];
  const targetIds = new Set(targets.map((target) => target.targetId));
  const requestedActive = text(source.activeTargetId, 'activeTargetId', { max: 160 });
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    revision: revision(source.revision, 'revision'),
    activeTargetId: requestedActive && targetIds.has(requestedActive) ? requestedActive : (targets[0]?.targetId || null),
    targets,
  });
}

export function createLocalTargetRuntimeContext(identity, { now = new Date(), snapshotVersion = 0 } = {}) {
  const target = normalizeTargetDescriptor({
    targetId: identity?.instanceId,
    instanceId: identity?.instanceId,
    deviceKind: 'computer',
    label: 'This device',
    platform: process.platform,
    status: 'online',
    runtimeVersion: process.env.npm_package_version || '',
    capabilities: ['sessions', 'runs', 'approvals', 'projects', 'files', 'triggers', 'usage'],
    snapshotVersion,
    lastSeenAt: now.toISOString(),
  });
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    target,
  });
}

export function normalizeTargetSummaryEvent(input = {}) {
  const source = objectValue(input);
  const entityType = enumValue(source.entityType, TARGET_RUNTIME_ENTITY_TYPES, 'entityType', 'notification');
  const eventType = enumValue(source.type, TARGET_RUNTIME_EVENT_TYPES, 'type', 'updated');
  const summary = objectValue(source.summary);
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    eventId: text(source.eventId, 'eventId', { required: true, max: 160 }),
    targetId: text(source.targetId, 'targetId', { required: true, max: 160 }),
    instanceId: text(source.instanceId, 'instanceId', { required: true, max: 160 }),
    entityType,
    entityId: text(source.entityId, 'entityId', { required: true, max: 160 }),
    revision: revision(source.revision, 'revision'),
    type: eventType,
    emittedAt: timestamp(source.emittedAt, 'emittedAt', { required: true }),
    summary: Object.freeze({ ...summary }),
  });
}

export function createTargetCommand(input = {}, { nowMs = Date.now() } = {}) {
  const source = objectValue(input);
  const operation = text(source.operation, 'operation', { required: true, max: 64 });
  if (!TARGET_RUNTIME_OPERATIONS.includes(operation)) {
    throw new TargetRuntimeContractError('TARGET_COMMAND_OPERATION_INVALID', 'Unsupported target command operation');
  }
  if (source.expectedRevision === undefined || source.expectedRevision === null || source.expectedRevision === '') {
    throw new TargetRuntimeContractError('TARGET_CONTRACT_FIELD_REQUIRED', 'expectedRevision is required');
  }
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    requestId: text(source.requestId, 'requestId', { required: true, max: 160 }),
    idempotencyKey: text(source.idempotencyKey, 'idempotencyKey', { required: true, max: 160 }),
    targetId: text(source.targetId, 'targetId', { required: true, max: 160 }),
    operation,
    resourceId: text(source.resourceId, 'resourceId', { required: true, max: 160 }),
    expectedRevision: revision(source.expectedRevision, 'expectedRevision'),
    expiresAt: timestamp(source.expiresAt, 'expiresAt', { required: true, nowMs, future: true }),
  });
}

export function normalizeTargetCommandResult(input = {}) {
  const source = objectValue(input);
  const status = enumValue(source.status, TARGET_COMMAND_STATUSES, 'status', 'failed');
  const error = objectValue(source.error);
  return Object.freeze({
    schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
    requestId: text(source.requestId, 'requestId', { required: true, max: 160 }),
    idempotencyKey: text(source.idempotencyKey, 'idempotencyKey', { required: true, max: 160 }),
    targetId: text(source.targetId, 'targetId', { required: true, max: 160 }),
    status,
    revision: revision(source.revision, 'revision'),
    ...(text(error.code, 'error.code', { max: 96 }) ? {
      error: Object.freeze({
        code: text(error.code, 'error.code', { max: 96 }),
        message: text(error.message, 'error.message', { max: 512 }),
        retryable: error.retryable === true,
      }),
    } : {}),
  });
}

export function createTargetEventDeduper({ maxEntries = 2048 } = {}) {
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 2048;
  const seen = new Map();
  return Object.freeze({
    accept(input) {
      const event = normalizeTargetSummaryEvent(input);
      const key = `${event.targetId}:${event.eventId}`;
      if (seen.has(key)) return false;
      seen.set(key, event.revision);
      while (seen.size > limit) seen.delete(seen.keys().next().value);
      return true;
    },
    has(targetId, eventId) {
      return seen.has(`${String(targetId || '').trim()}:${String(eventId || '').trim()}`);
    },
    clear() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  });
}
