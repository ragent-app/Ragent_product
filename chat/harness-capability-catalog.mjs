import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CLAUDE_MANAGED_HOME_DIR,
  CODEX_MANAGED_HOME_DIR,
  CODEX_CONTROL_HOME_DIR,
  CONFIG_DIR,
  PLATFORM_SKILLS_DIR,
} from '../lib/config.mjs';
import { listCodexAppServerCapabilities } from './codex-app-server-client.mjs';
import { listClaudeMcpServers } from '../lib/claude-mcp-manager.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { nativeOAuthAccountId, resolveDefaultProviderProfileId, resolveNativeSelectionFromManifest } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { codexSkillId, listCodexSkillPreferences } from '../lib/provider-runtime/codex-skill-preferences.mjs';
import { recordCodexCapabilitySyncResult } from './codex-capability-sync.mjs';

const MAX_SKILL_FILES = 500;
const MAX_SKILL_DESCRIPTION = 400;
const MAX_SELECTED_CAPABILITIES = 8;
const MAX_SELECTED_INSTRUCTION_CHARS = 48_000;

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseFrontmatter(markdown) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(markdown || ''));
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[field[1]] = value;
  }
  return fields;
}

async function collectMarkdownFiles(root, leafName, { maxDepth = 5 } = {}) {
  const absoluteRoot = resolve(root);
  const files = [];
  const visit = async (directory, depth) => {
    if (files.length >= MAX_SKILL_FILES || depth > maxDepth) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return; throw error; }
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile() && (leafName === 'SKILL.md' ? entry.name === leafName : entry.name.endsWith('.md'))) {
        files.push(absolute);
      }
    }
  };
  await visit(absoluteRoot, 0);
  return files;
}

function opaqueFileId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

function nativeProfileFamily(tool) {
  if (['codex', 'codex-cli', 'agentoc-codex-app-server'].includes(tool)) return 'codex';
  if (['claude', 'claude-bidi'].includes(tool)) return 'claude';
  return '';
}

async function resolveNativeProfileHome(providerProfileId, tool) {
  const family = nativeProfileFamily(tool);
  if (!family) return '';
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const profile = await registry.getProviderProfile(providerProfileId);
  if (!profile || profile.agentType !== family) {
    throw capabilityResolutionError('The selected provider profile is not available for this harness.');
  }
  const homeRoot = family === 'codex' ? CODEX_MANAGED_HOME_DIR : CLAUDE_MANAGED_HOME_DIR;
  return nativeProviderHomeRoot(dirname(homeRoot), profile.agentType, profile.id);
}

async function readJsonFile(pathname) {
  try {
    const value = JSON.parse(await readFile(pathname, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function normalizeCapability({ id, kind, source, title, description = '', invocationText = '', enabled = true, reason = '', state = null }) {
  const safeTitle = text(title, 120);
  if (!safeTitle || !text(id, 500)) return null;
  const safeInvocationText = typeof invocationText === 'string'
    ? invocationText.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
    : '';
  return {
    id: text(id, 500),
    kind,
    source,
    title: safeTitle,
    description: text(description, MAX_SKILL_DESCRIPTION),
    invocationText: safeInvocationText,
    enabled: enabled === true,
    ...(state ? { state } : {}),
    ...(reason ? { disabledReason: text(reason, 240) } : {}),
  };
}

async function listMarkdownCapabilities({ root, source, namespace, type, invocationPrefix }) {
  const skillMode = type === 'skill';
  const files = await collectMarkdownFiles(root, skillMode ? 'SKILL.md' : 'commands.md');
  const result = [];
  for (const pathname of files) {
    const markdown = await readFile(pathname, 'utf8').catch(() => '');
    if (!markdown) continue;
    const fields = parseFrontmatter(markdown);
    const rel = relative(resolve(root), pathname).split(sep).join('/');
    const name = text(fields.name) || (skillMode
      ? rel.split('/').at(-2)
      : rel.replace(/\.md$/i, '').replace(/\/index$/i, ''));
    if (!name || /[\r\n]/.test(name)) continue;
    const description = text(fields.description || fields['short-description'] || fields['short_description'], MAX_SKILL_DESCRIPTION);
    const commandName = `${namespace ? `${namespace}:` : ''}${name}`;
    const disabled = /^(true|yes|1)$/i.test(text(fields['disable-model-invocation'] || fields.disable_model_invocation));
    result.push(normalizeCapability({
      id: `${source}:${type}:${opaqueFileId(rel)}`,
      kind: type,
      source,
      title: commandName,
      description,
      invocationText: disabled ? '' : `${invocationPrefix}${commandName} `,
      enabled: !disabled,
      reason: disabled ? 'This item is not available for direct invocation.' : '',
    }));
  }
  return result.filter(Boolean);
}

async function listClaudeProjectMcpCapabilities(cwd) {
  const config = await readJsonFile(join(cwd, '.mcp.json'));
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return normalizeMcpNames(Object.keys(servers).map((name) => ({ name })), { source: 'claude-project' });
}

async function listClaudePluginCapabilities({ cwd, configDir }) {
  const pluginRoot = join(configDir, 'plugins');
  const installed = await readJsonFile(join(pluginRoot, 'installed_plugins.json'));
  const pluginRecords = installed?.plugins && typeof installed.plugins === 'object'
    ? installed.plugins
    : {};
  const [userSettings, projectSettings, localSettings] = await Promise.all([
    readJsonFile(join(configDir, 'settings.json')),
    readJsonFile(join(cwd, '.claude', 'settings.json')),
    readJsonFile(join(cwd, '.claude', 'settings.local.json')),
  ]);
  const enabledPlugins = {
    ...(userSettings?.enabledPlugins || {}),
    ...(projectSettings?.enabledPlugins || {}),
    ...(localSettings?.enabledPlugins || {}),
  };
  const items = [];
  for (const [pluginId, rawRecords] of Object.entries(pluginRecords)) {
    if (enabledPlugins[pluginId] !== true) continue;
    const records = Array.isArray(rawRecords) ? rawRecords : [rawRecords];
    const record = [...records].reverse().find((entry) => entry && typeof entry.installPath === 'string');
    if (!record) continue;
    const root = resolve(record.installPath);
    const manifest = await readJsonFile(join(root, '.claude-plugin', 'plugin.json'));
    const pluginName = text(manifest?.name || pluginId.split('@')[0], 120);
    if (!pluginName) continue;
    for (const type of ['skill', 'command']) {
      items.push(...await listMarkdownCapabilities({
        root: join(root, type === 'skill' ? 'skills' : 'commands'),
        source: 'claude-plugin',
        namespace: pluginName,
        type,
        invocationPrefix: '/',
      }));
    }
    const pluginMcp = await readJsonFile(join(root, '.mcp.json'));
    const pluginServers = pluginMcp?.mcpServers;
    if (pluginServers && typeof pluginServers === 'object' && !Array.isArray(pluginServers)) {
      items.push(...normalizeMcpNames(Object.keys(pluginServers).map((name) => ({ name })), {
        source: 'claude-plugin',
      }));
    }
    items.push(normalizeCapability({
      id: `claude:plugin:${opaqueFileId(pluginId)}`,
      kind: 'plugin',
      source: 'claude',
      title: pluginName,
      description: manifest?.description || '',
      enabled: true,
    }));
  }
  return items.filter(Boolean);
}

async function listPlatformSkillCapabilities(root) {
  const files = await collectMarkdownFiles(root, '*.md', { maxDepth: 1 });
  const items = [];
  for (const pathname of files) {
    const markdown = await readFile(pathname, 'utf8').catch(() => '');
    if (!markdown) continue;
    const rel = relative(resolve(root), pathname).split(sep).join('/');
    const fields = parseFrontmatter(markdown);
    const stem = rel.replace(/\.md$/i, '');
    const heading = /^#\s+(.+)$/m.exec(markdown)?.[1];
    const title = text(fields.name || heading || stem, 120);
    const body = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/m, '').replace(/^#\s+.+(?:\r?\n|$)/, '');
    const description = text(fields.description || body.split(/\r?\n/).find((line) => line.trim()) || '', MAX_SKILL_DESCRIPTION);
    const command = text(fields.name || stem, 120);
    if (!command || !title) continue;
    items.push(normalizeCapability({
      id: `agentoc:skill:${opaqueFileId(rel)}`,
      kind: 'skill',
      source: 'agentoc',
      title: command,
      description,
      invocationText: '',
      enabled: true,
    }));
  }
  return items.filter(Boolean);
}

function flattenCodexSkills(result) {
  const entries = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
  return entries.flatMap((entry) => (Array.isArray(entry?.skills) ? entry.skills : []));
}

function flattenCodexPlugins(result) {
  const marketplaces = Array.isArray(result?.marketplaces) ? result.marketplaces : [];
  return marketplaces.flatMap((marketplace) => {
    const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
    return plugins.map((plugin) => ({ ...plugin, marketplaceName: marketplace?.name || '' }));
  });
}

function flattenCodexMcpServers(result) {
  if (Array.isArray(result?.servers)) return result.servers;
  if (Array.isArray(result?.data)) return result.data;
  if (result?.servers && typeof result.servers === 'object') {
    return Object.entries(result.servers).map(([name, server]) => ({ name, ...server }));
  }
  return [];
}

function codexCapabilityItems(catalog) {
  const items = [];
  if (catalog?.skills?.ok) {
    for (const skill of flattenCodexSkills(catalog.skills.data)) {
      const name = text(skill?.name, 120);
      if (!name) continue;
      const enabled = skill?.enabled !== false;
      items.push(normalizeCapability({
        id: `codex:skill:${opaqueFileId(text(skill?.path, 2000) || name)}`,
        kind: 'skill',
        source: skill?.path?.startsWith?.('plugin://') ? 'plugin' : 'codex',
        title: name,
        description: skill?.interface?.shortDescription || skill?.shortDescription || skill?.description || '',
        invocationText: enabled ? `$${name} ` : '',
        enabled,
        reason: enabled ? '' : text(skill?.disabledReason || 'Skill is disabled.'),
        state: { manageable: typeof skill?.path === 'string' && isAbsolute(skill.path) },
      }));
    }
  }
  if (catalog?.plugins?.ok) {
    for (const plugin of flattenCodexPlugins(catalog.plugins.data)) {
      const name = text(plugin?.name || plugin?.id, 120);
      if (!name) continue;
      const enabled = plugin?.enabled === true;
      items.push(normalizeCapability({
        id: `codex:plugin:${text(plugin?.id || `${plugin?.marketplaceName}:${name}`, 240)}`,
        kind: 'plugin',
        source: 'codex',
        title: name,
        description: plugin?.summary?.description || plugin?.description || '',
        invocationText: '',
        enabled,
        reason: enabled ? '' : 'Enable this plugin in Codex before using it.',
      }));
    }
  }
  if (catalog?.mcp?.ok) {
    for (const server of flattenCodexMcpServers(catalog.mcp.data)) {
      const name = text(server?.name || server?.serverName || server?.id, 120);
      if (!name) continue;
      const source = name.toLowerCase() === 'agentoc' ? 'agentoc' : 'codex';
      const status = text(server?.status || server?.startupStatus, 40).toLowerCase();
      const authStatus = text(server?.authStatus, 40);
      const authorization = authStatus === 'oAuth' ? 'connected'
        : authStatus === 'notLoggedIn' ? 'authorization_required'
          : authStatus === 'bearerToken' ? 'credential_configured'
            : authStatus === 'unsupported' ? 'unsupported' : 'unknown';
      // `enabled` controls whether the user may request this capability; an
      // absent startup status is not proof that a configured server failed.
      // Runtime readiness remains explicitly unknown in the state projection.
      const enabled = !['failed', 'cancelled', 'disabled'].includes(status);
      items.push(normalizeCapability({
        id: `${source}:mcp:${source === 'agentoc' ? opaqueFileId(name) : name}`,
        kind: 'mcp',
        source,
        title: name,
        description: status ? `MCP server · ${status}` : 'Codex MCP server · runtime status unknown',
        invocationText: '',
        enabled,
        reason: enabled ? '' : 'This MCP server is not available in the current runtime.',
        state: { discovery: 'discovered', runtime: status === 'ready' ? 'available' : enabled ? 'unknown' : 'unavailable', authorization, scope: 'global' },
      }));
    }
  }
  if (catalog?.apps?.ok) {
    const installed = new Map((Array.isArray(catalog?.installedApps?.data?.apps) ? catalog.installedApps.data.apps : [])
      .filter((app) => typeof app?.id === 'string').map((app) => [app.id, app]));
    for (const app of Array.isArray(catalog.apps.data?.data) ? catalog.apps.data.data : []) {
      const id = text(app?.id, 240);
      const title = text(app?.name || id, 120);
      if (!id || !title) continue;
      const runtime = installed.get(id);
      const callable = runtime?.callable === true;
      items.push(normalizeCapability({
        id: `codex:app:${id}`, kind: 'app', source: 'codex', title,
        description: app.description || 'Codex app', enabled: callable,
        reason: callable ? '' : 'App availability has not been confirmed for this runtime.',
        state: {
          discovery: 'discovered',
          accessible: typeof app.isAccessible === 'boolean' ? app.isAccessible : null,
          configuration: typeof runtime?.enabled === 'boolean' ? (runtime.enabled ? 'enabled' : 'disabled') : 'unknown',
          runtime: typeof runtime?.callable === 'boolean' ? (runtime.callable ? 'callable' : 'unavailable') : 'unknown',
          authorization: 'unknown',
          scope: 'global',
        },
      }));
    }
  }
  return items.filter(Boolean);
}

async function listClaudeCapabilities({ cwd, configDir, listMcpServers = listClaudeMcpServers }) {
  const roots = [
    { root: join(configDir, 'skills'), source: 'claude', type: 'skill', namespace: '' },
    { root: join(configDir, 'commands'), source: 'claude', type: 'command', namespace: '' },
    { root: join(cwd, '.claude', 'skills'), source: 'claude-project', type: 'skill', namespace: '' },
    { root: join(cwd, '.claude', 'commands'), source: 'claude-project', type: 'command', namespace: '' },
  ];
  const items = (await Promise.all(roots.map((root) => listMarkdownCapabilities({
    ...root,
    invocationPrefix: '/',
  })))).flat();
  const [userMcp, projectMcp, plugins] = await Promise.all([
    listMcpServers({ configDir }).catch(() => ({ ok: false, servers: [] })),
    listClaudeProjectMcpCapabilities(cwd),
    listClaudePluginCapabilities({ cwd, configDir }),
  ]);
  const errors = {};
  if (userMcp?.ok) items.push(...normalizeMcpNames(userMcp.servers, { source: 'claude' }));
  else errors.claudeMcp = 'Claude MCP catalog is unavailable.';
  items.push(...projectMcp, ...plugins);
  return { items, errors };
}

function normalizeMcpNames(servers, { source, kind = 'mcp' }) {
  return (Array.isArray(servers) ? servers : []).map((server) => {
    const name = text(server?.name, 120);
    if (!name) return null;
    const capabilitySource = kind === 'mcp' && name.toLowerCase() === 'agentoc' ? 'agentoc' : source;
    return normalizeCapability({
      id: `${capabilitySource}:${kind}:${opaqueFileId(name)}`,
      kind,
      source: capabilitySource,
      title: name,
      description: `${kind === 'plugin' ? 'Plugin' : 'MCP server'} configured for this harness.`,
      invocationText: '',
      enabled: true,
    });
  }).filter(Boolean);
}

export async function resolveCapabilitySessionProvider({ session = {}, providerProfileId = '', model = '' } = {}) {
  const tool = text(session?.tool, 64).toLowerCase();
  let selected = resolveNativeSelectionFromManifest({ tool, options: {
    providerProfile: text(providerProfileId || session?.providerProfile || session?.providerProfileId),
    model: text(model || session?.model),
  } }).providerProfileId;
  if (!selected && nativeProfileFamily(tool) === 'codex') {
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    selected = await resolveDefaultProviderProfileId('codex', { configDir: CONFIG_DIR, registry, readFileImpl: readFile }).catch(() => '');
  }
  return selected;
}

export async function listHarnessCapabilities({
  session = {},
  cwd = process.cwd(),
  providerProfileId = '',
  model = '',
  codexHomeDir = CODEX_CONTROL_HOME_DIR,
  claudeConfigDir = CLAUDE_MANAGED_HOME_DIR,
  platformSkillsDir = PLATFORM_SKILLS_DIR,
  listCodexCapabilities = listCodexAppServerCapabilities,
  refresh = false,
} = {}) {
  const tool = text(session?.tool, 64).toLowerCase();
  const root = resolve(text(cwd) || process.cwd());
  const items = [];
  const errors = {};
  const requestedProviderProfile = await resolveCapabilitySessionProvider({ session, providerProfileId, model });
  let profileHome = '';
  if (requestedProviderProfile && nativeProfileFamily(tool)) {
    try {
      profileHome = await resolveNativeProfileHome(requestedProviderProfile, tool);
    } catch {
      errors[tool.startsWith('codex') || tool === 'agentoc-codex-app-server' ? 'codex' : 'claude'] =
        'Harness provider profile is unavailable.';
    }
  }
  if (tool === 'codex' || tool === 'codex-cli' || tool === 'agentoc-codex-app-server') {
    try {
      if (!requestedProviderProfile) throw new Error('provider-profile-not-selected');
      if (requestedProviderProfile && !profileHome) throw new Error('provider-profile-unavailable');
      const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
      const profile = await registry.getProviderProfile(requestedProviderProfile);
      const auth = profile?.authProfileId ? await registry.getAuthProfile(profile.authProfileId) : null;
      const secret = auth?.storageRef ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(auth.storageRef) : null;
      if (!secret?.ok) throw new Error('provider-credential-unavailable');
      const expectedAccountId = secret.authType === 'oauth' ? nativeOAuthAccountId(secret.tokens) : '';
      if (secret.authType === 'oauth' && (!expectedAccountId || !managedCodexMcpAccountBinding(secret))) throw new Error('provider-account-unverified');
      const actualHomeRoot = secret.authType === 'oauth'
        ? await resolveCodexAccountHomeRoot({ configDir: CONFIG_DIR, providerHomeRoot: profileHome,
          providerProfileId: requestedProviderProfile, accountId: expectedAccountId })
        : profileHome;
      const selectedHome = actualHomeRoot ? join(actualHomeRoot, 'codex') : codexHomeDir;
      const catalog = await listCodexCapabilities({ codexHomeDir: selectedHome, cwd: root, refresh,
        expectedAccountId, existingBrokerOnly: secret.authType === 'oauth' });
      if (secret.authType === 'oauth') {
        await recordCodexCapabilitySyncResult(requestedProviderProfile, managedCodexMcpAccountBinding(secret), catalog,
          { configDir: CONFIG_DIR, registry }).catch(() => {});
      }
      const choices = await listCodexSkillPreferences(CONFIG_DIR, requestedProviderProfile, managedCodexMcpAccountBinding(secret));
      const desiredSkills = new Map(choices.map((choice) => [codexSkillId(choice.path), choice.enabled]));
      items.push(...codexCapabilityItems(catalog).map((item) => item.kind === 'skill' && desiredSkills.has(item.id)
        ? { ...item, state: { ...(item.state || {}), desiredConfiguration: desiredSkills.get(item.id) ? 'enabled' : 'disabled' } }
        : item));
      for (const [key, result] of Object.entries(catalog || {})) {
        if (result?.ok === false) errors[`codex.${key}`] = result.unsupported
          ? 'This capability is not supported in production.' : 'Codex capability catalog is unavailable.';
      }
    } catch { errors.codex = 'Codex capability catalog is unavailable.'; }
  } else if (tool === 'claude' || tool === 'claude-bidi') {
    try {
      if (requestedProviderProfile && !profileHome) throw new Error('provider-profile-unavailable');
      const selectedConfigDir = profileHome ? join(profileHome, 'claude') : claudeConfigDir;
      const catalog = await listClaudeCapabilities({ cwd: root, configDir: selectedConfigDir });
      items.push(...catalog.items);
      Object.assign(errors, catalog.errors);
    } catch { errors.claude = 'Claude capability catalog is unavailable.'; }
  }
  if (platformSkillsDir) {
    try {
      const managed = await listPlatformSkillCapabilities(platformSkillsDir);
      items.push(...managed);
    } catch { errors.agentoc = 'AgentoC skill catalog is unavailable.'; }
  }
  const unique = new Map();
  for (const item of items) {
    if (item && !unique.has(item.id)) unique.set(item.id, item);
  }
  return {
    tool: tool || 'unknown',
    ...(requestedProviderProfile ? { providerProfileId: requestedProviderProfile } : {}),
    ...(nativeProfileFamily(tool) === 'codex' && requestedProviderProfile
      ? { context: { scope: 'provider', runtime: 'global' } } : {}),
    items: [...unique.values()],
    errors,
  };
}

function capabilityResolutionError(message, code = 'HARNESS_CAPABILITY_STALE', statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readPlatformSkillById(root, id) {
  for (const pathname of await collectMarkdownFiles(root, '*.md', { maxDepth: 1 })) {
    const rel = relative(resolve(root), pathname).split(sep).join('/');
    if (`agentoc:skill:${opaqueFileId(rel)}` !== id) continue;
    return readFile(pathname, 'utf8');
  }
  return '';
}

/**
 * Resolve selected opaque IDs against the current session catalog. Only
 * provider-configured MCP/plugin entries and AgentoC managed skills can be
 * attached; caller-provided paths, server names, and instruction bodies are
 * never trusted.
 */
export async function resolveHarnessCapabilityInstructions({
  ids = [],
  session = {},
  cwd = process.cwd(),
  providerProfileId = '',
  model = '',
  codexHomeDir = CODEX_CONTROL_HOME_DIR,
  claudeConfigDir = CLAUDE_MANAGED_HOME_DIR,
  platformSkillsDir = PLATFORM_SKILLS_DIR,
  listCodexCapabilities = listCodexAppServerCapabilities,
} = {}) {
  if (!Array.isArray(ids) || ids.length > MAX_SELECTED_CAPABILITIES) {
    throw capabilityResolutionError('Invalid harness capability selection.', 'HARNESS_CAPABILITY_INVALID', 400);
  }
  const selectedIds = [...new Set(ids.map((id) => typeof id === 'string' ? id.trim() : ''))];
  if (selectedIds.some((id) => !id || id.length > 500)) {
    throw capabilityResolutionError('Invalid harness capability selection.', 'HARNESS_CAPABILITY_INVALID', 400);
  }
  if (selectedIds.length === 0) return '';

  const catalog = await listHarnessCapabilities({
    session,
    cwd,
    providerProfileId,
    model,
    codexHomeDir,
    claudeConfigDir,
    platformSkillsDir,
    listCodexCapabilities,
  });
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const sections = [];
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (!item || !item.enabled) {
      throw capabilityResolutionError('A selected harness capability is no longer available. Refresh the slash menu and try again.');
    }
    if (item.source === 'agentoc' && item.kind === 'skill') {
      const markdown = await readPlatformSkillById(platformSkillsDir, id);
      if (!markdown.trim()) {
        throw capabilityResolutionError('A selected AgentoC skill could not be read. Refresh the slash menu and try again.');
      }
      sections.push(`### AgentoC skill: ${item.title}\n${markdown.trim()}`);
      continue;
    }
    if (item.kind === 'mcp') {
      sections.push(`- Use the already configured ${item.source} MCP server “${item.title}” when relevant to this request. Do not claim it was used unless the harness reports a successful tool call.`);
      continue;
    }
    if (item.kind === 'plugin') {
      sections.push(`- Use the enabled ${item.source} plugin “${item.title}” when relevant to this request.`);
      continue;
    }
    if (item.kind === 'app') {
      sections.push(`- Use the available ${item.source} app “${item.title}” when relevant to this request. Do not claim it was used unless the harness reports a successful tool call.`);
      continue;
    }
    throw capabilityResolutionError('This harness capability cannot be attached to a message.', 'HARNESS_CAPABILITY_INVALID', 400);
  }

  const instructions = [
    'The user explicitly selected these capabilities for this message. Use them when relevant; the connected harness remains responsible for tool availability and approval.',
    ...sections,
  ].join('\n\n');
  if (instructions.length > MAX_SELECTED_INSTRUCTION_CHARS) {
    throw capabilityResolutionError('Selected capability instructions are too large.', 'HARNESS_CAPABILITY_INVALID', 400);
  }
  return instructions;
}
