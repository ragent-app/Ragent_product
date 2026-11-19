// AgY Provider HTTP Routes for Ragent
// Handles AgY-specific API endpoints for model listing, agent management, execution,
// and owner-authenticated external MCP server management.

import { getAuthSession } from '../lib/auth.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  executeAgyPrompt,
  executeAgyInteractive,
  listAgyModels,
  listAgyAgents,
  getAgyVersion,
  ensureAgyAvailable,
  DEFAULT_AGY_PROCESS_TIMEOUT_MS,
  DEFAULT_AGY_PRINT_TIMEOUT,
} from '../lib/agy-manager.mjs';
import {
  addAgyMcpServer,
  listAgyMcpServers,
  removeAgyMcpServer,
  setAgyMcpServerEnabled,
} from '../lib/agy-mcp-manager.mjs';

const AGY_EXECUTION_TIMEOUT = DEFAULT_AGY_PROCESS_TIMEOUT_MS;
const AGY_REQUEST_MAX_BYTES = 65536; // 64KB max request size
const AGY_MCP_BODY_MAX_BYTES = 16384;

function defaultWriteJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isAgyModelsRoute(pathname) {
  return pathname === '/api/agy/models';
}

function isAgyAgentsRoute(pathname) {
  return pathname === '/api/agy/agents';
}

function isAgyExecuteRoute(pathname) {
  return pathname === '/api/agy/execute';
}

function isAgyVersionRoute(pathname) {
  return pathname === '/api/agy/version';
}

function isAgyMcpListRoute(pathname) {
  return pathname === '/api/agy/mcp-servers';
}

export function parseAgyMcpServerItemRoute(pathname) {
  const match = /^\/api\/agy\/mcp-servers\/([^/]+)$/.exec(pathname || '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isOwnerAuthSession(req, authSession) {
  let effective = authSession;
  if (effective === undefined) {
    // Narrow run-scoped tokens must never inherit owner cookie access if a caller
    // omits authSession when delegating to handleAgyRoutes.
    if (
      req?.headers?.['x-ragent-session-control-token']
      || req?.headers?.['x-ragent-collaboration-token']
      || req?.headers?.['x-ragent-approved-action-token']
      || req?.headers?.['x-ragent-browser-token']
    ) {
      return false;
    }
    effective = getAuthSession(req);
  }
  if (!effective || effective.role !== 'owner') return false;
  return !['run_capability', 'provisional_device', 'temporary_device'].includes(effective.principalKind);
}

async function handleAgyMcpRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  listMcpServers = listAgyMcpServers,
  addMcpServer = addAgyMcpServer,
  removeMcpServer = removeAgyMcpServer,
  setMcpServerEnabled = setAgyMcpServerEnabled,
}) {
  if (isAgyMcpListRoute(pathname)) {
    if (!isOwnerAuthSession(req, authSession)) {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if (req.method === 'GET') {
      const result = await listMcpServers();
      if (!result.ok) {
        writeJson(res, 500, { error: result.error, ...(result.code ? { code: result.code } : {}), servers: [] });
        return true;
      }
      writeJson(res, 200, { servers: result.servers });
      return true;
    }
    if (req.method === 'POST') {
      let payload = {};
      try {
        const rawBody = await readBody(req, AGY_MCP_BODY_MAX_BYTES);
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        writeJson(res, 400, { error: 'Invalid MCP server payload' });
        return true;
      }
      const result = await addMcpServer({
        name: typeof payload.name === 'string' ? payload.name : '',
        type: typeof payload.type === 'string' ? payload.type : undefined,
        transport: typeof payload.transport === 'string' ? payload.transport : undefined,
        sse: payload.sse === true,
        command: typeof payload.command === 'string' ? payload.command : '',
        args: Array.isArray(payload.args) ? payload.args.map(String) : undefined,
        url: typeof payload.url === 'string' ? payload.url : '',
        serverUrl: typeof payload.serverUrl === 'string' ? payload.serverUrl : '',
        env: payload.env,
        headers: payload.headers,
        disabled: payload.disabled === true,
      });
      if (!result.ok) {
        writeJson(res, 400, { error: result.error, ...(result.code ? { code: result.code } : {}) });
        return true;
      }
      writeJson(res, 200, { ok: true, server: result.server });
      return true;
    }
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const serverName = parseAgyMcpServerItemRoute(pathname);
  if (serverName !== null) {
    if (!isOwnerAuthSession(req, authSession)) {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if (req.method === 'PATCH') {
      let payload = {};
      try {
        const rawBody = await readBody(req, AGY_MCP_BODY_MAX_BYTES);
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const result = await setMcpServerEnabled({
        name: serverName,
        disabled: payload?.disabled,
      });
      if (!result.ok) {
        const status = result.code === 'AGY_MCP_NOT_FOUND' ? 404 : 400;
        writeJson(res, status, { error: result.error, ...(result.code ? { code: result.code } : {}) });
        return true;
      }
      writeJson(res, 200, { ok: true, server: result.server });
      return true;
    }
    if (req.method === 'DELETE') {
      const result = await removeMcpServer({ name: serverName });
      if (!result.ok) {
        const status = result.code === 'AGY_MCP_NOT_FOUND' ? 404 : 400;
        writeJson(res, status, { error: result.error, ...(result.code ? { code: result.code } : {}) });
        return true;
      }
      writeJson(res, 200, { ok: true });
      return true;
    }
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  return false;
}

export async function handleAgyRoutes({
  req,
  res,
  pathname,
  authSession = undefined,
  writeJson = defaultWriteJson,
  listMcpServers = listAgyMcpServers,
  addMcpServer = addAgyMcpServer,
  removeMcpServer = removeAgyMcpServer,
  setMcpServerEnabled = setAgyMcpServerEnabled,
}) {
  if (await handleAgyMcpRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
    listMcpServers,
    addMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
  })) {
    return true;
  }

  const isAgyRoute = isAgyModelsRoute(pathname)
    || isAgyAgentsRoute(pathname)
    || isAgyExecuteRoute(pathname)
    || isAgyVersionRoute(pathname);
  if (!isAgyRoute) return false;

  try {
    // Check AgY availability
    const available = await ensureAgyAvailable();
    if (!available) {
      writeJson(res, 503, { error: 'AgY CLI not available' });
      return true;
    }

    if (isAgyModelsRoute(pathname)) {
      await handleAgyModels(req, res, writeJson);
      return true;
    }

    if (isAgyAgentsRoute(pathname)) {
      await handleAgyAgents(req, res, writeJson);
      return true;
    }

    if (isAgyExecuteRoute(pathname)) {
      await handleAgyExecute(req, res, writeJson);
      return true;
    }

    if (isAgyVersionRoute(pathname)) {
      await handleAgyVersion(req, res, writeJson);
      return true;
    }

    writeJson(res, 404, { error: 'AgY route not found' });
    return true;
  } catch (error) {
    console.error('AgY route error:', error);
    writeJson(res, 500, { error: error.message });
    return true;
  }
}

async function handleAgyModels(req, res, writeJson = defaultWriteJson) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const models = await listAgyModels();
    writeJson(res, 200, { models });
  } catch (error) {
    writeJson(res, 500, { error: error.message });
  }
}

async function handleAgyAgents(req, res, writeJson = defaultWriteJson) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const agents = await listAgyAgents();
    writeJson(res, 200, { agents });
  } catch (error) {
    writeJson(res, 500, { error: error.message });
  }
}

async function handleAgyExecute(req, res, writeJson = defaultWriteJson) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readBody(req, AGY_REQUEST_MAX_BYTES);
    const {
      prompt,
      model,
      agent,
      project,
      mode,
      format,
      timeout,
      printTimeout,
      interactive,
    } = JSON.parse(body);

    if (!prompt) {
      writeJson(res, 400, { error: 'Prompt is required' });
      return;
    }

    const options = {
      model: model || undefined,
      agent: agent || undefined,
      project: project || undefined,
      mode: mode || undefined,
      format: format || 'text',
      timeout: timeout || AGY_EXECUTION_TIMEOUT,
      printTimeout: printTimeout || DEFAULT_AGY_PRINT_TIMEOUT,
    };

    let result;
    if (interactive) {
      result = await executeAgyInteractive(prompt, options);
    } else {
      result = await executeAgyPrompt(prompt, options);
    }

    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, 500, { error: error.message });
  }
}

async function handleAgyVersion(req, res, writeJson = defaultWriteJson) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const version = await getAgyVersion();
    writeJson(res, 200, { version });
  } catch (error) {
    writeJson(res, 500, { error: error.message });
  }
}
