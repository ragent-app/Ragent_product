#!/usr/bin/env node
// DS-02: safe test instance launcher.
//
// Launches a fully isolated AgentoC instance for tests / stress runs / diagnostics:
//   - fresh AGENTOC_CONFIG_DIR, AGENTOC_WORK_ROOT_DIR, AGENTOC_MEMORY_DIR
//   - unique instance id + instance marker (AGENTOC_TEST_INSTANCE_ID env, instance.json file)
//   - free temporary port (never 7690/7699 production ports)
//   - hard TTL with SIGTERM -> SIGKILL escalation (like timeout(1))
//   - on exit, removes ONLY the resources this instance created
//
// It never touches production state: no systemd units, no production config,
// no supervisor socket, no production cgroup membership. The child inherits the
// caller's cgroup (i.e. whatever sandbox/terminal runs the launcher) and is
// distinguishable from production processes via its env marker.
//
// Usage:
//   node scripts/launch-test-instance.mjs [options] [--] [command args...]
//
// Options:
//   --port <n|auto>   fixed port or auto (default: auto, free port 40000-49999)
//   --ttl <seconds>   hard lifetime; 0 = no TTL (default: 600)
//   --base-dir <dir>  parent dir for instances (default: $AGENTOC_TEST_INSTANCE_BASE_DIR
//                     or private temporary agct-<uid>; short /private/tmp path on macOS)
//   --instance-id <id> override generated id (/^[a-zA-Z0-9_-]{1,64}$/)
//   --grace <ms>      SIGTERM -> SIGKILL grace period (default: 3000)
//   --json            print a single machine-readable JSON status object on stdout
//                     (all diagnostics go to stderr)
//   --keep-on-error   do not clean up when the child fails to start (debugging)
//   -h, --help        show usage
//
// Default command: node chat-server.mjs (resolved from the repo root).
// Exit codes: child's exit code; 124 on TTL expiry; 130/143 on SIGINT/SIGTERM
// received by the launcher; 1 on launcher errors.

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DEFAULT_TARGET = join(repoRoot, 'chat-server.mjs');
const PRODUCTION_PORTS = new Set([7690, 7699]);
const TTL_EXIT_CODE = 124;
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArgs(argv) {
  const options = {
    port: 0,
    ttlSeconds: 600,
    baseDir: '',
    instanceId: '',
    graceMs: 3000,
    json: false,
    keepOnError: false,
    evidenceDir: '',
  };
  const command = [];
  let afterDoubleDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterDoubleDash) {
      command.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--keep-on-error') {
      options.keepOnError = true;
      continue;
    }
    const value = (flag) => {
      const inline = arg.startsWith(`${flag}=`);
      if (inline) return arg.slice(flag.length + 1);
      index += 1;
      return argv[index] ?? '';
    };
    if (arg === '--port' || arg.startsWith('--port=')) options.port = value('--port');
    else if (arg === '--ttl' || arg.startsWith('--ttl=')) options.ttlSeconds = value('--ttl');
    else if (arg === '--base-dir' || arg.startsWith('--base-dir=')) options.baseDir = value('--base-dir');
    else if (arg === '--instance-id' || arg.startsWith('--instance-id=')) options.instanceId = value('--instance-id');
    else if (arg === '--grace' || arg.startsWith('--grace=')) options.graceMs = value('--grace');
    else if (arg === '--evidence-dir' || arg.startsWith('--evidence-dir=')) options.evidenceDir = value('--evidence-dir');
    else command.push(arg);
  }
  return { options, command };
}

function diag(message) {
  process.stderr.write(`[launch-test-instance] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parsePort(value) {
  if (!value || String(value).toLowerCase() === 'auto') return 0;
  const port = /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  if (PRODUCTION_PORTS.has(port)) throw new Error(`Production port ${port} is forbidden`);
  return port;
}

function parseTtlSeconds(value) {
  const ttl = /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > Math.floor(0x7fffffff / 1000)) {
    throw new Error(`Invalid --ttl value: ${value}`);
  }
  return ttl;
}

function parseGraceMs(value) {
  const grace = /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(grace) || grace < 0 || grace > 60_000) {
    throw new Error(`Invalid --grace value: ${value}`);
  }
  return grace;
}

async function findFreePort(avoidSet, portHint = 0) {
  if (portHint > 0 && !avoidSet.has(portHint)) {
    const available = await isPortFree(portHint);
    if (available) return portHint;
    throw new Error(`Requested port ${portHint} is already in use`);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 40000 + Math.floor(Math.random() * 10000);
    if (avoidSet.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error('Unable to find a free port in 40000-49999');
}

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

function generateInstanceId() {
  return `test-${Date.now().toString(36)}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

export function buildChildEnvironment(instance, inherited = process.env) {
  const env = { ...inherited };
  // Never inherit instance-scoped overrides from the caller (they belong to
  // whatever production/test instance the caller runs in).
  for (const key of Object.keys(env)) {
    if (/^(AGENTOC_|CHAT_|FCM_|FIREBASE_|OPENAI_|ANTHROPIC_|GEMINI_|CLAUDE_|CODEX_)/i.test(key)
      || /^(GOOGLE_APPLICATION_CREDENTIALS(?:_JSON)?|GOOGLE_API_KEY|DEEPSEEK_API_KEY|QWEN_API_KEY)$/i.test(key)) {
      delete env[key];
    }
  }
  env.AGENTOC_INSTANCE_ROOT = instance.instanceDir;
  env.AGENTOC_CONFIG_DIR = instance.configDir;
  env.AGENTOC_WORK_ROOT_DIR = instance.workRootDir;
  env.AGENTOC_MEMORY_DIR = instance.memoryDir;
  env.AGENTOC_RUN_SPOOL_DIR = instance.spoolDir;
  env.AGENTOC_PROVIDER_HOMES_DIR = instance.providerHomesDir;
  env.AGENTOC_HARNESS_ROOT = join(instance.instanceDir, 'harnesses');
  env.AGENTOC_PLATFORM_SKILLS_DIR = join(instance.instanceDir, 'platform-skills');
  env.AGENTOC_SHARED_TOOLS_DIR = join(instance.instanceDir, 'shared-tools');
  env.AGENTOC_SOURCE_PROJECT_ROOT = repoRoot;
  // Only the child sees this throwaway profile, never the operator's profile.
  env.HOME = join(instance.instanceDir, 'home');
  env.USERPROFILE = env.HOME;
  env.APPDATA = join(env.HOME, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(env.HOME, 'AppData', 'Local');
  env.CHAT_PORT = String(instance.port);
  env.CHAT_BIND_HOST = '127.0.0.1';
  env.AGENTOC_TEST_INSTANCE_ID = instance.id;
  env.AGENTOC_TEST_INSTANCE_TTL_SECONDS = String(instance.ttlSeconds);
  // Let the server apply temp-dir overrides even when the caller HOME itself
  // looks like a temp agentoc home.
  env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  // Test instances must never reach the production runner supervisor or spawn
  // systemd transient units.
  env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
  env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = '';
  env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '';
  env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = '';
  env.AGENTOC_RUNNER_LIFECYCLE_REQUIRED = '';
  env.AGENTOC_RUNNER_LAUNCH_MODE = 'detached-process';
  env.AGENTOC_RUNNER_UNIT_NAME = '';
  env.AGENTOC_RUNNER_UNIT_SCOPE = '';
  // Keep the instance inside the local loopback and away from external ingress /
  // tunnel discovery (no production signaling contact, no cloudflared probing).
  env.AGENTOC_PUBLIC_BASE_URL = `http://127.0.0.1:${instance.port}`;
  env.AGENTOC_P2P_SIGNALING_URL = 'http://127.0.0.1:9';
  env.AGENTOC_ACCOUNTS_URL = 'http://127.0.0.1:9/accounts';
  env.AGENTOC_ACCOUNTS_JWKS_URL = 'http://127.0.0.1:9/accounts/.well-known/jwks.json';
  env.AGENTOC_ACCOUNTS_ISSUER = 'http://127.0.0.1:9';
  env.AGENTOC_TURN_BROKER_URL = 'http://127.0.0.1:9/turn';
  env.AGENTOC_HARNESS_POLICY_URL = 'http://127.0.0.1:9/accounts';
  env.AGENTOC_ENABLE_SHARED_STARTUP_DEFAULTS = '0';
  env.AGENTOC_AUTH_SESSION_SECRET = randomBytes(32).toString('hex');
  env.SECURE_COOKIES = '0';
  env.IS_SANDBOX = '1';
  return env;
}

async function safeRm(target) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(120 * (attempt + 1));
    }
  }
  await rm(target, { recursive: true, force: true });
}

function within(parent, target) {
  const rel = relative(parent, target);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

async function main() {
  const { options, command } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: node scripts/launch-test-instance.mjs [options] [--] [command args...]

Launches an isolated AgentoC test instance with independent config dir, work
root, memory dir, port, instance id, marker, TTL, and cleanup of only its own
temporary resources. Never touches production state.

Options:
  --port <n|auto>    fixed port or auto (default auto, 40000-49999, never 7690/7699)
  --ttl <seconds>    hard lifetime; 0 = no TTL (default 600)
  --base-dir <dir>   parent dir for instances (default private temporary agct-<uid>)
  --instance-id <id> override generated id
  --grace <ms>       SIGTERM -> SIGKILL grace (default 3000)
  --json             machine-readable JSON status on stdout
  --keep-on-error    keep temp resources when the child exits unsuccessfully
  --evidence-dir <dir> save bounded stdout/stderr tails and final status in a new private subdirectory
  -h, --help         this help

Default command: node chat-server.mjs (a random throwaway token is seeded into
the instance's own temp auth.json so the server can boot; it is removed with
cleanup and is never a real credential).
Exit codes: child exit code; 124 = TTL expiry; 130/143 = signal; 1 = launcher error.
`);
    process.exit(0);
  }

  const requestedBaseDir = options.baseDir
    ? resolve(options.baseDir)
    : (trimString(process.env.AGENTOC_TEST_INSTANCE_BASE_DIR)
        ? resolve(trimString(process.env.AGENTOC_TEST_INSTANCE_BASE_DIR))
        : join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
          `agct-${process.getuid?.() ?? 'user'}`));

  const instanceId = trimString(options.instanceId) || generateInstanceId();
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(`Invalid --instance-id: must match ${INSTANCE_ID_RE}`);
  }
  const port = await findFreePort(PRODUCTION_PORTS, parsePort(options.port));
  const ttlSeconds = parseTtlSeconds(options.ttlSeconds);
  const graceMs = parseGraceMs(options.graceMs);

  await mkdir(requestedBaseDir, { recursive: true, mode: 0o700 });
  const baseDir = await realpath(requestedBaseDir);
  const instanceDir = resolve(baseDir, instanceId);
  if (!within(baseDir, instanceDir)) throw new Error('Test instance escapes its base directory');
  const configDir = join(instanceDir, 'config');
  // macOS sockaddr_un has a 104-byte path field. Its default per-user TMPDIR
  // is already long, so fail before boot rather than report an opaque EINVAL.
  const socketBytes = Buffer.byteLength(join(configDir, 'agentoc-cli.sock'));
  if (process.platform !== 'win32' && socketBytes >= (process.platform === 'darwin' ? 104 : 108)) {
    throw new Error('Test CLI socket path is too long; use a shorter --base-dir or --instance-id');
  }
  const workRootDir = join(instanceDir, 'workspace');
  const memoryDir = join(instanceDir, 'memory');
  const spoolDir = join(instanceDir, 'data', 'chat-runs');
  const providerHomesDir = join(instanceDir, 'provider-homes');

  const commandArgv = command.length > 0
    ? command
    : [process.execPath, DEFAULT_TARGET];

  // chat-server refuses to boot without auth.json; seed a random throwaway
  // token inside the instance's own temp config dir (removed with cleanup,
  // never a real credential).
  const seededAuthToken = randomBytes(32).toString('hex');
  const instance = {
    id: instanceId,
    instanceDir,
    configDir,
    workRootDir,
    memoryDir,
    spoolDir,
    providerHomesDir,
    port,
    pid: null,
    command: commandArgv,
    ttlSeconds,
    graceMs,
    createdAt: new Date().toISOString(),
    markerEnv: 'AGENTOC_TEST_INSTANCE_ID',
    markerFile: 'instance.json',
    seededAuthToken: true,
    ownerNonce: randomBytes(24).toString('hex'),
    processCleanupScope: 'direct-child',
  };

  let evidenceDir = null;
  if (options.evidenceDir) {
    const evidenceBase = resolve(options.evidenceDir);
    await mkdir(evidenceBase, { recursive: true });
    evidenceDir = join(await realpath(evidenceBase), `${instanceId}-${randomBytes(6).toString('hex')}`);
    if (within(instanceDir, evidenceDir) || evidenceDir === instanceDir) {
      throw new Error('Evidence directory must survive instance cleanup');
    }
    await mkdir(evidenceDir, { mode: 0o700 });
  }
  // Exclusive creation: never reuse or clean an existing directory/marker.
  await mkdir(instanceDir, { mode: 0o700 });
  for (const dir of [configDir, workRootDir, memoryDir, spoolDir, providerHomesDir,
    join(instanceDir, 'home')]) await mkdir(dir, { recursive: true, mode: 0o700 });

  const env = buildChildEnvironment(instance);
  const markerPath = join(instanceDir, 'instance.json');
  await writeFile(
    join(configDir, 'auth.json'),
    `${JSON.stringify({ token: seededAuthToken }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await writeFile(markerPath, `${JSON.stringify({ ...instance, pid: null }, null, 2)}\n`, 'utf8');

  let settled = false;
  let ttlExpired = false;
  let forwardedSignal = null;
  let ttlTimer = null;
  let escalationTimer = null;
  let stdoutTail = '';
  let stderrTail = '';
  let stdioIncomplete = false;
  const tailLimit = 64 * 1024;
  const redact = (value) => String(value).split(seededAuthToken).join('[REDACTED_TEST_TOKEN]')
    .split(env.AGENTOC_AUTH_SESSION_SECRET).join('[REDACTED_TEST_SECRET]');

  const cleanup = async () => {
    const facts = await lstat(instanceDir);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (facts.isSymbolicLink() || await realpath(instanceDir) !== instanceDir
      || marker.ownerNonce !== instance.ownerNonce || marker.id !== instance.id
      || !within(baseDir, instanceDir)) throw new Error('Instance ownership changed; refusing cleanup');
    await safeRm(instanceDir);
  };

  const finish = async (code, extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(ttlTimer);
    clearTimeout(escalationTimer);
    let cleaned = false;
    let cleanupError = null;
    try {
      if (!stdioIncomplete && !(options.keepOnError && code !== 0)) {
        await cleanup();
        cleaned = true;
      }
    } catch (error) {
      cleanupError = error?.message || String(error);
      diag(`cleanup failed for ${instanceDir}: ${error?.message || String(error)}`);
    }
    const effectiveCode = (cleanupError || stdioIncomplete) && code === 0 ? 1 : code;
    const status = {
      ok: effectiveCode === 0 && !ttlExpired,
      instanceId: instance.id, pid: instance.pid, port: instance.port,
      instanceDir, configDir, workRootDir, memoryDir, spoolDir, providerHomesDir,
      ttlSeconds, ttlExpired, exitCode: effectiveCode, signal: forwardedSignal,
      cleaned, cleanupError, evidenceDir, processCleanupScope: instance.processCleanupScope,
      stdoutTail: redact(stdoutTail), stderrTail: redact(stderrTail),
      finishedAt: new Date().toISOString(), ...extra,
      stdioIncomplete,
    };
    if (evidenceDir) {
      try {
        await writeFile(join(evidenceDir, 'result.json'), `${JSON.stringify(status, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        diag(`could not save evidence: ${error.message}`);
        process.exitCode = 1;
        status.ok = false;
        status.exitCode = 1;
        status.evidenceError = error.message;
      }
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    }
    process.exit(process.exitCode || effectiveCode);
  };

  const child = spawn(commandArgv[0], commandArgv.slice(1), {
    env, cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  instance.pid = child.pid ?? null;
  child.stdout.on('data', (chunk) => {
    stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-tailLimit);
    (options.json ? process.stderr : process.stdout).write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-tailLimit);
    process.stderr.write(chunk);
  });
  // Register immediately: ENOENT or a fast exit must not race an awaited marker write.
  let spawnError = null;
  const closed = new Promise((resolveClosed) => {
    let drainTimer = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('exit', (code, signal) => {
      // An inherited grandchild pipe must not hang the launcher forever. This
      // launcher does not claim Job Object/process-group ownership of descendants.
      drainTimer = setTimeout(() => {
        stdioIncomplete = true;
        child.stdout.destroy();
        child.stderr.destroy();
        resolveClosed({ code, signal });
      }, Math.max(graceMs, 1000));
    });
    child.once('close', (code, signal) => {
      clearTimeout(drainTimer);
      resolveClosed({ code, signal });
    });
  });
  try {
    await writeFile(markerPath, `${JSON.stringify(instance, null, 2)}\n`, 'utf8');
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    await finish(1, { markerError: error.message });
    return;
  }
  diag(`instance ${instance.id}: pid=${instance.pid} port=${instance.port} dir=${instanceDir}`);
  const terminate = (signal) => {
    // ChildProcess owns the actual process handle; do not signal a marker PID or scan names.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(signal); } catch {}
    clearTimeout(escalationTimer);
    escalationTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, graceMs);
  };
  ttlTimer = ttlSeconds > 0
    ? setTimeout(() => {
        ttlExpired = true;
        diag(`instance ${instance.id}: TTL ${ttlSeconds}s expired, sending SIGTERM to pid ${instance.pid}`);
        terminate('SIGTERM');
      }, ttlSeconds * 1000)
    : null;
  ttlTimer?.unref?.();

  const onSignal = (signal) => {
    if (settled) return;
    forwardedSignal = signal;
    diag(`instance ${instance.id}: received ${signal}, forwarding to pid ${instance.pid}`);
    terminate(signal);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const { code, signal } = await closed;
  const effectiveCode = ttlExpired ? TTL_EXIT_CODE
    : forwardedSignal ? 128 + (signalNumbers[forwardedSignal] ?? 15)
      : (signal ? 128 + (signalNumbers[signal] ?? 15) : (code ?? 1));
  await finish(effectiveCode, {
    childSignal: signal ?? null, ttlExpired,
    spawnError: spawnError ? String(spawnError.message) : null,
  });
}

const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGQUIT: 3 };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[launch-test-instance] error: ${error?.message || String(error)}\n`);
    process.exit(1);
  });
}
