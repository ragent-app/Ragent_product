import { execFile, spawn } from 'node:child_process';
import { assertWorkbenchExecution } from '../lib/workbench-execution-policy.mjs';
import { randomBytes } from 'node:crypto';
import { open, readFile, appendFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_MANAGED_PROCESSES_DIR } from '../lib/config.mjs';
import {
  createKeyedTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { appendEvent } from './history.mjs';
import { statusEvent } from './normalizer.mjs';
import { getSession, submitHttpMessage } from './session-manager.mjs';
import { emitTriggerEvent } from './triggers.mjs';

const execFileAsync = promisify(execFile);
const SIDE_CAR_PATH = fileURLToPath(new URL('./managed-process-sidecar.mjs', import.meta.url));
const DEFAULT_SUPERVISOR_POLL_MS = 1000;
const MIN_SUPERVISOR_POLL_MS = 250;
const MAX_SUPERVISOR_POLL_MS = 60 * 1000;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 16 * 1024;
const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_OUTPUT_LOG_BYTES = 1024 * 1024;
const MAX_WAKE_TEXT_CHARS = 16 * 1024;
const PROCESS_ID_RE = /^mp_[a-f0-9]{24}$/;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const ALLOWED_WAKE_EVENTS = new Set(['terminal', 'output']);
const SENSITIVE_ENV_RE = /(TOKEN|PASSWORD|SECRET|COOKIE|AUTH|PRIVATE|CREDENTIAL|API_KEY|KEY$)/i;
const STATUS_LOCK_TIMEOUT_MS = 10 * 1000;
const STATUS_LOCK_STALE_MS = 30 * 1000;
const STATUS_LOCK_RETRY_MS = 10;

const processMutationQueue = createKeyedTaskQueue();
let supervisorTimer = null;
let supervisorPromise = null;
const feedbackPromises = new Map();

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function processDir(processId) {
  return join(CHAT_MANAGED_PROCESSES_DIR, processId);
}

function statusLockPath(processId) {
  return `${managedProcessStatusPath(processId)}.lock`;
}

async function withStatusFileLock(processId, callback) {
  const lockPath = statusLockPath(processId);
  await ensureDir(processDir(processId));
  const deadline = Date.now() + STATUS_LOCK_TIMEOUT_MS;
  let handle = null;
  let lockToken = '';

  while (Date.now() < deadline) {
    try {
      lockToken = randomBytes(16).toString('hex');
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${lockToken}\n`, 'utf8');
      break;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      handle = null;
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs >= STATUS_LOCK_STALE_MS) {
          let ownerPid = 0;
          try {
            ownerPid = Number.parseInt((await readFile(lockPath, 'utf8')).split(/\s+/, 1)[0], 10) || 0;
          } catch {
            // A malformed stale marker is not held by a verifiable writer.
          }
          if (!(ownerPid > 0) || !(await isPidAlive(ownerPid))) {
            await rm(lockPath, { force: true });
            continue;
          }
        }
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, STATUS_LOCK_RETRY_MS));
    }
  }

  if (!handle) {
    const error = new Error(`managed process status lock timeout: ${processId}`);
    error.code = 'MANAGED_PROCESS_STATUS_LOCK_TIMEOUT';
    throw error;
  }

  try {
    return await callback();
  } finally {
    let owned = false;
    try {
      const marker = await readFile(lockPath, 'utf8');
      owned = marker.includes(`\n${lockToken}\n`);
    } catch {
      owned = false;
    }
    await handle.close().catch(() => {});
    if (owned) await rm(lockPath, { force: true }).catch(() => {});
  }
}

export function managedProcessManifestPath(processId) {
  return join(processDir(processId), 'manifest.json');
}

export function managedProcessStatusPath(processId) {
  return join(processDir(processId), 'status.json');
}

export function managedProcessStdoutPath(processId) {
  return join(processDir(processId), 'stdout.log');
}

export function managedProcessStderrPath(processId) {
  return join(processDir(processId), 'stderr.log');
}

export function isManagedProcessTerminal(state) {
  return TERMINAL_STATES.has(text(state).toLowerCase());
}

function createManagedProcessId() {
  return `mp_${randomBytes(12).toString('hex')}`;
}

function parsePollMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SUPERVISOR_POLL_MS;
  return Math.max(MIN_SUPERVISOR_POLL_MS, Math.min(MAX_SUPERVISOR_POLL_MS, parsed));
}

function validateExecutable(value) {
  const executable = text(value);
  if (!executable || executable.includes('\0')) throw new Error('executable is required');
  if (executable.length > MAX_ARGUMENT_CHARS) throw new Error('executable is too long');
  return executable;
}

function validateArgs(value) {
  if (!Array.isArray(value)) throw new Error('args must be an array');
  if (value.length > MAX_ARGUMENTS) throw new Error(`args cannot contain more than ${MAX_ARGUMENTS} entries`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.includes('\0')) throw new Error(`args[${index}] must be a string without NUL`);
    if (entry.length > MAX_ARGUMENT_CHARS) throw new Error(`args[${index}] is too long`);
    return entry;
  });
}

function buildSafeEnvironment(overrides = {}) {
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new Error('env must be an object');
  }
  const env = {};
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key || key.startsWith('RAGENT_') || SENSITIVE_ENV_RE.test(key)) continue;
    if (raw !== undefined && raw !== null && !String(raw).includes('\0')) env[key] = String(raw);
  }
  for (const [rawKey, rawValue] of Object.entries(overrides || {})) {
    const key = String(rawKey);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (key.startsWith('RAGENT_') || SENSITIVE_ENV_RE.test(key)) {
      throw new Error(`Environment key is not allowed for a managed process: ${key}`);
    }
    if (rawValue === undefined || rawValue === null) delete env[key];
    else {
      const value = String(rawValue);
      if (value.includes('\0') || value.length > MAX_ARGUMENT_CHARS) throw new Error(`Invalid environment value: ${key}`);
      env[key] = value;
    }
  }
  return env;
}

function normalizeWake(input, defaultSessionId) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionId = text(raw.sessionId || defaultSessionId);
  if (!sessionId) throw new Error('wake.sessionId is required');
  const requested = Array.isArray(raw.on) ? raw.on : [raw.on || 'terminal'];
  const on = [...new Set(requested.map((entry) => text(entry).toLowerCase()).filter((entry) => ALLOWED_WAKE_EVENTS.has(entry)))];
  if (on.length === 0) throw new Error('wake.on must contain terminal or output');
  const wakeText = text(raw.text) || 'Managed process {{process.id}} finished with state {{process.state}}.';
  if (wakeText.length > MAX_WAKE_TEXT_CHARS) throw new Error('wake.text is too long');
  return {
    sessionId,
    on,
    text: wakeText,
    includeOutput: raw.includeOutput === true,
  };
}

async function readManagedRecord(processId) {
  if (!PROCESS_ID_RE.test(text(processId))) return null;
  const [manifest, status] = await Promise.all([
    readJson(managedProcessManifestPath(processId), null),
    readJson(managedProcessStatusPath(processId), null),
  ]);
  if (!manifest || !status) return null;
  return { manifest, status };
}

async function readTail(path, maxBytes = MAX_OUTPUT_TAIL_BYTES) {
  const stats = await statOrNull(path);
  if (!stats) return '';
  try {
    const content = await readFile(path);
    return content.length <= maxBytes ? content.toString('utf8') : content.subarray(-maxBytes).toString('utf8');
  } catch {
    return '';
  }
}

async function appendOutputFile(path, bytes) {
  await appendFile(path, bytes, { mode: 0o600 });
  const stats = await stat(path);
  if (stats.size <= MAX_OUTPUT_LOG_BYTES) return stats.size;

  // Keep the durable file bounded as well as the API response. The caller
  // holds the per-process lock, so truncating here cannot race another writer.
  const content = await readFile(path);
  const retained = content.subarray(-MAX_OUTPUT_LOG_BYTES);
  await writeFile(path, retained, { mode: 0o600 });
  return retained.length;
}

function publicRecord(record, { includeOutput = true } = {}) {
  if (!record) return null;
  const { manifest, status } = record;
  return {
    id: manifest.id,
    sessionId: manifest.sessionId,
    createdByRunId: manifest.createdByRunId,
    executable: manifest.executable,
    args: manifest.args,
    cwd: manifest.cwd,
    envKeys: Object.keys(manifest.env || {}),
    wake: manifest.wake,
    createdAt: manifest.createdAt,
    updatedAt: status.updatedAt || manifest.updatedAt,
    state: status.state,
    pid: Number.isInteger(status.pid) ? status.pid : null,
    sidecarPid: Number.isInteger(status.sidecarPid) ? status.sidecarPid : null,
    startedAt: status.startedAt || '',
    completedAt: status.completedAt || '',
    exitCode: Number.isInteger(status.exitCode) ? status.exitCode : null,
    signal: text(status.signal),
    windowsJobObjectManaged: status.windowsJobObjectManaged === true,
    windowsJobObjectCreation: text(status.windowsJobObjectCreation),
    error: text(status.error),
    stdoutBytes: Number(status.stdoutBytes) || 0,
    stderrBytes: Number(status.stderrBytes) || 0,
    stdoutTotalBytes: Number(status.stdoutTotalBytes) || Number(status.stdoutBytes) || 0,
    stderrTotalBytes: Number(status.stderrTotalBytes) || Number(status.stderrBytes) || 0,
    outputSeq: Number(status.outputSeq) || 0,
    feedbackDeliveredAt: status.feedbackDeliveredAt || '',
    outputFeedbackSeq: Number(status.outputFeedbackSeq) || 0,
  };
}

async function writeStatus(processId, patch) {
  const normalizedId = text(processId);
  if (!PROCESS_ID_RE.test(normalizedId)) return null;
  return processMutationQueue(normalizedId, () => withStatusFileLock(normalizedId, async () => {
    const path = managedProcessStatusPath(normalizedId);
    const current = await readJson(path, null);
    if (!current) return null;
    const currentState = text(current.state);
    const currentTerminal = isManagedProcessTerminal(currentState);
    // A late sidecar/reconciler write must not replace an already observed
    // terminal result. Auxiliary cursors (output/feedback) remain mergeable.
    const terminalFields = new Set(['state', 'startedAt', 'completedAt', 'pid', 'exitCode', 'signal', 'error']);
    const safePatch = currentTerminal
      ? Object.fromEntries(Object.entries(patch || {}).filter(([key]) => !terminalFields.has(key)))
      : patch;
    const next = { ...current, ...safePatch, updatedAt: nowIso() };
    await writeJsonAtomic(path, next, { mode: 0o600 });
    return next;
  }));
}

export async function readManagedProcess(processId, { includeOutput = true } = {}) {
  const record = await readManagedRecord(processId);
  if (!record) return null;
  const result = publicRecord(record, { includeOutput });
  if (includeOutput) {
    result.stdout = await readTail(managedProcessStdoutPath(record.manifest.id));
    result.stderr = await readTail(managedProcessStderrPath(record.manifest.id));
  }
  return result;
}

export async function listManagedProcesses({ sessionId = '' } = {}) {
  let entries = [];
  try { entries = await (await import('node:fs/promises')).readdir(CHAT_MANAGED_PROCESSES_DIR, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROCESS_ID_RE.test(entry.name)) continue;
    const record = await readManagedRecord(entry.name);
    if (!record || (sessionId && record.manifest.sessionId !== text(sessionId))) continue;
    result.push(publicRecord(record, { includeOutput: false }));
  }
  return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function assertSession(sessionId) {
  const session = await getSession(text(sessionId));
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  return session;
}

async function spawnSidecar(processId, { watchExisting = false } = {}) {
  const args = [SIDE_CAR_PATH, '--managed-process', processId];
  if (watchExisting) args.push('--watch-existing');
  const sidecarEnv = {
    PATH: process.env.PATH || '',
    NODE_ENV: process.env.NODE_ENV || 'production',
    HOME: process.env.HOME || '',
  };
  // The sidecar is detached from the Run but remains inside this Ragent
  // instance. Pass only path-selection variables so it can reopen the same
  // manifest/status files without inheriting session tokens or capabilities.
  for (const key of [
    // Windows per-user paths derive the config root from the instance name
    // when the launcher deliberately withholds RAGENT_CONFIG_DIR.
    'RAGENT_INSTANCE_NAME',
    'RAGENT_CONFIG_DIR',
    'RAGENT_INSTANCE_ROOT',
    'RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES',
    'RAGENT_SOURCE_PROJECT_ROOT',
    // Node's Windows homedir/config resolution relies on these variables;
    // preserve the instance's per-user location when the sidecar is detached.
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
  ]) {
    if (process.env[key]) sidecarEnv[key] = process.env[key];
  }
  const proc = spawn(process.execPath, args, {
    cwd: dirname(SIDE_CAR_PATH),
    env: sidecarEnv,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    shell: false,
  });
  proc.unref();
  // The sidecar owns the state transition to starting/running. Only record its
  // pid here; writing `starting` after spawn could overwrite a fast sidecar
  // that already reached `running`.
  await writeStatus(processId, { sidecarPid: proc.pid || null });
  return proc.pid || null;
}

export async function createManagedProcess(input = {}) {
  // An operator-limited workbench must not expose arbitrary auxiliary commands
  // as an alternative to its permitted, sandboxed model runtime.
  assertWorkbenchExecution({ agentType: 'managed-process' });
  const session = await assertSession(input.sessionId);
  const id = createManagedProcessId();
  const executable = validateExecutable(input.executable || input.file);
  const args = validateArgs(input.args || []);
  const cwd = resolve(text(input.cwd) || text(session.folder) || process.cwd());
  if (!isAbsolute(cwd)) throw new Error('cwd must resolve to an absolute path');
  const env = buildSafeEnvironment(input.env);
  const wake = normalizeWake(input.wake, session.id);
  if (wake.sessionId !== session.id) await assertSession(wake.sessionId);
  const createdAt = nowIso();
  const manifest = {
    version: 'managed-process/v1',
    id,
    sessionId: session.id,
    createdByRunId: text(input.createdByRunId),
    executable,
    args,
    cwd,
    env,
    wake,
    createdAt,
    updatedAt: createdAt,
    cancelRequested: false,
  };
  const status = {
    version: 'managed-process-status/v1',
    id,
    state: 'queued',
    pid: null,
    sidecarPid: null,
    startedAt: '',
    completedAt: '',
    exitCode: null,
    signal: '',
    error: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTotalBytes: 0,
    stderrTotalBytes: 0,
    windowsJobObjectManaged: false,
    windowsJobObjectCreation: '',
    outputSeq: 0,
    outputFeedbackSeq: 0,
    feedbackDeliveredAt: '',
    updatedAt: createdAt,
  };
  await ensureDir(processDir(id));
  await writeJsonAtomic(managedProcessManifestPath(id), manifest, { mode: 0o600 });
  await writeJsonAtomic(managedProcessStatusPath(id), status, { mode: 0o600 });
  try {
    await spawnSidecar(id);
  } catch (error) {
    await writeStatus(id, { state: 'failed', completedAt: nowIso(), error: error.message || String(error) });
    throw error;
  }
  return readManagedProcess(id);
}

async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function terminatePidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      return true;
    } catch { return false; }
  }
  try { process.kill(-pid, 'SIGTERM'); return true; } catch {}
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

export async function cancelManagedProcess(processId, reason = 'cancelled by owner') {
  const normalizedId = text(processId);
  const record = await readManagedRecord(normalizedId);
  if (!record) return null;
  if (isManagedProcessTerminal(record.status.state)) return publicRecord(record);
  await processMutationQueue(normalizedId, async () => {
    const manifest = await readJson(managedProcessManifestPath(normalizedId), null);
    if (manifest) await writeJsonAtomic(managedProcessManifestPath(normalizedId), {
      ...manifest,
      cancelRequested: true,
      cancelReason: text(reason) || 'cancelled by owner',
      updatedAt: nowIso(),
    }, { mode: 0o600 });
  });
  await terminatePidTree(Number(record.status.pid));
  await terminatePidTree(Number(record.status.sidecarPid));
  await writeStatus(normalizedId, { state: 'cancelled', completedAt: nowIso(), error: text(reason) || 'cancelled by owner' });
  await deliverManagedProcessFeedback(normalizedId).catch(() => {});
  return readManagedProcess(normalizedId);
}

function replaceTemplate(template, processId, status, output = '') {
  return String(template || '')
    .replace(/\{\{\s*process\.id\s*\}\}/g, processId)
    .replace(/\{\{\s*process\.state\s*\}\}/g, text(status.state))
    .replace(/\{\{\s*process\.exitCode\s*\}\}/g, status.exitCode == null ? '' : String(status.exitCode))
    .replace(/\{\{\s*process\.signal\s*\}\}/g, text(status.signal))
    .replace(/\{\{\s*process\.output\s*\}\}/g, output.slice(-MAX_OUTPUT_TAIL_BYTES))
    .slice(0, MAX_WAKE_TEXT_CHARS);
}

export async function deliverManagedProcessFeedback(processId) {
  const normalizedId = text(processId);
  const existing = feedbackPromises.get(normalizedId);
  if (existing) return existing;
  const promise = (async () => {
    const record = await readManagedRecord(normalizedId);
    if (!record || !isManagedProcessTerminal(record.status.state) || record.status.feedbackDeliveredAt) return false;
    const wake = record.manifest.wake;
    if (!wake?.on?.includes('terminal')) return true;
    const output = wake.includeOutput
      ? `${await readTail(managedProcessStdoutPath(normalizedId))}\n${await readTail(managedProcessStderrPath(normalizedId))}`
      : '';
    const message = replaceTemplate(wake.text, normalizedId, record.status, output);
    const requestId = `managed-process:${normalizedId}:terminal`;
    const outcome = await submitHttpMessage(wake.sessionId, message, [], {
      requestId,
      recordUserMessage: false,
      queueIfBusy: true,
      internalOperation: 'managed_process_feedback',
    });
    if (!outcome?.duplicate) {
      const event = statusEvent(`managed process ${normalizedId} finished: ${record.status.state}`);
      event.requestId = requestId;
      await appendEvent(wake.sessionId, event).catch(() => {});
    }
    await writeStatus(normalizedId, { feedbackDeliveredAt: nowIso() });
    return true;
  })().finally(() => {
    if (feedbackPromises.get(normalizedId) === promise) feedbackPromises.delete(normalizedId);
  });
  feedbackPromises.set(normalizedId, promise);
  return promise;
}

async function deliverManagedProcessOutputFeedback(processId) {
  const normalizedId = text(processId);
  const key = `${normalizedId}:output`;
  const existing = feedbackPromises.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const record = await readManagedRecord(normalizedId);
    if (!record || !record.manifest.wake?.on?.includes('output')) return false;
    const sequence = Number(record.status.outputSeq) || 0;
    if (sequence <= (Number(record.status.outputFeedbackSeq) || 0)) return false;
    const output = `${await readTail(managedProcessStdoutPath(normalizedId))}\n${await readTail(managedProcessStderrPath(normalizedId))}`;
    const message = replaceTemplate(record.manifest.wake.text, normalizedId, record.status, output);
    const outcome = await submitHttpMessage(record.manifest.wake.sessionId, message, [], {
      requestId: `managed-process:${normalizedId}:output:${sequence}`,
      recordUserMessage: false,
      queueIfBusy: true,
      internalOperation: 'managed_process_output_feedback',
    });
    if (!outcome?.duplicate) await appendEvent(record.manifest.wake.sessionId, statusEvent(`managed process ${normalizedId} produced output`)).catch(() => {});
    await writeStatus(normalizedId, { outputFeedbackSeq: sequence });
    return true;
  })().finally(() => {
    if (feedbackPromises.get(key) === promise) feedbackPromises.delete(key);
  });
  feedbackPromises.set(key, promise);
  return promise;
}

export async function reconcileManagedProcesses() {
  const records = await listManagedProcesses();
  for (const item of records) {
    const record = await readManagedRecord(item.id);
    if (!record) continue;
    if (isManagedProcessTerminal(record.status.state)) {
      await emitTriggerEvent('process_terminal', {
        eventId: `${item.id}:${record.status.completedAt || record.status.updatedAt}`,
        processId: item.id,
        sessionId: record.manifest.sessionId,
        state: record.status.state,
        exitCode: record.status.exitCode,
        signal: record.status.signal || '',
        completedAt: record.status.completedAt || '',
      }).catch(() => {});
      await deliverManagedProcessFeedback(item.id).catch((error) => console.error(`[managed-process] terminal feedback failed for ${item.id}: ${error.message}`));
      continue;
    }
    if (record.status.state === 'running' && !(await isPidAlive(Number(record.status.pid)))) {
      await writeStatus(item.id, {
        state: 'unknown',
        completedAt: nowIso(),
        error: 'Managed process disappeared before a terminal result was recorded',
      });
      await deliverManagedProcessFeedback(item.id).catch(() => {});
      continue;
    }
    if (['queued', 'starting'].includes(record.status.state)
        && !(await isPidAlive(Number(record.status.sidecarPid)))) {
      await writeStatus(item.id, { state: 'queued', sidecarPid: null });
      await spawnSidecar(item.id).catch(async (error) => {
        await writeStatus(item.id, { state: 'failed', completedAt: nowIso(), error: error.message || String(error) });
      });
    }
    if (record.status.state === 'running' && !(await isPidAlive(Number(record.status.sidecarPid)))) {
      // A detached child can survive a crashed sidecar. Reattach a polling
      // watcher instead of starting a second copy of the executable.
      await spawnSidecar(item.id, { watchExisting: true }).catch(async (error) => {
        await writeStatus(item.id, {
          state: 'unknown',
          completedAt: nowIso(),
          error: `Managed process watcher could not be restored: ${error.message || String(error)}`,
        });
      });
    }
    if ((Number(record.status.outputSeq) || 0) > (Number(record.status.outputFeedbackSeq) || 0)) {
      await emitTriggerEvent('process_output', {
        eventId: `${item.id}:output:${Number(record.status.outputSeq) || 0}`,
        processId: item.id,
        sessionId: record.manifest.sessionId,
        outputSeq: Number(record.status.outputSeq) || 0,
      }).catch(() => {});
    }
    await deliverManagedProcessOutputFeedback(item.id).catch(() => {});
  }
  return records.length;
}

export function startManagedProcessSupervisor(options = {}) {
  if (supervisorTimer) return supervisorTimer;
  const pollMs = parsePollMs(options.pollMs || process.env.RAGENT_MANAGED_PROCESS_POLL_MS);
  void reconcileManagedProcesses().catch(() => {});
  supervisorTimer = setInterval(() => {
    if (supervisorPromise) return;
    supervisorPromise = reconcileManagedProcesses().catch(() => {}).finally(() => { supervisorPromise = null; });
  }, pollMs);
  supervisorTimer.unref?.();
  return supervisorTimer;
}

export function stopManagedProcessSupervisor() {
  if (!supervisorTimer) return false;
  clearInterval(supervisorTimer);
  supervisorTimer = null;
  return true;
}

export async function loadManagedProcessInternal(processId) {
  return readManagedRecord(processId);
}

export async function appendManagedProcessOutput(processId, stream, chunk) {
  const normalizedId = text(processId);
  if (!PROCESS_ID_RE.test(normalizedId)) return;
  const path = stream === 'stderr' ? managedProcessStderrPath(normalizedId) : managedProcessStdoutPath(normalizedId);
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''));
  if (bytes.length === 0) return;
  // Append and advance the durable cursor under the same per-process queue.
  // This prevents two stream callbacks from reading the same counters and
  // losing bytes/sequence increments.
  await processMutationQueue(normalizedId, () => withStatusFileLock(normalizedId, async () => {
    const retainedBytes = await appendOutputFile(path, bytes);
    const statusPath = managedProcessStatusPath(normalizedId);
    const status = await readJson(statusPath, null);
    if (!status) return;
    const bytesField = stream === 'stderr' ? 'stderrBytes' : 'stdoutBytes';
    const totalBytesField = stream === 'stderr' ? 'stderrTotalBytes' : 'stdoutTotalBytes';
    const previousTotal = Number.isFinite(Number(status[totalBytesField]))
      ? Number(status[totalBytesField])
      : (Number(status[bytesField]) || 0);
    const updatedAt = nowIso();
    await writeJsonAtomic(statusPath, {
      ...status,
      [bytesField]: retainedBytes,
      [totalBytesField]: previousTotal + bytes.length,
      outputSeq: (Number(status.outputSeq) || 0) + 1,
      lastOutputAt: updatedAt,
      updatedAt,
    }, { mode: 0o600 });
  }));
}

export async function writeManagedProcessStatus(processId, patch) {
  return writeStatus(processId, patch);
}
