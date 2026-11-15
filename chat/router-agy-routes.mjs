// AgY Provider HTTP Routes for Ragent
// Handles AgY-specific API endpoints for model listing, agent management, and execution

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

const AGY_EXECUTION_TIMEOUT = DEFAULT_AGY_PROCESS_TIMEOUT_MS;
const AGY_REQUEST_MAX_BYTES = 65536; // 64KB max request size

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

export async function handleAgyRoutes({ req, res, pathname }) {
  const isAgyRoute = isAgyModelsRoute(pathname)
    || isAgyAgentsRoute(pathname)
    || isAgyExecuteRoute(pathname)
    || isAgyVersionRoute(pathname);
  if (!isAgyRoute) return false;

  try {
    // Check AgY availability
    const available = await ensureAgyAvailable();
    if (!available) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AgY CLI not available' }));
      return;
    }

    if (isAgyModelsRoute(pathname)) {
      return await handleAgyModels(req, res);
    }

    if (isAgyAgentsRoute(pathname)) {
      return await handleAgyAgents(req, res);
    }

    if (isAgyExecuteRoute(pathname)) {
      return await handleAgyExecute(req, res);
    }

    if (isAgyVersionRoute(pathname)) {
      return await handleAgyVersion(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'AgY route not found' }));

  } catch (error) {
    console.error('AgY route error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleAgyModels(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const models = await listAgyModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleAgyAgents(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const agents = await listAgyAgents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleAgyExecute(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
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
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Prompt is required' }));
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));

  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleAgyVersion(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const version = await getAgyVersion();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}
