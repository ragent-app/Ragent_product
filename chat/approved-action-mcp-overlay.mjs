import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

const CODEX_RUNTIME = 'codex-app-server-json';
const CLAUDE_RUNTIME = 'claude-stream-json-bidi';

export const MCP_OVERLAY_MAX_ATTEMPTS = 3;
export const MCP_OVERLAY_RETRY_DELAY_MS = 25;
export const MCP_OVERLAY_ERROR_CODES = Object.freeze({
  PROVIDER_HOME_UNAVAILABLE: 'MCP_PROVIDER_HOME_UNAVAILABLE',
  SERVER_UNAVAILABLE: 'MCP_SERVER_UNAVAILABLE',
  PREPARE_FAILED: 'MCP_OVERLAY_PREPARE_FAILED',
  VERIFY_FAILED: 'MCP_OVERLAY_VERIFY_FAILED',
});

const RETRYABLE_IO_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EPERM', 'ETIMEDOUT',
]);
let temporaryFileSequence = 0;

function configuredMaxAttempts() {
  const configured = Number.parseInt(process.env.AGENTOC_MCP_OVERLAY_MAX_ATTEMPTS || '', 10);
  return Number.isInteger(configured)
    ? Math.min(MCP_OVERLAY_MAX_ATTEMPTS, Math.max(1, configured))
    : MCP_OVERLAY_MAX_ATTEMPTS;
}

function isRetryableIoError(error) {
  return error?.retryable === true
    || RETRYABLE_IO_CODES.has(String(error?.code || ''));
}

function overlayCauseCode(error) {
  const code = String(error?.code || '').trim();
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : '';
}

function createOverlayError(code, message, {
  stage = 'prepare',
  attempt = 1,
  maxAttempts = configuredMaxAttempts(),
  cause = null,
  resource = '',
} = {}) {
  const error = new Error(message);
  error.name = 'ManagedMcpOverlayError';
  error.code = code;
  error.stage = stage;
  error.attempt = attempt;
  error.maxAttempts = maxAttempts;
  error.retryable = isRetryableIoError(cause);
  error.causeCode = overlayCauseCode(cause);
  error.resource = resource;
  return error;
}

export class ManagedMcpOverlayError extends Error {
  constructor(code, message, options = {}) {
    const source = createOverlayError(code, message, options);
    super(source.message);
    this.name = source.name;
    this.code = source.code;
    this.stage = source.stage;
    this.attempt = source.attempt;
    this.maxAttempts = source.maxAttempts;
    this.retryable = source.retryable;
    this.causeCode = source.causeCode;
    this.resource = source.resource;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withIoRetries(operation, { maxAttempts = 1 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { value: await operation(), attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableIoError(error) || attempt >= maxAttempts) {
        if (error && typeof error === 'object') error.ioAttempts = attempt;
        throw error;
      }
      await sleep(MCP_OVERLAY_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error('MCP overlay operation failed');
}

async function writeOverlayFileAtomically(path, content) {
  const temporaryPath = `${path}.tmp-${process.pid}-${temporaryFileSequence += 1}`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function assertReadableRegularFile(path, resource, code, { attempt, maxAttempts } = {}) {
  let info;
  try {
    ({ value: info } = await withIoRetries(() => stat(path)));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createOverlayError(code, `${resource} is unavailable`, {
        stage: 'preflight',
        attempt,
        maxAttempts,
        cause: error,
        resource,
      });
    }
      throw createOverlayError(code, `${resource} cannot be inspected`, {
        stage: 'preflight',
        attempt,
        maxAttempts,
        cause: error,
        resource,
    });
  }
  if (!info.isFile()) {
      throw createOverlayError(code, `${resource} is not a regular file`, {
        stage: 'preflight',
        attempt,
        maxAttempts,
        resource,
    });
  }
  try {
    await withIoRetries(() => access(path, fsConstants.R_OK));
  } catch (error) {
    throw createOverlayError(code, `${resource} is not readable`, {
      stage: 'preflight',
      attempt,
      maxAttempts,
      cause: error,
      resource,
    });
  }
  return info;
}

async function preflightManagedMcpOverlay({ family, sourceHome, servers, attempt, maxAttempts }) {
  if (family === CODEX_RUNTIME) {
    if (!sourceHome) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
        'Codex provider home is not bound to this Run',
        { stage: 'preflight', attempt, maxAttempts, resource: 'codex_home' },
      );
    }
    let homeInfo;
    try {
      ({ value: homeInfo } = await withIoRetries(() => stat(sourceHome)));
    } catch (error) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
        error?.code === 'ENOENT'
          ? 'Codex provider home is unavailable'
          : 'Codex provider home cannot be inspected',
        { stage: 'preflight', attempt, maxAttempts, cause: error, resource: 'codex_home' },
      );
    }
    if (!homeInfo.isDirectory()) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
        'Codex provider home is not a directory',
        { stage: 'preflight', attempt, maxAttempts, resource: 'codex_home' },
      );
    }
    const authInfo = await assertReadableRegularFile(
      join(sourceHome, 'auth.json'),
      'codex_auth',
      MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
      { attempt, maxAttempts },
    );
    if (authInfo.size <= 0) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
        'Codex provider authentication file is empty',
        { stage: 'preflight', attempt, maxAttempts, resource: 'codex_auth' },
      );
    }
  }

  for (const server of servers) {
    await assertReadableRegularFile(
      server.scriptPath,
      `mcp_server:${server.kind}`,
      MCP_OVERLAY_ERROR_CODES.SERVER_UNAVAILABLE,
      { attempt, maxAttempts },
    );
  }
}

// codex app-server does NOT inherit the parent environment when spawning MCP
// servers: only values declared in the [mcp_servers.X.env] config table (or
// env_vars passthrough list) reach the child. Every AGENTOC_* binding the
// approved-actions script reads via process.env must be projected here or the
// script sees an unbound runtime and tools/list answers [].
const APPROVED_ACTION_MCP_ENV_KEYS = [
  'AGENTOC_APPROVED_ACTIONS_ENABLED',
  'AGENTOC_APPROVED_ACTIONS_ENDPOINT',
  'AGENTOC_APPROVED_ACTIONS_TOKEN',
  'AGENTOC_APPROVED_ACTIONS_SESSION_ID',
  'AGENTOC_APPROVED_ACTIONS_RUN_ID',
  'AGENTOC_APPROVED_ACTIONS_TURN_ID',
  'AGENTOC_APPROVED_ACTIONS_CWD',
  'AGENTOC_APPROVED_ACTIONS_PROJECT_ROOT',
  'AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED',
];
const BROWSER_MCP_ENV_KEYS = [
  'AGENTOC_BROWSER_MCP_ENABLED',
  'AGENTOC_BROWSER_TOKEN',
  'AGENTOC_BROWSER_CONFIRMATION_ENDPOINT',
  'AGENTOC_BROWSER_SESSION_ID',
  'AGENTOC_BROWSER_RUN_ID',
  'AGENTOC_BROWSER_TURN_ID',
  'AGENTOC_BROWSER_PROFILE_DIR',
  'AGENTOC_BROWSER_ARTIFACT_DIR',
  'AGENTOC_BROWSER_APPROVAL_TIMEOUT_MS',
  'AGENTOC_BROWSER_HEADLESS',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeServerName(runId, kind = 'actions') {
  const normalizedKind = kind === 'approved-actions' ? 'actions' : kind;
  // Keep the established approved-action name stable. Browser is the first
  // additional managed server and gets its own namespace without changing
  // existing Codex/Claude readiness or persisted fixtures.
  const hashInput = normalizedKind === 'actions'
    ? (trimString(runId) || 'run')
    : `${trimString(runId) || 'run'}:${normalizedKind}`;
  const suffix = createHash('sha256')
    .update(hashInput, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `ragent_${normalizedKind}_${suffix}`;
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

async function copyIfPresent(source, target) {
  const temporaryPath = `${target}.tmp-${process.pid}-${temporaryFileSequence += 1}`;
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, target);
    await chmod(target, 0o600).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

// Recursive copy that never replays source modes.  fs.cp(recursive) chmods
// every copied directory to the source mode, and the shared provider home
// carries the setgid bit (2770); setting SGID on a fresh directory under /tmp
// (a nosuid mount, or without CAP_FSETID) fails with EPERM and used to abort
// the whole overlay with MCP_OVERLAY_PREPARE_FAILED.  Overlay privacy comes
// from the mkdtemp root mode, not from source modes.
async function copyTreeWithoutModes(source, target) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await copyTreeWithoutModes(join(source, entry.name), join(target, entry.name));
    } else if (entry.isFile()) {
      await copyFile(join(source, entry.name), join(target, entry.name));
    }
  }
}

// Codex loads command policy files from CODEX_HOME/rules. An overlay which
// drops those files could silently remove an owner's existing restrictions.
// Snapshot regular rule files into the private run home; never modify or
// symlink the original rules directory.
async function copyCodexRules(sourceHome, targetHome) {
  const source = join(sourceHome, 'rules');
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const rules = entries.filter((entry) => entry.name.endsWith('.rules'));
  if (!rules.length) return;
  const target = join(targetHome, 'rules');
  await mkdir(target, { recursive: true });
  for (const entry of rules) {
    const from = join(source, entry.name);
    const info = await stat(from);
    if (!info.isFile() || !await copyIfPresent(from, join(target, entry.name))) throw new Error('Codex rule file is unavailable');
  }
}

async function addWindowsCodexShellRules(root, runId, env) {
  const paths = new Set(['powershell', 'powershell.exe', 'PowerShell', 'PowerShell.exe', 'pwsh', 'pwsh.exe']);
  const addPathSpellings = (value) => {
    for (const spelling of [value, value.toLowerCase()]) {
      paths.add(spelling);
      paths.add(spelling.replace(/\\/g, '/'));
      // Drive-letter casing often differs even when the rest was canonical.
      const driveUpper = spelling[0].toUpperCase() + spelling.slice(1);
      paths.add(driveUpper);
      paths.add(driveUpper.replace(/\\/g, '/'));
    }
  };
  const legacy = resolveWindowsSystemPaths(env)?.powershell;
  const nativeProgramFiles = typeof env?.ProgramW6432 === 'string' && env.ProgramW6432.trim() ? env.ProgramW6432 : env?.ProgramFiles;
  const modern = typeof nativeProgramFiles === 'string' && /^[A-Za-z]:[\\/]/.test(nativeProgramFiles)
    ? win32.join(nativeProgramFiles, 'PowerShell', '7', 'pwsh.exe') : '';
  for (const candidate of [legacy, modern]) {
    if (!candidate) continue;
    addPathSpellings(candidate);
    // Windows paths are case-insensitive; the policy matcher is not. Include
    // the actual filesystem spelling as well as the configured spelling.
    const canonical = await realpath(candidate).catch(() => '');
    if (canonical && win32.isAbsolute(canonical)) addPathSpellings(canonical);
  }
  const dir = join(root, 'rules');
  await mkdir(dir, { recursive: true });
  const name = `agentoc-shell-gate-${createHash('sha256').update(String(runId)).digest('hex').slice(0, 16)}.rules`;
  const content = [...paths].map((candidate) => `prefix_rule(pattern=[${JSON.stringify(candidate)}], decision="prompt")`).join('\n') + '\n';
  await writeFile(join(dir, name), content, { flag: 'wx', mode: 0o600 });
}

function withCleanup(root, extra = {}) {
  let cleaned = false;
  return {
    root,
    ...extra,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function normalizeServers(servers = []) {
  return (servers || [])
    .map((server) => {
      const kind = trimString(server?.kind).replace(/[^a-zA-Z0-9_-]/g, '_') || 'managed';
      const scriptPath = trimString(server?.scriptPath);
      const envKeys = Array.isArray(server?.envKeys) && server.envKeys.length > 0
        ? server.envKeys.filter((key) => /^[A-Z0-9_]+$/.test(String(key)))
        : kind === 'browser' ? BROWSER_MCP_ENV_KEYS : APPROVED_ACTION_MCP_ENV_KEYS;
      if (!scriptPath) return null;
      return {
        kind,
        scriptPath,
        envKeys: [...new Set(envKeys)],
      };
    })
    .filter(Boolean);
}

function envPairsFor(server, spawnEnv) {
  return server.envKeys
    .filter((key) => typeof spawnEnv[key] === 'string' && spawnEnv[key].length > 0)
    .map((key) => `${key} = ${tomlString(spawnEnv[key])}`);
}

// Build the per-thread Codex config without copying CODEX_HOME or its OAuth
// credentials. These bindings are private run capabilities and must never be
// included in logs or persisted by the caller.
export async function prepareCodexThreadMcp({ runId = '', spawnEnv = {}, servers = [] } = {}) {
  const normalizedServers = normalizeServers(servers);
  if (!normalizedServers.length) return null;
  await preflightManagedMcpOverlay({
    family: CODEX_RUNTIME,
    sourceHome: trimString(spawnEnv.CODEX_HOME),
    servers: normalizedServers,
    attempt: 1,
    maxAttempts: 1,
  });
  const mcpServers = {};
  const serverNames = [];
  for (const server of normalizedServers) {
    const name = safeServerName(runId, server.kind);
    serverNames.push(name);
    mcpServers[name] = {
      command: process.execPath,
      args: [server.scriptPath],
      env: Object.fromEntries(server.envKeys
        .filter(key => typeof spawnEnv[key] === 'string' && spawnEnv[key].length > 0)
        .map(key => [key, spawnEnv[key]])),
    };
  }
  return { serverNames, config: { mcp_servers: mcpServers } };
}

async function prepareCodexOverlay({ root, sourceHome, servers, runId, spawnEnv = {}, codexWindowsApprovalGate = false, codexWindowsInstallHook = '' }) {
  const config = await readFile(join(sourceHome, 'config.toml'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  // CODEX_HOME also owns auth and resume state. Copy those files into the
  // private directory so changing CODEX_HOME cannot change the global view.
  if (!await copyIfPresent(join(sourceHome, 'auth.json'), join(root, 'auth.json'))) {
    throw createOverlayError(
      MCP_OVERLAY_ERROR_CODES.PROVIDER_HOME_UNAVAILABLE,
      'Codex provider authentication file disappeared during preparation',
      { stage: 'prepare', resource: 'codex_auth' },
    );
  }
  await copyIfPresent(join(sourceHome, 'models_cache.json'), join(root, 'models_cache.json'));
  await copyIfPresent(join(sourceHome, 'AGENTS.md'), join(root, 'AGENTS.md'));
  await copyIfPresent(join(sourceHome, '.agentoc-provider-id'), join(root, '.agentoc-provider-id'));
  await copyCodexRules(sourceHome, root);
  if (codexWindowsApprovalGate) await addWindowsCodexShellRules(root, runId, spawnEnv);
  const sourceSessions = join(sourceHome, 'sessions');
  const targetSessions = join(root, 'sessions');
  try {
    const sessionsStat = await stat(sourceSessions).catch(() => null);
    if (sessionsStat?.isDirectory()) {
      try {
        await symlink(sourceSessions, targetSessions, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        await copyTreeWithoutModes(sourceSessions, targetSessions);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const sections = servers.flatMap((server) => {
    const serverName = safeServerName(runId, server.kind);
    const section = [
      '',
      `[mcp_servers.${serverName}]`,
      `command = ${tomlString(process.execPath)}`,
      `args = [${tomlString(server.scriptPath)}]`,
    ];
    // Codex MCP children do not inherit the parent environment. Project only
    // the bindings for this server into its env table.
    const envPairs = envPairsFor(server, spawnEnv);
    if (envPairs.length > 0) section.push(`env = { ${envPairs.join(', ')} }`);
    section.push('');
    return section;
  });
  const sectionText = sections.join('\n');
  let hook = null;
  const sourceHooks = join(sourceHome, 'hooks.json');
  const overlayHooks = join(root, 'hooks.json');
  const existingHooks = await readFile(sourceHooks, 'utf8').catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
  if (existingHooks !== null) await writeOverlayFileAtomically(overlayHooks, existingHooks);
  if (codexWindowsInstallHook && win32.isAbsolute(codexWindowsInstallHook) && win32.isAbsolute(process.execPath)) {
    const info = await stat(codexWindowsInstallHook).catch(() => null);
    if (info?.isFile()) {
      const quote = value => `'${value.replace(/'/g, "''")}'`;
      const command = `& ${quote(process.execPath)} ${quote(codexWindowsInstallHook)}`;
      let document;
      try { document = existingHooks === null ? { hooks: {} } : JSON.parse(existingHooks); } catch { document = null; }
      if (document && typeof document === 'object' && !Array.isArray(document) && document.hooks &&
          typeof document.hooks === 'object' && !Array.isArray(document.hooks) &&
          (document.hooks.PreToolUse === undefined || Array.isArray(document.hooks.PreToolUse))) {
        document.hooks.PreToolUse ||= [];
        document.hooks.PreToolUse.push({ matcher: '^Bash$', hooks: [{ type: 'command', command }] });
        await writeOverlayFileAtomically(overlayHooks, JSON.stringify(document, null, 2));
        hook = { command, configPath: join(root, 'config.toml'), sourcePath: overlayHooks };
      }
    }
  }
  await writeOverlayFileAtomically(root + '/config.toml', `${config.replace(/\s*$/, '')}${sectionText}`);
  return withCleanup(root, {
    runtimeFamily: CODEX_RUNTIME,
    serverNames: servers.map((server) => safeServerName(runId, server.kind)),
    env: { CODEX_HOME: root },
    configPath: join(root, 'config.toml'),
    codexWindowsInstallHook: hook,
  });
}

async function prepareClaudeOverlay({ root, servers, runId }) {
  const configPath = join(root, 'mcp.json');
  const mcpServers = Object.fromEntries(servers.map((server) => [
    safeServerName(runId, server.kind),
    {
      command: process.execPath,
      args: [server.scriptPath],
    },
  ]));
  await writeOverlayFileAtomically(configPath, JSON.stringify({
    mcpServers,
  }));
  return withCleanup(root, {
    runtimeFamily: CLAUDE_RUNTIME,
    serverNames: servers.map((server) => safeServerName(runId, server.kind)),
    configPath,
    // Claude merges this file with its regular user/project MCP sources.
    args: ['--mcp-config', configPath],
  });
}

async function verifyManagedMcpOverlay(result, servers) {
  const requiredFiles = result.runtimeFamily === CODEX_RUNTIME
    ? ['config.toml', 'auth.json']
    : ['mcp.json'];
  for (const name of requiredFiles) {
    let info;
    try {
      info = await stat(join(result.root, name));
    } catch (error) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.VERIFY_FAILED,
        'Managed MCP overlay is incomplete',
        { stage: 'verify', cause: error, resource: name },
      );
    }
    if (!info.isFile() || info.size <= 0) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.VERIFY_FAILED,
        'Managed MCP overlay contains an invalid generated file',
        { stage: 'verify', resource: name },
      );
    }
  }
  let configText;
  try {
    configText = await readFile(result.configPath, 'utf8');
  } catch (error) {
    throw createOverlayError(
      MCP_OVERLAY_ERROR_CODES.VERIFY_FAILED,
      'Managed MCP overlay configuration cannot be read back',
      { stage: 'verify', cause: error, resource: 'config' },
    );
  }
  for (const server of servers) {
    const serverName = safeServerName(result.runId || '', server.kind);
    if (!configText.includes(
      result.runtimeFamily === CODEX_RUNTIME
        ? `[mcp_servers.${serverName}]`
        : `"${serverName}"`,
    )) {
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.VERIFY_FAILED,
        'Managed MCP overlay is missing a requested server',
        { stage: 'verify', resource: `mcp_server:${server.kind}` },
      );
    }
  }
}

export async function prepareManagedMcpOverlay({
  runtimeFamily = '',
  runId = '',
  spawnEnv = {},
  servers = [],
  codexWindowsApprovalGate = false,
  codexWindowsInstallHook = '',
} = {}) {
  const family = trimString(runtimeFamily);
  const normalizedServers = normalizeServers(servers);
  if (![CODEX_RUNTIME, CLAUDE_RUNTIME].includes(family) ||
      (normalizedServers.length === 0 && !(family === CODEX_RUNTIME && codexWindowsInstallHook))) return null;
  const sourceHome = trimString(spawnEnv.CODEX_HOME);
  const maxAttempts = configuredMaxAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let root = '';
    try {
      await preflightManagedMcpOverlay({
        family,
        sourceHome,
        servers: normalizedServers,
        attempt,
        maxAttempts,
      });
      // CODEX_HOME is also the home of Codex's executable helper aliases.
      // Moving it into the shared OS temp tree makes Codex refuse to create
      // those helpers. Keep its private overlay under the already validated
      // managed provider home; do not change the requested sandbox policy.
      root = await mkdtemp(join(
        family === CODEX_RUNTIME ? sourceHome : tmpdir(),
        'agentoc-approved-action-',
      ));
      await chmod(root, 0o700).catch(() => {});
      const result = family === CODEX_RUNTIME
        ? await prepareCodexOverlay({
          root,
          sourceHome,
          servers: normalizedServers,
          runId,
          spawnEnv,
          codexWindowsApprovalGate,
          codexWindowsInstallHook,
        })
        : await prepareClaudeOverlay({ root, servers: normalizedServers, runId });
      await verifyManagedMcpOverlay({ ...result, runId }, normalizedServers);
      return {
        ...result,
        runId,
        preparation: {
          state: 'ready',
          stage: 'verified',
          attempt,
          maxAttempts,
        },
      };
    } catch (error) {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
      if (attempt < maxAttempts && isRetryableIoError(error)) {
        await sleep(MCP_OVERLAY_RETRY_DELAY_MS * attempt);
        continue;
      }
      if (error?.name === 'ManagedMcpOverlayError') {
        error.attempt = attempt;
        error.maxAttempts = maxAttempts;
        throw error;
      }
      throw createOverlayError(
        MCP_OVERLAY_ERROR_CODES.PREPARE_FAILED,
        'Managed MCP overlay could not be prepared',
        { stage: 'prepare', attempt, maxAttempts, cause: error },
      );
    }
  }
  throw createOverlayError(MCP_OVERLAY_ERROR_CODES.PREPARE_FAILED, 'Managed MCP overlay could not be prepared', {
    stage: 'prepare',
    attempt: maxAttempts,
    maxAttempts,
  });
}

// Compatibility wrapper for existing approved-action callers and tests.
export async function prepareApprovedActionMcpOverlay({
  runtimeFamily = '',
  runId = '',
  spawnEnv = {},
  scriptPath = '',
} = {}) {
  const result = await prepareManagedMcpOverlay({
    runtimeFamily,
    runId,
    spawnEnv,
    servers: [{ kind: 'actions', scriptPath, envKeys: APPROVED_ACTION_MCP_ENV_KEYS }],
  });
  if (!result) return result;
  return {
    ...result,
    serverName: result.serverNames?.[0] || '',
  };
}

export const APPROVED_ACTION_MCP_RUNTIME_FAMILIES = Object.freeze({
  CODEX: CODEX_RUNTIME,
  CLAUDE: CLAUDE_RUNTIME,
});

export { APPROVED_ACTION_MCP_ENV_KEYS, BROWSER_MCP_ENV_KEYS };
