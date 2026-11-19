// AgY MCP server management. Manages external user-scoped AgY MCP definitions
// stored under <agyHomeDir>/.gemini/config/mcp_config.json (redirectable for
// controlled tests via RAGENT_AGY_MCP_HOME_DIR or options.agyHomeDir so the
// real ~/.gemini/ directory is never modified unintentionally).
//
// Security boundaries:
// - Strictly allows only `stdio` and Streamable `http` transports.
// - Explicitly rejects legacy HTTP+SSE (`sse`) with a clear diagnostic error.
// - Blocks reserved Ragent managed prefixes (`ragent_*`, `ragent-*`, `ragent`).
// - Strips env/header values and URL credentials whenever listing servers.

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AGY_CONTROL_HOME_DIR } from './config.mjs';

export const AGY_MCP_CONFIG_RELATIVE_PATH = join('.gemini', 'config', 'mcp_config.json');
export const AGY_SUPPORTED_MCP_TRANSPORTS = Object.freeze(['stdio', 'http']);

const AGY_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGY_RESERVED_MCP_NAME_PATTERN = /^ragent(?:[_-]|$)/i;
const AGY_LEGACY_UNSUPPORTED_TRANSPORTS = new Set(['sse', 'http+sse', 'http-sse', 'websocket', 'ws']);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MCP_CONFIG_BYTES = 512 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const writeQueues = new Map();
let tempSequence = 0;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveConfiguredPath(value) {
  const candidate = trimString(value);
  if (!candidate) return '';
  return isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
}

function sanitizeDisplayUrl(rawUrl) {
  const value = trimString(rawUrl);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export function isReservedRagentMcpName(name) {
  const normalized = trimString(name);
  return Boolean(normalized) && AGY_RESERVED_MCP_NAME_PATTERN.test(normalized);
}

export function resolveAgyMcpHomeDir(options = {}, environment = process.env) {
  return resolveConfiguredPath(options.agyHomeDir)
    || resolveConfiguredPath(options.homeDir)
    || resolveConfiguredPath(options.configDir)
    || resolveConfiguredPath(environment?.RAGENT_AGY_MCP_HOME_DIR)
    || resolveConfiguredPath(environment?.RAGENT_AGY_HOME_DIR)
    || AGY_CONTROL_HOME_DIR;
}

export function resolveAgyMcpConfigFile(options = {}, environment = process.env) {
  const explicitFile = resolveConfiguredPath(options.mcpConfigFile);
  if (explicitFile) return explicitFile;
  const geminiDir = resolveConfiguredPath(options.geminiDir) || resolveConfiguredPath(environment?.RAGENT_AGY_GEMINI_DIR);
  if (geminiDir) return join(geminiDir, 'config', 'mcp_config.json');
  return join(resolveAgyMcpHomeDir(options, environment), AGY_MCP_CONFIG_RELATIVE_PATH);
}

function failValidation(code, error) {
  return { ok: false, code, error };
}

function normalizeStringMap(raw, { label, keyPattern = null, forbidRagentEnv = false } = {}) {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return failValidation('AGY_MCP_INVALID_CONFIG', `${label} must be a plain key/value object`);
  }
  const out = Object.create(null);
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    const key = trimString(rawKey);
    if (!key || FORBIDDEN_KEYS.has(key)) {
      return failValidation('AGY_MCP_INVALID_CONFIG', `Invalid ${label} key`);
    }
    if (keyPattern && !keyPattern.test(key)) {
      return failValidation('AGY_MCP_INVALID_CONFIG', `Invalid ${label} key "${key}"`);
    }
    if (forbidRagentEnv && /^RAGENT_/i.test(key)) {
      return failValidation('AGY_MCP_RESERVED_ENV', `External AgY MCP cannot override reserved ${key} environment binding`);
    }
    if (/[\r\n\0]/.test(key)) {
      return failValidation('AGY_MCP_INVALID_CONFIG', `Invalid characters in ${label} key`);
    }
    const val = rawVal === undefined || rawVal === null ? '' : String(rawVal);
    if (/[\r\n\0]/.test(val)) {
      return failValidation('AGY_MCP_INVALID_CONFIG', `Invalid control characters in ${label} value for "${key}"`);
    }
    if (val) out[key] = val;
  }
  return { ok: true, value: { ...out } };
}

function detectRawTransport(input = {}) {
  const explicit = trimString(input.type || input.transport).toLowerCase();
  if (explicit) return explicit;
  if (trimString(input.serverUrl || input.url)) return 'http';
  if (trimString(input.command)) return 'stdio';
  return '';
}

export function validateAgyMcpServerInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return failValidation('AGY_MCP_INVALID_CONFIG', 'Server configuration must be an object');
  }
  const name = trimString(input.name);
  if (!name) {
    return failValidation('AGY_MCP_NAME_REQUIRED', 'Server name is required');
  }
  if (FORBIDDEN_KEYS.has(name) || !AGY_MCP_NAME_PATTERN.test(name)) {
    return failValidation(
      'AGY_MCP_INVALID_NAME',
      'Server name must start with an alphanumeric character and use only letters, digits, ".", "_", or "-"',
    );
  }
  if (isReservedRagentMcpName(name)) {
    return failValidation(
      'AGY_MCP_RESERVED_NAME',
      `Server name "${name}" uses a reserved Ragent prefix ("ragent_*")`,
    );
  }

  const rawTransport = detectRawTransport(input);
  if (input.sse === true || AGY_LEGACY_UNSUPPORTED_TRANSPORTS.has(rawTransport)) {
    return failValidation(
      'AGY_MCP_UNSUPPORTED_TRANSPORT',
      'Legacy HTTP+SSE MCP transport is unsupported by AgY; use stdio or Streamable http instead',
    );
  }
  const transport = rawTransport === 'streamable-http' || rawTransport === 'streamable_http'
    ? 'http'
    : rawTransport;
  if (!AGY_SUPPORTED_MCP_TRANSPORTS.includes(transport)) {
    return failValidation(
      'AGY_MCP_UNSUPPORTED_TRANSPORT',
      rawTransport
        ? `Unsupported AgY MCP transport "${rawTransport}"; only "stdio" and Streamable "http" are supported`
        : 'Either command (stdio) or Streamable HTTP url is required',
    );
  }

  const disabled = input.disabled === true;

  if (transport === 'http') {
    const rawUrl = trimString(input.serverUrl || input.url);
    if (!rawUrl) {
      return failValidation('AGY_MCP_INVALID_URL', 'Streamable HTTP url is required');
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return failValidation('AGY_MCP_INVALID_URL', 'Streamable HTTP url must be a valid absolute http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return failValidation('AGY_MCP_INVALID_URL', 'Streamable HTTP url must use http:// or https://');
    }
    if (parsed.username || parsed.password) {
      return failValidation('AGY_MCP_INVALID_URL', 'Streamable HTTP url must not embed username or password credentials');
    }
    const headersResult = normalizeStringMap(input.headers, { label: 'headers' });
    if (!headersResult.ok) return headersResult;

    const entry = {
      serverUrl: parsed.toString(),
      disabled,
      ...(Object.keys(headersResult.value).length > 0 ? { headers: headersResult.value } : {}),
    };
    return {
      ok: true,
      name,
      type: 'http',
      entry,
      normalized: {
        name,
        type: 'http',
        url: entry.serverUrl,
        headers: headersResult.value,
        disabled,
      },
    };
  }

  const command = trimString(input.command);
  if (!command || /[\r\n\0]/.test(command)) {
    return failValidation('AGY_MCP_INVALID_COMMAND', 'command is required for stdio MCP servers');
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    return failValidation('AGY_MCP_INVALID_CONFIG', 'args must be an array of strings');
  }
  const args = Array.isArray(input.args)
    ? input.args.map((arg) => String(arg)).filter((arg) => !/\0/.test(arg))
    : [];
  const envResult = normalizeStringMap(input.env, {
    label: 'env',
    keyPattern: ENV_KEY_PATTERN,
    forbidRagentEnv: true,
  });
  if (!envResult.ok) return envResult;

  const entry = {
    command,
    args,
    disabled,
    ...(Object.keys(envResult.value).length > 0 ? { env: envResult.value } : {}),
  };
  return {
    ok: true,
    name,
    type: 'stdio',
    entry,
    normalized: {
      name,
      type: 'stdio',
      command,
      args,
      env: envResult.value,
      disabled,
    },
  };
}

export function sanitizeAgyMcpServerEntry(name, entry = {}) {
  const serverName = trimString(name);
  if (!serverName || !entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rawType = detectRawTransport(entry);
  const isSse = entry.sse === true || AGY_LEGACY_UNSUPPORTED_TRANSPORTS.has(rawType);
  const type = isSse
    ? rawType || 'sse'
    : rawType === 'streamable-http' || rawType === 'streamable_http'
      ? 'http'
      : rawType || 'stdio';

  const summary = {
    name: serverName,
    scope: 'user',
    type,
    disabled: entry.disabled === true,
    ...(isSse ? { unsupported: true, unsupportedReason: 'legacy_sse' } : {}),
  };

  if (type === 'http' || isSse) {
    const safeUrl = sanitizeDisplayUrl(entry.serverUrl || entry.url);
    if (safeUrl) summary.url = safeUrl;
    const headers = entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
      ? entry.headers
      : {};
    const headerKeys = Object.keys(headers);
    if (headerKeys.length > 0) summary.headerKeys = headerKeys;
  } else {
    if (typeof entry.command === 'string' && entry.command.trim()) {
      summary.command = entry.command.trim();
    }
    if (Array.isArray(entry.args)) {
      summary.args = entry.args.map(String);
    }
    const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? entry.env
      : {};
    const envKeys = Object.keys(env);
    if (envKeys.length > 0) summary.envKeys = envKeys;
  }

  return summary;
}

async function withConfigWriteLock(configFile, action) {
  const prev = writeQueues.get(configFile) || Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = prev.catch(() => {}).then(() => current);
  writeQueues.set(configFile, tail);
  await prev.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (writeQueues.get(configFile) === tail) {
      writeQueues.delete(configFile);
    }
  }
}

async function readAgyMcpDocument(configFile, readFileImpl = readFile) {
  let raw = '';
  try {
    raw = await readFileImpl(configFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, doc: { mcpServers: {} }, existed: false };
    }
    return {
      ok: false,
      code: 'AGY_MCP_READ_FAILED',
      error: trimString(error?.message) || 'Failed to read AgY MCP configuration',
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_MCP_CONFIG_BYTES) {
    return { ok: false, code: 'AGY_MCP_TOO_LARGE', error: 'AgY MCP configuration file is too large' };
  }
  if (!raw.trim()) {
    return { ok: true, doc: { mcpServers: {} }, existed: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'AGY_MCP_INVALID_JSON', error: 'AgY MCP configuration is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'AGY_MCP_INVALID_JSON', error: 'AgY MCP configuration root must be a JSON object' };
  }
  const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? { ...parsed.mcpServers }
    : {};
  return { ok: true, doc: { ...parsed, mcpServers }, existed: true };
}

async function writeAgyMcpDocumentAtomic(configFile, doc, {
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  chmodImpl = chmod,
} = {}) {
  const dir = dirname(configFile);
  await mkdirImpl(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${configFile}.tmp-${process.pid}-${tempSequence += 1}`;
  try {
    await writeFileImpl(tempPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await renameImpl(tempPath, configFile);
    await chmodImpl(configFile, 0o600).catch(() => {});
  } finally {
    await unlinkImpl(tempPath).catch(() => {});
  }
}

export async function listAgyMcpServers(options = {}) {
  const configFile = resolveAgyMcpConfigFile(options);
  const loaded = await readAgyMcpDocument(configFile, options.readFileImpl || readFile);
  if (!loaded.ok) {
    return { ok: false, code: loaded.code, error: loaded.error, servers: [] };
  }
  const servers = Object.entries(loaded.doc.mcpServers)
    .map(([name, entry]) => sanitizeAgyMcpServerEntry(name, entry))
    .filter(Boolean);
  return { ok: true, servers };
}

export async function addAgyMcpServer(input = {}, options = {}) {
  const validated = validateAgyMcpServerInput(input);
  if (!validated.ok) return validated;

  const configFile = resolveAgyMcpConfigFile(options);
  return withConfigWriteLock(configFile, async () => {
    const loaded = await readAgyMcpDocument(configFile, options.readFileImpl || readFile);
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };

    const nextDoc = {
      ...loaded.doc,
      mcpServers: {
        ...loaded.doc.mcpServers,
        [validated.name]: validated.entry,
      },
    };
    await writeAgyMcpDocumentAtomic(configFile, nextDoc, options);
    return {
      ok: true,
      server: sanitizeAgyMcpServerEntry(validated.name, validated.entry),
    };
  });
}

export async function setAgyMcpServerEnabled({ name, disabled } = {}, options = {}) {
  const serverName = trimString(name);
  if (!serverName) return failValidation('AGY_MCP_NAME_REQUIRED', 'Server name is required');
  if (isReservedRagentMcpName(serverName)) {
    return failValidation('AGY_MCP_RESERVED_NAME', `Server name "${serverName}" uses a reserved Ragent prefix`);
  }
  if (typeof disabled !== 'boolean') {
    return failValidation('AGY_MCP_INVALID_CONFIG', 'disabled must be a boolean');
  }
  const configFile = resolveAgyMcpConfigFile(options);
  return withConfigWriteLock(configFile, async () => {
    const loaded = await readAgyMcpDocument(configFile, options.readFileImpl || readFile);
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
    if (!Object.hasOwn(loaded.doc.mcpServers, serverName)) {
      return failValidation('AGY_MCP_NOT_FOUND', `AgY MCP server "${serverName}" was not found`);
    }
    const existing = loaded.doc.mcpServers[serverName];
    const updated = { ...(existing && typeof existing === 'object' ? existing : {}), disabled };
    const nextDoc = {
      ...loaded.doc,
      mcpServers: {
        ...loaded.doc.mcpServers,
        [serverName]: updated,
      },
    };
    await writeAgyMcpDocumentAtomic(configFile, nextDoc, options);
    return { ok: true, server: sanitizeAgyMcpServerEntry(serverName, updated) };
  });
}

export async function removeAgyMcpServer({ name } = {}, options = {}) {
  const serverName = trimString(name);
  if (!serverName) return failValidation('AGY_MCP_NAME_REQUIRED', 'Server name is required');
  if (isReservedRagentMcpName(serverName)) {
    return failValidation('AGY_MCP_RESERVED_NAME', `Server name "${serverName}" uses a reserved Ragent prefix`);
  }
  const configFile = resolveAgyMcpConfigFile(options);
  return withConfigWriteLock(configFile, async () => {
    const loaded = await readAgyMcpDocument(configFile, options.readFileImpl || readFile);
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
    if (!Object.hasOwn(loaded.doc.mcpServers, serverName)) {
      return failValidation('AGY_MCP_NOT_FOUND', `AgY MCP server "${serverName}" was not found`);
    }
    const nextServers = { ...loaded.doc.mcpServers };
    delete nextServers[serverName];
    await writeAgyMcpDocumentAtomic(configFile, { ...loaded.doc, mcpServers: nextServers }, options);
    return { ok: true };
  });
}

/**
 * Load explicitly authorized external AgY MCP definitions from a controlled source
 * home/config file without copying credentials blindly or colliding with Ragent
 * managed server names.
 */
export async function resolveAuthorizedAgyExternalMcpServers({
  agyHomeDir = '',
  homeDir = '',
  geminiDir = '',
  mcpConfigFile = '',
  explicitServers = null,
  allowedNames = [],
  allowAllEnabled = false,
  reservedNames = [],
  readFileImpl = readFile,
} = {}) {
  const allowSet = new Set(
    (Array.isArray(allowedNames) ? allowedNames : [])
      .map((entry) => trimString(entry))
      .filter(Boolean),
  );
  const reservedSet = new Set(
    (Array.isArray(reservedNames) ? reservedNames : [])
      .map((entry) => trimString(entry).toLowerCase())
      .filter(Boolean),
  );

  // Neither explicit inline servers nor an explicit allowlist/flag -> empty fail-closed.
  if (allowSet.size === 0 && allowAllEnabled !== true && (!Array.isArray(explicitServers) || explicitServers.length === 0)) {
    return { ok: true, servers: [], skipped: [] };
  }

  let candidates = [];
  if (Array.isArray(explicitServers) && explicitServers.length > 0) {
    candidates = explicitServers
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ name: trimString(item.name), entry: item }));
  } else if (agyHomeDir || homeDir || geminiDir || mcpConfigFile) {
    const configFile = resolveAgyMcpConfigFile({ agyHomeDir, homeDir, geminiDir, mcpConfigFile });
    const loaded = await readAgyMcpDocument(configFile, readFileImpl);
    if (!loaded.ok) {
      return { ok: false, code: loaded.code, error: loaded.error, servers: [], skipped: [] };
    }
    candidates = Object.entries(loaded.doc.mcpServers).map(([name, entry]) => ({ name, entry }));
  }

  const servers = [];
  const skipped = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const name = trimString(candidate?.name);
    const entry = candidate?.entry;
    if (!name || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.disabled === true) {
      skipped.push({ name, reason: 'disabled' });
      continue;
    }
    if (allowSet.size > 0 && !allowSet.has(name)) {
      skipped.push({ name, reason: 'not_authorized' });
      continue;
    }
    if (isReservedRagentMcpName(name) || reservedSet.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'reserved_name' });
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'duplicate_name' });
      continue;
    }
    const validated = validateAgyMcpServerInput({ ...entry, name });
    if (!validated.ok) {
      skipped.push({ name, reason: validated.code || 'invalid_config', error: validated.error });
      continue;
    }
    seen.add(name.toLowerCase());
    servers.push({
      name: validated.name,
      type: validated.type,
      entry: validated.entry,
      normalized: validated.normalized,
    });
  }

  return { ok: true, servers, skipped };
}
