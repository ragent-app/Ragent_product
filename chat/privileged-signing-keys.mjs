import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import { chmod } from 'fs/promises';

import {
  buildPrivilegedCgroupFromRunId,
  createPrivilegedKeyId,
  isKnownPrivilegedAuthMode,
  PRIVILEGED_AUTH_MODE_INVALID,
  PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO,
  PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
  PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
  PRIVILEGED_TOKEN_TTL_MAX_MS,
  signPrivilegedToken,
} from './privileged-token.mjs';
import { signSemanticCapability } from './semantic-capability.mjs';
import {
  requestPrivilegedExecutor,
  PRIVILEGED_EXECUTOR_ACTION_EXEC,
  PRIVILEGED_EXECUTOR_ACTION_SEMANTIC_EXEC,
} from '../lib/privileged-executor-protocol.mjs';
import { computeOpManifestHash, privilegedExecResultEvent } from './privileged-ops.mjs';
import { createKeyedTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { PRIVILEGED_QUOTA_FILE, PRIVILEGED_SIGNING_KEYS_FILE } from '../lib/config.mjs';
import {
  checkInstallQuotaFile,
  INSTALL_AUTO_QUOTA_MAX_DEFAULT,
  INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT,
} from './privileged-quota.mjs';

// P3d — chat-server privileged signing keys + mint-and-send pipeline
// (proposal: /var/lib/ragent/workspace/p3-executor-proposal-draft.md §3.2, §8.1 P3d).
//
// Key management (load-or-create, mirror chat/push.mjs:40-47 VAPID pattern):
//   - Ed25519 asymmetric key pair, stored at configDir/privileged-signing-keys.json
//   - Format: {current: {kid, publicKey, privateKey, created}, previous: null|{...}}
//   - loadOrCreate: read → missing → generate → atomic write → cache
//
// Mint-and-send: executePrivilegedOp builds a P3a one-shot token, signs it with
// the active private key, sends it to the executor via P3b socket protocol, and
// maps the response to a privilegedExecResultEvent (privileged-ops.mjs:167-187).
//
// This module is chat-server runtime (I/O: file + socket). Pure-logic helpers
// (sign, verify) remain in privileged-token.mjs (P3a); transport in
// privileged-executor-protocol.mjs (P3b). This module is the glue between them.

// ── in-memory cache ──────────────────────────────────────────────────────────
let cachedKeys = null;

// Per-file serialization for the quota check-and-record (mint is async; two
// concurrent install-auto ops must not both read count=N and record N+1).
const installAutoQuotaQueue = createKeyedTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ── serialization ────────────────────────────────────────────────────────────

function exportPublicKeyBytes(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).toString('base64url');
}

function exportPrivateKeyBytes(keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
}

function importPublicKeyBytes(b64url) {
  return createPublicKey({ key: Buffer.from(b64url, 'base64url'), type: 'spki', format: 'der' });
}

function importPrivateKeyBytes(b64url) {
  return createPrivateKey({ key: Buffer.from(b64url, 'base64url'), type: 'pkcs8', format: 'der' });
}

function serializeKeyEntry(kid, keyPair, created) {
  return {
    kid,
    publicKey: exportPublicKeyBytes(keyPair.publicKey),
    privateKey: exportPrivateKeyBytes(keyPair.privateKey),
    created: created || new Date().toISOString(),
  };
}

function deserializeKeyEntry(entry) {
  if (!entry || !entry.publicKey || !entry.privateKey) return null;
  try {
    return {
      kid: entry.kid,
      publicKey: importPublicKeyBytes(entry.publicKey),
      privateKey: importPrivateKeyBytes(entry.privateKey),
      created: entry.created,
    };
  } catch {
    return null;
  }
}

async function securePrivilegedSigningKeysFile(filePath) {
  if (!filePath) return;
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort: load-or-create should not fail solely because an older
    // deployment produced a readable file on a filesystem that rejects chmod.
  }
}

// ── key management ───────────────────────────────────────────────────────────

/**
 * Load-or-create the privileged signing key pair from configDir. Mirrors
 * chat/push.mjs:40-47 (VAPID load-or-create).
 *
 * @param {string} [keysFilePath] — override path (tests); defaults to config.mjs PRIVILEGED_SIGNING_KEYS_FILE
 * @returns {Promise<{current: object, previous: object|null}>}
 */
export async function loadOrCreatePrivilegedSigningKeys(keysFilePath) {
  if (cachedKeys) return cachedKeys;
  const filePath = trimString(keysFilePath) || PRIVILEGED_SIGNING_KEYS_FILE;

  const existing = await readJson(filePath, null);
  if (existing && existing.current) {
    await securePrivilegedSigningKeysFile(filePath);
    cachedKeys = existing;
    return cachedKeys;
  }

  // Generate new key pair
  const keyPair = generateKeyPairSync('ed25519');
  const kid = createPrivilegedKeyId();
  const created = new Date().toISOString();

  cachedKeys = {
    current: serializeKeyEntry(kid, keyPair, created),
    previous: null,
  };
  await writeJsonAtomic(filePath, cachedKeys);
  await securePrivilegedSigningKeysFile(filePath);
  console.log(`[privileged-signing] Generated new signing key (kid=${kid})`);
  return cachedKeys;
}

/**
 * Return the active (current) signing key pair as deserialized KeyObjects, or
 * null if keys have not been loaded.
 */
export function getActivePrivilegedSigningKey() {
  if (!cachedKeys || !cachedKeys.current) return null;
  return deserializeKeyEntry(cachedKeys.current);
}

/**
 * Return all public keys for executor verification, as [{kid, publicKey}].
 */
export function getPrivilegedPublicKeys() {
  if (!cachedKeys) return [];
  const keys = [];
  if (cachedKeys.current) {
    try {
      keys.push({
        kid: cachedKeys.current.kid,
        publicKey: importPublicKeyBytes(cachedKeys.current.publicKey),
      });
    } catch { /* skip corrupt entry */ }
  }
  if (cachedKeys.previous) {
    try {
      keys.push({
        kid: cachedKeys.previous.kid,
        publicKey: importPublicKeyBytes(cachedKeys.previous.publicKey),
      });
    } catch { /* skip corrupt entry */ }
  }
  return keys;
}

// ── mint and send ────────────────────────────────────────────────────────────

/**
 * Build, sign, and deliver a one-shot privileged token to the executor.
 *
 * @param {object} op — the approved op from the batch: {opId, command, category, cwd, manifestHash}
 *   manifestHash may be omitted; it is recomputed here when absent.
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.runId
 * @param {string} options.turnId
 * @param {string} options.authMode — 'passkey' or 'install-auto'
 * @param {string} [options.auditLabel] — human-readable label (≤300 chars)
 * @param {string} [options.socketPath] — override executor socket path
 * @param {number} [options.timeoutMs] — socket timeout override
 * @returns {Promise<object>} {ok, opId, category, exitCode, auditId, stdoutRef, error}
 */
export async function executePrivilegedOp(op, options = {}) {
  const activeKey = getActivePrivilegedSigningKey();
  if (!activeKey) {
    return { ok: false, opId: trimString(op?.opId), error: 'No active signing key', code: 'NO_SIGNING_KEY' };
  }

  const command = trimString(op?.command);
  if (!command) {
    return { ok: false, opId: trimString(op?.opId), error: 'Empty command', code: 'EMPTY_COMMAND' };
  }

  // Fail closed on unknown authMode instead of coercing it into passkey: the
  // token's authMode is an authorization claim the executor reasons about, so
  // only the exact known modes may ever be signed (P2/§5.6).
  const authMode = trimString(options.authMode);
  if (!isKnownPrivilegedAuthMode(authMode)) {
    return {
      ok: false,
      opId: trimString(op?.opId),
      error: `Unknown privileged authMode: ${authMode || '(empty)'}`,
      code: PRIVILEGED_AUTH_MODE_INVALID,
    };
  }

  const category = trimString(op?.category);
  const cwd = trimString(op?.cwd);
  const runId = trimString(options.runId);

  const manifestHash = trimString(op?.manifestHash) || computeOpManifestHash({ command, category, cwd });
  const now = new Date();
  const issuedAt = now.toISOString();
  const temporaryDeadline = options.temporaryControlExpiresAt;
  if (temporaryDeadline !== undefined && (!Number.isSafeInteger(temporaryDeadline) || temporaryDeadline <= now.getTime())) {
    return { ok: false, opId: trimString(op?.opId), error: 'Temporary control approval expired', code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' };
  }
  const expiresAt = new Date(Math.min(now.getTime() + PRIVILEGED_TOKEN_TTL_MAX_MS,
    temporaryDeadline ?? Number.POSITIVE_INFINITY)).toISOString();

  // install-auto quota gate (design §5.3 / P3 hardening): before minting an
  // install-auto token, consume one unit of the durable sliding-window quota.
  // Exceeding the cap fails closed — the op is NOT executed and the run sees
  // INSTALL_QUOTA_EXCEEDED (passkey fallback for over-quota installs lands
  // with P2/passkey semantics; until then over-quota means denied).
  if (trimString(options.authMode) === PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO) {
    const max = Number(process.env.RAGENT_INSTALL_AUTO_QUOTA_MAX) || INSTALL_AUTO_QUOTA_MAX_DEFAULT;
    const windowMs = Number(process.env.RAGENT_INSTALL_AUTO_QUOTA_WINDOW_MS) || INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT;
    const quota = await installAutoQuotaQueue(PRIVILEGED_QUOTA_FILE, () =>
      checkInstallQuotaFile(PRIVILEGED_QUOTA_FILE, { record: true, max, windowMs }));
    if (!quota.allowed) {
      return {
        ok: false,
        opId: trimString(op?.opId),
        error: `Install-auto quota exceeded (${quota.used}/${quota.max} in ${quota.windowMs}ms window)`,
        code: 'INSTALL_QUOTA_EXCEEDED',
      };
    }
  }

  // P2 passkey gate (design §5.6): 'passkey'-mode tokens require a human
  // WebAuthn assertion over exactly the batch subset this op belongs to. The
  // credentialId proves a human approved; signedManifestHash (the hash bound
  // into the WebAuthn challenge and returned with the proof) must equal the
  // op's batch subset hash. Fails closed — no token, no execution.
  //
  // 'owner-click' mode (owner passkey policy off) drops only the credentialId
  // requirement; the op is still bound to the exact checked subset via
  // signedManifestHash === batchManifestHash, and the token stays one-shot,
  // short-TTL, and cgroup-bound. Any unknown authMode still fails closed.
  if (trimString(options.authMode) !== PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO) {
    const credentialId = trimString(options.webauthnCredentialId);
    const signedManifestHash = trimString(options.signedManifestHash);
    const batchManifestHash = trimString(op?.batchManifestHash);
    if (!credentialId && trimString(options.authMode) !== PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK) {
      return {
        ok: false,
        opId: trimString(op?.opId),
        error: 'Passkey approval is required for this category',
        code: 'PRIVILEGED_PASSKEY_REQUIRED',
      };
    }
    if (!signedManifestHash || !batchManifestHash || signedManifestHash !== batchManifestHash) {
      return {
        ok: false,
        opId: trimString(op?.opId),
        error: 'WebAuthn-signed subset does not match this op batch',
        code: 'PRIVILEGED_PASSKEY_MANIFEST_MISMATCH',
      };
    }
  }

  const tokenPayload = {
    kid: activeKey.kid,
    opId: trimString(op.opId),
    category,
    command,
    cwd,
    manifestHash,
    sessionId: trimString(options.sessionId),
    runId,
    turnId: trimString(options.turnId),
    cgroup: runId ? buildPrivilegedCgroupFromRunId(runId) : '',
    authMode,
    issuedAt,
    expiresAt,
  };

  let signedToken;
  try {
    signedToken = signPrivilegedToken(tokenPayload, activeKey.privateKey, { kid: activeKey.kid });
  } catch (err) {
    return { ok: false, opId: tokenPayload.opId, error: `Token signing failed: ${err.message}`, code: 'SIGNING_FAILED' };
  }

  let response;
  try {
    response = await requestPrivilegedExecutor(
      {
        action: PRIVILEGED_EXECUTOR_ACTION_EXEC,
        token: signedToken,
        auditLabel: trimString(options.auditLabel) || undefined,
      },
      {
        socketPath: trimString(options.socketPath) || undefined,
        timeoutMs: options.timeoutMs,
      },
    );
  } catch (err) {
    // Socket-level error (timeout, connection refused, too large, etc.) —
    // map to a consistent result shape so callers don't need to distinguish
    // transport errors from executor rejection errors.
    return {
      ok: false,
      opId: tokenPayload.opId,
      category: tokenPayload.category,
      error: err.message,
      code: err.code || 'PRIVILEGED_REQUEST_FAILED',
    };
  }

  // Executor responded — map to result
  const result = response?.result || {};
  return {
    ok: response?.ok === true,
    opId: tokenPayload.opId,
    category: tokenPayload.category,
    exitCode: result.exitCode ?? null,
    auditId: trimString(result.auditId),
    stdoutRef: trimString(result.stdoutRef || result.stdout),
    error: !response?.ok ? trimString(response?.error) : '',
    code: !response?.ok ? trimString(response?.code) : '',
  };
}

/**
 * Sign and deliver a semantic capability to the separate fixed-argv executor
 * action. The caller must already have consumed an owner proof for exactly the
 * capability selection; this function deliberately accepts no raw command,
 * argv, cwd, environment, or replacement resource descriptor.
 */
export async function executeSemanticCapability(capability, options = {}) {
  const activeKey = getActivePrivilegedSigningKey();
  if (!activeKey) {
    return { ok: false, error: 'No active signing key', code: 'NO_SIGNING_KEY' };
  }
  if (trimString(capability?.kid) !== trimString(activeKey.kid)) {
    return { ok: false, error: 'Semantic capability signing key mismatch', code: 'SEMANTIC_CAPABILITY_KEY_MISMATCH' };
  }
  let signedCapability;
  try {
    signedCapability = signSemanticCapability(capability, activeKey.privateKey);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      code: trimString(error?.code) || 'SEMANTIC_CAPABILITY_SIGNING_FAILED',
    };
  }
  let response;
  try {
    response = await requestPrivilegedExecutor({
      action: PRIVILEGED_EXECUTOR_ACTION_SEMANTIC_EXEC,
      capability: signedCapability,
      auditLabel: trimString(options.auditLabel) || undefined,
    }, {
      socketPath: trimString(options.socketPath) || undefined,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      capabilityId: trimString(signedCapability.capabilityId),
      error: error?.message || String(error),
      code: trimString(error?.code) || 'PRIVILEGED_REQUEST_FAILED',
    };
  }
  const result = response?.result || {};
  return {
    ok: response?.ok === true,
    capabilityId: trimString(signedCapability.capabilityId),
    adapter: trimString(signedCapability.adapter),
    exitCode: result.exitCode ?? null,
    auditId: trimString(result.auditId),
    stdoutRef: trimString(result.stdoutRef || result.stdout),
    error: response?.ok === true ? '' : trimString(response?.error),
    code: response?.ok === true ? '' : trimString(response?.code),
  };
}

/**
 * Convenience: execute an op and return a privilegedExecResultEvent ready for
 * append to the session event stream, or null on signing failure.
 */
export async function executePrivilegedOpAsEvent(op, options = {}) {
  const result = await executePrivilegedOp(op, options);
  return privilegedExecResultEvent({
    opId: result.opId,
    category: result.category,
    exitCode: result.exitCode,
    auditId: result.auditId,
    stdoutRef: result.stdoutRef,
    error: result.error,
  });
}
