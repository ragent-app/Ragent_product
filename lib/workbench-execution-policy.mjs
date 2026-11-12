// Optional operator-owned ceiling for a dedicated workbench. This is not an
// account entitlement: it constrains AgentoC-managed execution on this machine.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function denied(message = 'This workbench only permits its configured Codex model') {
  return Object.assign(new Error(message), { code: 'WORKBENCH_EXECUTION_POLICY_DENIED', statusCode: 403 });
}

export function loadWorkbenchExecutionPolicy(file) {
  if (!file) return null;
  try {
    if (!isAbsolute(file)) throw new Error();
    const raw = readFileSync(file);
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(raw.toString('utf8'));
    const keys = ['schemaVersion', 'agentType', 'authType', 'model', 'providerProfileId', 'allowProviderSetup', 'codexPermissionProfile'];
    if (!value || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))
        || value.schemaVersion !== 1 || value.agentType !== 'codex' || value.authType !== 'oauth'
        || typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.model)
        || (value.providerProfileId !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(value.providerProfileId))
        || (value.allowProviderSetup !== undefined && typeof value.allowProviderSetup !== 'boolean')
        || (value.codexPermissionProfile !== undefined && (typeof value.codexPermissionProfile !== 'string'
          || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.codexPermissionProfile)))) throw new Error();
    return Object.freeze({ ...value, allowProviderSetup: value.allowProviderSetup === true });
  } catch {
    throw Object.assign(new Error('Workbench execution policy is unavailable or invalid'), {
      code: 'WORKBENCH_EXECUTION_POLICY_INVALID',
    });
  }
}

// Read once, fail closed when configured, restart for an operator policy change.
export const WORKBENCH_EXECUTION_POLICY = loadWorkbenchExecutionPolicy(process.env.AGENTOC_WORKBENCH_EXECUTION_POLICY_FILE);

// The broker needs AgentoC policy/lock state; the native model process does not.
// Keep the dedicated OAuth workbench's control environment out of its tool
// children. Credentials are read by Codex from its prepared, machine-local home.
const WORKBENCH_CODEX_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME', 'LC_NUMERIC', 'LC_MONETARY', 'LC_COLLATE',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
]);

export function buildWorkbenchCodexEnvironment(environment, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return environment;
  return Object.fromEntries(Object.entries(environment || {}).filter(([key, value]) => {
    const normalized = key.toUpperCase();
    return value !== undefined && value !== null
      && WORKBENCH_CODEX_ENV_KEYS.has(normalized);
  }));
}

export function policyModelId(model) {
  const raw = String(model || '').trim();
  return raw.replace(/@[A-Za-z0-9._-]+$/, '');
}

export function workbenchToolAllowed(tool, policy = WORKBENCH_EXECUTION_POLICY) {
  return !policy || (policy.codexPermissionProfile
    ? ['codex', 'agentoc-codex-app-server']
    : ['codex', 'codex-cli', 'agentoc-codex-app-server']).includes(String(tool || '').trim());
}

export function assertWorkbenchExecution({ agentType, model, authType, providerProfileId } = {}, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return;
  if ((agentType !== undefined && !workbenchToolAllowed(agentType, policy))
      || (model !== undefined && policyModelId(model) !== policy.model)
      || (authType !== undefined && authType !== policy.authType)
      || (providerProfileId !== undefined && policy.providerProfileId && providerProfileId !== policy.providerProfileId)) throw denied();
}

export function assertWorkbenchProviderSetup({ agentType, authType } = {}, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return;
  assertWorkbenchExecution({ agentType, authType }, policy);
  if (!policy.allowProviderSetup) throw denied('Provider management is locked by the workbench operator');
}

export function applyWorkbenchRunPolicy(manifest, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return manifest;
  assertWorkbenchExecution({ agentType: manifest?.tool || '',
    model: manifest?.options?.model || policy.model }, policy);
  const { approvedActionChannel, windowsBrokerChannel, browserChannel, ...options } = manifest?.options || {};
  return { ...manifest, options: { ...options,
    model: manifest?.options?.model || policy.model,
    riskMode: 'safe', permissionMode: policy.codexPermissionProfile ? 'never-read-only' : 'untrusted-read-only', privilegedMode: false } };
}

export function filterWorkbenchModels(catalog, tool, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return catalog;
  const models = workbenchToolAllowed(tool, policy)
    ? (catalog?.models || []).filter((entry) => policyModelId(entry.id || entry.model) === policy.model
      && (!policy.providerProfileId || !entry.providerProfileId || entry.providerProfileId === policy.providerProfileId)) : [];
  return { ...catalog, models, defaultModel: models.find((entry) => entry.id === catalog.defaultModel)?.id || models[0]?.id || null };
}

export function constrainCodexBrokerRequest(message, policy = WORKBENCH_EXECUTION_POLICY) {
  if (!policy) return message;
  const params = message?.params;
  if (params?.model !== undefined) assertWorkbenchExecution({ model: params.model }, policy);
  if (params?.config?.model !== undefined) assertWorkbenchExecution({ model: params.config.model }, policy);
  if (params?.collaborationMode?.settings?.model !== undefined) assertWorkbenchExecution({ model: params.collaborationMode.settings.model }, policy);
  if (params?.modelProvider && params.modelProvider !== 'openai') throw denied();
  if (params?.config) {
    const allowed = new Set(['mode', 'model', 'allow_login_shell', 'projects']);
    if (Object.keys(params.config).some((key) => !allowed.has(key))
        || (params.config.allow_login_shell !== undefined && params.config.allow_login_shell !== false)) throw denied();
    if (params.config.projects !== undefined) {
      const projects = params.config.projects;
      if (!projects || typeof projects !== 'object' || Array.isArray(projects)
          || Object.entries(projects).some(([root, value]) => root !== params.cwd || !value
            || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => key !== 'trust_level') || value.trust_level !== 'untrusted')) throw denied();
    }
  }
  // Legacy per-request sandbox selectors replace native permission profiles.
  // The operator's requirements.toml supplies this profile and its complete
  // allowlist. Clients cannot select a built-in or weaken it through these RPCs.
  let boundedParams = params;
  if (policy.codexPermissionProfile && params && typeof params === 'object') {
    boundedParams = { ...params };
    for (const key of ['sandbox', 'sandboxPolicy', 'permissionProfile']) delete boundedParams[key];
  }
  if (['thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(message?.method)) {
    const boundary = policy.codexPermissionProfile ? {} : message.method === 'turn/start'
      ? { sandboxPolicy: { type: 'readOnly', networkAccess: false } }
      : { sandbox: 'read-only' };
    return { ...message, params: { ...boundedParams, ...boundary, model: policy.model,
      approvalPolicy: policy.codexPermissionProfile ? 'never' : 'untrusted' } };
  }
  return boundedParams === params ? message : { ...message, params: boundedParams };
}
