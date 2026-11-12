#!/usr/bin/env node
// AgentoC as an MCP server (stdio transport, JSON-RPC 2.0, one JSON object
// per line — the Model Context Protocol framing). The protocol is generic, so
// any MCP-capable client can consume it. Register with:
//
//   codex mcp add agentoc -- node /srv/agentoc-promoted/scripts/agentoc-mcp-server.mjs
//   claude mcp add -s user agentoc -- node /srv/agentoc-promoted/scripts/agentoc-mcp-server.mjs
//
// Exposes a minimal READ-ONLY tool set (session metadata only). Conversation
// bodies and credentials are never read or returned; AGENTOC_CONFIG_DIR
// selects the AgentoC config root (defaults to the service user's
// ~/.config/agentoc).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getExecution, listExecutions } from '../chat/orchestration-store.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ragent';
const SERVER_VERSION = '1.0.0';

const SESSION_METADATA_FIELDS = [
  'id',
  'name',
  'group',
  'description',
  'tool',
  'folder',
  'sourceName',
  'interactionMode',
  'created',
  'updatedAt',
  'projectId',
  'workflowState',
  'workflowPriority',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function configDir() {
  const explicit = trimString(process.env.AGENTOC_CONFIG_DIR);
  if (explicit) return explicit;
  return join(homedir(), '.config', 'agentoc');
}

function pickSessionMetadata(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const picked = {};
  for (const key of SESSION_METADATA_FIELDS) {
    const value = session[key];
    if (value !== undefined && value !== null) {
      picked[key] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : String(value);
    }
  }
  return picked.id ? picked : null;
}

async function loadSessionIndex() {
  const file = join(configDir(), 'chat-sessions.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter((entry) => entry && typeof entry === 'object');
  }
  return [];
}

async function listSessions(args = {}) {
  const sessions = await loadSessionIndex();
  const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(Number(args.limit), 50)) : 20;
  const sorted = [...sessions]
    .map(pickSessionMetadata)
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return { sessions: sorted.slice(0, limit) };
}

async function getSession(args = {}) {
  const sessionId = trimString(args?.sessionId);
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const sessions = await loadSessionIndex();
  const found = sessions.find((session) => String(session.id) === sessionId)
    || sessions.find((session) => String(session.name) === sessionId);
  const metadata = pickSessionMetadata(found);
  if (!metadata) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return { session: metadata };
}

async function listOrchestrations(args = {}) {
  const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(Number(args.limit), 100)) : 20;
  return {
    executions: await listExecutions({
      rootSessionId: trimString(args?.rootSessionId),
      state: trimString(args?.state),
      limit,
    }),
  };
}

async function getOrchestration(args = {}) {
  const executionId = trimString(args?.executionId);
  if (!executionId) throw new Error('executionId is required');
  const execution = await getExecution(executionId, { includeDetails: true });
  if (!execution) throw new Error(`Orchestration not found: ${executionId}`);
  return { execution };
}

const TOOLS = [
  {
    name: 'ragent_list_sessions',
    description: 'List Ragent chat sessions (metadata only: id, name, group, description, tool, timestamps). Sorted by most recently updated.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max sessions to return (1-50, default 20)' },
      },
    },
  },
  {
    name: 'ragent_get_session',
    description: 'Get a single Ragent session metadata by session id or exact name. Conversation bodies are never exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id or exact session name' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'ragent_list_orchestrations',
    description: 'List durable Ragent orchestration executions and their provider-neutral state (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        rootSessionId: { type: 'string', description: 'Optional root session filter' },
        state: { type: 'string', description: 'Optional execution state filter' },
        limit: { type: 'integer', description: 'Max executions to return (1-100, default 20)' },
      },
    },
  },
  {
    name: 'ragent_get_orchestration',
    description: 'Read one durable orchestration execution, including steps, commands, interrupts and audit events (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'Execution id returned by ragent_list_orchestrations' },
      },
      required: ['executionId'],
    },
  },
];

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleRequest(request) {
  const id = request.id;
  const method = request.method;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    // Keep old calls working for clients that cached the previous tool list.
    const requestedName = trimString(request.params?.name);
    const name = requestedName.replace(/^agentoc_/, 'ragent_');
    const args = request.params?.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments
      : {};
    try {
      if (name === 'ragent_list_sessions') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await listSessions(args), null, 2)));
      }
      if (name === 'ragent_get_session') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await getSession(args), null, 2)));
      }
      if (name === 'ragent_list_orchestrations') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await listOrchestrations(args), null, 2)));
      }
      if (name === 'ragent_get_orchestration') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await getOrchestration(args), null, 2)));
      }
      return jsonRpcResult(id, toolResult(`Unknown tool: ${name}`, true));
    } catch (error) {
      return jsonRpcResult(id, toolResult(String(error?.message || error), true));
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = trimString(line);
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    process.stdout.write(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')) + '\n');
    return;
  }
  // Notifications (no id) never get a response.
  if (request.id === undefined || request.id === null) return;
  void handleRequest(request).then((response) => {
    process.stdout.write(JSON.stringify(response) + '\n');
  });
});
