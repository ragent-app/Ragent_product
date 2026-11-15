import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { win32 } from 'node:path';

export const WINDOWS_RUNTIME_PRODUCT_DIR = 'Ragent';
export const WINDOWS_DEFAULT_INSTANCE_NAME = 'owner';
export const WINDOWS_PATH_ERROR = 'WINDOWS_RUNTIME_PATH_INVALID';
export const WINDOWS_PATH_BOUNDARY_UNTRUSTED = 'WINDOWS_PATH_BOUNDARY_UNTRUSTED';

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
const WINDOWS_PROGRAM_DATA_ROOT = /^[a-z]:\\programdata(?:\\|$)/i;
const WINDOWS_SERVICE_MODE = process.platform === 'win32'
  && trimString(process.env.RAGENT_WINDOWS_SERVICE_MODE) === '1';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathError(message) {
  const error = new Error(message);
  error.code = WINDOWS_PATH_ERROR;
  return error;
}

function assertWindowsAbsolutePath(value, fieldName, { allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  const normalized = trimString(value);
  // `\\work` is rooted on the current drive, not a stable absolute path.  A0
  // deliberately supports only explicit local drive paths; UNC/device paths
  // need a separate identity and reparse policy before they can be trusted.
  if (!normalized || !/^[a-z]:\\/i.test(normalized) || !win32.isAbsolute(normalized)) {
    throw pathError(`${fieldName} must be an absolute local Windows path`);
  }
  const result = win32.normalize(normalized);
  if (WINDOWS_PROGRAM_DATA_ROOT.test(result) && !allowProgramData) {
    throw pathError(`${fieldName} must not be under Windows ProgramData`);
  }
  return result;
}

export function normalizeWindowsInstanceName(value) {
  const name = (trimString(value) || WINDOWS_DEFAULT_INSTANCE_NAME).normalize('NFC');
  const deviceBaseName = name.split('.')[0].replace(/[. ]+$/g, '');
  if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || WINDOWS_RESERVED_DEVICE_NAME.test(deviceBaseName)) {
    throw pathError('instance name contains a Windows path separator or reserved character');
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw pathError('instance name must not end with a dot or space');
  }
  return name;
}

function instanceDirectoryName(name) {
  // NTFS is case-insensitive by default.  Use a stable folded directory key
  // so `Owner` and `owner` cannot accidentally describe different instances
  // while resolving to the same on-disk state.
  return name.normalize('NFC').toLowerCase();
}

function assertPathWithinInstanceRoot(value, fieldName, instanceRoot, { allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  const normalized = assertWindowsAbsolutePath(value, fieldName, { allowProgramData });
  if (!isWindowsPathWithin(instanceRoot, normalized, { allowProgramData })) {
    throw pathError(`${fieldName} must remain inside RAGENT_INSTANCE_ROOT`);
  }
  return normalized;
}

function inferInstanceRootFromRunnerPath(value, fieldName, suffix, { allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  const normalized = assertWindowsAbsolutePath(value, fieldName, { allowProgramData });
  const segments = suffix.split('\\');
  let cursor = normalized;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (win32.basename(cursor).toLowerCase() !== segments[index].toLowerCase()) return null;
    cursor = win32.dirname(cursor);
  }
  return assertWindowsAbsolutePath(cursor, 'derived instance root', { allowProgramData });
}

function deriveInstanceRootFromRunnerPaths({ spoolPath, providerHomesPath, allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  const candidates = [];
  if (trimString(spoolPath)) {
    const candidate = inferInstanceRootFromRunnerPath(
      spoolPath,
      'RAGENT_RUN_SPOOL_DIR',
      'data\\chat-runs',
      { allowProgramData },
    );
    if (candidate) candidates.push(candidate);
  }
  if (trimString(providerHomesPath)) {
    const candidate = inferInstanceRootFromRunnerPath(
      providerHomesPath,
      'RAGENT_PROVIDER_HOMES_DIR',
      'provider-homes',
      { allowProgramData },
    );
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0) return '';
  const root = candidates[0];
  if (candidates.some((candidate) => candidate.toLowerCase() !== root.toLowerCase())) {
    throw pathError('runner-scoped paths must derive the same instance root');
  }
  return root;
}

function hashPath(value) {
  return createHash('sha256').update(win32.resolve(value).normalize('NFC').toLowerCase()).digest('hex').slice(0, 24);
}

function hashInstanceId(value) {
  // The root is folded because Windows filesystem paths are case-insensitive;
  // the persisted instance identity is not folded so distinct identities can
  // never silently share a named-pipe endpoint.
  return createHash('sha256').update(value.normalize('NFC')).digest('hex').slice(0, 24);
}

function assertDisjointWindowsPaths(entries, { allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  for (let index = 0; index < entries.length; index += 1) {
    const [leftName, leftPath] = entries[index];
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const [rightName, rightPath] = entries[otherIndex];
      if (isWindowsPathWithin(leftPath, rightPath, { allowProgramData }) || isWindowsPathWithin(rightPath, leftPath, { allowProgramData })) {
        throw pathError(`${leftName} must not overlap ${rightName}`);
      }
    }
  }
}

export function isWindowsPathWithin(parent, candidate, { allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  let normalizedParent;
  let normalizedCandidate;
  try {
    normalizedParent = assertWindowsAbsolutePath(parent, 'parent', { allowProgramData });
    normalizedCandidate = assertWindowsAbsolutePath(candidate, 'candidate', { allowProgramData });
  } catch {
    return false;
  }
  const relative = win32.relative(normalizedParent, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative));
}

/**
 * Turn filesystem observations from the Windows facts provider into one
 * explicit decision.  This module does not stat paths itself: callers must
 * obtain a canonical path and reparse fact from the OS immediately before the
 * sensitive operation.  Missing or contradictory facts never become a safe
 * path by inference.
 */
export function assessWindowsPathBoundary({
  expectedRoot,
  configuredPath,
  canonicalPath,
  reparsePoint,
} = {}) {
  const configured = trimString(configuredPath);
  const canonical = trimString(canonicalPath);
  let root;
  try {
    root = assertWindowsAbsolutePath(expectedRoot, 'expectedRoot');
  } catch {
    return Object.freeze({
      ok: false,
      code: WINDOWS_PATH_BOUNDARY_UNTRUSTED,
      reason: 'root-invalid',
      configuredPath: configured,
      canonicalPath: canonical,
    });
  }

  if (!configured || !isWindowsPathWithin(root, configured)) {
    return Object.freeze({
      ok: false,
      code: WINDOWS_PATH_BOUNDARY_UNTRUSTED,
      reason: 'configured-path-outside-root',
      configuredPath: configured,
      canonicalPath: canonical,
    });
  }
  if (!canonical) {
    return Object.freeze({
      ok: false,
      code: WINDOWS_PATH_BOUNDARY_UNTRUSTED,
      reason: 'canonical-path-unverified',
      configuredPath: configured,
      canonicalPath: canonical,
    });
  }
  if (!isWindowsPathWithin(root, canonical)) {
    return Object.freeze({
      ok: false,
      code: WINDOWS_PATH_BOUNDARY_UNTRUSTED,
      reason: 'canonical-path-outside-root',
      configuredPath: configured,
      canonicalPath: canonical,
    });
  }
  if (reparsePoint !== false) {
    return Object.freeze({
      ok: false,
      code: WINDOWS_PATH_BOUNDARY_UNTRUSTED,
      reason: reparsePoint === true ? 'reparse-point' : 'reparse-fact-unverified',
      configuredPath: configured,
      canonicalPath: canonical,
    });
  }
  return Object.freeze({
    ok: true,
    configuredPath: win32.normalize(configured),
    canonicalPath: win32.normalize(canonical),
    root,
    reparsePoint: false,
  });
}

export function deriveWindowsEndpointName({ instanceRoot, instanceId = '', allowProgramData = WINDOWS_SERVICE_MODE } = {}) {
  const root = assertWindowsAbsolutePath(instanceRoot, 'instanceRoot', { allowProgramData });
  const id = trimString(instanceId);
  if (!id) {
    throw pathError('instanceId is required to derive a Windows endpoint name');
  }
  if (/\x00|[\r\n]/.test(id)) {
    throw pathError('instanceId contains a control character');
  }
  return `\\\\.\\pipe\\ragent-${hashPath(root)}-${hashInstanceId(id)}`;
}

/**
 * Resolve the A0 per-user directory family without touching the filesystem.
 * The function is intentionally explicit about the platform so Linux tests
 * can exercise the Windows contract without presenting as Windows live.
 */
export function resolveWindowsPerUserPaths({
  platform = process.platform,
  env = process.env,
  instanceName = env.RAGENT_INSTANCE_NAME,
  productRootOverride = '',
  instanceRootOverride = env.RAGENT_INSTANCE_ROOT,
  configDirOverride = env.RAGENT_CONFIG_DIR,
} = {}) {
  if (platform !== 'win32') {
    const error = new Error('Windows per-user paths require win32');
    error.code = 'WINDOWS_RUNTIME_PLATFORM_REQUIRED';
    throw error;
  }

  const runnerServicePaths = trimString(env.RAGENT_RUNNER_LAUNCH_MODE) === 'runner-supervisor'
    && !trimString(instanceRootOverride) && !trimString(configDirOverride)
    && Boolean(trimString(env.RAGENT_RUN_SPOOL_DIR))
    && Boolean(trimString(env.RAGENT_PROVIDER_HOMES_DIR));
  const allowProgramData = trimString(env.RAGENT_WINDOWS_SERVICE_MODE) === '1' || runnerServicePaths;
  const explicitProductRoot = trimString(productRootOverride);
  const productRoot = explicitProductRoot
    ? assertWindowsAbsolutePath(explicitProductRoot, 'RAGENT_PRODUCT_ROOT', { allowProgramData })
    : win32.join(assertWindowsAbsolutePath(
      trimString(env.LOCALAPPDATA) || win32.join(homedir(), 'AppData', 'Local'),
      'LOCALAPPDATA',
      { allowProgramData },
    ), WINDOWS_RUNTIME_PRODUCT_DIR);
  const normalizedInstanceName = normalizeWindowsInstanceName(instanceName);
  const defaultInstanceRoot = win32.join(productRoot, 'instances', instanceDirectoryName(normalizedInstanceName));
  const explicitRoot = trimString(instanceRootOverride);
  const explicitConfig = trimString(configDirOverride);
  const derivedRunnerRoot = !explicitRoot && !explicitConfig
    ? deriveInstanceRootFromRunnerPaths({
      spoolPath: env.RAGENT_RUN_SPOOL_DIR,
      providerHomesPath: env.RAGENT_PROVIDER_HOMES_DIR,
      allowProgramData,
    })
    : '';
  let instanceRoot;
  let configDir;
  if (explicitRoot) {
    instanceRoot = assertWindowsAbsolutePath(explicitRoot, 'RAGENT_INSTANCE_ROOT', { allowProgramData });
    configDir = explicitConfig
      ? assertWindowsAbsolutePath(explicitConfig, 'RAGENT_CONFIG_DIR', { allowProgramData })
      : win32.join(instanceRoot, 'config');
    if (!isWindowsPathWithin(instanceRoot, configDir, { allowProgramData })) {
      throw pathError('RAGENT_CONFIG_DIR must remain inside RAGENT_INSTANCE_ROOT');
    }
  } else if (explicitConfig) {
    configDir = assertWindowsAbsolutePath(explicitConfig, 'RAGENT_CONFIG_DIR', { allowProgramData });
    instanceRoot = win32.dirname(configDir);
  } else if (derivedRunnerRoot) {
    instanceRoot = derivedRunnerRoot;
    configDir = win32.join(instanceRoot, 'config');
  } else {
    instanceRoot = defaultInstanceRoot;
    configDir = win32.join(instanceRoot, 'config');
  }
  const dataDir = win32.join(instanceRoot, 'data');
  const runtimeDir = win32.join(instanceRoot, 'runtime');
  const spoolDir = trimString(env.RAGENT_RUN_SPOOL_DIR)
    ? assertPathWithinInstanceRoot(env.RAGENT_RUN_SPOOL_DIR, 'RAGENT_RUN_SPOOL_DIR', instanceRoot, { allowProgramData })
    : win32.join(dataDir, 'chat-runs');
  const providerHomesDir = trimString(env.RAGENT_PROVIDER_HOMES_DIR)
    ? assertPathWithinInstanceRoot(env.RAGENT_PROVIDER_HOMES_DIR, 'RAGENT_PROVIDER_HOMES_DIR', instanceRoot, { allowProgramData })
    : win32.join(instanceRoot, 'provider-homes');
  const memoryDir = trimString(env.RAGENT_MEMORY_DIR)
    ? assertPathWithinInstanceRoot(env.RAGENT_MEMORY_DIR, 'RAGENT_MEMORY_DIR', instanceRoot, { allowProgramData })
    : win32.join(instanceRoot, 'memory');
  const workspaceDir = trimString(env.RAGENT_WORK_ROOT_DIR)
    ? assertPathWithinInstanceRoot(env.RAGENT_WORK_ROOT_DIR, 'RAGENT_WORK_ROOT_DIR', instanceRoot, { allowProgramData })
    : win32.join(instanceRoot, 'workspace');
  const platformSkillsDir = trimString(env.RAGENT_PLATFORM_SKILLS_DIR)
    ? assertPathWithinInstanceRoot(env.RAGENT_PLATFORM_SKILLS_DIR, 'RAGENT_PLATFORM_SKILLS_DIR', instanceRoot, { allowProgramData })
    : win32.join(instanceRoot, 'platform', 'skills');
  const instanceIdentityFile = trimString(env.RAGENT_INSTANCE_KEY_FILE)
    ? assertPathWithinInstanceRoot(env.RAGENT_INSTANCE_KEY_FILE, 'RAGENT_INSTANCE_KEY_FILE', instanceRoot, { allowProgramData })
    : win32.join(configDir, 'instance-identity.json');

  // These directories are separate ownership/security domains.  Spool is
  // intentionally nested below data, so it is checked against the other
  // domains but not against data itself.
  assertDisjointWindowsPaths([
    ['RAGENT_CONFIG_DIR', configDir],
    ['data directory', dataDir],
    ['runtime directory', runtimeDir],
    ['provider homes', providerHomesDir],
    ['memory directory', memoryDir],
    ['workspace directory', workspaceDir],
    ['platform skills', platformSkillsDir],
  ], { allowProgramData });
  assertDisjointWindowsPaths([
    ['RAGENT_RUN_SPOOL_DIR', spoolDir],
    ['RAGENT_CONFIG_DIR', configDir],
    ['runtime directory', runtimeDir],
    ['provider homes', providerHomesDir],
    ['memory directory', memoryDir],
    ['workspace directory', workspaceDir],
    ['platform skills', platformSkillsDir],
  ], { allowProgramData });

  return Object.freeze({
    productRoot,
    instanceName: normalizedInstanceName,
    instanceDirectoryName: instanceDirectoryName(normalizedInstanceName),
    instanceRoot,
    configDir,
    dataDir,
    runtimeDir,
    spoolDir,
    providerHomesDir,
    codexHomeDir: win32.join(providerHomesDir, 'codex'),
    claudeHomeDir: win32.join(providerHomesDir, 'claude'),
    memoryDir,
    workspaceDir,
    platformSkillsDir,
    instanceIdentityFile,
    ownershipFile: win32.join(runtimeDir, 'instance-ownership.json'),
    endpointNamespace: `ragent-${hashPath(instanceRoot)}`,
  });
}

/**
 * Resolve the canonical LocalSystem/MSI instance without inheriting caller
 * supplied per-user runner paths.  The service host injects the same root
 * family into its children; this helper lets read-only tools inspect that
 * instance from an ordinary signed-in user's shell.
 */
export function resolveWindowsServicePaths({
  platform = process.platform,
  env = process.env,
  instanceName = WINDOWS_DEFAULT_INSTANCE_NAME,
} = {}) {
  if (platform !== 'win32') {
    const error = new Error('Windows service paths require win32');
    error.code = 'WINDOWS_RUNTIME_PLATFORM_REQUIRED';
    throw error;
  }

  const programData = assertWindowsAbsolutePath(env.ProgramData, 'ProgramData', { allowProgramData: true });
  const productRoot = win32.join(programData, WINDOWS_RUNTIME_PRODUCT_DIR);
  const normalizedInstanceName = normalizeWindowsInstanceName(instanceName);
  const instanceRoot = win32.join(productRoot, 'instances', instanceDirectoryName(normalizedInstanceName));
  const configDir = win32.join(instanceRoot, 'config');
  const serviceEnv = {
    RAGENT_WINDOWS_SERVICE_MODE: '1',
    RAGENT_INSTANCE_ROOT: instanceRoot,
    RAGENT_CONFIG_DIR: configDir,
    RAGENT_RUN_SPOOL_DIR: '',
    RAGENT_PROVIDER_HOMES_DIR: '',
    RAGENT_MEMORY_DIR: '',
    RAGENT_WORK_ROOT_DIR: '',
    RAGENT_PLATFORM_SKILLS_DIR: '',
    RAGENT_INSTANCE_KEY_FILE: '',
  };
  return resolveWindowsPerUserPaths({
    platform,
    env: serviceEnv,
    instanceName: normalizedInstanceName,
    productRootOverride: productRoot,
    instanceRootOverride: instanceRoot,
    configDirOverride: configDir,
  });
}

export function windowsPathFacts(paths) {
  const values = [
    paths?.productRoot,
    paths?.instanceRoot,
    paths?.configDir,
    paths?.dataDir,
    paths?.runtimeDir,
    paths?.spoolDir,
    paths?.providerHomesDir,
    paths?.memoryDir,
    paths?.workspaceDir,
    paths?.platformSkillsDir,
    paths?.instanceIdentityFile,
  ].filter(Boolean);
  return {
    platform: 'win32',
    usesProgramData: values.some((value) => /\\programdata(?:\\|$)/i.test(value)),
    allUnderLocalAppData: values.every((value) => isWindowsPathWithin(paths.productRoot, value)),
    uniqueRoots: new Set(values.map((value) => win32.normalize(value).toLowerCase())).size === values.length,
  };
}
