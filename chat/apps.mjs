import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { resolveDefaultStarterToolId } from './starter-session-content.mjs';
import { normalizeCollaborationPolicy, normalizeExplicitAgentCapabilities } from './collaboration-policy.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';

export const DEFAULT_APP_ID = 'chat';
export const EMAIL_APP_ID = 'email';
export const BUILTIN_APPS = Object.freeze([
  Object.freeze({
    id: DEFAULT_APP_ID,
    name: 'Chat',
    builtin: true,
    templateSelectable: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: EMAIL_APP_ID,
    name: 'Email',
    builtin: true,
    templateSelectable: false,
    showInSidebarWhenEmpty: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? JSON.parse(JSON.stringify(app)) : null;
}

function normalizeAppCollaborationPolicy(value) {
  const policy = normalizeCollaborationPolicy(value);
  return policy ? JSON.parse(JSON.stringify(policy)) : null;
}

async function resolveDefaultAppToolId() {
  return resolveDefaultStarterToolId();
}

async function materializeApp(app, { defaultToolId = '' } = {}) {
  const cloned = cloneApp(app);
  if (!cloned) return null;
  if (!cloned.tool) {
    cloned.tool = defaultToolId || await resolveDefaultAppToolId();
  }
  const policy = normalizeAppCollaborationPolicy(cloned.collaborationPolicy);
  if (policy) cloned.collaborationPolicy = policy;
  else delete cloned.collaborationPolicy;
  return cloned;
}

function normalizeTemplateContext(templateContext) {
  const content = typeof templateContext?.content === 'string'
    ? templateContext.content.trim()
    : '';
  if (!content) return null;
  return {
    content,
    sourceSessionId: typeof templateContext?.sourceSessionId === 'string'
      ? templateContext.sourceSessionId.trim()
      : '',
    sourceSessionName: typeof templateContext?.sourceSessionName === 'string'
      ? templateContext.sourceSessionName.trim()
      : '',
    sourceSessionUpdatedAt: typeof templateContext?.sourceSessionUpdatedAt === 'string'
      ? templateContext.sourceSessionUpdatedAt.trim()
      : '',
    updatedAt: typeof templateContext?.updatedAt === 'string' && templateContext.updatedAt.trim()
      ? templateContext.updatedAt.trim()
      : new Date().toISOString(),
  };
}

export function normalizeAppId(appId, { fallbackDefault = false } = {}) {
  const trimmed = typeof appId === 'string' ? appId.trim() : '';
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : '';
  }

  const builtinId = trimmed.toLowerCase();
  if (BUILTIN_APP_MAP.has(builtinId)) {
    return builtinId;
  }

  return trimmed;
}

export function resolveEffectiveAppId(appId) {
  return normalizeAppId(appId, { fallbackDefault: true });
}

export function isBuiltinAppId(appId) {
  const normalized = normalizeAppId(appId);
  return normalized ? BUILTIN_APP_MAP.has(normalized) : false;
}

export function getBuiltinApp(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return null;
  return cloneApp(BUILTIN_APP_MAP.get(normalized));
}

function mergeApps(list) {
  const merged = new Map(BUILTIN_APPS.map((app) => [app.id, cloneApp(app)]));
  for (const app of list) {
    if (!app || app.deleted || !app.id || merged.has(app.id)) continue;
    merged.set(app.id, cloneApp(app));
  }
  return [...merged.values()];
}

async function loadApps() {
  const apps = await readJson(APPS_FILE, []);
  return Array.isArray(apps) ? apps : [];
}

async function saveApps(list, { assertAuthorization } = {}) {
  const dir = dirname(APPS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(APPS_FILE, list, { beforeReplace: assertAuthorization });
}

export async function listApps() {
  const defaultToolId = await resolveDefaultAppToolId();
  return Promise.all(mergeApps(await loadApps()).map((app) => materializeApp(app, { defaultToolId })));
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return materializeApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.id === id);
  if (existing) return existing.deleted ? null : existing;
  return null;
}

// Per-locale message prompt catalog, e.g.
// { "zh-CN": "…", "en": "…", "auto": "…" }. Empty/malformed input → null.
export function normalizePerMessageSystemPrompt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  let hasAny = false;
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    normalized[key] = trimmed;
    hasAny = true;
  }
  return hasAny ? normalized : null;
}

export async function createApp(input = {}, { assertAuthorization = () => {} } = {}) {
  const {
    name,
    systemPrompt,
    welcomeMessage,
    skills,
    tool,
    templateContext,
    perMessageSystemPrompt,
    collaborationPolicy,
    capabilities,
  } = input;
  const explicitCapabilities = capabilities === undefined ? null : normalizeExplicitAgentCapabilities(capabilities);
  const policyCapabilities = collaborationPolicy && Object.hasOwn(collaborationPolicy, 'allowedCapabilities')
    ? normalizeExplicitAgentCapabilities(collaborationPolicy.allowedCapabilities) : null;
  if (explicitCapabilities && policyCapabilities && JSON.stringify(explicitCapabilities) !== JSON.stringify(policyCapabilities)) throw new Error('Agent capability declarations conflict');
  if (policyCapabilities && !normalizeAppCollaborationPolicy(collaborationPolicy)) throw new Error('Agent collaboration policy is invalid');
  return runAppsMutation(async () => {
    const id = `app_${randomBytes(16).toString('hex')}`;
    const resolvedTool = typeof tool === 'string' && tool.trim()
      ? tool.trim()
      : await resolveDefaultAppToolId();
    const app = {
      id,
      name: name || 'Untitled Agent',
      systemPrompt: systemPrompt || '',
      welcomeMessage: welcomeMessage || '',
      skills: skills || [],
      tool: resolvedTool,
      createdAt: new Date().toISOString(),
    };
    if (explicitCapabilities || policyCapabilities) app.capabilities = explicitCapabilities || policyCapabilities;
    const normalizedPerMessagePrompt = normalizePerMessageSystemPrompt(perMessageSystemPrompt);
    if (normalizedPerMessagePrompt) {
      app.perMessageSystemPrompt = normalizedPerMessagePrompt;
    }
    const normalizedTemplateContext = normalizeTemplateContext(templateContext);
    if (normalizedTemplateContext) {
      app.templateContext = normalizedTemplateContext;
    }
    const normalizedCollaborationPolicy = normalizeAppCollaborationPolicy(collaborationPolicy);
    if (normalizedCollaborationPolicy) app.collaborationPolicy = normalizedCollaborationPolicy;
    const apps = await loadApps();
    apps.push(app);
    assertAuthorization();
    await saveApps(apps, { assertAuthorization });
    return app;
  });
}

export async function updateApp(id, updates) {
  if (isBuiltinAppId(id)) return null;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return null;
    const explicitCapabilities = updates.capabilities === undefined ? null : normalizeExplicitAgentCapabilities(updates.capabilities);
    const policyCapabilities = updates.collaborationPolicy && Object.hasOwn(updates.collaborationPolicy, 'allowedCapabilities')
      ? normalizeExplicitAgentCapabilities(updates.collaborationPolicy.allowedCapabilities) : null;
    if (explicitCapabilities && policyCapabilities && JSON.stringify(explicitCapabilities) !== JSON.stringify(policyCapabilities)) throw new Error('Agent capability declarations conflict');
    if (policyCapabilities && !normalizeAppCollaborationPolicy(updates.collaborationPolicy)) throw new Error('Agent collaboration policy is invalid');
    const selectedCapabilities = explicitCapabilities || policyCapabilities;
    const allowed = ['name', 'systemPrompt', 'welcomeMessage', 'skills', 'tool', 'perMessageSystemPrompt', 'collaborationPolicy'];
    for (const key of allowed) {
      if (updates[key] === undefined) continue;
      if (key === 'perMessageSystemPrompt') {
        const normalized = normalizePerMessageSystemPrompt(updates[key]);
        if (normalized) {
          apps[idx][key] = normalized;
        } else {
          delete apps[idx][key];
        }
        continue;
      }
      if (key === 'collaborationPolicy') {
        const normalized = normalizeAppCollaborationPolicy(updates[key]);
        if (normalized) apps[idx][key] = normalized;
        else delete apps[idx][key];
        continue;
      }
      apps[idx][key] = updates[key];
    }
    if (selectedCapabilities) {
      apps[idx].capabilities = selectedCapabilities;
      if (apps[idx].collaborationPolicy) apps[idx].collaborationPolicy.allowedCapabilities = selectedCapabilities;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'templateContext')) {
      const templateContext = normalizeTemplateContext(updates.templateContext);
      if (templateContext) {
        apps[idx].templateContext = templateContext;
      } else {
        delete apps[idx].templateContext;
      }
    }
    apps[idx].updatedAt = new Date().toISOString();
    await saveApps(apps);
    return apps[idx];
  });
}

export async function deleteApp(id) {
  if (isBuiltinAppId(id)) return false;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return false;
    apps[idx].deleted = true;
    apps[idx].deletedAt = new Date().toISOString();
    await saveApps(apps);
    return true;
  });
}

// Account sync uses the raw custom Agent template, not the materialized view
// returned to the UI. Built-in starter apps never leave this machine.
export async function listAgentSyncProfiles() {
  const apps = await loadApps();
  return apps
    .filter((app) => app && typeof app.id === 'string' && app.id.trim() && !isBuiltinAppId(app.id))
    .map((app) => cloneApp(app));
}

function normalizeAgentSyncProfile(profile) {
  const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
  if (!id || id.length > 256 || isBuiltinAppId(id)) return null;
  const normalized = {
    id,
    name: typeof profile.name === 'string' ? profile.name : 'Untitled Agent',
    systemPrompt: typeof profile.systemPrompt === 'string' ? profile.systemPrompt : '',
    welcomeMessage: typeof profile.welcomeMessage === 'string' ? profile.welcomeMessage : '',
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    tool: typeof profile.tool === 'string' ? profile.tool : '',
    createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : '',
    updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : '',
  };
  if (profile.capabilities !== undefined) {
    try { normalized.capabilities = normalizeExplicitAgentCapabilities(profile.capabilities); } catch { return null; }
  }
  if (profile.collaborationPolicy && Object.hasOwn(profile.collaborationPolicy, 'allowedCapabilities')) {
    try {
      const caps = normalizeExplicitAgentCapabilities(profile.collaborationPolicy.allowedCapabilities);
      if (normalized.capabilities && JSON.stringify(caps) !== JSON.stringify(normalized.capabilities)) return null;
    } catch { return null; }
  }
  const perMessageSystemPrompt = normalizePerMessageSystemPrompt(profile.perMessageSystemPrompt);
  if (perMessageSystemPrompt) normalized.perMessageSystemPrompt = perMessageSystemPrompt;
  const templateContext = normalizeTemplateContext(profile.templateContext);
  if (templateContext) normalized.templateContext = templateContext;
  const collaborationPolicy = normalizeAppCollaborationPolicy(profile.collaborationPolicy);
  if (collaborationPolicy) normalized.collaborationPolicy = collaborationPolicy;
  return normalized;
}

export async function applyAgentSyncProfile(profile) {
  return runAppsMutation(async () => {
    const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
    if (!id || isBuiltinAppId(id)) return { ok: false, reason: 'invalid-agent' };
    const apps = await loadApps();
    const index = apps.findIndex((app) => app?.id === id);
    if (profile?.deletedAt || profile?.deleted) {
      const existing = index >= 0 ? apps[index] : { id, createdAt: new Date().toISOString() };
      apps[index >= 0 ? index : apps.length] = {
        ...existing,
        id,
        deleted: true,
        deletedAt: typeof profile.deletedAt === 'string' ? profile.deletedAt : new Date().toISOString(),
      };
      await saveApps(apps);
      return { ok: true, deleted: true };
    }
    const normalized = normalizeAgentSyncProfile(profile);
    if (!normalized) return { ok: false, reason: 'invalid-agent' };
    const existing = index >= 0 ? apps[index] : null;
    const next = {
      ...normalized,
      createdAt: existing?.createdAt || normalized.createdAt || new Date().toISOString(),
      updatedAt: normalized.updatedAt || new Date().toISOString(),
    };
    if (index >= 0) apps[index] = next;
    else apps.push(next);
    await saveApps(apps);
    return { ok: true, agent: cloneApp(next) };
  });
}

export const listAgents = listApps;
export const getAgent = getApp;
export const createAgent = createApp;
export const updateAgent = updateApp;
export const deleteAgent = deleteApp;
