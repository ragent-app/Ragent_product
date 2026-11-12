#!/usr/bin/env node
// Private, per-run MCP server for the approved action channel.
//
// This process has no executor capability. It only forwards one structured
// proposal batch to chat-server and returns the durable batch id. The server
// side performs all validation, classification, binding, persistence, and
// authorization checks.

import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ragent-approved-actions';
const SERVER_VERSION = '1.0.0';
const MAX_ACTIONS = 32;
const MAX_REQUEST_BYTES = 64 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envFlag(name) {
  return trimString(process.env[name]).toLowerCase() === '1';
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function actionTool() {
  return {
    name: 'ragent_request_actions',
    description: 'Propose related host-administrator actions. For Windows winget installs and service control, use this tool rather than running them directly. Eligible installs may start automatically and dangerous actions go to owner review. An executing status is not completion: call this tool with statusOnly=true and the same requestKey and identical action until it reports succeeded, failed or unknown. Never repeat an operation when its outcome is unknown; check the original requestKey.',
    inputSchema: {
      type: 'object',
      properties: {
        requestKey: { type: 'string', description: 'Optional stable idempotency key for a retry of the same proposal.' },
        statusOnly: { type: 'boolean', description: 'Only check the existing Windows installation or service operation by requestKey; never starts a new operation.' },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ACTIONS,
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'One executable command. Do not use shell pipelines or interpreters.' },
              cwd: { type: 'string', description: 'Absolute working directory.' },
              description: { type: 'string', description: 'Short human summary.' },
              reason: { type: 'string', description: 'Why the action is needed.' },
              category: { type: 'string', enum: ['software_install', 'privileged_other', 'destructive_delete'] },
            },
            required: ['command'],
          },
        },
      },
      required: ['actions'],
    },
  };
}

export function agentCreateTool() {
  return {
    name: 'ragent_create_agent',
    description: 'Propose one fully specified Ragent Agent for owner review. This tool never creates the Agent directly and never receives owner credentials.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestKey: { type: 'string', description: 'Optional stable idempotency key for retrying the exact same proposal.' },
        reason: { type: 'string', description: 'Short reason this Agent should be created.' },
        agent: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 256 },
            systemPrompt: { type: 'string', maxLength: 65536 },
            welcomeMessage: { type: 'string', maxLength: 16384 },
            tool: { type: 'string', minLength: 1, maxLength: 128 },
            skills: {
              type: 'array',
              maxItems: 32,
              items: { type: 'string', minLength: 1, maxLength: 256 },
            },
            perMessageSystemPrompt: {
              type: 'object',
              maxProperties: 16,
              additionalProperties: { type: 'string', minLength: 1, maxLength: 16384 },
            },
          },
          required: ['name', 'systemPrompt', 'tool'],
        },
      },
      required: ['agent'],
    },
  };
}

export function readConfig() {
  return {
    enabled: envFlag('AGENTOC_APPROVED_ACTIONS_ENABLED'),
    agentCreateEnabled: envFlag('AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED'),
    endpoint: trimString(process.env.AGENTOC_APPROVED_ACTIONS_ENDPOINT) || 'http://127.0.0.1:7690/api/internal/approved-actions/propose',
    token: trimString(process.env.AGENTOC_APPROVED_ACTIONS_TOKEN),
    sessionId: trimString(process.env.AGENTOC_APPROVED_ACTIONS_SESSION_ID),
    runId: trimString(process.env.AGENTOC_APPROVED_ACTIONS_RUN_ID),
    turnId: trimString(process.env.AGENTOC_APPROVED_ACTIONS_TURN_ID),
    cwd: trimString(process.env.AGENTOC_APPROVED_ACTIONS_CWD),
    projectRoot: trimString(process.env.AGENTOC_APPROVED_ACTIONS_PROJECT_ROOT),
  };
}

function postProposal(config, payload) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(config.endpoint);
    } catch {
      reject(new Error('approved action endpoint is invalid'));
      return;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      reject(new Error('approved action proposal is too large'));
      return;
    }
    const request = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body, 'utf8'),
        'x-agentoc-approved-action-token': config.token,
      },
      // A Windows package lookup may query a remote trusted source before the
      // broker accepts the operation. Timing out earlier makes its outcome
      // ambiguous and encourages an unsafe retry with a different request ID.
      timeout: 11 * 60_000,
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data, 'utf8') > MAX_REQUEST_BYTES) response.destroy(new Error('response too large'));
      });
      response.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { error: 'invalid chat-server response' }; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(trimString(parsed?.error) || `chat-server rejected proposal (${response.statusCode})`);
          error.code = trimString(parsed?.code) || 'APPROVED_ACTION_PROPOSAL_REJECTED';
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('chat-server proposal timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function normalizeActions(args) {
  if (!Array.isArray(args?.actions) || args.actions.length < 1 || args.actions.length > MAX_ACTIONS) {
    throw new Error(`actions must contain 1-${MAX_ACTIONS} entries`);
  }
  return args.actions.map((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('each action must be an object');
    return {
      command: trimString(action.command),
      ...(trimString(action.cwd) ? { cwd: trimString(action.cwd) } : {}),
      ...(trimString(action.description) ? { description: trimString(action.description) } : {}),
      ...(trimString(action.reason) ? { reason: trimString(action.reason) } : {}),
      ...(trimString(action.category) ? { category: trimString(action.category) } : {}),
    };
  });
}

export async function requestActions(args, requestId, config = readConfig()) {
  if (!config.enabled) throw new Error('approved action capability is unavailable for this runtime');
  if (!config.token || !config.sessionId || !config.runId || !config.turnId) {
    throw new Error('approved action capability is not bound to an active run');
  }
  const actions = normalizeActions(args);
  if (args?.statusOnly === true && !trimString(args?.requestKey)) throw new Error('statusOnly requires the original requestKey');
  const requestKey = trimString(args?.requestKey)
    || `mcp:${config.runId}:${config.turnId}:${String(requestId || randomBytes(6).toString('hex'))}`;
  let response;
  try { response = await postProposal(config, {
    requestKey,
    ...(args?.statusOnly === true ? { autoInstallStatusOnly: true } : {}),
    actions,
    sessionId: config.sessionId,
    runId: config.runId,
    turnId: config.turnId,
    cwd: config.cwd,
    projectRoot: config.projectRoot,
  }); } catch (error) {
    // The server may have accepted a submission even if the reply was lost.
    // Always return its stable key so the agent can query the same operation.
    error.message = `${error.message || 'Approved action request failed'} (requestKey: ${requestKey}; check this same key before retrying)`;
    throw error;
  }
  if (response?.kind === 'automatic_install') {
    return { kind: response.kind, status: response.status, code: response.code || '', requestId: response.requestId,
      requestKey, duplicate: response.duplicate === true };
  }
  if (response?.kind === 'windows_service_control') {
    return { kind: response.kind, status: response.status, code: response.code || '', requestId: response.requestId,
      requestKey, duplicate: response.duplicate === true };
  }
  return {
    status: 'awaiting_approval',
    batchId: trimString(response?.batchId),
    actions: Array.isArray(response?.actions) ? response.actions : [],
  };
}

export async function requestAgentCreate(args, requestId, config = readConfig()) {
  if (!config.enabled || !config.agentCreateEnabled) {
    throw new Error('managed Agent creation capability is unavailable for this runtime');
  }
  if (!config.token || !config.sessionId || !config.runId || !config.turnId) {
    throw new Error('managed Agent creation capability is not bound to an active run');
  }
  if (!args?.agent || typeof args.agent !== 'object' || Array.isArray(args.agent)) {
    throw new Error('agent must be an object');
  }
  const requestKey = trimString(args?.requestKey)
    || `agent-create:${config.runId}:${config.turnId}:${String(requestId || randomBytes(6).toString('hex'))}`;
  const response = await postProposal(config, {
    requestKey,
    actions: [{
      operation: 'agent.create',
      agent: args.agent,
      description: `Create Agent \"${trimString(args.agent.name)}\"`,
      reason: trimString(args.reason),
    }],
    sessionId: config.sessionId,
    runId: config.runId,
    turnId: config.turnId,
  });
  return {
    status: 'awaiting_approval',
    batchId: trimString(response?.batchId),
    actions: Array.isArray(response?.actions) ? response.actions : [],
  };
}

export async function handleRequest(request, config = readConfig()) {
  const id = request.id;
  if (request.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (request.method === 'ping') return jsonRpcResult(id, {});
  if (request.method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: config.enabled
        ? [actionTool(), ...(config.agentCreateEnabled ? [agentCreateTool()] : [])]
        : [],
    });
  }
  if (request.method === 'tools/call') {
    // Preserve in-flight calls from clients that cached the former tool names.
    const name = trimString(request.params?.name).replace(/^agentoc_/, 'ragent_');
    try {
      if (name === 'ragent_request_actions') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await requestActions(request.params?.arguments || {}, id, config))));
      }
      if (name === 'ragent_create_agent') {
        return jsonRpcResult(id, toolResult(JSON.stringify(await requestAgentCreate(request.params?.arguments || {}, id, config))));
      }
      return jsonRpcResult(id, toolResult(`Unknown tool: ${name}`, true));
    } catch (error) {
      return jsonRpcResult(id, toolResult(String(error?.message || error), true));
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
 rl.on('line', (line) => {
  const text = trimString(line);
  if (!text) return;
  let request;
  try { request = JSON.parse(text); } catch {
    process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))}\n`);
    return;
  }
  if (request.id === undefined || request.id === null) return;
  void handleRequest(request).then((response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
 });
}
