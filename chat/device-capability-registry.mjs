// Durable cross-device capability registry & deterministic authorized routing selector.
// Device capability reports are facts/observations, never authorization grants:
// effective access always requires an explicit owner ∩ binding policy match,
// trusted fact provenance, fresh heartbeat, capacity, and verified isolation.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { factoryRead, factoryTransaction, factoryError, now, newId, encode, decode } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { assessDeviceAdmission, normalizeDeviceCapabilitySnapshot } from '../lib/device-capability-snapshot.mjs';

export const DEVICE_PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);
export const DEVICE_STATUSES = Object.freeze(['online', 'offline', 'stale']);
export const ISOLATION_MODES = Object.freeze(['worktree', 'container', 'sandbox', 'shared', 'none', 'unknown']);
export const ISOLATED_MODES = new Set(['worktree', 'container', 'sandbox']);
export const TRUSTED_FACT_SOURCES = new Set(['local', 'verified_remote']);
export const DEFAULT_HEARTBEAT_STALE_MS = 90_000;
export const MIN_HEARTBEAT_STALE_MS = 1_000;
export const MAX_HEARTBEAT_STALE_MS = 24 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

function text(value, max = 512) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function hashCanonical(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') {
      return `{${Object.keys(item).sort().map((k) => `${JSON.stringify(k)}:${canonical(item[k])}`).join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requiredId(value, name) {
  const normalized = text(value, 160);
  if (!ID_PATTERN.test(normalized)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', `${name} is invalid`, 400);
  }
  return normalized;
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_capability_registry (
      instance_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      stale_after_ms INTEGER NOT NULL,
      harnesses_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      max_concurrent_runs INTEGER,
      current_concurrent_runs INTEGER NOT NULL DEFAULT 0,
      isolation_json TEXT NOT NULL,
      installed INTEGER NOT NULL DEFAULT 1,
      fact_source TEXT NOT NULL,
      public_key TEXT NOT NULL DEFAULT '',
      attestation_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_registry_platform_status
      ON device_capability_registry(platform, status, heartbeat_at);

    CREATE TABLE IF NOT EXISTS device_peer_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      binding_id TEXT NOT NULL DEFAULT '',
      target_instance_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      owner_authorized INTEGER NOT NULL DEFAULT 0,
      owner_policy_json TEXT NOT NULL DEFAULT '{}',
      binding_policy_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, target_instance_id, binding_id)
    );
    CREATE INDEX IF NOT EXISTS device_peer_policies_org_target
      ON device_peer_policies(organization_id, target_instance_id);
  `);
}

export function normalizePlatform(value) {
  const raw = text(value, 32).toLowerCase();
  if (raw === 'win32' || raw === 'windows') return 'windows';
  if (raw === 'darwin' || raw === 'macos' || raw === 'mac') return 'macos';
  if (raw === 'linux') return 'linux';
  return '';
}

function normalizeStringList(value, { lower = true, maxItems = 64, maxLen = 128 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Expected a list of strings', 400);
  }
  const items = [];
  for (const entry of value) {
    const item = text(entry, maxLen);
    if (!item) continue;
    items.push(lower ? item.toLowerCase() : item);
  }
  return [...new Set(items)].sort().slice(0, maxItems);
}

function normalizeOptionalStringList(value, options) {
  if (value === undefined || value === null) return null;
  return normalizeStringList(value, options);
}

export function normalizeWorkspaceRoot(rawPath, platformHint = '') {
  if (typeof rawPath !== 'string') {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Workspace root must be a string', 400);
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Workspace root is invalid', 400);
  }
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'UNC workspace roots are not allowed', 400);
  }
  const slashed = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const isWindowsDrive = /^[A-Za-z]:\//.test(slashed) || /^[A-Za-z]:$/.test(slashed);
  const isPosixAbs = slashed.startsWith('/');
  if (!isWindowsDrive && !isPosixAbs) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Workspace root must be an absolute path', 400);
  }
  const segments = (isWindowsDrive ? slashed.slice(2) : slashed).split('/').filter(Boolean);
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Workspace root must not contain traversal segments', 400);
  }
  if (isWindowsDrive) {
    const drive = slashed[0].toLowerCase();
    return segments.length ? `${drive}:/${segments.join('/')}` : `${drive}:/`;
  }
  void platformHint;
  return segments.length ? `/${segments.join('/')}` : '/';
}

export function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== 'string') {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Relative path must be a string', 400);
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0') || trimmed.includes('\\')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Relative path is invalid', 400);
  }
  if (/^(?:[A-Za-z]:|\/)/.test(trimmed) || trimmed.endsWith('/')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Relative path must stay within workspace root', 400);
  }
  const parts = trimmed.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Relative path contains traversal segments', 400);
  }
  return parts.join('/');
}

export function workspaceRootCovers(rootPath, targetPath, platform = '') {
  let root;
  let target;
  try {
    root = normalizeWorkspaceRoot(rootPath, platform);
    target = normalizeWorkspaceRoot(targetPath, platform);
  } catch {
    return false;
  }
  const winComparison = platform === 'windows' || /^[a-z]:\//.test(root) || /^[a-z]:\//.test(target);
  const normRoot = winComparison ? root.toLowerCase() : root;
  const normTarget = winComparison ? target.toLowerCase() : target;
  if (normRoot === normTarget) return true;
  const prefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  return normTarget.startsWith(prefix);
}

function relativePathCovers(allowedRoot, requested) {
  return requested === allowedRoot || requested.startsWith(`${allowedRoot}/`);
}

function normalizeWorkspaceRootsList(roots, platform = '') {
  if (roots === undefined || roots === null) return [];
  if (!Array.isArray(roots)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'authorizedWorkspaceRoots must be an array', 400);
  }
  const normalized = roots.map((entry) => normalizeWorkspaceRoot(entry, platform));
  return [...new Set(normalized)].sort().slice(0, 64);
}

function normalizeIsolation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { supported: false, enforced: false, mode: 'unknown', readOnlySupported: false, evidence: 'unverified' };
  }
  const modeRaw = text(input.mode, 32).toLowerCase();
  const mode = ISOLATION_MODES.includes(modeRaw) ? modeRaw : 'unknown';
  const isolated = ISOLATED_MODES.has(mode);
  const supported = input.supported === true && isolated;
  // Never mark isolation enforced when mode is shared/none/unknown.
  const enforced = input.enforced === true && isolated && supported;
  return {
    supported,
    enforced,
    mode,
    readOnlySupported: input.readOnlySupported === true,
    evidence: text(input.evidence, 256) || (enforced ? mode : 'unverified'),
  };
}

function normalizeHarnesses(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'availableHarnesses must be an array', 400);
  }
  const list = [];
  for (const entry of input) {
    if (typeof entry === 'string') {
      const id = text(entry, 64).toLowerCase();
      if (id) list.push(id);
    } else if (entry && typeof entry === 'object') {
      if (entry.available === false) continue;
      const id = text(entry.id || entry.tool || entry.name, 64).toLowerCase();
      if (id) list.push(id);
    }
  }
  return [...new Set(list)].sort().slice(0, 32);
}

function normalizeStaleAfterMs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_HEARTBEAT_STALE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_HEARTBEAT_STALE_MS || parsed > MAX_HEARTBEAT_STALE_MS) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'staleAfterMs is out of range', 400);
  }
  return parsed;
}

function normalizePublicKey(key, instanceId) {
  const pem = text(key, 4096);
  if (!pem) return '';
  try {
    const parsed = createPublicKey(pem);
    if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 required');
    if (`inst_${createInstancePublicKeyFingerprint(pem).slice(0, 32)}` !== instanceId) {
      throw new Error('Public key does not match instanceId');
    }
    return parsed.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Device publicKey does not match instanceId', 400);
  }
}

export function computeDeviceEffectiveStatus(record, { nowMs = Date.now(), staleAfterMs = null } = {}) {
  if (!record) return 'offline';
  if (record.status === 'offline') return 'offline';
  if (record.status === 'stale') return 'stale';
  const heartbeatMs = Date.parse(record.heartbeatAt || record.heartbeat_at || '');
  if (!Number.isFinite(heartbeatMs)) return 'offline';
  const threshold = staleAfterMs ?? record.staleAfterMs ?? record.stale_after_ms ?? DEFAULT_HEARTBEAT_STALE_MS;
  if (nowMs - heartbeatMs > threshold) return 'stale';
  return 'online';
}

function projectDeviceRow(row, nowMs = Date.now()) {
  if (!row) return null;
  const harnesses = decode(row.harnesses_json, []);
  const capabilities = decode(row.capabilities_json, []);
  const authorizedWorkspaceRoots = decode(row.workspace_roots_json, []);
  const isolation = decode(row.isolation_json, { supported: false, enforced: false, mode: 'unknown', readOnlySupported: false, evidence: 'unverified' });
  const maxConcurrentRuns = Number.isSafeInteger(row.max_concurrent_runs) ? row.max_concurrent_runs : null;
  const currentConcurrentRuns = Number.isSafeInteger(row.current_concurrent_runs) ? row.current_concurrent_runs : 0;
  const availableSlots = maxConcurrentRuns === null ? null : Math.max(0, maxConcurrentRuns - currentConcurrentRuns);
  const effectiveStatus = computeDeviceEffectiveStatus(row, { nowMs });
  return {
    instanceId: row.instance_id,
    label: row.label || row.instance_id,
    platform: row.platform,
    reportedStatus: row.status,
    status: effectiveStatus,
    isStale: effectiveStatus === 'stale',
    heartbeatAt: row.heartbeat_at,
    staleAfterMs: row.stale_after_ms,
    availableHarnesses: harnesses,
    capabilities,
    authorizedWorkspaceRoots,
    maxConcurrentRuns,
    currentConcurrentRuns,
    availableSlots,
    isolation,
    installed: Boolean(row.installed),
    factSource: row.fact_source,
    // Authorization is NEVER stored on or inferred from device capability reports.
    capabilitySnapshot: normalizeDeviceCapabilitySnapshot({
      installed: Boolean(row.installed),
      online: effectiveStatus === 'online',
      authorized: 'unknown',
      isolationEnforced: isolation.enforced === true,
      availableSlots,
    }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function signDeviceCapabilityReport(payload = {}, { identity: providedIdentity = null } = {}) {
  const identity = providedIdentity || await loadOrCreateInstanceIdentity();
  const platform = normalizePlatform(payload.platform || process.platform);
  if (!platform) throw factoryError('DEVICE_REGISTRY_INVALID', 'Supported platform required', 400);
  const status = DEVICE_STATUSES.includes(text(payload.status, 32)) ? text(payload.status, 32) : 'online';
  const heartbeatAt = payload.heartbeatAt && Number.isFinite(Date.parse(payload.heartbeatAt))
    ? new Date(payload.heartbeatAt).toISOString()
    : now();
  const report = {
    schemaVersion: 1,
    instanceId: identity.instanceId,
    label: text(payload.label, 128) || identity.instanceId,
    platform,
    status,
    heartbeatAt,
    staleAfterMs: normalizeStaleAfterMs(payload.staleAfterMs),
    availableHarnesses: normalizeHarnesses(payload.availableHarnesses || payload.harnesses || []),
    capabilities: normalizeStringList(payload.capabilities || []),
    authorizedWorkspaceRoots: normalizeWorkspaceRootsList(payload.authorizedWorkspaceRoots || payload.workspaceRoots || [], platform),
    maxConcurrentRuns: payload.maxConcurrentRuns === undefined || payload.maxConcurrentRuns === null
      ? null
      : Number(payload.maxConcurrentRuns),
    currentConcurrentRuns: Number.isSafeInteger(Number(payload.currentConcurrentRuns)) ? Number(payload.currentConcurrentRuns) : 0,
    isolation: normalizeIsolation(payload.isolation),
    installed: payload.installed !== false,
  };
  const signature = signWithInstanceIdentity(identity, `ragent-device-capabilities-v1:${hashCanonical(report)}`);
  return { report, publicKey: identity.publicKey, signature };
}

export function verifyDeviceCapabilityReport(envelope, expectedPublicKey = '') {
  const report = envelope?.report;
  const sig = text(envelope?.signature, 1024);
  const pub = text(expectedPublicKey || envelope?.publicKey, 4096);
  if (!report || typeof report !== 'object' || Array.isArray(report) || !sig || !pub) {
    return { valid: false, reason: 'capability_attestation_incomplete' };
  }
  const instanceId = text(report.instanceId, 160);
  if (!ID_PATTERN.test(instanceId)) return { valid: false, reason: 'instance_id_invalid' };
  try {
    const keyObj = createPublicKey(pub);
    if (keyObj.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'key_algorithm_invalid' };
    if (`inst_${createInstancePublicKeyFingerprint(pub).slice(0, 32)}` !== instanceId) {
      return { valid: false, reason: 'instance_key_mismatch' };
    }
    const ok = verify(null, Buffer.from(`ragent-device-capabilities-v1:${hashCanonical(report)}`), keyObj, Buffer.from(sig, 'base64url'));
    if (!ok) return { valid: false, reason: 'capability_signature_invalid' };
    return { valid: true, report, publicKey: keyObj.export({ type: 'spki', format: 'pem' }).toString(), reason: null };
  } catch {
    return { valid: false, reason: 'capability_signature_invalid' };
  }
}

export async function registerDeviceCapabilities(input, actor = null, { nowMs = Date.now() } = {}) {
  let payload = input;
  let verifiedPublicKey = '';
  let resolvedFactSource = text(input?.factSource, 32) || 'local';

  if (input?.signedReport || input?.report) {
    const envelope = input.signedReport || input;
    const verified = verifyDeviceCapabilityReport(envelope, input.expectedPublicKey || '');
    if (!verified.valid) {
      throw factoryError('DEVICE_CAPABILITY_FORBIDDEN', verified.reason || 'Device capability signature invalid', 403);
    }
    payload = verified.report;
    verifiedPublicKey = verified.publicKey;
    resolvedFactSource = 'verified_remote';
  }

  const instanceId = requiredId(payload?.instanceId, 'instanceId');
  const platform = normalizePlatform(payload?.platform);
  if (!platform) throw factoryError('DEVICE_REGISTRY_INVALID', 'platform must be windows, macos, or linux', 400);

  const status = text(payload?.status, 32) || 'online';
  if (!DEVICE_STATUSES.includes(status)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'status must be online, offline, or stale', 400);
  }

  const heartbeatRaw = payload?.heartbeatAt !== undefined ? payload.heartbeatAt : new Date(nowMs).toISOString();
  const heartbeatMs = Date.parse(heartbeatRaw);
  if (!Number.isFinite(heartbeatMs)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'heartbeatAt must be a valid ISO timestamp', 400);
  }
  const heartbeatAt = new Date(heartbeatMs).toISOString();
  const staleAfterMs = normalizeStaleAfterMs(payload?.staleAfterMs);
  const harnesses = normalizeHarnesses(payload?.availableHarnesses ?? payload?.harnesses ?? []);
  const capabilities = normalizeStringList(payload?.capabilities ?? []);
  const workspaceRoots = normalizeWorkspaceRootsList(payload?.authorizedWorkspaceRoots ?? payload?.workspaceRoots ?? [], platform);

  const maxRaw = payload?.maxConcurrentRuns;
  let maxConcurrentRuns = null;
  if (maxRaw !== undefined && maxRaw !== null && maxRaw !== '') {
    const parsedMax = Number(maxRaw);
    if (!Number.isSafeInteger(parsedMax) || parsedMax < 0 || parsedMax > 1024) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'maxConcurrentRuns must be an integer between 0 and 1024', 400);
    }
    maxConcurrentRuns = parsedMax;
  }

  const currentRaw = payload?.currentConcurrentRuns ?? 0;
  const currentConcurrentRuns = Number(currentRaw);
  if (!Number.isSafeInteger(currentConcurrentRuns) || currentConcurrentRuns < 0 || currentConcurrentRuns > 1024) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'currentConcurrentRuns must be a non-negative integer', 400);
  }

  const isolation = normalizeIsolation(payload?.isolation);
  const installed = payload?.installed !== false ? 1 : 0;
  const label = text(payload?.label, 128) || instanceId;
  const publicKey = verifiedPublicKey || (payload?.publicKey ? normalizePublicKey(payload.publicKey, instanceId) : '');

  if (actor?.principalKind === 'target_runtime_gateway') {
    if (actor.sourceInstanceId !== instanceId && !verifiedPublicKey) {
      throw factoryError('DEVICE_CAPABILITY_FORBIDDEN', 'Target gateway can only report its own signed capabilities', 403);
    }
    if (!['catalog', 'unverified'].includes(resolvedFactSource)) {
      resolvedFactSource = 'verified_remote';
    }
  } else if (actor && !['user', 'service'].includes(actor.kind)) {
    throw factoryError('DEVICE_CAPABILITY_FORBIDDEN', 'Unsupported actor for device capability registration', 403);
  }
  if (!['local', 'verified_remote', 'catalog', 'unverified'].includes(resolvedFactSource)) {
    resolvedFactSource = 'unverified';
  }

  return factoryTransaction((db) => {
    schema(db);
    const old = db.prepare('SELECT * FROM device_capability_registry WHERE instance_id=?').get(instanceId);
    const ts = new Date(nowMs).toISOString();
    const version = (old?.version || 0) + 1;
    db.prepare(`
      INSERT INTO device_capability_registry (
        instance_id, label, platform, status, heartbeat_at, stale_after_ms,
        harnesses_json, capabilities_json, workspace_roots_json,
        max_concurrent_runs, current_concurrent_runs, isolation_json,
        installed, fact_source, public_key, attestation_json, version, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(instance_id) DO UPDATE SET
        label=excluded.label,
        platform=excluded.platform,
        status=excluded.status,
        heartbeat_at=excluded.heartbeat_at,
        stale_after_ms=excluded.stale_after_ms,
        harnesses_json=excluded.harnesses_json,
        capabilities_json=excluded.capabilities_json,
        workspace_roots_json=excluded.workspace_roots_json,
        max_concurrent_runs=excluded.max_concurrent_runs,
        current_concurrent_runs=excluded.current_concurrent_runs,
        isolation_json=excluded.isolation_json,
        installed=excluded.installed,
        fact_source=excluded.fact_source,
        public_key=CASE WHEN excluded.public_key<>'' THEN excluded.public_key ELSE device_capability_registry.public_key END,
        attestation_json=excluded.attestation_json,
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      instanceId, label, platform, status, heartbeatAt, staleAfterMs,
      JSON.stringify(harnesses), JSON.stringify(capabilities), JSON.stringify(workspaceRoots),
      maxConcurrentRuns, currentConcurrentRuns, JSON.stringify(isolation),
      installed, resolvedFactSource, publicKey,
      verifiedPublicKey ? JSON.stringify(input?.signedReport || input) : null,
      version, old?.created_at || ts, ts,
    );
    return projectDeviceRow(db.prepare('SELECT * FROM device_capability_registry WHERE instance_id=?').get(instanceId), nowMs);
  });
}

export async function recordDeviceHeartbeat(input, actor = null, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  if (input?.signedReport || input?.report) {
    return registerDeviceCapabilities(input, actor, { nowMs });
  }
  const instanceId = requiredId(input?.instanceId || input?.report?.instanceId || input?.signedReport?.report?.instanceId, 'instanceId');
  const existing = await getDeviceCapabilities(instanceId, { nowMs });
  if (!existing) {
    return registerDeviceCapabilities(input, actor, { nowMs });
  }
  const next = {
    instanceId,
    label: input?.label ?? existing.label,
    platform: input?.platform ?? existing.platform,
    status: input?.status ?? 'online',
    heartbeatAt: input?.heartbeatAt ?? new Date(nowMs).toISOString(),
    staleAfterMs: input?.staleAfterMs ?? existing.staleAfterMs,
    availableHarnesses: input?.availableHarnesses ?? input?.harnesses ?? existing.availableHarnesses,
    capabilities: input?.capabilities ?? existing.capabilities,
    authorizedWorkspaceRoots: input?.authorizedWorkspaceRoots ?? input?.workspaceRoots ?? existing.authorizedWorkspaceRoots,
    maxConcurrentRuns: input?.maxConcurrentRuns !== undefined ? input.maxConcurrentRuns : existing.maxConcurrentRuns,
    currentConcurrentRuns: input?.currentConcurrentRuns !== undefined ? input.currentConcurrentRuns : existing.currentConcurrentRuns,
    isolation: input?.isolation ?? existing.isolation,
    installed: input?.installed !== undefined ? input.installed : existing.installed,
    factSource: input?.factSource ?? existing.factSource,
    publicKey: input?.publicKey,
  };
  return registerDeviceCapabilities(next, actor, { nowMs });
}

export async function getDeviceCapabilities(instanceId, { nowMs = Date.now() } = {}) {
  const id = requiredId(instanceId, 'instanceId');
  return factoryRead((db) => {
    schema(db);
    return projectDeviceRow(db.prepare('SELECT * FROM device_capability_registry WHERE instance_id=?').get(id), nowMs);
  });
}

export async function listDeviceCapabilities({ platform = '', status = '', includeStale = true, nowMs = Date.now() } = {}) {
  const normalizedPlatform = platform ? normalizePlatform(platform) : '';
  return factoryRead((db) => {
    schema(db);
    const rows = db.prepare('SELECT * FROM device_capability_registry ORDER BY instance_id').all();
    return rows
      .map((row) => projectDeviceRow(row, nowMs))
      .filter((device) => {
        if (normalizedPlatform && device.platform !== normalizedPlatform) return false;
        if (status && device.status !== status) return false;
        if (!includeStale && device.status === 'stale') return false;
        return true;
      });
  });
}

export async function updateDeviceConcurrency(instanceId, delta, { nowMs = Date.now() } = {}) {
  const id = requiredId(instanceId, 'instanceId');
  if (!Number.isSafeInteger(delta)) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'Concurrency delta must be an integer', 400);
  }
  return factoryTransaction((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM device_capability_registry WHERE instance_id=?').get(id);
    if (!row) throw factoryError('DEVICE_NOT_FOUND', 'Device not registered', 404);
    const next = row.current_concurrent_runs + delta;
    if (next < 0) throw factoryError('DEVICE_CONFLICT', 'Concurrent run count cannot be negative', 409);
    if (delta > 0 && row.max_concurrent_runs !== null && next > row.max_concurrent_runs) {
      throw factoryError('DEVICE_CAPACITY_EXHAUSTED', 'Device concurrency capacity exhausted', 409);
    }
    db.prepare('UPDATE device_capability_registry SET current_concurrent_runs=?, version=version+1, updated_at=? WHERE instance_id=?')
      .run(next, new Date(nowMs).toISOString(), id);
    return projectDeviceRow(db.prepare('SELECT * FROM device_capability_registry WHERE instance_id=?').get(id), nowMs);
  });
}

export function normalizePeerPolicySlice(input = {}, platformHint = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  const allowedInstanceIds = normalizeOptionalStringList(input.allowedInstanceIds, { lower: false });
  if (allowedInstanceIds !== null) out.allowedInstanceIds = allowedInstanceIds;

  if (input.allowedPlatforms !== undefined && input.allowedPlatforms !== null) {
    if (!Array.isArray(input.allowedPlatforms)) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'allowedPlatforms must be an array', 400);
    }
    const plats = input.allowedPlatforms.map((p) => {
      const normalized = normalizePlatform(p);
      if (!normalized) throw factoryError('DEVICE_REGISTRY_INVALID', 'Invalid platform in policy', 400);
      return normalized;
    });
    out.allowedPlatforms = [...new Set(plats)].sort();
  }

  const allowedHarnesses = normalizeOptionalStringList(input.allowedHarnesses);
  if (allowedHarnesses !== null) out.allowedHarnesses = allowedHarnesses;

  const allowedCapabilities = normalizeOptionalStringList(input.allowedCapabilities);
  if (allowedCapabilities !== null) out.allowedCapabilities = allowedCapabilities;

  if (input.allowedWorkspaceRoots !== undefined && input.allowedWorkspaceRoots !== null) {
    out.allowedWorkspaceRoots = normalizeWorkspaceRootsList(input.allowedWorkspaceRoots, platformHint);
  }

  if (input.allowedRelativePaths !== undefined && input.allowedRelativePaths !== null) {
    if (!Array.isArray(input.allowedRelativePaths)) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'allowedRelativePaths must be an array', 400);
    }
    out.allowedRelativePaths = [...new Set(input.allowedRelativePaths.map(normalizeRelativePath))].sort();
  }

  if (input.allowedAccessModes !== undefined && input.allowedAccessModes !== null) {
    if (!Array.isArray(input.allowedAccessModes)) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'allowedAccessModes must be an array', 400);
    }
    const modes = input.allowedAccessModes.map((m) => {
      const norm = text(m, 16).toLowerCase();
      if (!['read', 'write'].includes(norm)) throw factoryError('DEVICE_REGISTRY_INVALID', 'Invalid accessMode in policy', 400);
      return norm;
    });
    out.allowedAccessModes = [...new Set(modes)].sort();
  }

  if (input.allowedIsolationModes !== undefined && input.allowedIsolationModes !== null) {
    if (!Array.isArray(input.allowedIsolationModes)) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'allowedIsolationModes must be an array', 400);
    }
    const modes = input.allowedIsolationModes.map((m) => {
      const norm = text(m, 32).toLowerCase();
      if (!ISOLATION_MODES.includes(norm)) throw factoryError('DEVICE_REGISTRY_INVALID', 'Invalid isolation mode in policy', 400);
      return norm;
    });
    out.allowedIsolationModes = [...new Set(modes)].sort();
  }

  if (typeof input.requireIsolation === 'boolean') out.requireIsolation = input.requireIsolation;

  if (input.maxConcurrentRuns !== undefined && input.maxConcurrentRuns !== null && input.maxConcurrentRuns !== '') {
    const maxRuns = Number(input.maxConcurrentRuns);
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 0 || maxRuns > 1024) {
      throw factoryError('DEVICE_REGISTRY_INVALID', 'Policy maxConcurrentRuns is invalid', 400);
    }
    out.maxConcurrentRuns = maxRuns;
  }

  return out;
}

function projectPeerPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    bindingId: row.binding_id,
    targetInstanceId: row.target_instance_id,
    ownerPrincipalId: row.owner_principal_id,
    ownerAuthorized: Boolean(row.owner_authorized),
    ownerPolicy: decode(row.owner_policy_json, {}),
    bindingPolicy: decode(row.binding_policy_json, {}),
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function configureDevicePeerAuthorization(input, actor, { nowMs = Date.now() } = {}) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor.principalId, 160)) {
    throw factoryError('DEVICE_CAPABILITY_FORBIDDEN', 'Owner required to configure peer authorization', 403);
  }
  const organizationId = requiredId(input?.organizationId, 'organizationId');
  const targetInstanceId = requiredId(input?.targetInstanceId, 'targetInstanceId');
  const bindingId = input?.bindingId ? requiredId(input.bindingId, 'bindingId') : '';
  const id = input?.id ? requiredId(input.id, 'id') : `peerpol_${organizationId}_${targetInstanceId}${bindingId ? `_${bindingId}` : ''}`.slice(0, 160);
  const expectedVersion = input?.expectedVersion ?? 0;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'expectedVersion must be a non-negative integer', 400);
  }
  const expiresMs = Date.parse(input?.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'expiresAt must be a future ISO timestamp', 400);
  }
  const ownerAuthorized = input?.ownerAuthorized === true;
  const ownerPolicy = normalizePeerPolicySlice(input?.ownerPolicy || {});
  const bindingPolicy = normalizePeerPolicySlice(input?.bindingPolicy || {});

  return factoryTransaction((db) => {
    schema(db);
    authorize(db, organizationId, actor, 'factory.read');
    const old = db.prepare('SELECT * FROM device_peer_policies WHERE id=?').get(id)
      || db.prepare('SELECT * FROM device_peer_policies WHERE organization_id=? AND target_instance_id=? AND binding_id=?').get(organizationId, targetInstanceId, bindingId);
    if ((old?.version || 0) !== expectedVersion || (old && old.organization_id !== organizationId)) {
      throw factoryError('DEVICE_REGISTRY_CONFLICT', 'Device peer policy version changed', 409);
    }
    const ts = new Date(nowMs).toISOString();
    const rowId = old?.id || id;
    const nextVersion = expectedVersion + 1;
    db.prepare(`
      INSERT INTO device_peer_policies (
        id, organization_id, binding_id, target_instance_id, owner_principal_id,
        owner_authorized, owner_policy_json, binding_policy_json, enabled, expires_at,
        version, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        binding_id=excluded.binding_id,
        owner_principal_id=excluded.owner_principal_id,
        owner_authorized=excluded.owner_authorized,
        owner_policy_json=excluded.owner_policy_json,
        binding_policy_json=excluded.binding_policy_json,
        enabled=excluded.enabled,
        expires_at=excluded.expires_at,
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      rowId, organizationId, bindingId, targetInstanceId, actor.principalId,
      ownerAuthorized ? 1 : 0, JSON.stringify(ownerPolicy), JSON.stringify(bindingPolicy),
      input?.enabled === false ? 0 : 1, new Date(expiresMs).toISOString(),
      nextVersion, old?.created_at || ts, ts,
    );
    return projectPeerPolicy(db.prepare('SELECT * FROM device_peer_policies WHERE id=?').get(rowId));
  });
}

export async function getDevicePeerAuthorization(organizationId, targetInstanceId, { bindingId = '' } = {}) {
  const orgId = requiredId(organizationId, 'organizationId');
  const targetId = requiredId(targetInstanceId, 'targetInstanceId');
  return factoryRead((db) => {
    schema(db);
    const row = bindingId
      ? db.prepare('SELECT * FROM device_peer_policies WHERE organization_id=? AND target_instance_id=? AND binding_id=?').get(orgId, targetId, bindingId)
      : db.prepare('SELECT * FROM device_peer_policies WHERE organization_id=? AND target_instance_id=? ORDER BY version DESC LIMIT 1').get(orgId, targetId);
    return projectPeerPolicy(row);
  });
}

function intersectList(layers, field) {
  const specified = layers.filter((layer) => Array.isArray(layer?.[field])).map((layer) => layer[field]);
  if (specified.length === 0) return null;
  let current = new Set(specified[0]);
  for (let i = 1; i < specified.length; i += 1) {
    const next = new Set(specified[i]);
    current = new Set([...current].filter((value) => next.has(value)));
  }
  return [...current].sort();
}

function evaluatePolicyIntersection(device, policyLayers, task, reasons) {
  const allowedIds = intersectList(policyLayers, 'allowedInstanceIds');
  if (allowedIds !== null && !allowedIds.includes(device.instanceId)) {
    reasons.push('policy_instance_denied');
  }

  const allowedPlatforms = intersectList(policyLayers, 'allowedPlatforms');
  if (allowedPlatforms !== null && !allowedPlatforms.includes(device.platform)) {
    reasons.push('policy_platform_denied');
  }

  const allowedHarnesses = intersectList(policyLayers, 'allowedHarnesses');
  if (task.requiredHarness && allowedHarnesses !== null && !allowedHarnesses.includes(task.requiredHarness)) {
    reasons.push('policy_harness_denied');
  }

  const allowedCapabilities = intersectList(policyLayers, 'allowedCapabilities');
  if (allowedCapabilities !== null && task.requiredCapabilities.some((cap) => !allowedCapabilities.includes(cap))) {
    reasons.push('policy_capability_denied');
  }

  const allowedAccessModes = intersectList(policyLayers, 'allowedAccessModes');
  if (allowedAccessModes !== null && !allowedAccessModes.includes(task.accessMode)) {
    reasons.push('policy_access_mode_denied');
  }

  const allowedIsolationModes = intersectList(policyLayers, 'allowedIsolationModes');
  if (allowedIsolationModes !== null && !allowedIsolationModes.includes(device.isolation.mode)) {
    reasons.push('policy_isolation_mode_denied');
  }

  if (task.workspaceRoot) {
    const rootLayers = policyLayers
      .filter((layer) => Array.isArray(layer?.allowedWorkspaceRoots))
      .map((layer) => layer.allowedWorkspaceRoots);
    for (const roots of rootLayers) {
      if (!roots.some((root) => workspaceRootCovers(root, task.workspaceRoot, device.platform))) {
        reasons.push('policy_workspace_root_denied');
        break;
      }
    }
  }

  if (task.allowedPaths.length > 0) {
    const relLayers = policyLayers
      .filter((layer) => Array.isArray(layer?.allowedRelativePaths))
      .map((layer) => layer.allowedRelativePaths);
    for (const allowedRel of relLayers) {
      if (task.allowedPaths.some((p) => !allowedRel.some((root) => relativePathCovers(root, p)))) {
        reasons.push('policy_relative_path_denied');
        break;
      }
    }
  }

  const policyMaxCaps = policyLayers
    .map((layer) => layer?.maxConcurrentRuns)
    .filter((n) => Number.isSafeInteger(n) && n >= 0);
  const effectiveMaxConcurrent = device.maxConcurrentRuns === null
    ? null
    : policyMaxCaps.length > 0
      ? Math.min(device.maxConcurrentRuns, ...policyMaxCaps)
      : device.maxConcurrentRuns;

  const policyRequiresIsolation = policyLayers.some((layer) => layer?.requireIsolation === true);
  return { effectiveMaxConcurrent, policyRequiresIsolation };
}

function normalizeTaskRequirements(input = {}) {
  const requiredPlatformRaw = input.requiredPlatform || input.platform || '';
  const requiredPlatformsRaw = Array.isArray(input.requiredPlatforms || input.platforms)
    ? (input.requiredPlatforms || input.platforms)
    : (requiredPlatformRaw ? [requiredPlatformRaw] : []);
  const requiredPlatforms = requiredPlatformsRaw.map((p) => {
    const norm = normalizePlatform(p);
    if (!norm) throw factoryError('DEVICE_REGISTRY_INVALID', 'Requested platform is invalid', 400);
    return norm;
  });

  const requiredCapabilities = normalizeStringList(input.requiredCapabilities || input.capabilities || []);
  const requiredHarness = text(input.requiredHarness || input.harness, 64).toLowerCase();
  const workspaceRoot = input.workspaceRoot ? normalizeWorkspaceRoot(input.workspaceRoot) : '';
  const allowedPaths = Array.isArray(input.allowedPaths) ? input.allowedPaths.map(normalizeRelativePath) : [];
  const accessMode = text(input.accessMode, 16).toLowerCase() === 'write' ? 'write' : 'read';
  const requiredIsolation = input.requiredIsolation !== false;
  const requiredIsolationModes = Array.isArray(input.requiredIsolationModes)
    ? input.requiredIsolationModes.map((m) => text(m, 32).toLowerCase()).filter(Boolean)
    : [];
  const minConcurrentSlots = input.minConcurrentSlots === undefined ? 1 : Number(input.minConcurrentSlots);
  if (!Number.isSafeInteger(minConcurrentSlots) || minConcurrentSlots < 1 || minConcurrentSlots > 1024) {
    throw factoryError('DEVICE_REGISTRY_INVALID', 'minConcurrentSlots must be a positive integer', 400);
  }

  return {
    organizationId: input.organizationId ? requiredId(input.organizationId, 'organizationId') : '',
    requiredPlatforms: [...new Set(requiredPlatforms)],
    requiredCapabilities,
    requiredHarness,
    workspaceRoot,
    allowedPaths,
    accessMode,
    requiredIsolation,
    requiredIsolationModes,
    requireReadOnlySupport: input.requireReadOnlySupport === true,
    minConcurrentSlots,
    requireVerifiedFacts: input.requireVerifiedFacts !== false,
    requireRemoteFactoryBinding: input.requireRemoteFactoryBinding === true,
    excludeInstanceIds: new Set(normalizeStringList(input.excludeInstanceIds || [], { lower: false })),
  };
}

export async function selectAuthorizedDeviceForTask(taskRequirements = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const task = normalizeTaskRequirements(taskRequirements);
  const inlineOwnerPolicy = options.ownerPolicy ? normalizePeerPolicySlice(options.ownerPolicy) : null;
  const preferredInstanceId = text(options.preferredInstanceId, 160);

  return factoryRead((db) => {
    schema(db);
    const devices = db.prepare('SELECT * FROM device_capability_registry ORDER BY instance_id').all()
      .map((row) => projectDeviceRow(row, nowMs));

    const hasSourceBindingsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_factory_source_bindings'").get(),
    );
    const hasBindingPolicyCol = hasSourceBindingsTable && db.prepare('PRAGMA table_info(remote_factory_source_bindings)').all()
      .some((col) => col.name === 'binding_policy_json');

    const sourceBindings = (task.organizationId && hasSourceBindingsTable)
      ? db.prepare('SELECT * FROM remote_factory_source_bindings WHERE organization_id=? ORDER BY id').all(task.organizationId)
      : [];
    const peerPolicies = task.organizationId
      ? db.prepare('SELECT * FROM device_peer_policies WHERE organization_id=? ORDER BY id').all(task.organizationId).map(projectPeerPolicy)
      : [];

    const eligible = [];
    const rejected = [];

    for (const device of devices) {
      if (task.excludeInstanceIds.has(device.instanceId)) {
        rejected.push({ instanceId: device.instanceId, status: device.status, reasons: ['device_excluded'] });
        continue;
      }

      const baseReasons = [];
      if (task.requireVerifiedFacts && !TRUSTED_FACT_SOURCES.has(device.factSource)) {
        baseReasons.push('unverified_device_facts');
      }
      if (device.status !== 'online') {
        baseReasons.push(device.status === 'stale' ? 'device_heartbeat_stale' : 'device_offline');
      }
      if (task.requiredPlatforms.length > 0 && !task.requiredPlatforms.includes(device.platform)) {
        baseReasons.push('platform_mismatch');
      }
      if (task.requiredHarness && !device.availableHarnesses.includes(task.requiredHarness)) {
        baseReasons.push('harness_unavailable');
      }
      if (task.requiredCapabilities.some((cap) => !device.capabilities.includes(cap))) {
        baseReasons.push('capability_missing');
      }
      if (task.workspaceRoot && !device.authorizedWorkspaceRoots.some((root) => workspaceRootCovers(root, task.workspaceRoot, device.platform))) {
        baseReasons.push('workspace_root_unauthorized');
      }
      if (task.requireReadOnlySupport && device.isolation.readOnlySupported !== true) {
        baseReasons.push('readonly_isolation_unsupported');
      }

      // Evaluate explicit peer bindings (owner ∩ binding policy); NEVER infer
      // authorization or isolation from status === 'online'.
      const matchingSourceBindings = sourceBindings.filter((b) =>
        b.target_instance_id === device.instanceId && b.enabled && Date.parse(b.expires_at) > nowMs);
      const matchingPeerPolicies = peerPolicies.filter((p) =>
        p.targetInstanceId === device.instanceId && p.enabled && Date.parse(p.expiresAt) > nowMs);

      if (!task.organizationId) {
        baseReasons.push('organization_authorization_required');
      } else if (task.requireRemoteFactoryBinding && matchingSourceBindings.length === 0) {
        baseReasons.push('missing_authorized_source_binding');
      } else if (matchingSourceBindings.length === 0 && !matchingPeerPolicies.some((p) => p.ownerAuthorized === true)) {
        baseReasons.push('device_not_authorized');
      }

      if (baseReasons.length > 0) {
        rejected.push({ instanceId: device.instanceId, status: device.status, reasons: [...new Set(baseReasons)] });
        continue;
      }

      // Check each binding candidate for this device.
      const candidateBindings = matchingSourceBindings.length > 0
        ? matchingSourceBindings.map((sb) => {
            const linkedPolicy = matchingPeerPolicies.find((p) => p.bindingId === sb.id)
              || matchingPeerPolicies.find((p) => !p.bindingId)
              || null;
            return { sourceBinding: sb, peerPolicy: linkedPolicy };
          })
        : matchingPeerPolicies.filter((p) => p.ownerAuthorized === true).map((p) => ({ sourceBinding: null, peerPolicy: p }));

      let matchedCandidate = null;
      const bindingRejectionReasons = [];

      for (const pair of candidateBindings) {
        const reasons = [];
        const { sourceBinding, peerPolicy } = pair;
        if (peerPolicy && peerPolicy.ownerAuthorized !== true) {
          reasons.push('owner_authorization_denied');
        }
        const sourceBindingPolicy = (sourceBinding && hasBindingPolicyCol)
          ? decode(sourceBinding.binding_policy_json, {})
          : {};
        const policyLayers = [
          inlineOwnerPolicy,
          peerPolicy?.ownerPolicy,
          peerPolicy?.bindingPolicy,
          sourceBindingPolicy,
        ].filter((layer) => layer && Object.keys(layer).length > 0);

        const { effectiveMaxConcurrent, policyRequiresIsolation } = evaluatePolicyIntersection(device, policyLayers, task, reasons);
        const requireIsolation = task.requiredIsolation || policyRequiresIsolation;
        const availableSlots = effectiveMaxConcurrent === null
          ? null
          : Math.max(0, effectiveMaxConcurrent - device.currentConcurrentRuns);

        const admission = assessDeviceAdmission({
          facts: {
            source: device.factSource,
            installed: device.installed,
            online: device.status === 'online',
            authorized: !reasons.includes('owner_authorization_denied'),
            isolationEnforced: device.isolation.enforced === true,
            availableSlots,
          },
          requiredIsolation: requireIsolation,
        });
        if (!admission.allowed) {
          reasons.push(admission.reason);
        }
        if (availableSlots !== null && availableSlots < task.minConcurrentSlots) {
          reasons.push('insufficient_concurrent_slots');
        }
        if (task.requiredIsolationModes.length > 0 && !task.requiredIsolationModes.includes(device.isolation.mode)) {
          reasons.push('isolation_mode_mismatch');
        }

        if (reasons.length === 0) {
          matchedCandidate = {
            instanceId: device.instanceId,
            label: device.label,
            bindingId: sourceBinding?.id || peerPolicy?.bindingId || null,
            bindingVersion: sourceBinding?.version || null,
            targetBindingId: sourceBinding?.target_binding_id || null,
            targetBindingVersion: sourceBinding?.target_binding_version || null,
            policyId: peerPolicy?.id || null,
            platform: device.platform,
            status: device.status,
            heartbeatAt: device.heartbeatAt,
            availableHarnesses: device.availableHarnesses,
            capabilities: device.capabilities,
            authorizedWorkspaceRoots: device.authorizedWorkspaceRoots,
            isolation: device.isolation,
            factSource: device.factSource,
            capacity: {
              maxConcurrentRuns: effectiveMaxConcurrent,
              currentConcurrentRuns: device.currentConcurrentRuns,
              availableSlots,
            },
            utilizationRatio: effectiveMaxConcurrent > 0
              ? Number((device.currentConcurrentRuns / effectiveMaxConcurrent).toFixed(6))
              : 1,
          };
          break;
        }
        bindingRejectionReasons.push(...reasons);
      }

      if (matchedCandidate) {
        eligible.push(matchedCandidate);
      } else {
        rejected.push({
          instanceId: device.instanceId,
          status: device.status,
          reasons: [...new Set(bindingRejectionReasons)],
        });
      }
    }

    eligible.sort((left, right) => {
      const leftPreferred = preferredInstanceId && left.instanceId === preferredInstanceId ? 0 : 1;
      const rightPreferred = preferredInstanceId && right.instanceId === preferredInstanceId ? 0 : 1;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      if (left.utilizationRatio !== right.utilizationRatio) return left.utilizationRatio - right.utilizationRatio;
      if (left.capacity.availableSlots !== right.capacity.availableSlots) {
        return right.capacity.availableSlots - left.capacity.availableSlots;
      }
      const hbCmp = String(right.heartbeatAt).localeCompare(String(left.heartbeatAt));
      if (hbCmp !== 0) return hbCmp;
      return left.instanceId.localeCompare(right.instanceId);
    });

    return {
      schemaVersion: 1,
      selected: eligible[0] || null,
      candidates: eligible,
      rejected,
      reason: eligible[0]
        ? null
        : (rejected.length > 0 ? 'no_eligible_authorized_device' : 'no_registered_devices'),
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  });
}
