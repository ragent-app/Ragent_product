#!/usr/bin/env node

// Root-owned, deliberately narrow launcher for ordinary Runs.  The chat
// service can request only a validated run id; all command, unit and resource
// properties are built here.  Each request becomes an independent transient
// systemd service with KillMode=control-group, so a provider that daemonises
// cannot outlive its Run.

import { execFile as execFileCallback } from 'child_process';
import { chmod, chown, mkdir, rm, readFile } from 'fs/promises';
import { createServer } from 'net';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { CONFIG_DIR } from '../lib/config.mjs';
import { resolveCodexRuntimeRolloutSources } from '../lib/provider-runtime/codex-rollout-sources.mjs';
import {
  RUNNER_ENV_ALLOWLIST,
  buildRunnerGuiBindPaths,
  pickRunnerGuiEnvironment,
  stripDeniedRunnerEnvKeys,
} from '../lib/runner-env.mjs';
import {
  DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
  buildDetachedRunnerUnitName,
  createProviderPreparationError,
  persistProviderPreparation,
  providerPreparationEvidence,
  resolveCodexProviderHomesDir,
  resolveRunProviderSelection,
} from '../chat/run-launcher.mjs';

// Compatibility export for callers and tests that historically imported this
// helper from the broker module.
export { resolveCodexProviderHomesDir } from '../chat/run-launcher.mjs';
import {
  RUNNER_LIFECYCLE_SOCKET_UNIT,
  inheritedSocketFd,
} from '../lib/systemd-socket-activation.mjs';
import { createRunnerWorkspaceCleanupSweep } from './runner-workspace-access.mjs';
import { normalizeRunnerInheritedGroups, RUNNER_DENIED_GROUPS } from '../lib/runner-user-groups.mjs';
import { buildRunnerGroupDropCommand, isTrustedSetpriv, resolveAllowedRunnerGroupIds,
  resolveRestrictedRunnerGroupIds, verifyDroppedRunnerProcess } from '../lib/linux-runner-group-drop.mjs';
import { resolveRunnerProxyEnvironment } from '../lib/network-proxy.mjs';
import { grantExistingRunnerFiles } from '../lib/linux-runner-file-access.mjs';
import { readOnlyWorkspaceForRun } from '../chat/read-only-run-sandbox.mjs';
import { registerLinuxRunContext, renewLinuxRunContext, revokeLinuxRunContext } from './linux-run-context-store.mjs';

const execFileAsync = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.RAGENT_PROJECT_ROOT || join(__dirname, '..');
const RUNNER_ENTRY = join(PROJECT_ROOT, 'chat', 'runner-sidecar.mjs');
const NODE_RUNTIME = process.env.RAGENT_NODE_RUNTIME || process.execPath;
const DEFAULT_SOCKET_PATH = process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET
  || join(CONFIG_DIR, 'runner-lifecycle.sock');
const SERVICE_USER_FILE = process.env.RAGENT_SERVICE_USER_FILE || '/etc/ragent/service-user';
const RUNNER_USER_FILE = process.env.RAGENT_RUNNER_USER_FILE || '/etc/ragent/runner-user';
const RUNNER_GROUPS_FILE = process.env.RAGENT_RUNNER_GROUPS_FILE || '/etc/ragent/runner-groups';
const DEFAULT_RUNNER_USER = 'ragent-runner';
const DEFAULT_RUNNER_GROUP = 'ragent-runners';
const RUN_SPOOL_DIR = process.env.RAGENT_RUN_SPOOL_DIR || join(CONFIG_DIR, 'chat-runs');
const MAX_REQUEST_BYTES = 16 * 1024;
const RUN_ID_RE = /^run_[A-Za-z0-9_-]{8,128}$/;
const lifecycleLaunchPromises = new Map();

// P0-B: the broker socket stays in the control-plane CONFIG_DIR (root creates
// it and chowns it to the control user; ordinary Runs never reach it).  Export
// for the boundary tests.
export const DEFAULT_LIFECYCLE_SOCKET_PATH = DEFAULT_SOCKET_PATH;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasRunnerOwner(ownerUid, ownerGid) {
  return Number.isInteger(ownerUid) && ownerUid >= 0
    && Number.isInteger(ownerGid) && ownerGid >= 0;
}

export function normalizeRunId(value) {
  const runId = trimString(value);
  return RUN_ID_RE.test(runId) ? runId : '';
}

function normalizeLaunchAttempt(value) {
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 10_000
    ? attempt
    : 0;
}

async function getentPasswdExists(user, { getentImpl = execFileAsync } = {}) {
  const normalized = trimString(user);
  if (!normalized) return false;
  try {
    const { stdout } = await getentImpl('getent', ['passwd', normalized], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    return String(stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

async function getentGroupExists(group, { getentImpl = execFileAsync } = {}) {
  const normalized = trimString(group);
  if (!normalized) return false;
  try {
    const { stdout } = await getentImpl('getent', ['group', normalized], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    return String(stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

// Control-plane user: the owner of CONFIG_DIR and the reader of the broker
// socket.  The broker is root and creates the socket; chowning it to the
// control plane lets the chat server connect without the runner user ever
// being able to reach the broker.
export async function resolveControlUser({ file = SERVICE_USER_FILE, readFileImpl = readFile } = {}) {
  try {
    const fromFile = trimString((await readFileImpl(file, 'utf8')).split(/\r?\n/, 1)[0]);
    if (fromFile) return fromFile;
  } catch {}
  return 'ragent';
}

// Same-user is the product default. Ordinary Runs must be able to edit files
// created by the configured service account (including existing worktrees), so
// they use the control-plane service UID/GID. The old dedicated runner remains
// an explicit compatibility mode only; a stale runner-user file must never
// silently switch a same-user installation back to another UID.
export function isSameUserRunnerMode(environment = process.env) {
  return String(environment?.RAGENT_RUNNER_SAME_USER ?? '1').trim() !== '0';
}

export async function resolveRunnerUser({
  file = RUNNER_USER_FILE,
  controlUserFile = SERVICE_USER_FILE,
  readFileImpl = readFile,
  getentImpl = execFileAsync,
  environment = process.env,
} = {}) {
  const controlUser = await resolveControlUser({ file: controlUserFile, readFileImpl });
  const configured = trimString(environment?.RAGENT_RUNNER_USER);
  if (isSameUserRunnerMode(environment)) {
    if (configured && configured !== controlUser) {
      throw new Error(`Same-user runner mode rejects RAGENT_RUNNER_USER=${configured}; expected ${controlUser}`);
    }
    return controlUser;
  }
  if (configured) {
    if (configured === controlUser) throw Object.assign(new Error('Separate runner mode requires a different user'), { code: 'RUNNER_IDENTITY_INVALID' });
    return configured;
  }
  try {
    const fromFile = trimString((await readFileImpl(file, 'utf8')).split(/\r?\n/, 1)[0]);
    if (fromFile && fromFile !== controlUser && await getentPasswdExists(fromFile, { getentImpl })) return fromFile;
  } catch {}
  if (DEFAULT_RUNNER_USER !== controlUser && await getentPasswdExists(DEFAULT_RUNNER_USER, { getentImpl })) return DEFAULT_RUNNER_USER;
  throw Object.assign(new Error('Separate runner account is unavailable'), { code: 'RUNNER_IDENTITY_INVALID' });
}

// Same-user mode must use the control account's actual primary group, matching
// the group selected by the package's id -gn service configuration.
export async function resolveRunnerGroup(runnerUser, {
  getentImpl = execFileAsync,
  environment = process.env,
} = {}) {
  const configured = trimString(environment?.RAGENT_RUNNER_GROUP);
  if (isSameUserRunnerMode(environment)) {
    let primaryGroup;
    try {
      const passwd = (await getentImpl('getent', ['passwd', runnerUser], { timeout: 2_000, maxBuffer: 16 * 1024 })).stdout.trim().split(':');
      const gid = passwd[3];
      if (!/^\d+$/.test(gid || '')) throw new Error('Invalid primary group ID');
      const group = (await getentImpl('getent', ['group', gid], { timeout: 2_000, maxBuffer: 16 * 1024 })).stdout.trim().split(':');
      if (!group[0] || group[2] !== gid) throw new Error('Primary group unavailable');
      primaryGroup = group[0];
    } catch {
      throw Object.assign(new Error('Cannot resolve runner primary group'), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    if (configured && configured !== primaryGroup) {
      throw Object.assign(new Error(`Same-user runner mode rejects RAGENT_RUNNER_GROUP=${configured}; expected ${primaryGroup}`), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    return primaryGroup;
  }
  if (configured) return configured;
  if (runnerUser && await getentGroupExists(runnerUser, { getentImpl })) return runnerUser;
  return DEFAULT_RUNNER_GROUP;
}

// The lifecycle broker runs as root and prepares provider homes before the
// transient unit drops to the low-privilege runner identity.  Resolve the
// numeric owner once so native preparation can repair pre-existing root-owned
// 0700 provider-key directories without a manual chown/chmod step.
export async function resolveRunnerOwnership(runnerUser, runnerGroup, {
  getentImpl = execFileAsync,
} = {}) {
  const resolveId = async (database, name) => {
    const normalized = trimString(name);
    if (!normalized) return null;
    try {
      const { stdout } = await getentImpl('getent', [database, normalized], {
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      });
      const id = Number.parseInt(String(stdout || '').trim().split(':')[2], 10);
      return Number.isInteger(id) && id >= 0 ? id : null;
    } catch {
      return null;
    }
  };
  return {
    uid: await resolveId('passwd', runnerUser),
    gid: await resolveId('group', runnerGroup),
  };
}

// systemd's SupplementaryGroups extends, rather than replaces, NSS group
// membership. Filtering the property alone cannot remove a user's existing
// sudo/docker/etc. memberships. Refuse such an identity until a native
// launcher can drop groups before exec; never silently claim it is isolated.
export async function verifyRunnerSystemGroups(runnerUser, runnerGroup, { runnerGid, execFileImpl = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl('/usr/bin/id', ['-G', runnerUser], { timeout: 2_000, maxBuffer: 16 * 1024 }));
  } catch {
    throw Object.assign(new Error('Cannot verify runner system groups'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  const groups = String(stdout || '').trim().split(/\s+/).filter(Boolean);
  if (!groups.length || groups.some(group => !/^\d+$/.test(group) || !Number.isSafeInteger(Number(group)))) {
    throw Object.assign(new Error('Cannot verify runner system groups'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  const deniedNames = [...new Set(RUNNER_DENIED_GROUPS)];
  const denied = await resolveRestrictedRunnerGroupIds({ execFileImpl });
  if (groups.some(group => denied.has(Number(group)))
      || (Number.isSafeInteger(runnerGid) && denied.has(runnerGid))
      || deniedNames.includes(String(runnerGroup || '').toLowerCase())) {
    throw Object.assign(new Error('Runner account belongs to a restricted system group; configure an unprivileged runner account'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
}

async function resolveServiceHome(serviceUser) {
  try {
    const { stdout } = await execFileAsync('getent', ['passwd', serviceUser], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const home = String(stdout || '').trim().split(':')[5] || '';
    if (home) return home;
  } catch {}
  return process.env.RAGENT_RUNNER_HOME || `/home/${serviceUser}`;
}

export async function resolveRunnerInheritedGroups(serviceUser, {
  environment = process.env,
  groupsFile = RUNNER_GROUPS_FILE,
  readFileImpl = readFile,
  execFileImpl = execFileAsync,
} = {}) {
  const configured = trimString(environment?.RAGENT_RUNNER_INHERITED_GROUPS);
  if (configured) return normalizeRunnerInheritedGroups(configured);
  try {
    const { stdout } = await execFileImpl('id', ['-Gn', serviceUser], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const groups = normalizeRunnerInheritedGroups(stdout);
    if (groups.length > 0) return groups;
  } catch {
    // Fall through to the installation snapshot. This keeps the broker usable
    // during transient NSS failures while still applying the same deny-list.
  }
  try {
    const fromFile = trimString(await readFileImpl(groupsFile, 'utf8'));
    if (fromFile) return normalizeRunnerInheritedGroups(fromFile);
  } catch {}
  return [];
}

// Control-plane mask targets under the config root.  The config directory
// itself is masked (not its /var/lib/ragent parent) so sibling state the
// control plane legitimately shares with ordinary Runs — today the managed
// work root /var/lib/ragent/workspace — stays reachable inside the transient
// unit.  Logging keeps its own root path.
export function buildControlPlaneMaskPaths(environment = process.env) {
  const configDir = trimString(environment?.RAGENT_CONFIG_DIR) || CONFIG_DIR;
  return [configDir, '/var/log/ragent'];
}

// The same desktop UID can ask its user service manager to start a process
// outside this unit's mount namespace. A config-path mask alone is therefore
// not an identity boundary for privileged Run records. GUI endpoints can
// likewise delegate actions to the logged-in desktop session.
export function isLinuxRunScopeRegistrationEligible({ runnerUid, controlUid, distinctIdentity, guiEnvironment } = {}) {
  return distinctIdentity === true && Number.isSafeInteger(runnerUid) && runnerUid > 0 &&
    Number.isSafeInteger(controlUid) && controlUid > 0 && runnerUid !== controlUid &&
    Object.keys(pickRunnerGuiEnvironment(guiEnvironment || {})).length === 0;
}

const GiB = 1024 * 1024 * 1024;
const RESOURCE_PROFILES = Object.freeze({
  default: { memoryHigh: 4 * GiB, memoryMax: 6 * GiB, tasksMax: 256, cpuWeight: 100 },
  android: { memoryHigh: 8 * GiB, memoryMax: 12 * GiB, tasksMax: 512, cpuWeight: 150 },
  emulator: { memoryHigh: 12 * GiB, memoryMax: 16 * GiB, tasksMax: 768, cpuWeight: 200 },
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRunnerResourceProfile(manifest = null, environment = process.env) {
  const requested = trimString(manifest?.options?.resourceProfile).toLowerCase();
  const cwd = trimString(manifest?.executionScope?.cwd?.realPath || manifest?.folder).toLowerCase();
  const profileName = requested === 'emulator' || requested === 'android' || requested === 'default'
    ? requested
    : (/(^|[/\\])android([/\\]|$)/.test(cwd) ? 'android' : 'default');
  const base = RESOURCE_PROFILES[profileName];
  const prefix = `RAGENT_RUN_${profileName.toUpperCase()}_`;
  return {
    name: profileName,
    memoryHigh: positiveInteger(environment?.[`${prefix}MEMORY_HIGH_BYTES`], base.memoryHigh),
    memoryMax: positiveInteger(environment?.[`${prefix}MEMORY_MAX_BYTES`], base.memoryMax),
    tasksMax: positiveInteger(environment?.[`${prefix}TASKS_MAX`], base.tasksMax),
    cpuWeight: positiveInteger(environment?.[`${prefix}CPU_WEIGHT`], positiveInteger(environment?.RAGENT_RUN_CPU_WEIGHT, base.cpuWeight)),
  };
}

export function buildLifecycleSystemdArgs(runId, {
  projectRoot = PROJECT_ROOT,
  runnerEntry = RUNNER_ENTRY,
  processExecPath = NODE_RUNTIME,
  serviceUser = 'ragent',
  serviceGroup = serviceUser,
  unitName = buildDetachedRunnerUnitName(runId),
  launchAttempt = 0,
  inheritedGroups = [],
  resourceProfile = RESOURCE_PROFILES.default,
  groupDrop = null,
  scopeProtection = false,
  environment = process.env,
} = {}) {
  const args = [
    '--quiet', '--collect', '--no-block', '--service-type=exec',
    '--unit', unitName,
    '--slice', 'ragent-runners.slice',
    '--working-directory', projectRoot,
    '--description', `Ragent Run ${runId}`,
    '--property', `User=${groupDrop ? 'root' : serviceUser}`,
    '--property', `Group=${groupDrop ? 'root' : serviceGroup}`,
    '--property', 'KillMode=control-group',
    // A Run with an experimental privileged context may reach the approval
    // service, but must not gain privileges itself through setuid or file
    // capabilities. Ordinary Runs retain their existing compatibility mode.
    '--property', `NoNewPrivileges=${scopeProtection ? 'true' : 'false'}`,
    '--property', 'PrivateTmp=true',
    '--property', 'ProtectSystem=full',
    '--property', 'ProtectHome=false',
    // The broad runner posture intentionally preserves ordinary user-owned
    // paths outside the workspace, but control-plane roots remain opaque even
    // when a desktop user's ordinary group is inherited for home-directory
    // access. These paths are not needed by the sidecar; spool/provider state
    // lives under /var/lib/ragent-run.
    //
    // The config directory itself (not its parent) is masked so the managed
    // work root /var/lib/ragent/workspace stays reachable when a Run's
    // execution scope points there: masking /var/lib/ragent made the default
    // workspace unreadable inside the unit namespace despite existing access.
    // Prefix the optional executor socket with `-`: systemd treats a missing
    // path as non-fatal when the executor has not created its RuntimeDirectory.
    '--property', `InaccessiblePaths=/etc/ragent ${buildControlPlaneMaskPaths(environment).join(' ')} /run/ragent -/run/ragent-privileged-executor`,
    // P2-A: transient-unit hardening.  The runner is a low-privilege user, so
    // the baseline runner identity boundary is already in place; these add
    // kernel-surface and device restrictions that do not impede normal
    // CLI/provider tool execution (network stays AF_UNIX/AF_INET/AF_INET6,
    // /var stays writable under ProtectSystem=full for the workspace + spool +
    // provider homes). DevicePolicy=auto deliberately leaves the complete host
    // device surface available to ordinary local Runs; GUI/GPU access is still
    // gated by the explicit sanitized display context below.
    '--property', 'LockPersonality=true',
    '--property', 'RestrictRealtime=true',
    '--property', 'RestrictSUIDSGID=true',
    '--property', 'ProtectKernelTunables=true',
    '--property', 'ProtectKernelModules=true',
    '--property', 'ProtectControlGroups=true',
    '--property', 'PrivateDevices=false',
    '--property', 'DevicePolicy=auto',
    '--property', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    '--property', 'SystemCallArchitectures=native',
    '--property', `MemoryHigh=${resourceProfile.memoryHigh}`,
    '--property', `MemoryMax=${resourceProfile.memoryMax}`,
    '--property', `TasksMax=${resourceProfile.tasksMax}`,
    '--property', `CPUWeight=${resourceProfile.cpuWeight}`,
    '--property', `IOWeight=${environment?.RAGENT_RUN_IO_WEIGHT || '100'}`,
  ];
  const guiEnvironment = pickRunnerGuiEnvironment(environment);
  const guiBindPaths = buildRunnerGuiBindPaths(guiEnvironment);
  if (guiBindPaths.length > 0) {
    // Bind only the X11 socket and the exact runtime/auth paths requested by
    // the display context. The '-' prefix keeps stale desktop-session paths
    // from preventing a non-GUI Run from starting.
    args.push('--property', `BindReadOnlyPaths=${guiBindPaths.map((path) => `-${path}`).join(' ')}`);
  }
  const supplementaryGroups = normalizeRunnerInheritedGroups(inheritedGroups);
  if (!groupDrop && supplementaryGroups.length > 0) {
    args.push('--property', `SupplementaryGroups=${supplementaryGroups.join(' ')}`);
  }
  // Only pass the shared runner allowlist plus HOME (launchLifecycleRunner
  // overrides HOME to the resolved runner home).  Production config/socket
  // paths are not allowlisted and the strip gate below drops them even if the
  // broker environment carries them.  Secrets remain inherited from the
  // broker's EnvironmentFile and are never placed in argv.
  const inheritedKeys = [...RUNNER_ENV_ALLOWLIST, 'HOME'];
  const inheritedEnv = stripDeniedRunnerEnvKeys(
    Object.fromEntries(
      inheritedKeys
        .map((key) => [key, environment?.[key]])
        .filter(([, value]) => value !== undefined && value !== null),
    ),
  );
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (!String(value).includes('\0')) {
      args.push('--setenv', `${key}=${String(value)}`);
    }
  }
  args.push('--setenv', `RAGENT_RUNNER_LAUNCH_MODE=${DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE}`);
  args.push('--setenv', `RAGENT_RUNNER_UNIT_NAME=${unitName}`);
  args.push('--setenv', 'RAGENT_RUNNER_UNIT_SCOPE=system');
  args.push('--setenv', `RAGENT_RUNNER_LAUNCH_ATTEMPT=${normalizeLaunchAttempt(launchAttempt)}`);
  if (groupDrop) args.push(groupDrop.command, ...groupDrop.args);
  else args.push(processExecPath, runnerEntry, runId);
  return args;
}

async function readSystemdMainPid(unitName, { execFileImpl = execFileAsync } = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const { stdout } = await execFileImpl('systemctl', [
        'show', '--property=MainPID', '--value', unitName,
      ], { timeout: 2_000, maxBuffer: 64 * 1024 });
      const pid = Number.parseInt(String(stdout || '').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export async function readLifecycleSystemdUnitState(unitName, { execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl('systemctl', [
      'show',
      '--property=LoadState',
      '--property=ActiveState',
      '--property=MainPID',
      '--property=User',
      unitName,
    ], { timeout: 2_000, maxBuffer: 64 * 1024 });
    const values = Object.fromEntries(String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.split('=', 2))
      .filter(([key, value]) => key && value !== undefined));
    const pid = Number.parseInt(values.MainPID || '', 10);
    return {
      loadState: values.LoadState || 'unknown',
      activeState: values.ActiveState || 'unknown',
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      user: values.User || '',
    };
  } catch (cause) {
    const error = new Error('Cannot inspect the existing runner unit');
    error.code = 'RUNNER_UNIT_STATUS_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
}

async function readRunManifest(runId, { readFileImpl = readFile } = {}) {
  try {
    return JSON.parse(await readFileImpl(join(RUN_SPOOL_DIR, runId, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRunStatus(runId) {
  return JSON.parse(await readFile(join(RUN_SPOOL_DIR, runId, 'status.json'), 'utf8'));
}

export function readWorkspaceAccessScope(manifest) {
  const scope = manifest?.executionScope;
  const cwd = trimString(scope?.cwd?.realPath) || trimString(manifest?.folder);
  if (!cwd) return null;
  const workspaceRoot = trimString(scope?.workspaceRoot?.realPath)
    || trimString(scope?.cwd?.realPath)
    || cwd;
  return { cwd, workspaceRoot };
}

async function launchLifecycleRunnerUnlocked(runId, {
  execFileImpl = execFileAsync,
  serviceUser = null,
  serviceGroup = null,
  serviceHome = null,
  controlUser = null,
  requireDistinctUid = false,
  resolveRunnerOwnershipImpl = resolveRunnerOwnership,
  verifyRunnerSystemGroupsImpl = verifyRunnerSystemGroups,
  resolveRestrictedGroupsImpl = resolveRestrictedRunnerGroupIds,
  resolveAllowedGroupsImpl = resolveAllowedRunnerGroupIds,
  verifyDroppedRunnerProcessImpl = verifyDroppedRunnerProcess,
  isTrustedSetprivImpl = isTrustedSetpriv,
  grantExistingRunnerFilesImpl = grantExistingRunnerFiles,
  resolveInheritedGroupsImpl = resolveRunnerInheritedGroups,
  readManifestImpl = readRunManifest,
  readRunStatusImpl = readRunStatus,
  prepareNativeRunProviderHomeImpl = null,
  readUnitStateImpl = readLifecycleSystemdUnitState,
  guiEnvironment = {},
  unitName = '',
  launchAttempt = 0,
  scopeGrant = null,
  runScopeRegistration = null,
  environment = process.env,
} = {}) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  const normalizedAttempt = normalizeLaunchAttempt(launchAttempt);
  const resolvedUnitName = trimString(unitName)
    || buildDetachedRunnerUnitName(normalized, { launchAttempt: normalizedAttempt });
  const resolvedServiceUser = serviceUser || await resolveRunnerUser();
  const resolvedServiceGroup = serviceGroup || await resolveRunnerGroup(resolvedServiceUser);
  const runnerOwnership = await resolveRunnerOwnershipImpl(resolvedServiceUser, resolvedServiceGroup);
  if (!Number.isSafeInteger(runnerOwnership?.uid) || runnerOwnership.uid <= 0
      || !Number.isSafeInteger(runnerOwnership?.gid) || runnerOwnership.gid <= 0) {
    const error = new Error('Cannot launch or reuse a Run without a verified non-root runner identity and group');
    error.code = 'RUNNER_IDENTITY_INVALID';
    throw error;
  }
  if (requireDistinctUid && isSameUserRunnerMode(environment)) {
    throw Object.assign(new Error('Lifecycle broker is not configured for a distinct runner identity'), { code: 'RUNNER_IDENTITY_INVALID' });
  }
  let resolvedControlUser = controlUser;
  let controlOwnership = null;
  let distinctIdentity = false;
  if (!isSameUserRunnerMode(environment)) {
    resolvedControlUser ||= await resolveControlUser();
    controlOwnership = await resolveRunnerOwnershipImpl(resolvedControlUser, resolvedServiceGroup);
    if (!Number.isSafeInteger(controlOwnership?.uid) || controlOwnership.uid <= 0 || controlOwnership.uid === runnerOwnership.uid) {
      throw Object.assign(new Error('Separate runner mode requires a different verified numeric UID'), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    distinctIdentity = true;
  }
  const groupDropSetting = trimString(environment.RAGENT_RUNNER_DROP_GROUPS).toLowerCase();
  const useGroupDrop = groupDropSetting === '1'
    || (groupDropSetting === 'auto' && isSameUserRunnerMode(environment));
  let restrictedIds = null;
  if (useGroupDrop) {
    if (!isTrustedSetprivImpl()) throw Object.assign(new Error('Trusted group-drop executable unavailable'), { code: 'RUNNER_IDENTITY_INVALID' });
    restrictedIds = await resolveRestrictedGroupsImpl();
    if (restrictedIds.has(runnerOwnership.gid)) throw Object.assign(new Error('Runner primary group is restricted'), { code: 'RUNNER_IDENTITY_INVALID' });
  } else {
    await verifyRunnerSystemGroupsImpl(resolvedServiceUser, resolvedServiceGroup, { runnerGid: runnerOwnership.gid });
  }
  const existingUnit = await readUnitStateImpl(resolvedUnitName, { execFileImpl });
  if (!['loaded', 'not-found'].includes(existingUnit?.loadState)
      || !['active', 'activating', 'reloading', 'deactivating', 'inactive', 'failed'].includes(existingUnit?.activeState)
      || (existingUnit.loadState === 'not-found' && existingUnit.activeState !== 'inactive')) {
    const error = new Error('Cannot confirm the existing runner unit state');
    error.code = 'RUNNER_UNIT_STATUS_UNAVAILABLE';
    throw error;
  }
  if (['active', 'activating', 'reloading'].includes(existingUnit.activeState)) {
    if (useGroupDrop && trimString(existingUnit.user) === 'root') {
      await verifyDroppedRunnerProcessImpl(existingUnit.pid, { uid: runnerOwnership.uid, gid: runnerOwnership.gid, restrictedIds });
    } else if (trimString(existingUnit.user) !== resolvedServiceUser || useGroupDrop) {
      const error = new Error('Cannot reuse a Run owned by a different or unknown systemd user');
      error.code = 'RUNNER_IDENTITY_INVALID';
      throw error;
    }
    if (requireDistinctUid && !useGroupDrop) {
      restrictedIds ||= await resolveRestrictedGroupsImpl();
      await verifyDroppedRunnerProcessImpl(existingUnit.pid, { uid: runnerOwnership.uid, gid: runnerOwnership.gid, restrictedIds });
    }
    return {
      pid: existingUnit.pid,
      unitName: resolvedUnitName,
      unitScope: 'system',
      launchMode: DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
      launchAttempt: normalizedAttempt,
      reused: true,
      workspaceAccessGroup: null,
    };
  }
  if (existingUnit.activeState === 'deactivating') {
    const error = new Error(`Runner unit ${resolvedUnitName} is still deactivating`);
    error.code = 'RUNNER_UNIT_DRAINING';
    throw error;
  }
  if (existingUnit.loadState === 'loaded'
      && ['inactive', 'failed'].includes(existingUnit.activeState)) {
    const error = new Error(`Runner unit ${resolvedUnitName} is still loaded after exit`);
    error.code = 'RUNNER_UNIT_DRAINING';
    throw error;
  }
  const resolvedServiceHome = serviceHome || await resolveServiceHome(resolvedServiceUser);
  // Same-user mode retains owner access for existing worktrees, but its
  // dropped groups are not a security boundary: same-UID IPC can launch a
  // process outside this unit. Explicit separate-user mode is checked above.
  resolvedControlUser ||= await resolveControlUser();
  if (isSameUserRunnerMode(environment)) distinctIdentity = resolvedServiceUser !== resolvedControlUser;
  if (controlOwnership && distinctIdentity) {
    await grantExistingRunnerFilesImpl(join(RUN_SPOOL_DIR, normalized), {
      controlUid: controlOwnership.uid, runnerUid: runnerOwnership.uid,
    });
  }
  const inheritedGroups = await resolveInheritedGroupsImpl(resolvedControlUser, {
    environment,
  });
  const manifest = await readManifestImpl(normalized);
  const resourceProfile = resolveRunnerResourceProfile(manifest, environment);
  const workspaceScope = readWorkspaceAccessScope(manifest);
  if (distinctIdentity && !workspaceScope) {
    throw Object.assign(new Error('Runner workspace path is missing; cannot verify existing access'),
      { code: 'RUNNER_WORKSPACE_ACCESS_DENIED', launchDefinitelyNotSubmitted: true });
  }
  let allowedGroupIds = null;
  if (distinctIdentity || useGroupDrop) {
    if (!isTrustedSetprivImpl()) {
      throw Object.assign(new Error('Trusted group-drop executable unavailable'), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    restrictedIds ||= await resolveRestrictedGroupsImpl();
    if (restrictedIds.has(runnerOwnership.gid)) {
      throw Object.assign(new Error('Runner primary group is restricted'), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    allowedGroupIds = await resolveAllowedGroupsImpl(normalizeRunnerInheritedGroups(inheritedGroups), { restrictedIds });
    if (!useGroupDrop) {
      // systemd initializes the user's supplementary groups and adds the
      // explicitly configured groups. Require the selected primary GID to
      // match NSS so id -G and systemd's initialized group set agree.
      let primary, groups;
      try {
        primary = (await execFileImpl('/usr/bin/id', ['-g', resolvedServiceUser], { timeout: 2_000, maxBuffer: 16 * 1024 })).stdout.trim();
        groups = (await execFileImpl('/usr/bin/id', ['-G', resolvedServiceUser], { timeout: 2_000, maxBuffer: 16 * 1024 })).stdout.trim().split(/\s+/);
      } catch {
        throw Object.assign(new Error('Cannot verify runner supplementary groups'), { code: 'RUNNER_IDENTITY_INVALID' });
      }
      if (!/^\d+$/.test(primary) || Number(primary) !== runnerOwnership.gid || !groups.length
          || groups.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))
            || Number(id) < 1 || Number(id) > 0xfffffffe || restrictedIds.has(Number(id)))) {
        throw Object.assign(new Error('Cannot verify safe runner supplementary groups'), { code: 'RUNNER_IDENTITY_INVALID' });
      }
      allowedGroupIds = [...new Set([...allowedGroupIds, ...groups.map(Number)])];
    }
  }
  if (distinctIdentity) {
    const readOnlyRequested = manifest?.executionScope?.accessMode === 'read'
      || manifest?.options?.readOnlyRequired === true;
    if (readOnlyRequested) readOnlyWorkspaceForRun(manifest, workspaceScope.cwd);
    const cwdChecks = readOnlyRequested
      ? 'test -d "$1" && test -r "$1" && test -x "$1"'
      : 'test -d "$1" && test -r "$1" && test -w "$1" && test -x "$1"';
    const paths = [
      { path: workspaceScope.workspaceRoot, checks: 'test -d "$1" && test -x "$1"', required: 'traverse' },
      { path: workspaceScope.cwd, checks: cwdChecks, required: readOnlyRequested ? 'read and traverse' : 'read, write, and traverse' },
    ];
    for (const { path, checks, required } of paths) {
      if (!isAbsolute(path) || path.includes('\0') || /[\r\n]/.test(path)) {
        throw Object.assign(new Error('Runner workspace path is invalid'), { code: 'RUNNER_WORKSPACE_ACCESS_DENIED', launchDefinitelyNotSubmitted: true });
      }
      const check = buildRunnerGroupDropCommand({ uid: runnerOwnership.uid, gid: runnerOwnership.gid,
        supplementaryGids: allowedGroupIds, command: '/bin/sh', args: ['-c', checks, 'sh', path] });
      try {
        await execFileImpl(check.command, check.args, { timeout: 5_000, maxBuffer: 16 * 1024 });
      } catch {
        throw Object.assign(new Error(`Runner user ${resolvedServiceUser} lacks existing ${required} access to the workspace path; grant access outside Ragent before retrying`),
          { code: 'RUNNER_WORKSPACE_ACCESS_DENIED', launchDefinitelyNotSubmitted: true });
      }
    }
  }
  // Provider selection must match the canonical resolver in
  // chat/run-launcher.mjs exactly: both codex and claude scoped model ids
  // (`model@providerId`) select the provider. A broker-local copy that only
  // parsed the codex suffix made claude runs drift-check requested='' against
  // the prepared provider and refuse to launch (Auto Compress workers).
  const selection = resolveRunProviderSelection(manifest);
  const runtimeFamily = trimString(manifest?.options?.runtimeFamily || manifest?.runtimeFamily);
  const tool = trimString(manifest?.tool);
  const isCodex = tool === 'codex' || tool === 'codex-cli' || runtimeFamily.startsWith('codex-');
  const isClaude = tool === 'claude' || tool === 'claude-bidi' || runtimeFamily.startsWith('claude-');
  const isAgy = tool === 'agy' || runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json';
  const providerId = selection.providerId;
  // Legacy/dev deployments may not define the relocated provider-home root.
  // Keep that fallback under the runner's own HOME; never pass the control
  // CONFIG_DIR-backed managed home through the Run environment.
  const providerHomesDir = trimString(environment.RAGENT_PROVIDER_HOMES_DIR)
    || join(resolvedServiceHome, '.config', 'ragent', 'provider-runtime-homes');
  const providerApp = isClaude ? 'claude' : (isCodex ? 'codex' : (isAgy ? 'agy' : ''));
  // Native preparation materializes per-Run provider metadata under
  // providerHomesDir/by-provider/<provider-hash>/by-run/<run-hash>. For
  // Legacy external-home fields may still be present in old launch envelopes;
  // native Codex no longer adopts them or shares their refresh-token chain.
  let runProviderHomesDir = providerHomesDir;
  let runCodexHomeDir = '';
  let codexRolloutSources = [];
  let runAgyHomeDir = '';
  let effectiveCodexServiceTier = '';
  // Codex OAuth is machine-local. The old environment flag is intentionally
  // ignored so a deployment cannot accidentally bind native Runs to the
  // control user's ~/.codex/auth.json and consume the same rotating token.
  const useExternalCodexOAuthOwnership = false;
  // Native provider runtime resolves the Run's provider from its per-Run
  // snapshot and writes the scoped-home contract the sidecar verifies. There
  // is no legacy global-provider or proxy path in the lifecycle broker.
  let nativeResult = null;
  let nativeOAuthLockHandedOff = false;
  try {
  if (providerApp) {
    const startedAt = new Date().toISOString();
    await persistProviderPreparation(normalized, providerPreparationEvidence({
      state: 'preparing',
      stage: 'provider-home',
      providerId,
      app: providerApp,
      startedAt,
    }));
    const prepareNativeRunProviderHome = prepareNativeRunProviderHomeImpl
      || (await import('../lib/provider-runtime/run-provider-prepare.mjs')).prepareNativeRunProviderHome;
    try {
      nativeResult = await prepareNativeRunProviderHome(normalized, manifest, {
        configDir: CONFIG_DIR,
        providerHomesRoot: providerHomesDir,
        // The broker runs as root during preparation, so resolve the external
        // Codex home from the configured control user's home rather than root's
        // HOME.  An explicit path is useful for multi-user installations.
        externalCodexAuthFile: trimString(environment.RAGENT_EXTERNAL_CODEX_AUTH_FILE)
          || (trimString(environment.RAGENT_EXTERNAL_CODEX_HOME)
            ? join(trimString(environment.RAGENT_EXTERNAL_CODEX_HOME), 'auth.json')
            : join(resolvedServiceHome, '.codex', 'auth.json')),
        externalOAuthOwnership: isCodex ? useExternalCodexOAuthOwnership : false,
        // Ordinary Codex OAuth Runs share the machine-local app-server broker;
        // only a Run-specific MCP fallback acquires a process lock in the
        // sidecar after preparation.
        holdNativeOAuthLock: false,
        forceRunScopedHome: manifest.executionScope?.accessMode === 'read',
        runnerReadable: true,
        runnerOwnerUid: runnerOwnership.uid,
        runnerOwnerGid: runnerOwnership.gid,
        previousRunnerOwnerUid: distinctIdentity ? controlOwnership?.uid ?? null : null,
      });
      if (nativeResult?.ok !== true || !nativeResult.providerId) {
        throw createProviderPreparationError(
          `Native ${providerApp} provider preparation failed (${providerId || 'unselected'})`,
          {
            app: providerApp,
            providerId,
            causeCode: nativeResult?.reason,
            startedAt,
          },
        );
      }
      if (providerId && nativeResult.providerId !== providerId) {
        throw createProviderPreparationError(
          `Native ${providerApp} provider preparation drifted`,
          {
            app: providerApp,
            providerId,
            causeCode: 'provider-home-drift',
            startedAt,
          },
        );
      }
      if (typeof nativeResult.homeDir !== 'string' || !nativeResult.homeDir.trim()) {
        throw createProviderPreparationError(
          `Native ${providerApp} provider preparation returned no scoped home`,
          {
            app: providerApp,
            providerId: nativeResult.providerId,
            causeCode: 'provider-home-missing',
            startedAt,
          },
        );
      }
    } catch (error) {
      try { await nativeResult?.oauthLock?.release?.(); } catch {}
      const preparedError = createProviderPreparationError(
        `Native ${providerApp} provider preparation failed (${providerId || 'unselected'})`,
        {
          app: providerApp,
          providerId,
          stage: error?.stage || 'provider-home',
          causeCode: error?.causeCode || error?.reason || '',
          sourceError: error,
          startedAt,
        },
      );
      await persistProviderPreparation(normalized, preparedError.providerPreparation);
      throw preparedError;
    }
    runProviderHomesDir = nativeResult.homeDir.trim();
    runCodexHomeDir = isCodex ? trimString(nativeResult.codexHomeDir) : '';
    if (isCodex && nativeResult.oauthAccountId) {
      codexRolloutSources = await resolveCodexRuntimeRolloutSources({ configDir: CONFIG_DIR, providerHomesRoot: providerHomesDir,
        homeRoot: nativeResult.homeDir, accountId: nativeResult.oauthAccountId });
    }
    runAgyHomeDir = isAgy ? trimString(nativeResult.agyHomeDir) : '';
    if (isCodex) {
      effectiveCodexServiceTier = trimString(nativeResult.snapshot?.serviceTier) || 'standard';
    }
    await persistProviderPreparation(normalized, providerPreparationEvidence({
      state: 'ready',
      stage: 'verified',
      attempt: nativeResult.preparation?.attempt || 1,
      maxAttempts: nativeResult.preparation?.maxAttempts || 1,
      providerId: nativeResult.providerId,
      app: providerApp,
      startedAt,
      finishedAt: new Date().toISOString(),
    }));
  }
  // RAGENT_RUN_SPOOL_DIR is the controlled write-back channel: the sidecar
  // writes run results here (control-plane chat-runs) without being told the
  // production RAGENT_CONFIG_DIR.  It rides the allowlist inheritedKeys.
  // P0-C: the channel is env-configurable so it can be relocated out of the
  // control CONFIG_DIR; the default stays at the legacy config/chat-runs until
  // the migration step flips it (and removes the config traverse ACL).
  const scopeRegistrationEligible = Boolean(scopeGrant && runScopeRegistration && manifest?.runPublication &&
    isLinuxRunScopeRegistrationEligible({ runnerUid: runnerOwnership.uid, controlUid: controlOwnership?.uid, distinctIdentity,
      guiEnvironment: { ...environment, ...guiEnvironment } }));
  const runEnvironment = {
    ...environment,
    ...pickRunnerGuiEnvironment({ ...environment, ...guiEnvironment }),
    ...(await resolveRunnerProxyEnvironment(environment)),
    HOME: resolvedServiceHome,
    ...(useGroupDrop ? { USER: resolvedServiceUser, LOGNAME: resolvedServiceUser } : {}),
    RAGENT_RUNNER_DISTINCT_IDENTITY: distinctIdentity ? '1' : '0',
    RAGENT_LINUX_SCOPE_FINISH_ENABLED: scopeRegistrationEligible ? '1' : '0',
    RAGENT_CODEX_HOME_DIR: runCodexHomeDir,
    RAGENT_CODEX_ROLLOUT_SOURCES: JSON.stringify(codexRolloutSources),
    RAGENT_AGY_HOME_DIR: isAgy ? runAgyHomeDir : '',
    RAGENT_RUN_SPOOL_DIR: environment.RAGENT_RUN_SPOOL_DIR || join(CONFIG_DIR, 'chat-runs'),
    RAGENT_PROVIDER_HOMES_DIR: runProviderHomesDir,
    ...(nativeResult?.oauthLock?.path && nativeResult?.oauthLock?.token
      ? {
        RAGENT_NATIVE_OAUTH_LOCK_PATH: nativeResult.oauthLock.path,
        RAGENT_NATIVE_OAUTH_LOCK_TOKEN: nativeResult.oauthLock.token,
      }
      : {}),
    ...(effectiveCodexServiceTier ? { RAGENT_CODEX_SERVICE_TIER: effectiveCodexServiceTier } : {}),
  };
  let groupDrop = null;
  if (useGroupDrop) {
    groupDrop = buildRunnerGroupDropCommand({ uid: runnerOwnership.uid, gid: runnerOwnership.gid,
      supplementaryGids: allowedGroupIds, command: NODE_RUNTIME, args: [RUNNER_ENTRY, normalized] });
  }
  const args = buildLifecycleSystemdArgs(normalized, {
    serviceUser: resolvedServiceUser,
    serviceGroup: resolvedServiceGroup,
    unitName: resolvedUnitName,
    launchAttempt: normalizedAttempt,
    inheritedGroups,
    resourceProfile,
    groupDrop,
    scopeProtection: scopeRegistrationEligible,
    environment: runEnvironment,
  });
  try {
    // Recheck durable identity immediately before systemd submission: the
    // owner may cancel while provider preparation is awaiting a shared lock.
    const latest = await readRunStatusImpl(normalized);
    if (latest?.id !== normalized || latest?.sessionId !== manifest?.sessionId ||
        latest?.cancelRequested === true || ['completed', 'failed', 'cancelled'].includes(latest?.state)) {
      throw Object.assign(new Error('Run is no longer eligible for launch'), { code: 'REQUEST_CANCELLED' });
    }
    await execFileImpl('/usr/bin/systemd-run', args, {
      env: environment,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    // Once systemd accepted the transient unit, the sidecar owns the lock and
    // will release it when the provider exits. Reading MainPID below is only
    // observability; failure there must not release a live Run's lock.
    nativeOAuthLockHandedOff = true;
  } catch (error) {
    throw error;
  }
  const pid = await readSystemdMainPid(resolvedUnitName, { execFileImpl });
  let privilegedContextRegistered = false;
  if (scopeRegistrationEligible) {
    // This branch is reached only after this broker created the unit. Never
    // claim a reused pre-existing unit as a newly authenticated launch.
    const run = { id: normalized, sessionId: manifest.sessionId, requestId: manifest.requestId,
      runPublication: manifest.runPublication };
    try {
      await registerLinuxRunContext({ directory: runScopeRegistration.directory,
        pinDirectory: runScopeRegistration.pinDirectory, run, manifest, grant: scopeGrant, launchAttempt: normalizedAttempt,
        runnerUid: runnerOwnership.uid });
      privilegedContextRegistered = true;
    } catch {
      // Scope registration is not needed for ordinary execution. Failure must
      // leave privileged actions unavailable without spawning a duplicate Run.
      console.warn(`[runner-lifecycle] privileged Run context unavailable for ${normalized}`);
    }
  }
  return {
    pid,
    unitName: resolvedUnitName,
    unitScope: 'system',
    launchMode: DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
    launchAttempt: normalizedAttempt,
    ...(scopeGrant ? { privilegedContextRegistered } : {}),
  };
  } finally {
    if (!nativeOAuthLockHandedOff) {
      try { await nativeResult?.oauthLock?.release?.(); } catch {}
    }
  }
}

export async function launchLifecycleRunner(runId, options = {}) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  const launchAttempt = normalizeLaunchAttempt(options.launchAttempt);
  const unitName = trimString(options.unitName)
    || buildDetachedRunnerUnitName(normalized, { launchAttempt });
  const existing = lifecycleLaunchPromises.get(unitName);
  if (existing) {
    if (existing.requireDistinctUid !== (options.requireDistinctUid === true)) {
      throw Object.assign(new Error('Conflicting runner identity requirements for the same launch'), { code: 'RUNNER_IDENTITY_INVALID' });
    }
    return existing.promise;
  }

  // systemctl preflight and systemd-run are not an atomic pair. Coalesce all
  // requests for the same launch generation so two simultaneous clients can
  // never both grant access, race to create the unit, and let the loser revoke
  // state still owned by the winner.
  const promise = launchLifecycleRunnerUnlocked(normalized, {
    ...options,
    launchAttempt,
    unitName,
  }).finally(() => {
    if (lifecycleLaunchPromises.get(unitName)?.promise === promise) {
      lifecycleLaunchPromises.delete(unitName);
    }
  });
  lifecycleLaunchPromises.set(unitName, { promise, requireDistinctUid: options.requireDistinctUid === true });
  return promise;
}

function sendResponse(socket, payload) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`);
}

export async function createRunnerLifecycleServer({
  socketPath = DEFAULT_SOCKET_PATH,
  launchRunner = launchLifecycleRunner,
  serviceUser = null,
  serviceGroup = null,
  controlUser = null,
  controlGroup = null,
  chownImpl = chown,
  inheritFd = null,
  inheritedSocketFdImpl = inheritedSocketFd,
  runScopeRegistration = null,
  revokeRunContextImpl = revokeLinuxRunContext,
  renewRunContextImpl = renewLinuxRunContext,
} = {}) {
  const normalizedSocketPath = trimString(socketPath);
  if (!normalizedSocketPath) throw new Error('Runner lifecycle socket path is required');

  // P2-C: when systemd pre-bound our socket (ragent-runner-lifecycle.socket),
  // accept the inherited listening fd instead of creating the socket file.  The
  // systemd-owned socket survives broker restarts, so the control plane never
  // hits ECONNREFUSED during a restart window.
  const inherited = inheritFd ?? inheritedSocketFdImpl({ expectedName: RUNNER_LIFECYCLE_SOCKET_UNIT });

  // Runs launch as the dedicated low-privilege runner user; the broker socket
  // itself is chowned to the control plane so ordinary Runs can never reach it.
  // Under socket activation the SocketUser/SocketGroup/SocketMode in the unit
  // express socket ownership declaratively, but the runner service identity is
  // still needed to build the transient units, so it is resolved in both modes.
  const resolvedServiceUser = serviceUser || await resolveRunnerUser();
  const resolvedServiceGroup = serviceGroup || await resolveRunnerGroup(resolvedServiceUser);
  const resolvedControlUser = controlUser || await resolveControlUser();
  if (!inherited) {
    const socketDir = dirname(normalizedSocketPath);
    await mkdir(socketDir, { recursive: true });
    await rm(normalizedSocketPath, { force: true });
  }
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    let capabilitiesNegotiated = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      while (!handled) {
        if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
          handled = true;
          sendResponse(socket, { ok: false, error: 'Request too large' });
          return;
        }
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) return;
        let request;
        try { request = JSON.parse(buffer.slice(0, newlineIndex)); } catch {
          handled = true;
          sendResponse(socket, { ok: false, error: 'Invalid JSON request' });
          return;
        }
        buffer = buffer.slice(newlineIndex + 1);
        if (request?.type === 'capabilities' && !capabilitiesNegotiated) {
          capabilitiesNegotiated = true;
          socket.write(`${JSON.stringify({ ok: true, protocol: 'ragent-runner-lifecycle-v2', strictDistinctUid: true })}\n`);
          continue;
        }
        handled = true;
        if (request?.type === 'health') {
          sendResponse(socket, { ok: true, status: 'ready' });
          return;
        }
        const runId = normalizeRunId(request?.runId);
        const requestedLaunchAttempt = Number(request?.launchAttempt ?? 0);
        if (!['launch', 'revoke-scope', 'renew-scope'].includes(request?.type) || !runId
            || !Number.isSafeInteger(requestedLaunchAttempt)
            || requestedLaunchAttempt < 0
            || requestedLaunchAttempt > 10_000) {
          sendResponse(socket, { ok: false, code: 'RUNNER_LAUNCH_REQUEST_INVALID', error: 'Invalid runner launch request' });
          return;
        }
        if (request.type === 'revoke-scope') {
          if (!runScopeRegistration) {
            sendResponse(socket, { ok: false, code: 'RUNNER_SCOPE_UNAVAILABLE', error: 'Run scope registration is unavailable' });
            return;
          }
          void revokeRunContextImpl({ directory: runScopeRegistration.directory, runId, launchAttempt: requestedLaunchAttempt })
            .then(() => sendResponse(socket, { ok: true }))
            .catch(() => sendResponse(socket, { ok: false, code: 'RUNNER_SCOPE_REVOCATION_FAILED', error: 'Run scope revocation failed' }));
          return;
        }
        if (request.type === 'renew-scope') {
          if (!runScopeRegistration || !request.scopeGrant || typeof request.scopeGrant !== 'object' || Array.isArray(request.scopeGrant)) {
            sendResponse(socket, { ok: false, code: 'RUNNER_SCOPE_UNAVAILABLE', error: 'Run scope renewal is unavailable' });
            return;
          }
          void renewRunContextImpl({ directory: runScopeRegistration.directory, pinDirectory: runScopeRegistration.pinDirectory,
            runId, launchAttempt: requestedLaunchAttempt, grant: request.scopeGrant })
            .then(() => sendResponse(socket, { ok: true }))
            .catch(() => sendResponse(socket, { ok: false, code: 'RUNNER_SCOPE_RENEWAL_FAILED', error: 'Run scope renewal failed' }));
          return;
        }
        if (request.requireDistinctUid !== undefined && typeof request.requireDistinctUid !== 'boolean'
            || (request.requireDistinctUid === true && !capabilitiesNegotiated)) {
          sendResponse(socket, { ok: false, code: 'RUNNER_LAUNCH_REQUEST_INVALID', error: 'Invalid runner identity requirement' });
          return;
        }
        const requestedGuiEnvironment = pickRunnerGuiEnvironment(request?.guiEnvironment);
        void launchRunner(runId, {
          serviceUser: resolvedServiceUser,
          serviceGroup: resolvedServiceGroup,
          controlUser: resolvedControlUser,
          requireDistinctUid: request.requireDistinctUid === true,
          launchAttempt: requestedLaunchAttempt,
          ...(runScopeRegistration && request?.scopeGrant ? { scopeGrant: request.scopeGrant, runScopeRegistration } : {}),
          ...(Object.keys(requestedGuiEnvironment).length > 0
            ? { guiEnvironment: requestedGuiEnvironment }
            : {}),
        })
          .then((result) => sendResponse(socket, { ok: true, ...result }))
          .catch((error) => sendResponse(socket, {
            ok: false,
            code: error?.code || 'RUNNER_LAUNCH_FAILED',
            error: error?.message || String(error),
            ...(error?.code === 'RUNNER_WORKSPACE_ACCESS_DENIED' && error?.launchDefinitelyNotSubmitted === true
              ? { launchDefinitelyNotSubmitted: true } : {}),
          }));
      }
    });
    socket.on('error', () => {});
  });
  if (inherited) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ fd: inherited.fd }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } else {
    const resolvedControlUser = controlUser || await resolveControlUser();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(normalizedSocketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(normalizedSocketPath, 0o660);
    try {
      const uid = Number.parseInt((await execFileAsync('id', ['-u', resolvedControlUser])).stdout.trim(), 10);
      const groupOutput = controlGroup
        ? (await execFileAsync('getent', ['group', controlGroup])).stdout.trim().split(':')[2]
        : (await execFileAsync('id', ['-g', resolvedControlUser])).stdout.trim();
      const gid = Number.parseInt(groupOutput, 10);
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('Invalid control socket ownership');
      await chownImpl(normalizedSocketPath, uid, gid);
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      await rm(normalizedSocketPath, { force: true });
      throw error;
    }
  }
  return {
    server,
    socketPath: normalizedSocketPath,
    inherited: !!inherited,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      // P2-C: a systemd-pre-bound socket is systemd's to remove; the daemon only
      // unlinks the socket file it created itself.
      if (!inherited) {
        await rm(normalizedSocketPath, { force: true });
      }
    },
  };
}

async function main() {
  const directory = trimString(process.env.RAGENT_LINUX_RUN_CONTEXT_DIR);
  const pinDirectory = trimString(process.env.RAGENT_LINUX_SERVICE_PIN_DIR);
  // The optional directories are root-configured; request fields never choose
  // them. The feature remains inactive until both protected stores are set up.
  const runScopeRegistration = directory && pinDirectory ? { directory, pinDirectory } : null;
  const server = await createRunnerLifecycleServer({ runScopeRegistration });
  // Historical grants are never changed automatically. Only report that
  // records need an operator's review once when the broker starts.
  try {
    const result = await createRunnerWorkspaceCleanupSweep()();
    if (result.manualReviewRequired) console.warn(`[runner-lifecycle] ${result.manualReviewRequired} historical workspace access records require manual review`);
  } catch (error) {
    console.warn(`[runner-lifecycle] historical workspace access review unavailable: ${error.message}`);
  }
  const shutdown = async () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`[runner-lifecycle] listening on ${server.socketPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[runner-lifecycle] ${error?.stack || error?.message || String(error)}`);
    process.exit(1);
  });
}
