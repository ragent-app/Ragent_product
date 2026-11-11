import { homedir, tmpdir } from 'os';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';
import {
  loadInstanceAccessDefaults,
  normalizeBaseUrl,
  resolveBridgeBaseUrl,
} from './instance-access.mjs';
import { resolveWindowsPerUserPaths } from './windows-runtime-paths.mjs';
import { resolveChatBindHost, resolveSecureCookies } from './windows-local-runtime.mjs';
import { normalizeTurnBrokerAuthMode } from './turn-broker-capability.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PROJECT_ROOT = process.env.AGENTOC_SOURCE_PROJECT_ROOT || join(__dirname, '..');

function validPort(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function validMs(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function validInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOverridePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function isPathWithin(parent, candidate) {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedParent) return true;
  // path.relative is platform-aware: win32 compares case-insensitively and
  // uses backslash separators, POSIX uses the "/" prefix rule. A candidate is
  // within the parent only when the relative path neither escapes ("..") nor
  // starts outside (absolute).
  const rel = relative(normalizedParent, normalizedCandidate);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function isLikelyTemporaryAgentoCHome(homeDir) {
  const normalizedHome = resolve(homeDir);
  const normalizedTmp = resolve(tmpdir());
  return isPathWithin(normalizedTmp, normalizedHome)
    && normalizedHome.slice(normalizedTmp.length + 1).startsWith('agentoc-');
}

function resolveInstanceScopedOverridePath(value) {
  const resolved = resolveOverridePath(value);
  if (!resolved) return '';
  const homeDir = homedir();
  if (!isLikelyTemporaryAgentoCHome(homeDir)) return resolved;
  if (envFlagEnabled(process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES, false)) return resolved;
  return isPathWithin(homeDir, resolved) ? resolved : '';
}

function envFlagEnabled(value, fallback = false) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function isVolcengineTosHost(hostname) {
  return /(^|\.)tos-[^.]+\.volces\.com$/i.test(trimString(hostname));
}

function normalizeFileAssetStorageProvider(value, urls = []) {
  const explicit = trimString(value).toLowerCase();
  if (['tos', 'volcengine-tos', 'volces-tos'].includes(explicit)) return 'tos';
  if (['s3', 'aws-s3', 's3-compatible', 'r2'].includes(explicit)) return 's3';

  for (const candidate of urls) {
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized) continue;
    try {
      if (isVolcengineTosHost(new URL(normalized).hostname)) return 'tos';
    } catch {}
  }

  return 's3';
}

function normalizeTosBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (!isVolcengineTosHost(parsed.hostname)) return normalized;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return normalized;

    const bucket = segments[0];
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) return normalized;
    if (parsed.hostname.toLowerCase().startsWith(`${bucket.toLowerCase()}.`)) return normalized;

    parsed.hostname = `${bucket}.${parsed.hostname}`;
    parsed.pathname = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

function normalizeFileAssetStorageUrl(value, provider) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';
  if (provider === 'tos') return normalizeTosBaseUrl(normalized);
  return normalized;
}

function extractOrigin(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

export const SESSION_EXPIRY = validMs(
  process.env.SESSION_EXPIRY,
  60 * 1000,          // min: 1 minute
  30 * 24 * 60 * 60 * 1000, // max: 30 days
  24 * 60 * 60 * 1000  // default: 24 hours
);
export const SECURE_COOKIES = resolveSecureCookies();

const WINDOWS_PATHS = process.platform === 'win32'
  ? resolveWindowsPerUserPaths({ platform: process.platform, env: process.env })
  : null;
// The Windows live runtime is intentionally pinned to the same public owner-auth
// and TURN broker endpoints as the current AgentoC host. Keep these values in
// source so the Windows control plane does not depend on a task-local env file.
const WINDOWS_FIXED_ACCOUNTS_URL = 'https://agentoc.andyscodexagent.cyou/accounts';
const WINDOWS_FIXED_TURN_BROKER_URL = 'https://agentoc.andyscodexagent.cyou/turn';
// Production Windows installs must use the bundled service endpoints. Isolated
// tests opt into temporary-instance overrides explicitly so their in-process
// Accounts mocks never contact the production control plane.
const WINDOWS_FIXED_SERVICE_ENDPOINTS = process.platform === 'win32'
  && !envFlagEnabled(process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES, false);
export const INSTANCE_ROOT = WINDOWS_PATHS?.instanceRoot
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_INSTANCE_ROOT)
  || null;
const configDir = WINDOWS_PATHS?.configDir
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_CONFIG_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'config') : join(homedir(), '.config', 'agentoc'));
export const CONFIG_DIR = configDir;
export const DATA_DIR = WINDOWS_PATHS?.dataDir || join(configDir, 'data');
export const RUNTIME_DIR = WINDOWS_PATHS?.runtimeDir || join(configDir, 'runtime');
await mkdir(configDir, { recursive: true });
const INSTANCE_ACCESS_DEFAULTS_FILE = join(homedir(), '.config', 'agentoc', 'guest-instance-defaults.json');
const instanceAccessDefaults = await loadInstanceAccessDefaults({
  defaultsFilePath: INSTANCE_ACCESS_DEFAULTS_FILE,
  env: process.env,
});

export const CHAT_PORT = validPort(process.env.CHAT_PORT, 7690);
export const CHAT_BIND_HOST = resolveChatBindHost({
  platform: process.platform,
  requestedHost: process.env.CHAT_BIND_HOST,
});
export const LOCAL_WEB_AUTH_ENABLED = process.env.AGENTOC_LOCAL_WEB_AUTH !== '0';
export const ALLOW_EMPTY_ACCESS_TOKEN_ON_NETWORK = envFlagEnabled(
  process.env.AGENTOC_ALLOW_EMPTY_TOKEN_ON_NETWORK,
  false,
);
export const ALLOW_EMPTY_ACCESS_TOKEN = envFlagEnabled(process.env.AGENTOC_ALLOW_EMPTY_TOKEN, false)
  && (ALLOW_EMPTY_ACCESS_TOKEN_ON_NETWORK || ['127.0.0.1', 'localhost', '::1'].includes(CHAT_BIND_HOST));
export const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.AGENTOC_PUBLIC_BASE_URL)
  || await detectPublicBaseUrl(CHAT_PORT);
// 运营方轻量信令地址（只转发 HMAC 签名 SDP/ICE envelope，不承载数据）。env 可覆盖；
// 为空的实例不启用 P2P 通道（纯 LAN 配对）。默认指向运营方托管信令端点。
export const P2P_SIGNALING_URL = normalizeBaseUrl(process.env.AGENTOC_P2P_SIGNALING_URL)
  || 'https://agentoc.andyscodexagent.cyou';
export const BRIDGE_PUBLIC_BASE_URL = resolveBridgeBaseUrl({
  instanceName: INSTANCE_ROOT ? '' : 'owner',
  instanceRoot: INSTANCE_ROOT,
  explicitBaseUrl: process.env.AGENTOC_BRIDGE_BASE_URL,
  bridgeBaseUrlTemplate: process.env.AGENTOC_BRIDGE_BASE_URL_TEMPLATE
    || instanceAccessDefaults.bridgeBaseUrlTemplate,
  bridgeRootBaseUrl: process.env.AGENTOC_BRIDGE_ROOT_BASE_URL
    || instanceAccessDefaults.bridgeRootBaseUrl,
});

async function detectPublicBaseUrl(port) {
  try {
    const { readFile: readFileAsync } = await import('fs/promises');
    const cfgPath = join(homedir(), '.cloudflared', 'config.yml');
    const raw = await readFileAsync(cfgPath, 'utf8');
    // Find the hostname that maps to our port
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const hostMatch = lines[i].match(/hostname:\s*(.+)/);
      const svcMatch = lines[i + 1]?.match(/service:\s*http:\/\/127\.0\.0\.1:(\d+)/);
      if (hostMatch && svcMatch && parseInt(svcMatch[1], 10) === port) {
        return `https://${hostMatch[1].trim()}`;
      }
    }
  } catch {}
  return '';
}
export const SHARED_STARTUP_DEFAULTS_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ENABLE_SHARED_STARTUP_DEFAULTS,
  true,
);

// Organization Runtime feature flags (S8+). The source-level fallback stays
// off for isolated development/tests; packaged installs set the implemented
// collaboration flags to 1 in /etc/agentoc/agentoc.env. S9 wires the
// ORG_SCHEMA_ENABLED command gate and the shadow projection reads
// ORG_SHADOW_PROJECTION at store level.
export const ORG_SCHEMA_ENABLED = envFlagEnabled(process.env.AGENTOC_ORG_SCHEMA_ENABLED, false);
export const ORG_SHADOW_PROJECTION = envFlagEnabled(process.env.AGENTOC_ORG_SHADOW_PROJECTION, false);
// S15: public root-session addressability. The source fallback is off so the
// additive session-class contract does not alter legacy ingress behavior in
// isolated processes; packaged installs enable it explicitly in agentoc.env.
export const ORG_SESSION_ADDRESSABILITY_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_SESSION_ADDRESSABILITY_ENABLED,
  false,
);
// S10: Managed Input enforcement. The source fallback is off; when on, every input bypass
// (fork/fork-at/delegate/session-spawn/continuation/message) against a managed
// session (sessionPlane === 'organization') is rejected with
// MANAGED_SESSION_INPUT_BYPASS (409). Wired in chat/managed-input.mjs.
export const MANAGED_INPUT_ENFORCEMENT = envFlagEnabled(process.env.AGENTOC_MANAGED_INPUT_ENFORCEMENT, false);
// S11: Managed Writer. The source fallback is off; when on, writer Attempts in
// organization-plane collaborations run against a private staging workspace
// and their diff is validated + committed through executeMutation()
// (chat/managed-writer.mjs). Wired in chat/collaboration-orchestrator.mjs.
export const MANAGED_WRITER_ENABLED = envFlagEnabled(process.env.AGENTOC_MANAGED_WRITER_ENABLED, false);
// S12: Certified read-only reviewer runtime. The source fallback is off; when on, reviewer
// tasks (role='reviewer') in organization-plane collaborations must execute
// through a certified read-only runtime — the run workspace is mounted
// read-only (bwrap --ro-bind) and only a runtime that declares
// supportsReadOnlyFilesystem qualifies. A sandbox startup/build failure refuses
// the reviewer run with READ_ONLY_RUNTIME_REFUSED (503) instead of downgrading
// to an unsandboxed launch. Wired in chat/collaboration-orchestrator.mjs and
// chat/runtime-adapter.mjs.
export const REVIEWER_ENABLED = envFlagEnabled(process.env.AGENTOC_REVIEWER_ENABLED, false);
// P1: Root Leadership natural-language ingress for Durable Collaboration. The
// source fallback is off; when enabled, only a server-validated marked plan
// can reach the Collaboration Runtime.
export const COLLABORATION_LEADER_ENABLED = envFlagEnabled(
  process.env.AGENTOC_COLLABORATION_LEADER_ENABLED,
  false,
);
// Autonomous Organization v1 rollout flags. The source fallback is off, while
// packaged installs enable the complete implemented set. Each slice remains
// independently disableable; disabled autonomous paths preserve facts but must
// not start new work or mutate existing organization state.
export const ORG_INTERNAL_ENVELOPE_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_INTERNAL_ENVELOPE_ENABLED,
  false,
);
export const ORG_AUTONOMOUS_LEADER_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_AUTONOMOUS_LEADER_ENABLED,
  false,
);
// S21 provisioning: materializes a Frozen Revision into real managed Sessions
// (Executive / Phase Lead / Worker / Reviewer). Off by default; when on, an
// explicit provisioning command creates one managed Session per organization
// node, in topological order (parent node first, so child node IDs and MANAGES
// edges are stable before the session factory binds them).
export const ORG_AUTONOMOUS_PROVISIONING_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  false,
);
// S21.1: automatically materialize a Frozen Revision after Root Leadership
// ingress. Kept separate from the explicit provisioning command gate so an
// operator can retain review-before-start while the feature is rolled out.
export const ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED,
  false,
);
export const ORG_HIERARCHICAL_DELEGATION_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_HIERARCHICAL_DELEGATION_ENABLED,
  false,
);
export const ORG_DYNAMIC_REPLAN_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_DYNAMIC_REPLAN_ENABLED,
  false,
);
export const ORG_STALL_GOVERNOR_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_STALL_GOVERNOR_ENABLED,
  false,
);
export const ORG_PROJECTION_V1_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_PROJECTION_V1_ENABLED,
  false,
);
// S24.2: Runtime-derived organization status projection. Kept separate from
// v1 so existing Web/Android consumers can continue to consume the original
// roster/event contract while v2 is rolled out and verified.
export const ORG_PROJECTION_V2_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_PROJECTION_V2_ENABLED,
  false,
);
export const ORG_RECOVERY_V1_ENABLED = envFlagEnabled(
  process.env.AGENTOC_ORG_RECOVERY_V1_ENABLED,
  false,
);
// P4-T1: Consultation V1 control-plane feature flag. The source fallback is
// off; packaged installs enable it. When on, the /api/consultations* routes
// (chat/router-consultation-routes.mjs) and the `agentoc consult` CLI expose
// the strategic consultation lifecycle (round + decision records).
export const CONSULTATION_V1_ENABLED = envFlagEnabled(
  process.env.AGENTOC_CONSULTATION_V1_ENABLED,
  false,
);

export const AUTH_FILE = join(configDir, 'auth.json');
// 本机 CLI 身份通道：chat-server 额外监听的 unix socket（0600，仅属主可连）。
// 网络请求无法到达，作为 2026-08-05 密码-only 加固后 CLI 免密获取 owner 会话的通道。
export const CLI_SOCKET_PATH = join(configDir, 'agentoc-cli.sock');
export const TOOLS_FILE = join(configDir, 'tools.json');
export const PLATFORM_SKILLS_DIR = WINDOWS_PATHS?.platformSkillsDir
  || resolveOverridePath(process.env.AGENTOC_PLATFORM_SKILLS_DIR)
  || join(homedir(), '.agentoc', 'platform', 'skills');
export const SHARED_TOOLS_DIR = resolveOverridePath(process.env.AGENTOC_SHARED_TOOLS_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'shared-tools') : join(homedir(), '.agentoc', 'shared-tools'));
export const MANAGED_WORK_ROOT_DIR = WINDOWS_PATHS?.workspaceDir
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_WORK_ROOT_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'workspace') : join(homedir(), '.agentoc', 'workspace'));
await mkdir(MANAGED_WORK_ROOT_DIR, { recursive: true });
export const TOOLS_ENABLED_FILE = resolveOverridePath(process.env.AGENTOC_TOOLS_ENABLED_FILE)
  || join(configDir, 'tools-enabled.md');
export const TOOL_OVERLAYS_DIR = resolveOverridePath(process.env.AGENTOC_TOOL_OVERLAYS_DIR)
  || join(configDir, 'tool-overlays');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const AUTH_SESSIONS_DB_FILE = join(configDir, 'auth-sessions.sqlite');
export const TRUSTED_DEVICES_FILE = join(configDir, 'trusted-devices.json');
// 每个实例的 Ed25519 身份：用于与受控 Accounts 服务交换一次性 owner 授权。
// 它不是用户数据；reset-data 与 decommission 的清除语义由调用方显式区分。
export const INSTANCE_IDENTITY_FILE = WINDOWS_PATHS?.instanceIdentityFile
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_INSTANCE_KEY_FILE)
  || join(configDir, 'instance-identity.json');
export const ACCOUNTS_URL = WINDOWS_FIXED_SERVICE_ENDPOINTS
  ? WINDOWS_FIXED_ACCOUNTS_URL
  : normalizeBaseUrl(process.env.AGENTOC_ACCOUNTS_URL);
export const ACCOUNTS_JWKS_URL = WINDOWS_FIXED_SERVICE_ENDPOINTS
  ? `${WINDOWS_FIXED_ACCOUNTS_URL}/.well-known/jwks.json`
  : normalizeBaseUrl(process.env.AGENTOC_ACCOUNTS_JWKS_URL);
export const ACCOUNTS_ISSUER = WINDOWS_FIXED_SERVICE_ENDPOINTS
  ? WINDOWS_FIXED_ACCOUNTS_URL.replace(/\/accounts$/, '')
  : normalizeBaseUrl(process.env.AGENTOC_ACCOUNTS_ISSUER) || ACCOUNTS_URL;
export const CONNECTIVITY_STATE_FILE = join(configDir, 'connectivity-state.json');
export const TURN_CONNECTION_LEASES_FILE = join(configDir, 'turn-connection-leases.json');
// Cloudflare credentials belong to the independently deployed TURN broker.
// The product backend only receives a broker URL and an instance-scoped token.
export const TURN_BROKER_URL = WINDOWS_FIXED_SERVICE_ENDPOINTS
  ? WINDOWS_FIXED_TURN_BROKER_URL
  : normalizeBaseUrl(process.env.AGENTOC_TURN_BROKER_URL);
export const TURN_BROKER_AUTH_MODE = normalizeTurnBrokerAuthMode(process.env.AGENTOC_TURN_BROKER_AUTH_MODE);
export const TURN_BROKER_TOKEN = trimString(process.env.AGENTOC_TURN_BROKER_TOKEN);
export const TURN_BROKER_TIMEOUT_MS = validMs(process.env.AGENTOC_TURN_BROKER_TIMEOUT_MS, 250, 30000, 5000);
export const INSTALL_HANDOFFS_FILE = join(configDir, 'install-handoffs.json');
export const CHAT_SESSIONS_FILE = join(configDir, 'chat-sessions.json');
export const CHAT_PROJECTS_FILE = join(configDir, 'chat-projects.json');
export const CHAT_TRIGGERS_FILE = join(configDir, 'chat-triggers.json');
// Durable processes started through the session control capability live in
// their own instance-scoped subtree. They must not share Run spool state: a
// managed process is intentionally allowed to outlive the Run that created it.
export const CHAT_MANAGED_PROCESSES_DIR = join(configDir, 'managed-processes');
export const CHAT_LOCAL_BRIDGE_FILE = join(configDir, 'chat-local-bridge.json');
export const CONNECTOR_BINDINGS_FILE = join(configDir, 'connector-bindings.json');
export const CHAT_HISTORY_DIR = join(configDir, 'chat-history');
// Controlled spool write-back channel: the runner launcher/broker sets
// AGENTOC_RUN_SPOOL_DIR to the control-plane chat-runs directory (so the
// sidecar writes results where the control plane reads them) without leaking
// AGENTOC_CONFIG_DIR into the Run.  In the control plane process the variable
// is unset and CHAT_RUNS_DIR stays the production path.
export const CHAT_RUNS_DIR = WINDOWS_PATHS?.spoolDir
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_RUN_SPOOL_DIR)
  || join(configDir, 'chat-runs');
// Durable Phase 2B capability usage state. This is separate from session
// history: a grant-use CAS must survive history projection/replay and must be
// writable by the control plane without exposing the grant store to runners.
export const CAPABILITY_GRANT_USAGE_DIR = resolveInstanceScopedOverridePath(process.env.AGENTOC_CAPABILITY_GRANT_USAGE_DIR)
  || join(configDir, 'capability-grant-usage');
export const CHAT_COLLABORATIONS_DIR = join(configDir, 'chat-collaborations');
export const CHAT_COLLABORATIONS_DB = join(CHAT_COLLABORATIONS_DIR, 'collaborations.sqlite');
export const CHAT_IMAGES_DIR = join(configDir, 'images');
export const CHAT_FILE_ASSETS_DIR = join(configDir, 'file-assets');
export const CHAT_FILE_ASSET_CACHE_DIR = join(configDir, 'file-assets-cache');
export const API_REQUEST_LOGS_DIR = join(configDir, 'api-logs');
export const USAGE_LEDGER_DIR = resolveOverridePath(process.env.AGENTOC_USAGE_LEDGER_DIR)
  || join(configDir, 'usage-ledger');
export const VAPID_KEYS_FILE = join(configDir, 'vapid-keys.json');
export const PRIVILEGED_SIGNING_KEYS_FILE = join(configDir, 'privileged-signing-keys.json');
export const PRIVILEGED_QUOTA_FILE = join(configDir, 'privileged-quota.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(configDir, 'push-subscriptions.json');
export const APPS_FILE = join(configDir, 'apps.json');
export const USERS_FILE = join(configDir, 'users.json');
export const VISITORS_FILE = join(configDir, 'visitors.json');
export const UI_RUNTIME_SELECTION_FILE = join(configDir, 'ui-runtime-selection.json');
export const UI_ACCOUNT_POLICY_FILE = join(configDir, 'ui-account-policy.json');
export const CALENDAR_EVENTS_FILE = join(configDir, 'calendar-events.json');
// P0-C: provider runtime homes are env-configurable so they can be relocated
// out of the control CONFIG_DIR to a runner-owned subtree (e.g.
// /var/lib/agentoc-run/provider-homes).  The default stays under config for
// dev and pre-migration production; agentoc.env flips it in a migration step
// together with the spool root, after which the runner group's config traverse
// ACL can be removed.
const PROVIDER_HOMES_DIR = WINDOWS_PATHS?.providerHomesDir
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_PROVIDER_HOMES_DIR)
  || join(configDir, 'provider-runtime-homes');
export const CODEX_MANAGED_HOME_DIR = join(PROVIDER_HOMES_DIR, 'codex');
export const CLAUDE_MANAGED_HOME_DIR = join(PROVIDER_HOMES_DIR, 'claude');
export const AGY_MANAGED_HOME_DIR = join(PROVIDER_HOMES_DIR, 'agy');
// Control-side (chat-server) one-shot Codex invocations — session-label
// suggestions, merged suggestions, detached assistant calls — run as the
// control user, NOT agentoc-runner.  When AGENTOC_PROVIDER_HOMES_DIR points
// at the runner-owned subtree (/var/lib/agentoc-run/provider-homes), sharing
// CODEX_MANAGED_HOME_DIR hands the control user a home whose state database
// and runtime files are runner-owned 0640: codex needs O_RDWR on
// state/installation files and fails with EACCES before the first turn.
// Keep this home under CONFIG_DIR, which transient Run units mask; do not put
// it beside runner-owned homes even though the control user may be in the
// shared agentoc-runners group.
export const CODEX_CONTROL_HOME_DIR = join(configDir, 'provider-runtime-homes', 'codex-control');
// AgY's official login is owned by the control plane, while ordinary Runs
// receive their own runtime HOME under AGENTOC_PROVIDER_HOMES_DIR.  Keeping a
// control-side sibling avoids making the chat service depend on runner-owned
// permissions after provider-home relocation.
export const AGY_CONTROL_HOME_DIR = join(configDir, 'provider-runtime-homes', 'agy-control');

const rawFileAssetStorageBaseUrl = normalizeBaseUrl(process.env.AGENTOC_ASSET_STORAGE_BASE_URL);
const rawFileAssetPublicBaseUrl = normalizeBaseUrl(process.env.AGENTOC_ASSET_STORAGE_PUBLIC_BASE_URL);
export const FILE_ASSET_STORAGE_PROVIDER = normalizeFileAssetStorageProvider(
  process.env.AGENTOC_ASSET_STORAGE_PROVIDER,
  [rawFileAssetStorageBaseUrl, rawFileAssetPublicBaseUrl],
);
export const FILE_ASSET_STORAGE_BASE_URL = normalizeFileAssetStorageUrl(rawFileAssetStorageBaseUrl, FILE_ASSET_STORAGE_PROVIDER);
export const FILE_ASSET_PUBLIC_BASE_URL = normalizeFileAssetStorageUrl(rawFileAssetPublicBaseUrl, FILE_ASSET_STORAGE_PROVIDER);
export const FILE_ASSET_STORAGE_REGION = trimString(process.env.AGENTOC_ASSET_STORAGE_REGION) || 'auto';
export const FILE_ASSET_STORAGE_ACCESS_KEY_ID = trimString(process.env.AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID);
export const FILE_ASSET_STORAGE_SECRET_ACCESS_KEY = trimString(process.env.AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY);
export const FILE_ASSET_STORAGE_KEY_PREFIX = (trimString(process.env.AGENTOC_ASSET_STORAGE_KEY_PREFIX) || 'session-assets')
  .replace(/^\/+/, '')
  .replace(/\/+$/, '');
export const FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS = validInt(
  process.env.AGENTOC_ASSET_STORAGE_PRESIGN_TTL_SECONDS,
  60,
  7 * 24 * 60 * 60,
  60 * 60,
);
export const FILE_ASSET_STORAGE_ENABLED = !!(
  FILE_ASSET_STORAGE_BASE_URL
  && FILE_ASSET_STORAGE_ACCESS_KEY_ID
  && FILE_ASSET_STORAGE_SECRET_ACCESS_KEY
  && FILE_ASSET_STORAGE_REGION
);
export const FILE_ASSET_DIRECT_UPLOAD_ENABLED = FILE_ASSET_STORAGE_ENABLED
  && envFlagEnabled(process.env.AGENTOC_ASSET_DIRECT_UPLOAD_ENABLED, true);
export const FILE_ASSET_ALLOWED_ORIGINS = [...new Set([
  extractOrigin(FILE_ASSET_STORAGE_BASE_URL),
  extractOrigin(FILE_ASSET_PUBLIC_BASE_URL),
].filter(Boolean))];

// AgentoC memory directories (model-managed persistent storage)
// User-level: private to this machine (preferences, local paths, personal habits)
export const MEMORY_DIR = WINDOWS_PATHS?.memoryDir
  || resolveInstanceScopedOverridePath(process.env.AGENTOC_MEMORY_DIR)
  || (INSTANCE_ROOT ? join(INSTANCE_ROOT, 'memory') : join(homedir(), '.agentoc', 'memory'));
// System-level: universal learnings stored in the code repo (shared across deployments)
export const SYSTEM_MEMORY_DIR = join(SOURCE_PROJECT_ROOT, 'memory');
// Standalone project-memory modules imported from backup/main. Runtime hooks
// remain disabled/unwired until their integration gate is verified.
export const PROJECT_MEMORY_DIR = join(MEMORY_DIR, 'projects');
export const PROJECT_MEMORY_DB = join(CONFIG_DIR, 'project-memory.sqlite');
