import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'path';
import {
  SHARED_TOOLS_DIR,
  TOOLS_ENABLED_FILE,
  TOOL_OVERLAYS_DIR,
  TOOLS_FILE,
} from './config.mjs';
import { fullPath } from './user-shell-env.mjs';
import { resolveExecutableCommandPathAsync } from './executable-resolution.mjs';
import {
  buildMicroAgentToolRecord,
  MICRO_AGENT_DEFAULT_TOOL_ID,
} from './micro-agent-tool.mjs';
import { buildProviderContractFields } from '../chat/provider-contract.mjs';
import { listHarnesses } from './harness-registry.mjs';
import { internalHarnessId } from './harness-paths.mjs';

// Keep startup diagnostics off stdout so machine-readable child-process
// contracts can safely use stdout for their result payload.
console.error('[tools] Resolved PATH dirs:', fullPath.split(delimiter).join('\n  '));

let customToolsCache = null;
let customToolsCacheMtimeMs = null;
let sharedToolsCache = null;
let sharedToolsCacheSignature = null;
let availableToolsCache = null;
const commandResolutionCache = new Map();
const HARNESS_TOOL_ALIASES = Object.freeze({
  'claude-bidi': 'claude',
  'codex-cli': 'codex',
  'kilo-code': 'kilo',
});

function isMicroAgentToolRecord(tool) {
  if (!tool || typeof tool !== 'object') return false;
  return String(tool.id || '').trim() === MICRO_AGENT_DEFAULT_TOOL_ID
    || normalizeToolProfile(tool.toolProfile) === 'micro-agent';
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const BUILTIN_TOOLS = [
  { id: 'codex', name: 'CodeX', command: 'codex', runtimeFamily: 'codex-app-server-json' },
  { id: 'claude', name: 'Claude Code (Compatibility)', command: 'claude', runtimeFamily: 'claude-stream-json', internalFallback: true },
  { id: 'claude-bidi', name: 'Claude Code', command: 'claude', runtimeFamily: 'claude-stream-json-bidi' },
  { id: 'agy', name: 'Antigravity CLI', command: 'agy', runtimeFamily: 'agy-stream-json' },
  { id: 'pi', name: 'Pi', command: 'pi', runtimeFamily: 'pi-rpc-jsonl' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', command: 'dsh', runtimeFamily: 'deepseek-harness-acp' },
  { id: 'qwen-code', name: 'Qwen Code', command: 'qwen', runtimeFamily: 'qwen-code-acp' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', runtimeFamily: 'opencode-json' },
  { id: 'kimi-code', name: 'Kimi Code', command: 'kimi', runtimeFamily: 'kimi-code-acp' },
  { id: 'goose', name: 'Goose', command: 'goose', runtimeFamily: 'goose-headless' },
  { id: 'openhands', name: 'OpenHands', command: 'agent-canvas', runtimeFamily: 'openhands-headless' },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot', runtimeFamily: 'copilot-json' },
  { id: 'hermes', name: 'Hermes Agent', command: 'hermes-acp', runtimeFamily: 'hermes-acp' },
  { id: 'cline', name: 'Cline', command: 'cline', runtimeFamily: 'cline-json' },
  { id: 'kilo', name: 'Kilo Code', command: 'kilo', runtimeFamily: 'kilo-json' },
];

const SIMPLE_RUNTIME_FAMILIES = new Set([
  'claude-stream-json',
  'claude-stream-json-bidi',
  'codex-json',
  'codex-app-server-json',
  'agy-json',
  'agy-stream-json',
  'pi-rpc-jsonl',
  'deepseek-harness-acp',
  'qwen-code-acp',
  'opencode-json',
  'kimi-code-acp',
  'goose-headless',
  'openhands-headless',
  'copilot-json',
  'hermes-acp',
  'cline-json',
  'kilo-json',
]);
const DEFAULT_CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];

function normalizeToolProfile(value) {
  const normalized = String(value || '').trim();
  return normalized === 'micro-agent' ? normalized : '';
}

function normalizeToolVisibility(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'private' ? 'private' : '';
}

export async function resolveToolCommandPathAsync(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  // Install/uninstall can happen after a failed discovery in this same process.
  // Internal runtimes never use the generic PATH/miss cache.
  if (internalHarnessId(trimmed)) return resolveExecutableCommandPathAsync(trimmed);
  if (commandResolutionCache.has(trimmed)) {
    return commandResolutionCache.get(trimmed);
  }

  const resolved = await resolveExecutableCommandPathAsync(trimmed);

  commandResolutionCache.set(trimmed, resolved);
  return resolved;
}

async function loadCustomTools() {
  const stats = await (async () => {
    try {
      return await stat(TOOLS_FILE);
    } catch {
      return null;
    }
  })();
  if (!stats) {
    customToolsCache = [];
    customToolsCacheMtimeMs = null;
    return customToolsCache;
  }

  const mtimeMs = stats.mtimeMs;
  if (customToolsCache && customToolsCacheMtimeMs === mtimeMs) {
    return customToolsCache;
  }
  try {
    const parsed = JSON.parse(await readFile(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.error('Failed to load tools.json: expected an array');
      customToolsCache = [];
      customToolsCacheMtimeMs = mtimeMs;
      availableToolsCache = null;
      return customToolsCache;
    }
    customToolsCache = parsed;
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  } catch (err) {
    console.error('Failed to load tools.json:', err.message);
    customToolsCache = [];
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  }
}

async function safeStatMtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function cleanMarkdownListToken(value) {
  return String(value || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function parseEnabledSharedToolIds(text) {
  const ids = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const candidate = line.match(/^[-*+]\s+(.+)$/)?.[1] || line;
    const cleaned = cleanMarkdownListToken(candidate);
    if (!cleaned) continue;
    if (cleaned === '*' || cleaned.toLowerCase() === 'all') return null;
    if (/^[a-zA-Z0-9-]+$/.test(cleaned)) {
      ids.add(cleaned);
    }
  }
  return ids.size > 0 ? ids : null;
}

function parseToolCardFrontmatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { fields: {}, body: source };
  }

  const lines = source.split(/\r?\n/);
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    return { fields: {}, body: source };
  }

  const fields = {};
  for (const rawLine of lines.slice(1, endIndex)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') {
      fields[key] = true;
      continue;
    }
    if (value === 'false') {
      fields[key] = false;
      continue;
    }
    fields[key] = value;
  }

  return {
    fields,
    body: lines.slice(endIndex + 1).join('\n'),
  };
}

function inferToolCardName(body, fallback) {
  const heading = String(body || '').match(/^#\s+(.+)$/m)?.[1];
  return String(heading || fallback || '').trim();
}

function inferRuntimeFamilyFromCommand(command) {
  const name = basename(String(command || '').trim()).toLowerCase();
  if (name === 'codex') return 'codex-json';
  if (name === 'claude') return 'claude-stream-json';
  return '';
}

function resolveSharedToolCommand(command, toolDir) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return resolve(toolDir, trimmed);
  }
  return trimmed;
}

async function findSharedToolOverlayPath(id) {
  for (const extension of ['yaml', 'yml', 'json', 'md']) {
    const candidate = join(TOOL_OVERLAYS_DIR, `${id}.${extension}`);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function buildSharedToolsSignature() {
  const parts = [`enabled:${await safeStatMtime(TOOLS_ENABLED_FILE) ?? 'none'}`];
  if (!await pathExists(SHARED_TOOLS_DIR)) {
    return parts.join('|');
  }

  const entries = [];
  try {
    for (const entry of await readdir(SHARED_TOOLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardPath = join(SHARED_TOOLS_DIR, entry.name, 'TOOL.md');
      if (!await pathExists(cardPath)) continue;
      entries.push(`${entry.name}:${await safeStatMtime(cardPath) ?? 'none'}`);
    }
  } catch (err) {
    console.error(`[tools] Failed to scan shared tools: ${err.message}`);
  }

  entries.sort();
  return `${parts.join('|')}|${entries.join('|')}`;
}

function attachInternalToolMeta(tool, meta) {
  Object.defineProperty(tool, '_meta', {
    value: Object.freeze({ ...(tool._meta || {}), ...meta }),
    enumerable: false,
    configurable: true,
  });
  return tool;
}

async function loadSharedTools() {
  const signature = await buildSharedToolsSignature();
  if (sharedToolsCache && sharedToolsCacheSignature === signature) {
    return sharedToolsCache;
  }

  let enabledIds = null;
  if (await pathExists(TOOLS_ENABLED_FILE)) {
    try {
      enabledIds = parseEnabledSharedToolIds(await readFile(TOOLS_ENABLED_FILE, 'utf8'));
    } catch (err) {
      console.error(`[tools] Failed to read tools-enabled.md: ${err.message}`);
    }
  }

  const sharedTools = [];
  if (await pathExists(SHARED_TOOLS_DIR)) {
    try {
      for (const entry of await readdir(SHARED_TOOLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const toolDir = join(SHARED_TOOLS_DIR, entry.name);
        const cardPath = join(toolDir, 'TOOL.md');
        if (!await pathExists(cardPath)) continue;

        try {
          const card = parseToolCardFrontmatter(await readFile(cardPath, 'utf8'));
          const rawId = String(card.fields.id || entry.name).trim() || entry.name;
          const id = /^[a-zA-Z0-9-]+$/.test(rawId)
            ? rawId
            : slugifyToolId(rawId || entry.name);
          if (enabledIds && !enabledIds.has(id)) continue;

          const command = resolveSharedToolCommand(card.fields.command, toolDir);
          if (!command) {
            throw new Error('Shared tool is missing a command in TOOL.md frontmatter');
          }

          const runtimeFamily = normalizeRuntimeFamily(card.fields.runtimeFamily)
            || inferRuntimeFamilyFromCommand(command);
          if (!runtimeFamily) {
            throw new Error('Shared tool must declare runtimeFamily unless the command is codex or claude');
          }

          const normalized = normalizeSimpleToolRecord({
            id,
            name: String(card.fields.name || inferToolCardName(card.body, id) || id).trim() || id,
            command,
            runtimeFamily,
            visibility: card.fields.visibility,
            toolProfile: card.fields.toolProfile,
            promptMode: card.fields.promptMode,
            flattenPrompt: card.fields.flattenPrompt === true,
          });
          if (!normalized) continue;

          sharedTools.push(attachInternalToolMeta(normalized, {
            sourceKind: 'shared',
            toolDir,
            cardPath,
            overlayPath: await findSharedToolOverlayPath(id),
          }));
        } catch (err) {
          console.error(`[tools] Skipping shared tool "${entry.name}": ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[tools] Failed to load shared tools: ${err.message}`);
    }
  }

  sharedToolsCache = sharedTools;
  sharedToolsCacheSignature = signature;
  availableToolsCache = null;
  commandResolutionCache.clear();
  return sharedToolsCache;
}

function getToolSourceKind(tool) {
  const sharedSource = String(tool?._meta?.sourceKind || '').trim();
  if (sharedSource) return sharedSource;
  return tool?.builtin ? 'builtin' : 'custom';
}

export function buildToolProcessEnvOverrides(tool) {
  if (!tool || typeof tool !== 'object') return {};
  const id = String(tool.id || '').trim();
  if (!id) return {};

  const env = {
    AGENTOC_TOOL_ID: id,
    AGENTOC_TOOL_SOURCE: getToolSourceKind(tool),
  };

  const name = String(tool.name || '').trim();
  if (name) {
    env.AGENTOC_TOOL_NAME = name;
  }

  const toolDir = String(tool?._meta?.toolDir || '').trim();
  if (toolDir) {
    env.AGENTOC_SHARED_TOOL_DIR = toolDir;
  }

  const cardPath = String(tool?._meta?.cardPath || '').trim();
  if (cardPath) {
    env.AGENTOC_SHARED_TOOL_CARD = cardPath;
  }

  const overlayPath = String(tool?._meta?.overlayPath || '').trim();
  if (overlayPath) {
    env.AGENTOC_TOOL_OVERLAY = overlayPath;
  }

  return env;
}

async function saveCustomToolsAsync(tools) {
  try {
    const dir = dirname(TOOLS_FILE);
    await mkdir(dir, { recursive: true });
    await writeFile(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8');
    customToolsCache = tools;
    try {
      customToolsCacheMtimeMs = (await stat(TOOLS_FILE)).mtimeMs;
    } catch {
      customToolsCacheMtimeMs = null;
    }
    availableToolsCache = null;
    commandResolutionCache.clear();
  } catch (err) {
    console.error('Failed to save tools.json:', err.message);
  }
}

async function ensureDefaultMicroAgentToolRegistrationLoaded(customTools) {
  // Micro Agent is no longer registered as a selectable tool; keep this stub so
  // existing callers (startup + getAvailableTools) keep their shape without
  // ever reseeding micro-agent into tools.json.
  return Array.isArray(customTools) ? customTools : [];
}

function validateToolId(id) {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

function validateCommand(command) {
  // Reject shell metacharacters
  return !/[;|&$`\\(){}<>]/.test(command) && command.trim().length > 0;
}

function slugifyToolId(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'tool';
}

function normalizeRuntimeFamily(runtimeFamily) {
  return SIMPLE_RUNTIME_FAMILIES.has(runtimeFamily) ? runtimeFamily : null;
}

function cloneReasoningDescriptor(reasoning, fallbackLabel = 'Thinking') {
  if (!reasoning || typeof reasoning !== 'object') return null;
  const kind = String(reasoning.kind || '').trim().toLowerCase();
  const label = String(reasoning.label || fallbackLabel).trim() || fallbackLabel;
  if (kind === 'enum') {
    const levels = [...new Set(
      (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((level) => String(level || '').trim())
        .filter(Boolean),
    )];
    if (levels.length === 0) return null;
    const defaultValue = String(
      reasoning.default
      || reasoning.defaultReasoning
      || reasoning.defaultEffort
      || levels[0],
    ).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === 'toggle' || kind === 'none') {
    return { kind, label };
  }
  return null;
}

function buildModelReasoningDescriptor(entry, fallbackReasoning = null) {
  if (!entry || typeof entry !== 'object') {
    return cloneReasoningDescriptor(fallbackReasoning);
  }

  const flatLevels = Array.isArray(entry.reasoningLevels)
    ? entry.reasoningLevels
    : Array.isArray(entry.effortLevels)
      ? entry.effortLevels
      : Array.isArray(entry.supportedReasoningLevels)
        ? entry.supportedReasoningLevels
        : null;
  const flatDefault = String(entry.defaultReasoning || entry.defaultEffort || '').trim();
  const flatKind = String(entry.reasoningKind || '').trim().toLowerCase();
  const hasFlatOverride = !!flatKind || !!flatDefault || (Array.isArray(flatLevels) && flatLevels.length > 0);

  const source = entry.reasoning && typeof entry.reasoning === 'object'
    ? entry.reasoning
    : hasFlatOverride
      ? {
        kind: flatKind || String(fallbackReasoning?.kind || '').trim().toLowerCase(),
        label: entry.reasoningLabel || fallbackReasoning?.label,
        ...(Array.isArray(flatLevels)
          ? { levels: flatLevels }
          : Array.isArray(fallbackReasoning?.levels)
            ? { levels: fallbackReasoning.levels }
            : {}),
        ...(flatDefault
          ? { default: flatDefault }
          : fallbackReasoning?.default
            ? { default: fallbackReasoning.default }
            : {}),
      }
      : fallbackReasoning;

  return cloneReasoningDescriptor(
    source,
    String(fallbackReasoning?.label || 'Thinking').trim() || 'Thinking',
  );
}

function normalizeSimpleModels(models, reasoning) {
  if (!Array.isArray(models)) return [];

  const seen = new Set();
  const normalized = [];

  for (const entry of models) {
    const modelId = String(entry?.id || entry || '').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);

    const model = {
      id: modelId,
      label: String(entry?.label || modelId).trim() || modelId,
    };

    const modelReasoning = buildModelReasoningDescriptor(entry, reasoning);
    if (modelReasoning) {
      model.reasoning = modelReasoning;
      if (modelReasoning.kind === 'enum') {
        model.defaultReasoning = modelReasoning.default;
        model.effortLevels = [...modelReasoning.levels];
      }
    }

    normalized.push(model);
  }

  return normalized;
}

function normalizeSimpleReasoning(reasoning, runtimeFamily) {
  const fallbackKind = runtimeFamily === 'codex-json' || runtimeFamily === 'codex-app-server-json'
    ? 'enum'
    : 'none';
  const allowedKinds = new Set(['none', 'enum', 'toggle']);

  const kind = String(reasoning?.kind || fallbackKind).trim();
  if (!allowedKinds.has(kind)) {
    throw new Error(`Reasoning kind "${kind}" is not supported`);
  }

  const label = String(reasoning?.label || 'Thinking').trim() || 'Thinking';

  if (kind === 'enum') {
    const rawLevels = Array.isArray(reasoning?.levels)
      ? reasoning.levels
      : DEFAULT_CODEX_REASONING_LEVELS;
    const levels = [...new Set(rawLevels.map(level => String(level || '').trim()).filter(Boolean))];
    if (levels.length === 0) {
      throw new Error('Reasoning levels are required for enum reasoning');
    }
    const defaultValue = String(reasoning?.default || levels[0]).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }

  if (kind === 'toggle') {
    return { kind, label };
  }

  return { kind, label };
}

function normalizeSimpleToolRecord(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const command = String(tool.command || '').trim();
  if (!command) return null;

  const hasRuntimeFamily = Object.hasOwn(tool, 'runtimeFamily');
  const runtimeFamily = normalizeRuntimeFamily(tool.runtimeFamily);
  if (hasRuntimeFamily && !runtimeFamily) {
    throw new Error(`Unsupported runtimeFamily "${tool.runtimeFamily}"`);
  }

  const configuredId = String(tool.id || '').trim();
  const id = configuredId && validateToolId(configuredId)
    ? configuredId
    : slugifyToolId(command);
  const toolProfile = normalizeToolProfile(tool.toolProfile);
  const visibility = normalizeToolVisibility(tool.visibility);
  const reasoning = runtimeFamily
    ? normalizeSimpleReasoning(tool.reasoning, runtimeFamily)
    : undefined;
  const models = runtimeFamily
    ? normalizeSimpleModels(tool.models, reasoning)
    : undefined;
  const promptMode = String(tool.promptMode || '').trim();
  const normalizedPromptMode = promptMode === 'bare-user' ? 'bare-user' : null;
  const flattenPrompt = tool.flattenPrompt === true;
  const providerContract = runtimeFamily ? buildProviderContractFields(runtimeFamily) : {};

  return {
    id,
    name: String(tool.name || command).trim() || command,
    command,
    ...(toolProfile ? { toolProfile } : {}),
    ...(visibility ? { visibility } : {}),
    ...(runtimeFamily ? {
      runtimeFamily,
      ...(providerContract.provider ? { provider: providerContract.provider } : {}),
      ...(providerContract.providerCapabilities ? { providerCapabilities: providerContract.providerCapabilities } : {}),
      models,
      reasoning,
    } : {}),
    ...(normalizedPromptMode ? { promptMode: normalizedPromptMode } : {}),
    ...(flattenPrompt ? { flattenPrompt: true } : {}),
  };
}

function attachProviderContractFields(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const runtimeFamily = String(tool.runtimeFamily || '').trim();
  if (!runtimeFamily) return tool;
  const providerContract = buildProviderContractFields(runtimeFamily, {
    provider: tool.provider,
    providerCapabilities: tool.providerCapabilities,
  });
  return {
    ...tool,
    ...(providerContract.provider ? { provider: providerContract.provider } : {}),
    ...(providerContract.runtimeFamily ? { runtimeFamily: providerContract.runtimeFamily } : {}),
    ...(providerContract.providerCapabilities ? { providerCapabilities: providerContract.providerCapabilities } : {}),
  };
}

export async function getAvailableTools() {
  let [customTools, sharedTools] = await Promise.all([
    loadCustomTools(),
    loadSharedTools(),
  ]);
  customTools = await ensureDefaultMicroAgentToolRegistrationLoaded(customTools, sharedTools);
  const harnesses = await listHarnesses();
  const harnessById = new Map(harnesses.map((harness) => [harness.id, harness]));
  const resolveAvailability = async (tool) => {
    const harnessId = HARNESS_TOOL_ALIASES[tool.id] || tool.id;
    const harness = harnessById.get(harnessId);
    if (harness) return harness.installed === true && Boolean(harness.path || harness.commandAvailable);
    return !!await resolveToolCommandPathAsync(tool.command);
  };
  if (availableToolsCache) {
    return availableToolsCache;
  }

  const builtins = await Promise.all(BUILTIN_TOOLS.map(async (tool) => {
    const available = await resolveAvailability(tool);
    console.log(`[tools] ${tool.id} (${tool.command}): ${available ? 'available' : 'NOT FOUND'}`);
    return attachProviderContractFields({ ...tool, builtin: true, available });
  }));

  const customs = [];
  for (const tool of customTools) {
    try {
      const normalized = normalizeSimpleToolRecord(tool);
      if (!normalized) continue;
      customs.push({
        ...attachProviderContractFields(normalized),
        builtin: false,
        available: await resolveAvailability(normalized),
      });
    } catch (err) {
      const label = String(tool?.name || tool?.command || tool?.id || 'unknown tool').trim();
      console.error(`[tools] Skipping custom tool "${label}": ${err.message}`);
    }
  }

  const takenIds = new Set([...builtins, ...customs].map((tool) => tool.id));
  const shared = [];
  for (const tool of sharedTools) {
    if (takenIds.has(tool.id)) {
      console.error(`[tools] Skipping shared tool "${tool.id}": id already exists`);
      continue;
    }
    takenIds.add(tool.id);
    shared.push(attachInternalToolMeta({
      ...attachProviderContractFields(tool),
      builtin: false,
      available: await resolveAvailability(tool),
    }, tool._meta || {}));
  }

  availableToolsCache = [...builtins, ...customs, ...shared]
    .filter((tool) => tool.available);
  return availableToolsCache;
}

export const getAvailableToolsAsync = getAvailableTools;

export function invalidateAvailableToolsCache() {
  availableToolsCache = null;
  commandResolutionCache.clear();
}

export async function getPublicAvailableToolsAsync() {
  return (await getAvailableTools()).filter((tool) => tool.internalFallback !== true);
}

export async function ensureDefaultMicroAgentToolRegistrationAsync() {
  const [customTools, sharedTools] = await Promise.all([
    loadCustomTools(),
    loadSharedTools(),
  ]);
  const ensured = await ensureDefaultMicroAgentToolRegistrationLoaded(customTools, sharedTools);
  return ensured.some(isMicroAgentToolRecord);
}

/**
 * Check the internal Codex installation. Startup never writes global shims or
 * adopts a user-installed CLI; installation belongs to Harness management.
 */
export async function ensureCodexAvailableAsync() {
  const existing = await resolveToolCommandPathAsync('codex');
  if (existing) {
    console.log(`[tools] codex available: ${existing}`);
    return true;
  }

  console.warn('[tools] Internal Codex is not installed; install it in Ragent Harness management.');
  return false;
}

export async function getToolDefinitionAsync(id) {
  const all = await getAvailableToolsAsync();
  const requestedId = typeof id === 'string' ? id.trim() : '';
  if (!requestedId) return null;

  // A harness alias is only a fallback for installations that expose one
  // command under a legacy id. It must not override an actual tool of the
  // requested id: `claude-bidi` is a separate stdin-based runtime, while its
  // underlying executable is still the `claude` harness.
  const exact = all.find((tool) => tool.id === requestedId);
  if (exact) return exact;

  const canonicalId = HARNESS_TOOL_ALIASES[requestedId] || requestedId;
  return canonicalId !== requestedId
    ? all.find((tool) => tool.id === canonicalId) || null
    : null;
}

export async function getToolProcessEnvOverridesAsync(id) {
  const tool = await getToolDefinitionAsync(id);
  return buildToolProcessEnvOverrides(tool);
}

export async function addTool({ id, name, command }) {
  if (!validateToolId(id)) {
    throw new Error('Invalid tool id: must match /^[a-zA-Z0-9-]+$/');
  }
  if (!validateCommand(command)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }
  if (!name || !name.trim()) {
    throw new Error('Name is required');
  }

  const allTools = await getAvailableTools();
  if (allTools.some(t => t.id === id)) {
    throw new Error(`Tool with id "${id}" already exists`);
  }

  const customs = await loadCustomTools();
  customs.push({ id, name: name.trim(), command: command.trim() });
  await saveCustomToolsAsync(customs);
  return {
    id,
    name: name.trim(),
    command: command.trim(),
    builtin: false,
    available: !!await resolveToolCommandPathAsync(command.trim()),
  };
}

export async function removeTool(id) {
  if (BUILTIN_TOOLS.some(t => t.id === id)) {
    throw new Error('Cannot remove a builtin tool');
  }
  const customs = await loadCustomTools();
  const index = customs.findIndex(t => t.id === id);
  if (index === -1) {
    throw new Error(`Tool "${id}" not found`);
  }
  customs.splice(index, 1);
  await saveCustomToolsAsync(customs);
}

export async function isToolValid(id) {
  if (id === 'shell') return true;
  const all = await getAvailableTools();
  const requestedId = typeof id === 'string' ? id.trim() : '';
  if (!requestedId) return false;
  if (all.some((tool) => tool.id === requestedId)) return true;
  const canonicalId = HARNESS_TOOL_ALIASES[requestedId] || requestedId;
  return canonicalId !== requestedId && all.some((tool) => tool.id === canonicalId);
}

export async function getToolCommandAsync(id) {
  const tool = await getToolDefinitionAsync(id);
  if (!tool && internalHarnessId(id)) throw Object.assign(new Error(`Internal Harness is not installed: ${id}`), { code: 'HARNESS_RUNTIME_UNAVAILABLE' });
  return tool ? tool.command : 'claude';
}

export async function saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning, visibility }) {
  const trimmedCommand = String(command || '').trim();
  if (!validateCommand(trimmedCommand)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }

  const normalizedFamily = normalizeRuntimeFamily(runtimeFamily);
  if (!normalizedFamily) {
    throw new Error('runtimeFamily must be a supported built-in runtime family');
  }

  const builtinConflict = BUILTIN_TOOLS.find((tool) => tool.command === trimmedCommand);
  if (builtinConflict) {
    throw new Error(`Command "${trimmedCommand}" is already handled by builtin tool "${builtinConflict.id}"`);
  }

  const normalizedReasoning = normalizeSimpleReasoning(reasoning, normalizedFamily);
  const normalizedModels = normalizeSimpleModels(models, normalizedReasoning);
  const toolName = String(name || trimmedCommand).trim() || trimmedCommand;

  const customs = await loadCustomTools();
  const existingIndex = customs.findIndex((tool) => String(tool.command || '').trim() === trimmedCommand);
  const existing = existingIndex >= 0 ? customs[existingIndex] : null;
  let id = existingIndex >= 0
    ? String(customs[existingIndex].id || slugifyToolId(trimmedCommand)).trim()
    : slugifyToolId(trimmedCommand);

  if (existingIndex === -1) {
    let suffix = 2;
    while (BUILTIN_TOOLS.some((tool) => tool.id === id) || customs.some((tool) => tool.id === id)) {
      id = `${slugifyToolId(trimmedCommand)}-${suffix}`;
      suffix += 1;
    }
  }

  const normalizedVisibility = normalizeToolVisibility(visibility || existing?.visibility);

  const record = {
    id,
    name: toolName,
    command: trimmedCommand,
    ...(normalizedVisibility ? { visibility: normalizedVisibility } : {}),
    runtimeFamily: normalizedFamily,
    models: normalizedModels,
    reasoning: normalizedReasoning,
  };

  if (existingIndex >= 0) {
    customs[existingIndex] = record;
  } else {
    customs.push(record);
  }
  await saveCustomToolsAsync(customs);
  return {
    ...record,
    builtin: false,
    available: !!await resolveToolCommandPathAsync(trimmedCommand),
  };
}
