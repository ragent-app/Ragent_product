import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AGY_CONTROL_HOME_DIR,
  AGY_MANAGED_HOME_DIR,
  CLAUDE_MANAGED_HOME_DIR,
  CODEX_MANAGED_HOME_DIR,
  CODEX_CONTROL_HOME_DIR,
  CONFIG_DIR,
  PLATFORM_SKILLS_DIR,
} from '../lib/config.mjs';
import { listCodexAppServerCapabilities } from './codex-app-server-client.mjs';
import { listClaudeMcpServers } from '../lib/claude-mcp-manager.mjs';
import { isReservedRagentMcpName, listAgyMcpServers, resolveAgyMcpHomeDir } from '../lib/agy-mcp-manager.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { nativeOAuthAccountId, resolveDefaultProviderProfileId, resolveNativeSelectionFromManifest } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { codexSkillId, listCodexSkillPreferences } from '../lib/provider-runtime/codex-skill-preferences.mjs';
import { recordCodexCapabilitySyncResult } from './codex-capability-sync.mjs';
import { listBuiltinSkills, readBuiltinSkill } from './builtin-skills.mjs';

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

function contentHashHex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function nativeProfileFamily(tool) {
  if (['codex', 'codex-cli', 'ragent-codex-app-server'].includes(tool)) return 'codex';
  if (['claude', 'claude-bidi'].includes(tool)) return 'claude';
  if (['agy', 'agy-acp', 'agy-json', 'agy-stream-json', 'agy-stream-json-bidi'].includes(tool)) return 'agy';
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
  const homeRoot = family === 'codex'
    ? CODEX_MANAGED_HOME_DIR
    : family === 'claude'
      ? CLAUDE_MANAGED_HOME_DIR
      : AGY_MANAGED_HOME_DIR;
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

async function listMarkdownCapabilities({ root, source, namespace, type, invocationPrefix, includeHash = false, provenance = '' }) {
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
    const state = includeHash || provenance
      ? {
        ...(includeHash ? { contentHash: contentHashHex(markdown) } : {}),
        ...(provenance ? { provenance } : {}),
        ...(namespace ? { plugin: namespace } : {}),
      }
      : null;
    result.push(normalizeCapability({
      id: `${source}:${type}:${opaqueFileId(rel)}`,
      kind: type,
      source,
      title: commandName,
      description,
      invocationText: disabled ? '' : `${invocationPrefix}${commandName} `,
      enabled: !disabled,
      reason: disabled ? 'This item is not available for direct invocation.' : '',
      ...(state ? { state } : {}),
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
      id: `ragent:skill:${opaqueFileId(rel)}`,
      kind: 'skill',
      source: 'ragent',
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
      const source = name.toLowerCase() === 'ragent' ? 'ragent' : 'codex';
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
        id: `${source}:mcp:${source === 'ragent' ? opaqueFileId(name) : name}`,
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

function normalizeMcpNames(servers, { source, kind = 'mcp', includeHash = false, provenance = '' }) {
  return (Array.isArray(servers) ? servers : []).map((server) => {
    const name = text(server?.name, 120);
    if (!name) return null;
    const isRagent = kind === 'mcp' && (name.toLowerCase() === 'ragent' || isReservedRagentMcpName(name));
    const capabilitySource = isRagent ? 'ragent' : source;
    const disabled = server?.disabled === true;
    const unsupported = server?.unsupported === true;
    const enabled = !disabled && !unsupported;
    const state = includeHash || provenance || server?.type
      ? {
        discovery: 'discovered',
        ...(server?.type ? { transport: text(server.type, 32) } : {}),
        ...(disabled ? { disabled: true } : {}),
        ...(provenance ? { provenance } : {}),
        ...(includeHash
          ? {
            contentHash: contentHashHex(JSON.stringify({
              name,
              type: server?.type || '',
              command: server?.command || '',
              args: Array.isArray(server?.args) ? server.args : [],
              url: server?.url || '',
              envKeys: Array.isArray(server?.envKeys) ? server.envKeys : [],
              headerKeys: Array.isArray(server?.headerKeys) ? server.headerKeys : [],
              disabled,
            })),
          }
          : {}),
      }
      : null;
    return normalizeCapability({
      id: `${capabilitySource}:${kind}:${opaqueFileId(name)}`,
      kind,
      source: capabilitySource,
      title: name,
      description: `${kind === 'plugin' ? 'Plugin' : 'MCP server'} configured for this harness.`,
      invocationText: '',
      enabled,
      reason: unsupported
        ? 'This MCP transport is unsupported by AgY.'
        : disabled
          ? 'This MCP server is disabled in configuration.'
          : '',
      ...(state ? { state } : {}),
    });
  }).filter(Boolean);
}

function isPathInsideRealRoot(realBase, realTarget) {
  return Boolean(realBase && realTarget)
    && (realTarget === realBase || realTarget.startsWith(`${realBase}${sep}`));
}

async function resolveContainedRegularPath(baseDir, candidatePath) {
  const relOrAbs = text(candidatePath, 1000);
  if (!relOrAbs) return '';
  const base = resolve(baseDir);
  const resolved = resolve(base, relOrAbs);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) return '';
  const info = await lstat(resolved).catch(() => null);
  if (!info || info.isSymbolicLink()) return '';
  let targetPath = resolved;
  if (info.isDirectory()) {
    targetPath = join(resolved, 'SKILL.md');
    const skillInfo = await lstat(targetPath).catch(() => null);
    if (!skillInfo || skillInfo.isSymbolicLink() || !skillInfo.isFile()) return '';
  } else if (!info.isFile()) {
    return '';
  }
  const [realBase, realTarget] = await Promise.all([
    realpath(base).catch(() => ''),
    realpath(targetPath).catch(() => ''),
  ]);
  if (!isPathInsideRealRoot(realBase, realTarget)) return '';
  return realTarget;
}

async function listAgyWorkspaceSkillsManifest(cwd, existingItems) {
  const manifestPath = join(resolve(cwd), '.agents', 'skills.json');
  let raw = '';
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const byTitle = new Map(existingItems.filter(Boolean).map((item) => [item.title, item]));
  const disabledNames = new Set(
    Array.isArray(parsed?.disabled)
      ? parsed.disabled.map((v) => text(v, 120)).filter(Boolean)
      : [],
  );
  for (const name of disabledNames) {
    const existing = byTitle.get(name);
    if (existing) {
      existing.enabled = false;
      existing.invocationText = '';
      existing.disabledReason = 'Disabled in .agents/skills.json.';
      existing.state = { ...(existing.state || {}), provenance: 'agy_workspace_manifest' };
    }
  }

  let entries = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (Array.isArray(parsed?.skills)) {
    entries = parsed.skills;
  } else if (parsed?.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
    entries = Object.entries(parsed.skills).map(([name, val]) => (
      val && typeof val === 'object' ? { name, ...val } : { name, enabled: val !== false }
    ));
  }

  const extra = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const name = text(entry.name || entry.id, 120);
    if (!name || /[\r\n]/.test(name)) continue;
    const entryEnabled = entry.enabled !== false && entry.disabled !== true && !disabledNames.has(name);
    const existing = byTitle.get(name);
    if (existing) {
      if (!entryEnabled) {
        existing.enabled = false;
        existing.invocationText = '';
        existing.disabledReason = text(entry.disabledReason) || 'Disabled in .agents/skills.json.';
      }
      if (!existing.description && entry.description) {
        existing.description = text(entry.description, MAX_SKILL_DESCRIPTION);
      }
      continue;
    }

    let description = text(entry.description, MAX_SKILL_DESCRIPTION);
    let contentHash = contentHashHex(JSON.stringify({ name, description, entry: entry.path || entry.skillPath || '' }));
    let disabledByFrontmatter = false;
    const candidateFile = await resolveContainedRegularPath(resolve(cwd), entry.path || entry.skillPath || '');
    if (candidateFile) {
      const markdown = await readFile(candidateFile, 'utf8').catch(() => '');
      if (markdown) {
        contentHash = contentHashHex(markdown);
        const fields = parseFrontmatter(markdown);
        if (!description) {
          description = text(fields.description || fields['short-description'] || fields['short_description'], MAX_SKILL_DESCRIPTION);
        }
        disabledByFrontmatter = /^(true|yes|1)$/i.test(text(fields['disable-model-invocation'] || fields.disable_model_invocation));
      }
    }
    const enabled = entryEnabled && !disabledByFrontmatter;
    extra.push(normalizeCapability({
      id: `agy-project:skill:${opaqueFileId(`manifest:${name}`)}`,
      kind: 'skill',
      source: 'agy-project',
      title: name,
      description,
      invocationText: enabled ? `/${name} ` : '',
      enabled,
      reason: enabled ? '' : 'Disabled in .agents/skills.json.',
      state: {
        contentHash,
        provenance: 'agy_workspace_manifest',
      },
    }));
  }
  return extra.filter(Boolean);
}

async function listAgyPluginCapabilities({ agyHomeDir }) {
  const configRoot = join(agyHomeDir, '.gemini', 'config');
  const pluginsRoot = join(configRoot, 'plugins');
  let dirEntries;
  try {
    dirEntries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }

  const [configDoc, settingsDoc] = await Promise.all([
    readJsonFile(join(configRoot, 'config.json')),
    readJsonFile(join(configRoot, 'settings.json')),
  ]);
  const disabledSet = new Set([
    ...(Array.isArray(configDoc?.disabledPlugins) ? configDoc.disabledPlugins : []),
    ...(Array.isArray(settingsDoc?.disabledPlugins) ? settingsDoc.disabledPlugins : []),
  ].map((v) => text(v, 120)).filter(Boolean));
  const enabledMap = {
    ...(configDoc?.enabledPlugins && typeof configDoc.enabledPlugins === 'object' ? configDoc.enabledPlugins : {}),
    ...(settingsDoc?.enabledPlugins && typeof settingsDoc.enabledPlugins === 'object' ? settingsDoc.enabledPlugins : {}),
  };

  const items = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pluginDir = join(pluginsRoot, entry.name);
    const manifestRaw = await readFile(join(pluginDir, 'plugin.json'), 'utf8')
      .catch(() => readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8').catch(() => ''));
    let manifest = null;
    if (manifestRaw) {
      try { manifest = JSON.parse(manifestRaw); } catch { manifest = null; }
    }
    const pluginName = text(manifest?.name || entry.name, 120);
    if (!pluginName) continue;
    const pluginEnabled = !disabledSet.has(pluginName)
      && !disabledSet.has(entry.name)
      && enabledMap[pluginName] !== false
      && enabledMap[entry.name] !== false
      && manifest?.enabled !== false;
    const pluginHash = contentHashHex(manifestRaw || entry.name);

    if (pluginEnabled) {
      items.push(...await listMarkdownCapabilities({
        root: join(pluginDir, 'skills'),
        source: 'agy-plugin',
        namespace: pluginName,
        type: 'skill',
        invocationPrefix: '/',
        includeHash: true,
        provenance: 'agy_plugin',
      }));
      items.push(...await listMarkdownCapabilities({
        root: join(pluginDir, 'commands'),
        source: 'agy-plugin',
        namespace: pluginName,
        type: 'command',
        invocationPrefix: '/',
        includeHash: true,
        provenance: 'agy_plugin',
      }));
      for (const mcpFile of ['.mcp.json', 'mcp.json', 'mcp_config.json']) {
        const mcpDoc = await readJsonFile(join(pluginDir, mcpFile));
        const mcpServers = mcpDoc?.mcpServers;
        if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
          items.push(...normalizeMcpNames(
            Object.entries(mcpServers).map(([name, cfg]) => ({
              name,
              ...(cfg && typeof cfg === 'object' ? { disabled: cfg.disabled === true, command: cfg.command, url: cfg.serverUrl || cfg.url } : {}),
            })),
            { source: 'agy-plugin', includeHash: true, provenance: 'agy_plugin' },
          ));
          break;
        }
      }
    }

    items.push(normalizeCapability({
      id: `agy:plugin:${opaqueFileId(entry.name)}`,
      kind: 'plugin',
      source: 'agy',
      title: pluginName,
      description: text(manifest?.description || manifest?.displayName || 'AgY plugin bundle', MAX_SKILL_DESCRIPTION),
      enabled: pluginEnabled,
      reason: pluginEnabled ? '' : 'This plugin is disabled in AgY configuration.',
      state: {
        contentHash: pluginHash,
        provenance: 'agy_plugin',
      },
    }));
  }
  return items.filter(Boolean);
}

export async function listAgyCapabilities({
  cwd = process.cwd(),
  agyHomeDir = AGY_CONTROL_HOME_DIR,
  listMcpServers = listAgyMcpServers,
} = {}) {
  const workspaceRoot = resolve(text(cwd) || process.cwd());
  const selectedHome = text(agyHomeDir) ? resolve(text(agyHomeDir)) : '';
  const errors = {};

  const wsSkillsDir = join(workspaceRoot, '.agents', 'skills');
  const [realWsRoot, realWsSkillsDir] = await Promise.all([
    realpath(workspaceRoot).catch(() => ''),
    realpath(wsSkillsDir).catch(() => ''),
  ]);
  const wsSkillsContained = !realWsSkillsDir || isPathInsideRealRoot(realWsRoot, realWsSkillsDir);
  const workspaceSkills = wsSkillsContained
    ? await listMarkdownCapabilities({
      root: wsSkillsDir,
      source: 'agy-project',
      namespace: '',
      type: 'skill',
      invocationPrefix: '/',
      includeHash: true,
      provenance: 'agy_workspace',
    })
    : [];
  const manifestSkills = await listAgyWorkspaceSkillsManifest(workspaceRoot, workspaceSkills);

  let homeSkills = [];
  let pluginItems = [];
  let mcpItems = [];
  if (selectedHome) {
    const [skillsRes, pluginsRes, mcpRes] = await Promise.all([
      listMarkdownCapabilities({
        root: join(selectedHome, '.gemini', 'config', 'skills'),
        source: 'agy',
        namespace: '',
        type: 'skill',
        invocationPrefix: '/',
        includeHash: true,
        provenance: 'agy_user_config',
      }),
      listAgyPluginCapabilities({ agyHomeDir: selectedHome }),
      listMcpServers({ agyHomeDir: selectedHome }).catch(() => ({ ok: false, servers: [] })),
    ]);
    homeSkills = skillsRes;
    pluginItems = pluginsRes;
    if (mcpRes?.ok) {
      mcpItems = normalizeMcpNames(mcpRes.servers, {
        source: 'agy',
        includeHash: true,
        provenance: 'agy_mcp_config',
      });
    } else {
      errors.agyMcp = 'AgY MCP catalog is unavailable.';
    }
  }

  return {
    items: [...workspaceSkills, ...manifestSkills, ...homeSkills, ...pluginItems, ...mcpItems].filter(Boolean),
    errors,
  };
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
  agyHomeDir = '',
  platformSkillsDir = PLATFORM_SKILLS_DIR,
  listCodexCapabilities = listCodexAppServerCapabilities,
  listAgyMcp = listAgyMcpServers,
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
      const familyErrorKey = nativeProfileFamily(tool) || 'claude';
      errors[familyErrorKey] = 'Harness provider profile is unavailable.';
    }
  }
  if (tool === 'codex' || tool === 'codex-cli' || tool === 'ragent-codex-app-server') {
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
  } else if (nativeProfileFamily(tool) === 'agy') {
    try {
      if (requestedProviderProfile && !profileHome) throw new Error('provider-profile-unavailable');
      const selectedAgyHome = text(agyHomeDir) || resolveAgyMcpHomeDir();
      const catalog = await listAgyCapabilities({
        cwd: root,
        agyHomeDir: selectedAgyHome,
        listMcpServers: listAgyMcp,
      });
      items.push(...catalog.items);
      Object.assign(errors, catalog.errors);
    } catch { errors.agy = 'AgY capability catalog is unavailable.'; }
  }
  // The route authorizes access to the session; selection is revalidated before use.
  const builtins = await listBuiltinSkills({ authorize: async () => true });
  items.push(...builtins.map((skill) => normalizeCapability({
    id: skill.id, kind: 'skill', source: 'ragent', title: skill.name,
    description: skill.description, enabled: true, state: { contentHash: skill.contentHash },
  })).filter(Boolean));
  if (platformSkillsDir) {
    try {
      const managed = await listPlatformSkillCapabilities(platformSkillsDir);
      items.push(...managed);
    } catch { errors.ragent = 'Ragent skill catalog is unavailable.'; }
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
    if (`ragent:skill:${opaqueFileId(rel)}` !== id) continue;
    return readFile(pathname, 'utf8');
  }
  return '';
}

/**
 * Resolve selected opaque IDs against the current session catalog. Only
 * provider-configured MCP/plugin entries and Ragent managed skills can be
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
  agyHomeDir = '',
  platformSkillsDir = PLATFORM_SKILLS_DIR,
  listCodexCapabilities = listCodexAppServerCapabilities,
  listAgyMcp = listAgyMcpServers,
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
    agyHomeDir,
    platformSkillsDir,
    listCodexCapabilities,
    listAgyMcp,
  });
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const sections = [];
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (!item || !item.enabled) {
      throw capabilityResolutionError('A selected harness capability is no longer available. Refresh the slash menu and try again.');
    }
    if (item.source === 'ragent' && item.kind === 'skill') {
      if (id.startsWith('ragent:builtin:')) {
        const skill = await readBuiltinSkill({ id, expectedHash: item.state?.contentHash, authorize: async () => true });
        sections.push(`### Ragent skill: ${item.title}\n${skill.content.trim()}`);
        continue;
      }
      const markdown = await readPlatformSkillById(platformSkillsDir, id);
      if (!markdown.trim()) {
        throw capabilityResolutionError('A selected Ragent skill could not be read. Refresh the slash menu and try again.');
      }
      sections.push(`### Ragent skill: ${item.title}\n${markdown.trim()}`);
      continue;
    }
    if (item.kind === 'skill') {
      sections.push(`- Use the enabled ${item.source} skill “${item.title}” when relevant to this request.`);
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
