// Runner process environment policy.
//
// Ordinary Runs execute arbitrary commands as the runner service user, so the
// environment handed to a Run must be an explicit allowlist rather than the
// full production control-plane environment.  The chat control plane
// (run-launcher) and the runner-lifecycle broker
// build the runner env from this single policy so no code path can fall back
// to inheriting AGENTOC_CONFIG_DIR / sockets / credentials.
//
// This module is deliberately side-effect free so the root-owned brokers can
// import it without pulling in the chat stack.

import { isAbsolute, join, resolve } from 'path';

export const RUNNER_GUI_ENV_KEYS = [
  'DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
];

const RUNNER_GUI_PATH_ENV_KEYS = new Set(['XAUTHORITY', 'XDG_RUNTIME_DIR']);
const DISPLAY_VALUE_RE = /^[A-Za-z0-9._:/\[\]-]{1,256}$/;
const MAX_GUI_PATH_LENGTH = 4096;

// Keys copied from the caller's process.env into every runner process.  These
// are locale/terminal basics a CLI needs, or non-secret runtime hints the
// runner sidecar reads to place itself.
export const RUNNER_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'HOME',
  // Windows APIs, user-scoped package installation and native child processes
  // need these OS locations. They contain no provider or control-plane tokens.
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  // PowerShell 7 and Windows package discovery use the OS installation
  // directories; detached sidecars need the same trusted locations as their
  // launcher, including the native directory from a 32-bit process.
  'ProgramFiles',
  'ProgramW6432',
  'ProgramFiles(x86)',
  'ProgramData',
  'PATHEXT',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'AGENTOC_PROJECT_ROOT',
  // The managed harness installation root is a non-secret runtime location.
  // Windows detached Runs need it so command resolution cannot fall back to
  // an older user-PATH installation after the control plane selected the
  // AgentoC-owned harness.
  'AGENTOC_HARNESS_ROOT',
  // macOS bundles the launchers inside the movable app. The detached runner
  // must resolve the same packaged root selected by the app launcher.
  'AGENTOC_PACKAGED_HARNESS_ROOT',
  // Public policy path; the operator mounts this file read-only in a dedicated workbench.
  'AGENTOC_WORKBENCH_EXECUTION_POLICY_FILE',
  'AGENTOC_CHAT_BASE_URL',
  'CHAT_PORT',
  // Operator-set isolation requirement; never infer this from provider input.
  'AGENTOC_RUN_SANDBOX',
  'AGENTOC_RUNNER_LAUNCH_MODE',
  'AGENTOC_RUNNER_UNIT_NAME',
  'AGENTOC_RUNNER_UNIT_SCOPE',
  // This non-secret flag lets a separate runner preserve the control user's
  // access to its own atomically replaced Run files.
  'AGENTOC_RUNNER_DISTINCT_IDENTITY',
  'AGENTOC_LINUX_SCOPE_FINISH_ENABLED',
  'AGENTOC_USER_SHELL_ENV_B64',
  // Controlled result/spool write-back channel.  Points the sidecar at the
  // control plane's chat-runs directory without leaking the production config
  // path; the launcher/broker set it explicitly to the control-plane value.
  'AGENTOC_RUN_SPOOL_DIR',
  // Provider credentials live in a separate runner-owned subtree.  The
  // sidecar must receive this explicit path; otherwise its HOME fallback
  // silently selects $HOME/.config/agentoc/provider-runtime-homes.
  'AGENTOC_PROVIDER_HOMES_DIR',
  'AGENTOC_PROVIDER_PROTOCOL',
  // AgY's runtime HOME is derived by the runner lifecycle broker and is
  // separate from the service user's interactive HOME/keyring.
  'AGENTOC_AGY_HOME_DIR',
  // Prepared Codex provider home. Native OAuth is machine-local; this path is
  // never redirected to the interactive user's ~/.codex directory.
  'AGENTOC_CODEX_HOME_DIR',
  'AGENTOC_CODEX_ROLLOUT_SOURCES',
  'AGENTOC_CODEX_SERVICE_TIER',
  // Provider liveness controls are copied to the detached sidecar so the
  // control plane and all runner launch modes use the same bounded watchdog.
  'AGENTOC_RUN_IDLE_TIMEOUT_MS',
  'AGENTOC_RUN_IDLE_CHECK_INTERVAL_MS',
  'AGENTOC_CODEX_TOOL_IDLE_TIMEOUT_MS',
  'AGENTOC_CODEX_TURN_IDLE_TIMEOUT_MS',
  'AGENTOC_CODEX_IDLE_INTERRUPT_GRACE_MS',
  'AGENTOC_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS',
  'AGENTOC_RUN_STDOUT_QUEUE_MAX_LINES',
  'AGENTOC_RUN_STDOUT_QUEUE_MAX_BYTES',
  'AGENTOC_RUN_STDOUT_LINE_MAX_BYTES',
  // One-shot handoff from the launcher/broker to the sidecar. The token is
  // deliberately allowlisted despite the generic secret-key filter because it
  // is scoped to this provider-home lock and never comes from user config.
  'AGENTOC_NATIVE_OAUTH_LOCK_PATH',
  'AGENTOC_NATIVE_OAUTH_LOCK_TOKEN',
  'IS_SANDBOX',
  // Provider CLIs must use the same outbound proxy as the host when the
  // control service discovered one on the loopback desktop proxy.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // GUI values are accepted only through pickRunnerGuiEnvironment(); the
  // lifecycle broker also applies the same validation before systemd-run.
  ...RUNNER_GUI_ENV_KEYS,
];

// Keys that must never reach a Run even if a caller explicitly tries to set
// them.  Production config/socket/credential locations are control-plane
// secrets; a Run must not be able to reach the production chat-server socket,
// config directory or control-plane sockets with the same OS user.
export const RUNNER_ENV_DENYLIST = [
  'AGENTOC_CONFIG_DIR',
  'AGENTOC_INSTANCE_ROOT',
  'AGENTOC_MEMORY_DIR',
  'AGENTOC_CONTROL_SOCKET',
  'AGENTOC_PRIVILEGED_EXECUTOR_SOCKET',
  'AGENTOC_RUNNER_SUPERVISOR_SOCKET',
  'AGENTOC_RUNNER_LIFECYCLE_SOCKET',
  'AGENTOC_LINUX_PEER_RESULT_SOCKET',
  'AGENTOC_LINUX_PEER_CREDENTIAL_HELPER',
  'AGENTOC_RUNNER_LIFECYCLE_REQUIRED',
  'AGENTOC_RUNNER_SUPERVISOR_REQUIRED',
  'AGENTOC_PUBLIC_BASE_URL',
  'AGENTOC_NODE_RUNTIME',
  'AGENTOC_SERVICE_USER',
  'AGENTOC_RUNNER_USER',
];

// Any variable whose name carries one of these substrings is treated as a
// secret (unless it is an explicit allowlisted key) and is never inherited.
const SECRET_ENV_KEY_PATTERN =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_KEY|APIKEY|CREDENTIAL|AUTH)/;

const DENIED_ENV_KEYS = new Set(RUNNER_ENV_DENYLIST);

export function isDeniedRunnerEnvKey(key) {
  return !RUNNER_ENV_ALLOWLIST.includes(key)
    && (DENIED_ENV_KEYS.has(key) || SECRET_ENV_KEY_PATTERN.test(key));
}

function normalizeGuiValue(key, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > MAX_GUI_PATH_LENGTH || /[\0\r\n\s]/.test(normalized)) {
    return '';
  }
  if (key === 'DISPLAY') return DISPLAY_VALUE_RE.test(normalized) ? normalized : '';
  if (!RUNNER_GUI_PATH_ENV_KEYS.has(key) || !isAbsolute(normalized)) return '';
  const resolved = resolve(normalized);
  return resolved === '/' ? '' : resolved;
}

/**
 * Pick the small, non-secret GUI context needed by local X11 tools. Paths are
 * normalized to absolute paths and values containing shell/control whitespace
 * are rejected before they can reach systemd or bwrap argv construction.
 */
export function pickRunnerGuiEnvironment(source = {}) {
  const env = {};
  for (const key of RUNNER_GUI_ENV_KEYS) {
    const value = normalizeGuiValue(key, source?.[key]);
    if (value) env[key] = value;
  }
  return env;
}

export function buildRunnerGuiBindPaths(source = {}) {
  const gui = pickRunnerGuiEnvironment(source);
  const paths = [];
  if (gui.DISPLAY) paths.push('/tmp/.X11-unix');
  if (gui.XAUTHORITY) paths.push(gui.XAUTHORITY);
  if (gui.XDG_RUNTIME_DIR) paths.push(gui.XDG_RUNTIME_DIR);
  return [...new Set(paths)];
}

// Copy only the allowlisted keys from a source environment object.
export function pickRunnerEnvAllowlist(source = {}) {
  const env = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
    const value = source[key];
    if (RUNNER_GUI_ENV_KEYS.includes(key)) {
      const normalized = pickRunnerGuiEnvironment({ [key]: value })[key];
      if (normalized) env[key] = normalized;
    } else if (value !== undefined && value !== null) {
      env[key] = value;
    }
  }
  return env;
}

// Remove every key a Run must never see.  Safe to apply to a merged env object
// (allowlist picks plus explicit overrides) as a second gate.
export function stripDeniedRunnerEnvKeys(source = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (isDeniedRunnerEnvKey(key)) continue;
    if (RUNNER_GUI_ENV_KEYS.includes(key)) {
      const normalized = pickRunnerGuiEnvironment({ [key]: value })[key];
      if (normalized) env[key] = normalized;
      continue;
    }
    env[key] = value;
  }
  return env;
}

// The provider home is a broker-derived resource fact.  A sidecar may receive
// a user shell snapshot, but it must never use that snapshot to select Codex's
// credential/config root.
export function resolveRunnerCodexHomeDir(environment = process.env) {
  const explicitHome = typeof environment?.AGENTOC_CODEX_HOME_DIR === 'string'
    ? environment.AGENTOC_CODEX_HOME_DIR.trim()
    : '';
  if (explicitHome) return explicitHome;
  const launchMode = typeof environment?.AGENTOC_RUNNER_LAUNCH_MODE === 'string'
    ? environment.AGENTOC_RUNNER_LAUNCH_MODE.trim()
    : '';
  const providerHomesDir = typeof environment?.AGENTOC_PROVIDER_HOMES_DIR === 'string'
    ? environment.AGENTOC_PROVIDER_HOMES_DIR.trim()
    : '';
  return launchMode && providerHomesDir ? join(providerHomesDir, 'codex') : '';
}

export function resolveRunnerAgyHomeDir(environment = process.env) {
  const explicitHome = typeof environment?.AGENTOC_AGY_HOME_DIR === 'string'
    ? environment.AGENTOC_AGY_HOME_DIR.trim()
    : '';
  if (explicitHome) return explicitHome;
  const launchMode = typeof environment?.AGENTOC_RUNNER_LAUNCH_MODE === 'string'
    ? environment.AGENTOC_RUNNER_LAUNCH_MODE.trim()
    : '';
  const providerHomesDir = typeof environment?.AGENTOC_PROVIDER_HOMES_DIR === 'string'
    ? environment.AGENTOC_PROVIDER_HOMES_DIR.trim()
    : '';
  return launchMode && providerHomesDir ? join(providerHomesDir, 'agy') : '';
}
