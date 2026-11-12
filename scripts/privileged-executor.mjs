#!/usr/bin/env node
import { chmod, chown, lstat, mkdir, open, readFile, unlink } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { createPublicKey, randomBytes } from 'crypto';
import { dirname, isAbsolute } from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';

// P3c — privileged executor daemon (root)
// (proposal: /var/lib/agentoc/workspace/p3-executor-proposal-draft.md §2.1, §3.3, §4).
//
// This daemon runs as root and accepts one-shot signed token exec requests
// from the chat-server over a Unix socket. It owns the narrow socket/exec/
// audit boundary for approved privileged operations and uses P3a token
// verification (Ed25519 signature + consumed-Set + install-auto structural
// checks).
//
// Executor lifecycle (§2.3):
// - No persistent request queue (pure request/response)
// - Socket in /run (volatile) — prepareSocket rebuilds on restart
// - Audit in /var/lib/agentoc/config (persistent) — append-only
// - Consumed set rebuilt from audit on startup (blocks replay across restarts)
// - SIGTERM/SIGINT graceful shutdown

// ── constants ────────────────────────────────────────────────────────────────

const MAX_REQUEST_BYTES = 1024 * 1024;        // 1 MiB
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;     // 2 MiB
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;     // 30 min

const EXECUTOR_GROUP = process.env.AGENTOC_PRIVILEGED_EXECUTOR_GROUP || 'agentoc-privileged';
const SOCKET_PATH = process.env.AGENTOC_PRIVILEGED_EXECUTOR_SOCKET
  || '/run/agentoc-privileged-executor/sock';
const AUDIT_FILE = process.env.AGENTOC_PRIVILEGED_EXECUTOR_AUDIT_FILE
  || '/var/log/agentoc-privileged/audit.jsonl';
const SERVICE_USER_FILE = process.env.AGENTOC_SERVICE_USER_FILE
  || '/etc/agentoc/service-user';
const PEERCRED_HELPER = process.env.AGENTOC_PRIVILEGED_PEERCRED_HELPER
  || '/usr/lib/agentoc/privileged-peercred';

const ALLOW_UNPRIVILEGED_TEST = process.env.AGENTOC_PRIVILEGED_EXECUTOR_ALLOW_UNPRIVILEGED_TEST === '1';
const SKIP_RUNNER_LIVENESS = process.env.AGENTOC_PRIVILEGED_EXECUTOR_SKIP_RUNNER_LIVENESS === '1';
// Default off. This controls only the separate fixed-argv semantic route.
const SEMANTIC_APT_ADAPTER_ENABLED = process.env.AGENTOC_SEMANTIC_APT_ADAPTER_ENABLED === '1';
// Windows adapters remain hard-disabled until this executor has a verified
// named-pipe peer, the Phase 2A policy gate, Windows service liveness, ACL,
// and artifact-facts boundaries. The environment cannot opt into a partially
// implemented trust boundary.
// Test-only: even in unprivileged-test mode, run the real SO_PEERCRED helper
// path so the uid-mismatch rejection branch can be exercised without root.
const FORCE_PEERCRED_TEST = process.env.AGENTOC_PRIVILEGED_EXECUTOR_FORCE_PEERCRED === '1';

const execFileAsync = promisify(execFileCallback);

// ── from P3a token verification (inlined to keep executor self-contained) ────

import {
  PRIVILEGED_CGROUP_INACTIVE,
  PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO,
  PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
  PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
  PRIVILEGED_TOKEN_OK,
  buildPrivilegedCgroupFromRunId,
  verifyPrivilegedExecutableScope,
  verifyPrivilegedInstallScope,
  verifyPrivilegedToken,
} from '../chat/privileged-token.mjs';
import {
  SEMANTIC_ADAPTER_APT_INSTALL_V1,
  SEMANTIC_CAPABILITY_ERROR,
  verifySemanticCapability,
} from '../chat/semantic-capability.mjs';

// ── in-memory consumed set (rebuilt from audit on startup) ────────────────────

const consumedOpIds = new Set();
const consumedSemanticNonces = new Set();

const APT_GET_EXECUTABLE = '/usr/bin/apt-get';
const APT_CACHE_EXECUTABLE = '/usr/bin/apt-cache';

// ── helpers ──────────────────────────────────────────────────────────────────

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isUnprivilegedTestProcess() {
  return ALLOW_UNPRIVILEGED_TEST
    && typeof process.geteuid === 'function'
    && process.geteuid() !== 0;
}

async function chownIfPrivileged(path, uid, gid) {
  if (isUnprivilegedTestProcess()) return;
  await chown(path, uid, gid);
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readCommandOutput(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function parseIntegerOutput(command, args) {
  return Number.parseInt(await readCommandOutput(command, args), 10);
}

async function resolveAccount(name) {
  const user = trimString(name);
  if (!user || user === 'root') throw new Error('A non-root service user is required');
  const [passwdLine, group, uid, gid] = await Promise.all([
    readCommandOutput('getent', ['passwd', user]),
    readCommandOutput('id', ['-gn', user]),
    parseIntegerOutput('id', ['-u', user]),
    parseIntegerOutput('id', ['-g', user]),
  ]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`Unable to resolve numeric account IDs for: ${user}`);
  }
  const passwd = passwdLine.split(':');
  return {
    user,
    group,
    home: trimString(passwd[5]) || '/var/lib/agentoc',
    uid,
    gid,
  };
}

async function lookupGroupGid(groupName) {
  try {
    const stdout = await readCommandOutput('getent', ['group', groupName], { timeout: 2_000, maxBuffer: 16 * 1024 });
    const gid = Number.parseInt(stdout.split(':')[2], 10);
    if (Number.isInteger(gid) && gid > 0) return gid;
  } catch {}
  try {
    const stdout = await readCommandOutput('id', ['-g', groupName], { timeout: 2_000, maxBuffer: 16 * 1024 });
    const gid = Number.parseInt(stdout.trim(), 10);
    if (Number.isInteger(gid) && gid > 0) return gid;
  } catch {}
  // Fallback: in unprivileged test mode, use current process gid
  if (ALLOW_UNPRIVILEGED_TEST && typeof process.getegid === 'function') {
    const egid = process.getegid();
    if (typeof egid === 'number' && egid >= 0) return egid;
  }
  throw new Error(`Unable to resolve group: ${groupName}`);
}

// ── peer credential resolution ──────────────────────────────────────────────

async function readPeerCredentials(socket) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) {
    const error = new Error('Unable to inspect privileged executor caller credentials');
    error.code = 'PRIVILEGED_CALLER_UNKNOWN';
    throw error;
  }
  let parsed;
  try {
    const stdout = await new Promise((resolvePromise, reject) => {
      const child = spawn(PEERCRED_HELPER, [], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
      });
      let settled = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let timer = null;
      const finish = (error, value = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise(value);
      };
      const collect = (chunk, stream) => {
        const next = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + chunk.toString('utf8');
        if (Buffer.byteLength(next, 'utf8') > 64 * 1024) {
          child.kill('SIGKILL');
          finish(new Error('peer credential helper output exceeded the size limit'));
          return;
        }
        if (stream === 'stdout') stdoutBuffer = next;
        else stderrBuffer = next;
      };
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('peer credential helper timed out'));
      }, 2_000);
      child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
      child.once('error', (error) => finish(error));
      child.once('close', (exitCode, signal) => {
        if (exitCode === 0) finish(null, stdoutBuffer);
        else finish(new Error(trimString(stderrBuffer) || `peer credential helper exited with ${signal || exitCode}`));
      });
    });
    parsed = JSON.parse(stdout);
  } catch (cause) {
    const error = new Error(`Unable to inspect privileged executor caller credentials: ${cause?.message || cause}`);
    error.code = 'PRIVILEGED_CALLER_UNKNOWN';
    throw error;
  }
  if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0 || !Number.isInteger(parsed?.uid)) {
    const error = new Error('Privileged executor caller credentials are invalid');
    error.code = 'PRIVILEGED_CALLER_UNKNOWN';
    throw error;
  }
  return parsed;
}

async function resolveServiceAccount() {
  let serviceUser = '';
  try {
    serviceUser = trimString((await readFile(SERVICE_USER_FILE, 'utf8')).split(/\r?\n/, 1)[0]);
  } catch {}
  return await resolveAccount(serviceUser || 'agentoc');
}

async function resolveCaller(socket, request = {}) {
  if (ALLOW_UNPRIVILEGED_TEST && !FORCE_PEERCRED_TEST) {
    return { uid: process.geteuid?.() ?? process.getuid?.() ?? 0, pid: process.pid };
  }
  const peer = await readPeerCredentials(socket);
  const account = await resolveServiceAccount();
  if (peer.uid !== account.uid) {
    const error = new Error('Privileged executor caller is not the configured AgentoC service user');
    error.code = 'PRIVILEGED_CALLER_DENIED';
    throw error;
  }
  return peer;
}

// ── public key loading (self-contained, no dependency on chat-server modules) ──

const PRIVILEGED_SIGNING_KEYS_FILE = process.env.AGENTOC_PRIVILEGED_SIGNING_KEYS_FILE
  || '/var/lib/agentoc/config/privileged-signing-keys.json';

// In-memory map: kid → publicKey (KeyObject). Loaded once at startup from
// the same keys file the chat-server writes, which the executor can read
// because it runs as root (§3.2, §3.3 step 1).
let publicKeyMap = new Map();

async function loadPublicKeys() {
  const keysFile = await readJsonOrNull(PRIVILEGED_SIGNING_KEYS_FILE);
  if (!keysFile) {
    console.warn('[privileged-executor] No signing keys file found — all tokens will be rejected');
    return;
  }
  const map = new Map();
  for (const slot of [keysFile.current, keysFile.previous]) {
    if (!slot || !slot.kid || !slot.publicKey) continue;
    try {
      const pubKey = createPublicKey({
        key: Buffer.from(slot.publicKey, 'base64url'),
        type: 'spki',
        format: 'der',
      });
      map.set(slot.kid, pubKey);
    } catch (err) {
      console.error(`[privileged-executor] Failed to load public key ${slot.kid}: ${err.message}`);
    }
  }
  publicKeyMap = map;
  console.log(`[privileged-executor] Loaded ${map.size} public key(s)`);
}

function resolvePublicKeyByKid(kid) {
  return publicKeyMap.get(kid) || null;
}

async function verifyExecutorToken(token) {
  // Step 1: find public key by kid (§3.3 step 2)
  const kid = trimString(token?.kid);
  if (!kid) return { ok: false, code: 'PRIVILEGED_TOKEN_INVALID', error: 'Missing token kid' };
  if (!resolvePublicKeyByKid(kid)) {
    await loadPublicKeys();
  }
  const publicKey = resolvePublicKeyByKid(kid);
  if (!publicKey) return { ok: false, code: 'PRIVILEGED_TOKEN_INVALID', error: `Unknown signing key: ${kid}` };

  // Steps 2–6: pure checks (signature, expiry, manifest, cgroup)
  const pureResult = verifyPrivilegedToken(token, { publicKey });
  if (!pureResult.ok) return { ok: false, code: pureResult.code, error: `Token verification failed: ${pureResult.code}` };

  // Step 4 (executor-side): consumed check
  const opId = trimString(token.opId);
  if (consumedOpIds.has(opId)) {
    return { ok: false, code: 'PRIVILEGED_TOKEN_CONSUMED', error: 'Token already consumed' };
  }

  // D4 liveness (§3.4 "medium": derived-consistency in pureResult above +
  // systemctl is-active). Non-systemd launch modes already fail closed in
  // verifyPrivilegedTokenCgroup (null cgroup). Tests and environments without
  // the runner units skip the IO via env.
  if (!SKIP_RUNNER_LIVENESS) {
    const liveness = await runnerUnitLiveness(trimString(token.runId));
    if (!liveness.ok) {
      return { ok: false, code: PRIVILEGED_CGROUP_INACTIVE, error: liveness.error };
    }
  }

  // Step 7: install-auto hard structural whitelist (defense-in-depth)
  if (trimString(token.authMode) === PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO) {
    if (!verifyPrivilegedInstallScope(token)) {
      return { ok: false, code: 'PRIVILEGED_INSTALL_SCOPE_DENIED', error: 'Install scope check failed' };
    }
  }

  // Human-authorized executable allowlist (design §5.6 hardening): a passkey
  // proof or an explicit owner click is human approval, not a free pass for
  // arbitrary root shells. Both modes execute only concrete allowlisted
  // programs as root; shells/interpreters and anything unknown fail closed.
  // Unknown authMode values never reach this point — they fail closed in
  // verifyPrivilegedToken with PRIVILEGED_AUTH_MODE_INVALID.
  if (trimString(token.authMode) === PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK) {
    if (!verifyPrivilegedExecutableScope(token)) {
      return { ok: false, code: 'PRIVILEGED_OWNER_CLICK_SCOPE_DENIED', error: 'Owner-click scope check failed' };
    }
  }

  // Passkey-mode executable allowlist (design §5.6 hardening): a WebAuthn
  // proof is human approval, not a free pass for arbitrary root shells. Only
  // concrete allowlisted programs execute as root; shells/interpreters and
  // anything unknown fail closed even with a valid passkey.
  if (trimString(token.authMode) === PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY) {
    if (!verifyPrivilegedExecutableScope(token)) {
      return { ok: false, code: 'PRIVILEGED_PASSKEY_SCOPE_DENIED', error: 'Passkey scope check failed' };
    }
  }

  return { ok: true, code: PRIVILEGED_TOKEN_OK };
}

async function verifySemanticExecutorCapability(capability) {
  const kid = trimString(capability?.kid);
  if (!kid) return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, error: 'Missing semantic capability key id' };
  if (!resolvePublicKeyByKid(kid)) await loadPublicKeys();
  const publicKey = resolvePublicKeyByKid(kid);
  if (!publicKey) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, error: `Unknown signing key: ${kid}` };
  }
  const verified = verifySemanticCapability(capability, { publicKey });
  if (!verified.ok) return verified;
  const nonce = trimString(capability.nonce);
  if (consumedSemanticNonces.has(nonce)) {
    return { ok: false, code: 'SEMANTIC_CAPABILITY_CONSUMED', error: 'Semantic capability nonce already consumed' };
  }
  if (!SKIP_RUNNER_LIVENESS) {
    const liveness = await runnerUnitLiveness(trimString(capability.runId));
    if (!liveness.ok) return { ok: false, code: PRIVILEGED_CGROUP_INACTIVE, error: liveness.error };
  }
  return { ok: true, code: '' };
}

/**
 * Derive the only supported semantic adapter invocation. No client-provided
 * command, argv, cwd, PATH, or environment is accepted on this route.
 */
export function buildSemanticAptInstallInvocation(capability = {}) {
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_APT_INSTALL_V1) {
    const error = new Error('Unsupported semantic adapter');
    error.code = SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED;
    throw error;
  }
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  const validOperations = operations.length > 0 && operations.every((entry) => {
    const effects = Array.isArray(entry?.effects) ? entry.effects.map(trimString).sort() : [];
    const input = entry?.adapterInput || {};
    return entry?.primaryAction === 'package.install'
      && entry?.platform === 'linux'
      && entry?.executionClass === 'host'
      && JSON.stringify(effects) === JSON.stringify(['process.execute'])
      && ['apt', 'apt-get'].includes(trimString(input.manager))
      && trimString(input.source) === 'trusted_repository'
      && Array.isArray(input.packages)
      && input.packages.length === 1
      && input.packages.every((name) => /^[a-z0-9][a-z0-9.+:~-]*$/i.test(trimString(name)))
      && Array.isArray(input.requestedVersions)
      && input.requestedVersions.length === input.packages.length
      && input.requestedVersions.every((version) => typeof version === 'string')
      && Array.isArray(input.resolvedVersions)
      && input.resolvedVersions.length === input.packages.length
      && input.resolvedVersions.every((version) => trimString(version))
      && Array.isArray(input.repositories)
      && input.repositories.length > 0
      && input.repositories.every((repository) => (
        trimString(repository?.id) && trimString(repository?.trust) === 'configured'
      ));
  });
  const packages = operations
    .flatMap((entry) => entry?.adapterInput?.packages || [])
    .map(trimString);
  if (!validOperations || packages.length === 0) {
    const error = new Error('Semantic adapter package target is invalid');
    error.code = SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED;
    throw error;
  }
  return {
    executable: APT_GET_EXECUTABLE,
    argv: ['install', ...packages],
    cwd: '/',
  };
}

export async function revalidateSemanticAptInstall(capability, { execFile = execFileAsync } = {}) {
  let invocation;
  try {
    invocation = buildSemanticAptInstallInvocation(capability);
  } catch (error) {
    return { ok: false, code: trimString(error?.code) || SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED, error: error?.message || String(error) };
  }
  // Package names are immutable in the signed capability. Validate each one
  // against current local apt metadata immediately before fixed-argv exec; no
  // shell, cwd, or environment from the requester participates.
  const packageEntries = (Array.isArray(capability.operations) ? capability.operations : [])
    .flatMap((entry) => {
      const input = entry?.adapterInput || {};
      return (input.packages || []).map((name, index) => ({
        name: trimString(name),
        requestedVersion: typeof input.requestedVersions?.[index] === 'string'
          ? input.requestedVersions[index] : '',
        resolvedVersion: trimString(input.resolvedVersions?.[index]),
        repositories: input.repositories || [],
      }));
    });
  for (const packageEntry of packageEntries) {
    const packageName = packageEntry.name;
    try {
      const { stdout } = await execFile(APT_CACHE_EXECUTABLE, ['show', '--no-all-versions', packageName], {
        cwd: '/',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      const packageHeader = String(stdout || '').match(/^Package:\s*(\S+)\s*$/m)?.[1] || '';
      const versions = [...String(stdout || '').matchAll(/^Version:\s*(\S+)\s*$/gm)].map((match) => match[1]);
      if (packageHeader !== packageName || versions.length === 0) {
        return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: `Package is no longer resolvable: ${packageName}` };
      }
      if (packageEntry.requestedVersion && !versions.includes(packageEntry.requestedVersion)) {
        return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: `Package version changed: ${packageName}` };
      }
      if (!versions.includes(packageEntry.resolvedVersion)) {
        return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: `Package candidate changed: ${packageName}` };
      }
      if (!packageEntry.repositories.every((repository) => String(stdout || '').includes(repository.id))) {
        return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: `Package repository changed: ${packageName}` };
      }
    } catch (error) {
      return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: `Package revalidation failed for ${packageName}: ${error?.message || error}` };
    }
  }
  return { ok: true, invocation };
}

// D4 liveness (§3.4 "medium"). Pure decision over the raw `systemctl is-active`
// output; the IO itself is a thin shell so the rejection branch is unit-testable
// without a systemd host. active → ok; everything else (inactive, failed,
// unknown, empty) → rejected, matching the fails-closed D4 default.
export function evaluateRunnerLiveness(rawOutput = '') {
  const state = String(rawOutput || '').trim().toLowerCase();
  if (state === 'active') return { ok: true, code: PRIVILEGED_TOKEN_OK };
  return { ok: false, code: PRIVILEGED_CGROUP_INACTIVE, error: `Runner unit not active (state: ${state || 'unknown'})` };
}

// D4 IO shell: `systemctl is-active <runner-unit>`. Any non-zero exit or spawn
// failure (unit missing, no systemd) fails closed.
async function runnerUnitLiveness(runId) {
  if (!trimString(runId)) {
    return { ok: false, code: PRIVILEGED_CGROUP_INACTIVE, error: 'Missing runId for runner liveness' };
  }
  const unit = buildPrivilegedCgroupFromRunId(runId);
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', unit], { timeout: 5_000 });
    return evaluateRunnerLiveness(stdout);
  } catch (error) {
    return { ok: false, code: PRIVILEGED_CGROUP_INACTIVE, error: `Runner liveness check failed: ${error?.message || error}` };
  }
}

// ── command execution ───────────────────────────────────────────────────────

async function spawnCaptured(command, options = {}) {
  const cwd = isAbsolute(trimString(options.cwd)) ? trimString(options.cwd) : '/';
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1_000, Math.min(MAX_EXEC_TIMEOUT_MS, Number(options.timeoutMs)))
    : DEFAULT_EXEC_TIMEOUT_MS;

  const startedAt = Date.now();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: {
        PATH: '/opt/agentoc/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/root',
        LANG: process.env.LANG || 'C.UTF-8',
        ...(options.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const collect = (chunk, chunks, stream) => {
      const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === 'stdout') {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) stdoutTruncated = true;
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES) stderrTruncated = true;
      }
    };

    child.stdout.on('data', (chunk) => collect(chunk, stdoutChunks, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, stderrChunks, 'stderr'));
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || '',
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function spawnFixedArgv(executable, argv, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1_000, Math.min(MAX_EXEC_TIMEOUT_MS, Number(options.timeoutMs)))
    : DEFAULT_EXEC_TIMEOUT_MS;
  const startedAt = Date.now();
  return await new Promise((resolvePromise, reject) => {
    // Do not use /bin/sh, inherited PATH, caller cwd, or caller environment.
    const child = spawn(executable, Array.isArray(argv) ? argv : [], {
      cwd: '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const collect = (chunk, chunks, stream) => {
      const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === 'stdout') {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) stdoutTruncated = true;
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES) stderrTruncated = true;
      }
    };
    child.stdout.on('data', (chunk) => collect(chunk, stdoutChunks, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, stderrChunks, 'stderr'));
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || '',
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// ── audit ────────────────────────────────────────────────────────────────────

let auditQueue = Promise.resolve();
async function appendAuditRecord(event = {}, { required = false } = {}) {
  const write = auditQueue.catch(() => {}).then(() => writeAuditRecord(event, { required }));
  auditQueue = write;
  return write;
}

async function writeAuditRecord(event = {}, { required = false } = {}) {
  let file;
  try {
    const groupGid = await lookupGroupGid(EXECUTOR_GROUP);
    const ownerUid = isUnprivilegedTestProcess() ? process.geteuid() : 0;
    await mkdir(dirname(AUDIT_FILE), { recursive: true, mode: 0o750 });
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    file = await open(AUDIT_FILE, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o640);
    const auditStat = await file.stat();
    if (!auditStat.isFile() || auditStat.uid !== ownerUid || auditStat.nlink !== 1 || (auditStat.mode & 0o022) !== 0) {
      throw new Error('Privileged audit is not an owner-controlled regular file');
    }
    await file.chmod(0o640);
    if (!isUnprivilegedTestProcess()) await file.chown(ownerUid, groupGid);
    await file.writeFile(line);
    if (required) {
      // Both file data and its directory entry must survive a crash before
      // the associated operation is allowed to start.
      await file.sync();
      const dir = await open(dirname(AUDIT_FILE), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } catch (err) {
    console.error(`[privileged-executor] audit write failed: ${err.message}`);
    if (required) {
      const error = new Error(`Required privileged audit write failed: ${err.message}`);
      error.code = 'PRIVILEGED_AUDIT_REQUIRED';
      throw error;
    }
  } finally { if (file) await file.close(); }
}

async function appendAudit(event = {}) {
  return appendAuditRecord(event);
}

// Semantic capabilities are one-shot across executor restarts. Their consume
// record is therefore an execution precondition, not best-effort telemetry.
async function appendRequiredAudit(event = {}) {
  return appendAuditRecord(event, { required: true });
}

function createAuditId() {
  return `paud_${randomBytes(10).toString('hex')}`;
}

// ── consumed set rebuild from audit (lifecycle §2.3) ──────────────────────────

async function rebuildConsumedSetFromAudit() {
  let content;
  let file;
  try {
    file = await open(AUDIT_FILE, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const auditStat = await file.stat();
    const ownerUid = isUnprivilegedTestProcess() ? process.geteuid() : 0;
    if (!auditStat.isFile() || auditStat.uid !== ownerUid || auditStat.nlink !== 1 || (auditStat.mode & 0o022) !== 0) {
      throw new Error('Privileged audit is not an owner-controlled regular file');
    }
    content = new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile());
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(`Cannot read privileged audit for replay protection: ${error.message}`);
  } finally { if (file) await file.close(); }
  if (content && !content.endsWith('\n')) throw new Error('Privileged audit ends with an incomplete record');
  try {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || typeof record.event !== 'string' || !record.event.trim()) throw new Error('Invalid audit record');
        const opId = trimString(record?.opId);
        if (opId && (record?.event === 'command_started' || record?.event === 'command_completed')) {
          consumedOpIds.add(opId);
        }
        const semanticNonce = trimString(record?.semanticNonce);
        if (semanticNonce && (record?.event === 'semantic_capability_consumed'
          || record?.event === 'semantic_command_started'
          || record?.event === 'semantic_command_completed')) {
          consumedSemanticNonces.add(semanticNonce);
        }
      } catch { throw new Error('Privileged audit contains an invalid record'); }
    }
    if (consumedOpIds.size > 0) {
      console.log(`[privileged-executor] Rebuilt consumed set: ${consumedOpIds.size} opIds`);
    }
    if (consumedSemanticNonces.size > 0) {
      console.log(`[privileged-executor] Rebuilt semantic nonce set: ${consumedSemanticNonces.size} nonces`);
    }
  } catch (error) { throw new Error(`Cannot rebuild privileged replay state: ${error.message}`); }
}

// ── request handling ─────────────────────────────────────────────────────────

export async function handleSemanticRequest(request, context = {}) {
  void context;
  const requestId = trimString(request?.id);
  const capability = request?.capability;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    return { ok: false, id: requestId, error: 'Missing semantic capability', code: SEMANTIC_CAPABILITY_ERROR.INVALID };
  }
  const adapter = trimString(capability.adapter);
  if (adapter === SEMANTIC_ADAPTER_APT_INSTALL_V1 && !SEMANTIC_APT_ADAPTER_ENABLED) {
    return { ok: false, id: requestId, error: 'Semantic apt adapter is disabled', code: 'SEMANTIC_ADAPTER_DISABLED' };
  }
  if (adapter === 'windows-winget-install/v1' || adapter === 'windows-msi-install/v1') {
    // This executor deliberately has no Windows Phase 2B production path yet.
    // Keep the old capability/revalidation implementation unreachable: a
    // caller-supplied test option or environment variable must not turn it
    // into an execution route without the unified policy gate and a real
    // connection-bound named-pipe fact source.
    return {
      ok: false,
      id: requestId,
      error: 'Semantic Windows adapter is disabled until the governed runtime boundary is complete',
      code: 'SEMANTIC_WINDOWS_ADAPTER_DISABLED',
    };
  }
  if (adapter !== SEMANTIC_ADAPTER_APT_INSTALL_V1) {
    return { ok: false, id: requestId, error: 'Unsupported semantic adapter', code: SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED };
  }
  const verification = await verifySemanticExecutorCapability(capability);
  if (!verification.ok) {
    await appendAudit({
      event: 'request_failed',
      requestId,
      capabilityId: trimString(capability.capabilityId),
      semanticNonce: trimString(capability.nonce),
      adapter: trimString(capability.adapter),
      code: verification.code,
      error: trimString(verification.error),
    });
    return { ok: false, id: requestId, error: verification.error, code: verification.code };
  }

  // Reserve and audit the nonce before any async revalidation. A concurrent
  // request, crash, or later failed check must not make this capability usable
  // a second time; startup reconstructs this set from the durable audit.
  const nonce = trimString(capability.nonce);
  // verifySemanticExecutorCapability checks before async liveness I/O. Check
  // once more immediately before the synchronous reservation so concurrent
  // verified requests cannot both use the same capability.
  if (consumedSemanticNonces.has(nonce)) {
    return { ok: false, id: requestId, error: 'Semantic capability nonce already consumed', code: 'SEMANTIC_CAPABILITY_CONSUMED' };
  }
  consumedSemanticNonces.add(nonce);
  await appendRequiredAudit({
    event: 'semantic_capability_consumed',
    requestId,
    capabilityId: trimString(capability.capabilityId),
    semanticNonce: nonce,
    adapter: trimString(capability.adapter),
    operationSetHash: trimString(capability.operationSetHash),
    selectionManifestHash: trimString(capability.selectionManifestHash),
    sessionId: trimString(capability.sessionId),
    runId: trimString(capability.runId),
    turnId: trimString(capability.turnId),
  });

  const revalidation = await revalidateSemanticAptInstall(capability);
  if (!revalidation.ok) {
    await appendAudit({
      event: 'request_failed',
      requestId,
      capabilityId: trimString(capability.capabilityId),
      semanticNonce: nonce,
      adapter: trimString(capability.adapter),
      code: revalidation.code,
      error: trimString(revalidation.error),
    });
    return { ok: false, id: requestId, error: revalidation.error, code: revalidation.code };
  }

  // Package metadata probing is asynchronous. Re-check the runner binding at
  // the last meaningful point before the durable start record and exec so a
  // run that stopped during revalidation cannot use a still-valid capability.
  if (!SKIP_RUNNER_LIVENESS) {
    const liveness = await runnerUnitLiveness(trimString(capability.runId));
    if (!liveness.ok) {
      await appendAudit({
        event: 'request_failed',
        requestId,
        capabilityId: trimString(capability.capabilityId),
        semanticNonce: nonce,
        adapter: trimString(capability.adapter),
        code: liveness.code,
        error: trimString(liveness.error),
      });
      return { ok: false, id: requestId, error: liveness.error, code: liveness.code };
    }
  }

  const auditId = createAuditId();
  const invocation = revalidation.invocation;
  await appendRequiredAudit({
    event: 'semantic_command_started',
    requestId,
    auditId,
    capabilityId: trimString(capability.capabilityId),
    semanticNonce: nonce,
    adapter: trimString(capability.adapter),
    operationSetHash: trimString(capability.operationSetHash),
    selectionManifestHash: trimString(capability.selectionManifestHash),
    sessionId: trimString(capability.sessionId),
    runId: trimString(capability.runId),
    turnId: trimString(capability.turnId),
  });
  const execResult = await spawnFixedArgv(invocation.executable, invocation.argv, {
    timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  });
  await appendAudit({
    event: 'semantic_command_completed',
    requestId,
    auditId,
    capabilityId: trimString(capability.capabilityId),
    semanticNonce: nonce,
    adapter: trimString(capability.adapter),
    exitCode: execResult.exitCode,
    signal: execResult.signal,
    timedOut: execResult.timedOut,
    durationMs: execResult.durationMs,
    stdoutTruncated: execResult.stdoutTruncated,
    stderrTruncated: execResult.stderrTruncated,
  });
  return {
    ok: true,
    id: requestId,
    result: {
      capabilityId: trimString(capability.capabilityId),
      adapter: trimString(capability.adapter),
      exitCode: execResult.exitCode,
      signal: execResult.signal,
      timedOut: execResult.timedOut,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      stdoutTruncated: execResult.stdoutTruncated,
      stderrTruncated: execResult.stderrTruncated,
      durationMs: execResult.durationMs,
      auditId,
    },
  };
}

export async function handleRequest(request, socket, options = {}) {
  const action = trimString(request?.action);
  if (action === 'semantic-exec') {
    await resolveCaller(socket, request);
    // Windows semantic execution is deliberately hard-disabled here. The
    // actual named-pipe dispatch module remains separately testable, but this
    // privileged daemon has no production Phase 2B gate/fact-boundary wiring.
    return handleSemanticRequest(request);
  }
  if (action !== 'exec') {
    const error = new Error(`Unknown privileged executor action: ${action || '(none)'}`);
    error.code = 'PRIVILEGED_UNKNOWN_ACTION';
    throw error;
  }

  const requestId = trimString(request?.id);

  // SO_PEERCRED — only chat-server may connect (§3.3 step 1)
  await resolveCaller(socket, request);

  // Verify the token (§3.3 steps 2–7)
  const token = request?.token;
  if (!token || typeof token !== 'object') {
    throw Object.assign(new Error('Missing or invalid token'), { code: 'PRIVILEGED_TOKEN_INVALID' });
  }
  const verification = await verifyExecutorToken(token);
  if (!verification.ok) {
    await appendAudit({
      event: 'request_failed',
      requestId,
      opId: trimString(token?.opId),
      category: trimString(token?.category),
      code: verification.code,
      error: verification.error,
    });
    return {
      ok: false,
      id: requestId,
      error: verification.error,
      code: verification.code,
    };
  }

  const opId = trimString(token.opId);
  const command = trimString(token.command);
  const cwd = trimString(token.cwd) || '/';
  const category = trimString(token.category);
  const auditId = createAuditId();
  const auditLabel = trimString(request?.auditLabel);

  // Reserve synchronously after verification: concurrent requests must not
  // both pass the prior asynchronous liveness check with the same token.
  if (consumedOpIds.has(opId)) {
    return { ok: false, id: requestId, error: 'Token already consumed', code: 'PRIVILEGED_TOKEN_CONSUMED' };
  }
  consumedOpIds.add(opId);
  // Execution requires a durable start record so replay remains blocked
  // after a crash, including when audit storage is full or unavailable.
  await appendRequiredAudit({
    event: 'command_started',
    requestId,
    opId,
    auditId,
    category,
    command,
    cwd,
    authMode: trimString(token.authMode),
    sessionId: trimString(token.sessionId),
    runId: trimString(token.runId),
    cgroup: trimString(token.cgroup),
    auditLabel: auditLabel || undefined,
  });

  // Execute (§4.1)
  const execResult = await spawnCaptured(command, { cwd, timeoutMs: DEFAULT_EXEC_TIMEOUT_MS });

  // Audit: command_completed
  await appendAudit({
    event: 'command_completed',
    requestId,
    opId,
    auditId,
    category,
    exitCode: execResult.exitCode,
    signal: execResult.signal,
    timedOut: execResult.timedOut,
    durationMs: execResult.durationMs,
    stdoutTruncated: execResult.stdoutTruncated,
    stderrTruncated: execResult.stderrTruncated,
  });

  return {
    ok: true,
    id: requestId,
    result: {
      opId,
      exitCode: execResult.exitCode,
      signal: execResult.signal,
      timedOut: execResult.timedOut,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      stdoutTruncated: execResult.stdoutTruncated,
      stderrTruncated: execResult.stderrTruncated,
      durationMs: execResult.durationMs,
      auditId,
      category,
    },
  };
}

// ── socket setup ─────────────────────────────────────────────────────────────

async function prepareSocket() {
  const groupGid = await lookupGroupGid(EXECUTOR_GROUP);
  const ownerUid = isUnprivilegedTestProcess() ? process.geteuid() : 0;
  await mkdir(dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });
  await chmod(dirname(SOCKET_PATH), 0o750);
  await chownIfPrivileged(dirname(SOCKET_PATH), ownerUid, groupGid);
  try {
    const existing = await lstat(SOCKET_PATH);
    if (!existing.isSocket()) throw new Error(`Refusing to replace non-socket path: ${SOCKET_PATH}`);
    await unlink(SOCKET_PATH);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return groupGid;
}

// ── serve ────────────────────────────────────────────────────────────────────

async function serve() {
  if (typeof process.geteuid === 'function' && process.geteuid() !== 0 && !ALLOW_UNPRIVILEGED_TEST) {
    throw new Error('Privileged executor must run as root');
  }

  await rebuildConsumedSetFromAudit();
  await loadPublicKeys();

  const groupGid = await prepareSocket();
  const server = net.createServer((socket) => {
    let requestBuffer = '';
    let handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      requestBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(requestBuffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: 'Request exceeded the size limit', code: 'PRIVILEGED_REQUEST_TOO_LARGE' })}\n`);
        return;
      }
      const newlineIndex = requestBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      handled = true;
      let request = null;
      try {
        request = JSON.parse(requestBuffer.slice(0, newlineIndex));
        socket.end(`${JSON.stringify(await handleRequest(request, socket))}\n`);
      } catch (error) {
        await appendAudit({
          event: 'request_failed',
          requestId: trimString(request?.id),
          action: trimString(request?.action),
          code: trimString(error?.code) || 'PRIVILEGED_REQUEST_FAILED',
          error: trimString(error?.message).slice(0, 500),
        }).catch(() => {});
        socket.end(`${JSON.stringify({
          ok: false,
          id: trimString(request?.id),
          error: error?.message || 'Privileged executor request failed',
          code: error?.code || 'PRIVILEGED_REQUEST_FAILED',
        })}\n`);
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', (error) => {
    console.error(`[privileged-executor] ${error.stack || error.message || error}`);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, resolvePromise);
  });
  await chmod(SOCKET_PATH, 0o660);
  await chownIfPrivileged(SOCKET_PATH, ALLOW_UNPRIVILEGED_TEST ? process.geteuid() : 0, groupGid);
  console.log(`[privileged-executor] listening on ${SOCKET_PATH}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── entry ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = trimString(argv[0]);
const invokedAsMain = typeof process.argv[1] === 'string'
  && (process.argv[1].endsWith('/privileged-executor.mjs') || process.argv[1].endsWith('scripts/privileged-executor.mjs'));

if (invokedAsMain) {
  if (command === 'serve' || command === '') {
    serve().catch((error) => {
      console.error(`[privileged-executor] ${error.stack || error.message || error}`);
      process.exit(1);
    });
  } else {
    console.error(`Unknown privileged executor command: ${command}`);
    console.error('Usage: node scripts/privileged-executor.mjs [serve]');
    process.exit(1);
  }
}
